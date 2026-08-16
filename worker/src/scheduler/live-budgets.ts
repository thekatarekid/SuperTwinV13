// ===========================================================================
// [CODE] What the live path COSTS, and the budgets it is judged against —
// arch §8.3 (guards 1–4, the cost paragraph) and §9.7 (pacing and stalls);
// build item 3.4.
//
// ./live.ts decides WHETHER a pass fires. This file is the accounting around
// that decision: the per-stream pass ledger the hourly cap and the daily call
// budget are both read from, and the four shipped numbers a run is scored on.
// They live apart from the trigger because they answer a different question —
// "what did this cost?" rather than "should this run?" — and because a budget
// a surface renders should not drag the session queries in with it.
//
// THE LEDGER IS IN THE DATABASE, NOT IN MEMORY. A counter that resets on
// restart is a counter that gives a runaway stream a fresh 20 passes every time
// the worker bounces — which is precisely when it would be bouncing.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import {
  clampLiveInterval,
  deltaPassCost,
  effectiveInterval,
  IdleTracker,
  wholeSessionPassCost,
  type PauseWindow,
} from "./lanes.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// The shipped budgets — global acceptance, instrumented rather than asserted
// ---------------------------------------------------------------------------

/**
 * The four numbers this item is measured against, in one place so a test and a
 * surface cannot disagree about what "the budget" is.
 *
 * `visibilitySlackMs` is item 3.4's own line — "new message → claims visible
 * ≤ live_interval + 15 s" — and it is a slack ON TOP of the effective interval,
 * not an absolute latency: choosing a 10-minute interval legitimately means a
 * 10-minute wait, and backpressure that stretches the interval must show that
 * stretch (guard 1) rather than silently fail this budget.
 */
export const LIVE_BUDGETS = {
  /** Cold install → the first claim on screen. */
  firstClaimMs: 30_000,
  /** Cold install → spaces and tasks on screen. */
  spacesTasksMs: 120_000,
  /** Longest silent gap during a full import, quota pauses excluded. */
  silentGapMs: 90_000,
  /** Steady-state model calls on a quiet day, live passes + consolidations. */
  steadyCallsPerDay: 12,
  /** Item 3.4: claims visible within the effective interval plus this. */
  visibilitySlackMs: 15_000,
} as const;

/** When a pass firing at `intervalMs` must have its claims on screen by. */
export function visibilityDeadlineMs(eventAtMs: number, intervalMs: number): number {
  return eventAtMs + clampLiveInterval(intervalMs) + LIVE_BUDGETS.visibilitySlackMs;
}

// ---------------------------------------------------------------------------
// The pass ledger — guard 2 (20/stream/hour) and the daily call budget
// ---------------------------------------------------------------------------

export type LivePassKind = "delta" | "consolidation";

export interface LedgerEntry {
  atMs: number;
  kind: LivePassKind;
}

const LEDGER_PREFIX = "live_ledger:";

/** `1712000000000:d,1712000030000:c` — greppable in a sqlite shell, not JSON. */
function encodeLedger(entries: readonly LedgerEntry[]): string {
  return entries.map((e) => `${e.atMs}:${e.kind === "consolidation" ? "c" : "d"}`).join(",");
}

function decodeLedger(raw: string | null): LedgerEntry[] {
  if (!raw) return [];
  const out: LedgerEntry[] = [];
  for (const part of raw.split(",")) {
    if (part === "") continue;
    const colon = part.indexOf(":");
    const atMs = Number(colon > 0 ? part.slice(0, colon) : part);
    if (!Number.isFinite(atMs)) continue;
    out.push({ atMs, kind: part.slice(colon + 1) === "c" ? "consolidation" : "delta" });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function readLedger(streamId: string): LedgerEntry[] {
  return decodeLedger(appStateGet(`${LEDGER_PREFIX}${streamId}`));
}

/**
 * Append one pass and prune anything older than 24 h.
 *
 * Pruning on write keeps the row bounded without a sweeper: a stream that stops
 * being busy stops growing its ledger, and a stream that never stops is capped
 * at a day of entries by construction.
 */
export function recordLivePass(streamId: string, atMs: number, kind: LivePassKind = "delta"): LedgerEntry[] {
  const kept = readLedger(streamId).filter((e) => e.atMs > atMs - DAY_MS);
  kept.push({ atMs, kind });
  kept.sort((a, b) => a.atMs - b.atMs);
  appStateSet(`${LEDGER_PREFIX}${streamId}`, encodeLedger(kept));
  return kept;
}

/** Passes this stream has already spent in the trailing hour (guard 2). */
export function passesThisHour(streamId: string, nowMs: number): number {
  return readLedger(streamId).filter((e) => e.atMs > nowMs - HOUR_MS && e.kind === "delta").length;
}

interface LedgerRow {
  key: string;
  value: string | null;
}

/** Every stream's ledger, for the account-wide call budget. */
function allLedgers(): { streamId: string; entries: LedgerEntry[] }[] {
  const rows = getDb()
    .prepare(`SELECT key, value FROM app_state WHERE key LIKE '${LEDGER_PREFIX}%'`)
    .all() as LedgerRow[];
  return rows.map((row) => ({
    streamId: row.key.slice(LEDGER_PREFIX.length),
    entries: decodeLedger(row.value),
  }));
}

/**
 * Model calls attributable to the live path in the trailing window.
 *
 * ONE PASS IS ONE CALL. A delta pass is a single P-CL1Δ call over the new
 * events plus the running summary, and a conditional consolidation is one more
 * — so counting ledger entries counts calls, and the "≤ 12 on a quiet day"
 * budget can be measured on a running system instead of estimated.
 */
export function liveCallsInWindow(nowMs: number, windowMs: number = DAY_MS): number {
  let total = 0;
  for (const ledger of allLedgers()) {
    total += ledger.entries.filter((e) => e.atMs > nowMs - windowMs).length;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The budgets, measured
// ---------------------------------------------------------------------------

export interface BudgetCheck {
  name: "first_claim" | "spaces_tasks" | "silent_gap" | "steady_calls" | "live_visibility";
  budget: number;
  actual: number;
  unit: "ms" | "calls";
  met: boolean;
}

export interface BudgetInput {
  nowMs: number;
  /** Cold install → first claim rendered. */
  firstClaimMs?: number;
  /** Cold install → spaces and tasks rendered. */
  spacesTasksMs?: number;
  /** Longest silent gap during the import, quota pauses already excluded. */
  silentGapMs?: number;
  /** Model calls on the day; defaults to the live ledger's own count. */
  callsLast24h?: number;
  /** Newest-event → claims-visible, for a live pass at `intervalMs`. */
  visibility?: { latencyMs: number; intervalMs: number };
}

/**
 * The four global-acceptance numbers plus item 3.4's own, as a report.
 *
 * A check whose input is absent is simply not returned — an unmeasured budget
 * is not a passing one, and a report that invents a zero for it would say the
 * opposite. `met` on the whole report is the AND over what WAS measured, and
 * callers that need "all five" assert the length too.
 */
export function budgetReport(input: BudgetInput): { checks: BudgetCheck[]; met: boolean } {
  const checks: BudgetCheck[] = [];
  const push = (name: BudgetCheck["name"], budget: number, actual: number, unit: BudgetCheck["unit"]): void => {
    checks.push({ name, budget, actual, unit, met: actual <= budget });
  };

  if (input.firstClaimMs !== undefined) push("first_claim", LIVE_BUDGETS.firstClaimMs, input.firstClaimMs, "ms");
  if (input.spacesTasksMs !== undefined) {
    push("spaces_tasks", LIVE_BUDGETS.spacesTasksMs, input.spacesTasksMs, "ms");
  }
  if (input.silentGapMs !== undefined) push("silent_gap", LIVE_BUDGETS.silentGapMs, input.silentGapMs, "ms");

  const calls = input.callsLast24h ?? liveCallsInWindow(input.nowMs);
  push("steady_calls", LIVE_BUDGETS.steadyCallsPerDay, calls, "calls");

  if (input.visibility) {
    const allowed = clampLiveInterval(input.visibility.intervalMs) + LIVE_BUDGETS.visibilitySlackMs;
    push("live_visibility", allowed, input.visibility.latencyMs, "ms");
  }

  return { checks, met: checks.every((c) => c.met) };
}

/**
 * The longest silent gap across a run, in ms, quota pauses removed.
 *
 * Thin wrapper over lanes' `IdleTracker` so the 90 s budget is measured with
 * the same clock §9.7 rule 1 is judged by — one pause-subtraction rule, not a
 * second one here that rounds differently.
 */
export function silentGapMs(input: {
  startedAtMs: number;
  nowMs: number;
  beats: readonly number[];
  pauses?: readonly PauseWindow[];
}): number {
  const tracker = new IdleTracker(input.startedAtMs);
  for (const beat of input.beats) tracker.beat(beat);
  for (const pause of input.pauses ?? []) tracker.pause(pause);
  return Math.round(tracker.report(input.nowMs).maxIdleGapSeconds * 1000);
}

export interface QuietDayEstimate {
  passes: number;
  consolidations: number;
  calls: number;
  /** What re-reading each session whole would have cost, for comparison. */
  wholeSessionTokens: number;
  deltaTokens: number;
  withinBudget: boolean;
}

/**
 * What a quiet day costs: `burstsPerSession` conversational bursts across
 * `sessions` sessions, at most one consolidation each.
 *
 * §8.3's cost paragraph, arithmetic instead of prose: three bursts is ~3 small
 * delta calls plus at most one consolidation. The token columns are the O(n)
 * versus O(n^2) comparison — the reason delta extraction is mandatory.
 */
export function quietDayEstimate(input: {
  sessions: number;
  burstsPerSession: number;
  messagesPerBurst: number;
}): QuietDayEstimate {
  const passes = input.sessions * input.burstsPerSession;
  const consolidations = input.sessions;
  const messages = input.sessions * input.burstsPerSession * input.messagesPerBurst;
  return {
    passes,
    consolidations,
    calls: passes + consolidations,
    deltaTokens: deltaPassCost(messages, Math.max(1, input.messagesPerBurst)).inputTokens,
    wholeSessionTokens: wholeSessionPassCost(messages, Math.max(1, input.messagesPerBurst)).inputTokens,
    withinBudget: passes + consolidations <= LIVE_BUDGETS.steadyCallsPerDay,
  };
}

/** The UI's line for Settings → Processing (§8.3's table, at the top end). */
export function intervalNote(liveIntervalMs: number): string {
  const ms = clampLiveInterval(liveIntervalMs);
  const { intervalMs } = effectiveInterval(ms, 0);
  if (intervalMs >= 6 * HOUR_MS) return "at 6 hours, extraction happens only when a conversation ends";
  if (intervalMs >= 120_000) return "conversations mostly resolved before extraction; fewer calls";
  return "near-realtime; a commitment appears about half a minute after it is made";
}
