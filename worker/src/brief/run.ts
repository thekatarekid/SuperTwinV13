// ===========================================================================
// The brief pass — code composes, brief.v2 phrases (V6 P1 S4.6; Build §7.2
// lane B; Product_V6 §14.4 item 7; Prompts P-13; evals BRF-01, BRF-02).
//
// The order matters and is the whole design:
//
//   1. LOOKUP.  `briefDeltaSince(lastBriefAt())` — a few indexed COUNTs over
//               the world model. Zero rows → status "skipped", ZERO model
//               calls, no card, no row, and the window stays open so the next
//               brief still says what moved since the last one the user read
//               (BRF-01, gate `clock_only_call`).
//   2. COMPOSE. Code builds the ledger: needs you · today · moved. Still zero
//               calls. An empty ledger is also no call and no card — a quiet
//               day gets no filler.
//   3. PHRASE.  ONE brief.v2 call turns the ledger into prose (BRF-02).
//               Exactly one; there is no second pass, no per-item call.
//   4. CHECK.   Any figure in the prose that is not in the ledger is named.
//               A failed or refused call is not a missing brief: the ledger
//               renders itself and the card still goes up, marked as such.
//
// The pass writes ONE row in `briefs` and one decisions row. It never mints an
// artifact: the brief is its own surface (§14.4 item 7), and an artifact would
// join the router's pending set as one of the six nudge kinds, which it is not.
// ===========================================================================

import { runJsonPass, type JsonPassDeps } from "../brain/llm.js";
import { DEFAULT_TZ, localDate, localTime } from "../calendar/clocks.js";
import { appStateGet } from "../db/ingest.js";
import {
  BRIEF_V2_ID,
  BRIEF_V2_SYSTEM,
  figuresNotInLedger,
  parseBriefV2,
} from "../prompts/brief.v2.js";
import { isStepEnabled } from "../settings/steps.js";
import { briefDeltaSince, type BriefDelta } from "./delta.js";
import {
  composeLedger,
  ledgerIsEmpty,
  ledgerItemCount,
  packBriefV2User,
  renderLedgerFallback,
  type BriefLedger,
} from "./ledger.js";
import { BRIEF_TIMES_KEY, briefTimes, dueSlot, slotKey, type DueSlot } from "./schedule.js";
import { insertBrief, lastBriefAt, lastSlot, setLastSlot, type BriefRow } from "./store.js";

/** The Settings › Intelligence step key this lane spends under. */
export const BRIEF_STEP = "brief";
export const BRIEF_TIMEOUT_MS = 60_000;

export type BriefStatus = "composed" | "skipped";
export type BriefSkipReason = "no_delta" | "empty_ledger" | "step_off" | "stale_slot" | "not_due";

export interface BriefReport {
  status: BriefStatus;
  reason?: BriefSkipReason;
  /** The set time this run was for (`yyyy-mm-dd HH:MM`), or null for an ad-hoc run. */
  slot: string | null;
  delta: BriefDelta;
  ledger: BriefLedger | null;
  brief: BriefRow | null;
  /** Model calls this run spent. 0 on every skip — that is the point. */
  modelCalls: number;
  /** `brief-inflation:<figure>` · `brief-call-failed:<code>`. */
  violations: string[];
}

export interface RunBriefOptions {
  now?: Date;
  tz?: string;
  /** The set time this run answers; null for an on-demand run ("show me the brief"). */
  slot?: string | null;
  /** Ignore the delta gate (the user asked for it explicitly). Never used by the job. */
  force?: boolean;
  deps?: JsonPassDeps;
}

/**
 * Compose one brief. Returns without spending anything when the world model
 * has not moved — the gate that makes a clock-driven surface honest.
 */
export async function runBrief(opts: RunBriefOptions = {}): Promise<BriefReport> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const slot = opts.slot ?? null;
  const since = lastBriefAt();
  const delta = briefDeltaSince(since);

  const skip = (reason: BriefSkipReason, ledger: BriefLedger | null = null): BriefReport => ({
    status: "skipped",
    reason,
    slot,
    delta,
    ledger,
    brief: null,
    modelCalls: 0,
    violations: [],
  });

  // 1. The lookup before the call.
  if (!opts.force && delta.rows === 0) return skip("no_delta");

  // 2. Code composes. Still zero calls.
  const ledger = composeLedger({ now, tz, since });
  if (!opts.force && ledgerIsEmpty(ledger)) return skip("empty_ledger", ledger);

  // 3. One call writes the prose.
  const violations: string[] = [];
  let text = "";
  let modelCalls = 0;
  let runId: string | null = null;
  const packed = packBriefV2User(ledger);
  try {
    const result = await runJsonPass(
      {
        pass: BRIEF_V2_ID,
        system: BRIEF_V2_SYSTEM,
        user: packed,
        role: "brief",
        cohortId: null,
        unit: { kind: "brief", id: slot ?? now.toISOString() },
        timeoutMs: BRIEF_TIMEOUT_MS,
        validate: parseBriefV2,
      },
      opts.deps ?? {},
    );
    modelCalls = Math.max(1, result.runIds.length);
    runId = result.runIds[result.runIds.length - 1] ?? null;
    if (result.output) {
      text = result.output.text;
    } else {
      violations.push(`brief-call-failed:${result.error?.code ?? result.status}`);
    }
  } catch (err) {
    modelCalls = Math.max(modelCalls, 1);
    violations.push(`brief-call-failed:${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. The mechanical check, then the row. A brief the model could not write
  //    still goes up as the ledger — 08:30 is a promise, not a best effort.
  if (text) {
    for (const figure of figuresNotInLedger(text, packed)) {
      violations.push(`brief-inflation:${figure}`);
    }
  } else {
    text = renderLedgerFallback(ledger);
  }

  const brief = insertBrief({
    // An on-demand brief takes the slot key of the minute it was asked for, in
    // the user's zone — the same shape as a set time, so "the 08:30 brief" is
    // one row whether the clock or the user asked for it.
    slot: slot ?? slotKey(localDate(now.getTime(), tz), localTime(now.getTime(), tz)),
    tz,
    composedAt: now.toISOString(),
    since,
    deltaRows: delta.rows,
    ledger,
    text,
    modelCalls,
    runId,
  });

  return { status: "composed", slot: brief.slot, delta, ledger, brief, modelCalls, violations };
}

// ---------------------------------------------------------------------------
// The clock half
// ---------------------------------------------------------------------------

export interface BriefTickReport extends BriefReport {
  /** The slot the clock offered, before the delta had its say. */
  due: DueSlot | null;
  items: number;
}

/**
 * One tick of the brief lane: is a set time due, and if so does the world
 * model justify a brief? Consumes a stale slot (a laptop opened at 14:00 does
 * not owe the user an 08:30 brief) and always advances `brief.last_slot`, so
 * one set time is considered exactly once.
 */
export async function briefTick(
  opts: { now?: Date; tz?: string; deps?: JsonPassDeps; times?: readonly string[] } = {},
): Promise<BriefTickReport> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const times = opts.times ? briefTimes(opts.times) : briefTimes(readBriefTimes());
  const due = dueSlot(now.getTime(), times, lastSlot(), tz);
  const nothing = (reason: BriefSkipReason): BriefTickReport => ({
    status: "skipped",
    reason,
    slot: due?.slot ?? null,
    delta: { since: null, rows: 0, byTable: {} },
    ledger: null,
    brief: null,
    modelCalls: 0,
    violations: [],
    due,
    items: 0,
  });

  if (!due) return nothing("not_due");
  // The slot is answered either way — composed, stale or held.
  if (due.stale) {
    setLastSlot(due.slot);
    return nothing("stale_slot");
  }
  if (!isStepEnabled(BRIEF_STEP)) {
    // A step turned off never spends and never drops the slot silently: the
    // slot is NOT consumed, so switching the step back on serves it (SET-01).
    return nothing("step_off");
  }

  const report = await runBrief({ now, tz, slot: due.slot, deps: opts.deps });
  setLastSlot(due.slot);
  return { ...report, due, items: report.ledger ? ledgerItemCount(report.ledger) : 0 };
}

/** The set times as Settings wrote them. */
export function readBriefTimes(): string[] {
  try {
    const raw = appStateGet(BRIEF_TIMES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}
