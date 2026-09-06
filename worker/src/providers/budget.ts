// ===========================================================================
// [CODE] Budget — the hard spend and call ceiling at the single spawn site
// (build V6 P1 S0.2, backlog T0-4; GoldenEvals SPD-01/SPD-02).
//
// WHY. The quota gate in providers/pool.ts meters tokens per window, but three
// call sites bypass the pool and background passes never metered into it
// (T0-11). The 13.4.x incident spent for nine hours because nothing downstream
// of every bypass could say "stop". This module sits where assertTraceContext
// sits — in claude-local/index.ts, BEFORE spawn — so there is no path to a
// `claude` child that does not pass through it.
//
// THE RULE.
//   Ceilings (defaults): $3/hour, $15/day, 400 calls/hour, 3,000 calls/day.
//   A call that would breach any ceiling throws BUDGET_EXCEEDED before the
//   process is spawned, and LATCHES `app_state.budget_tripped_at`. The latch
//   never clears on its own — not on the hour, not on restart (SPD-02). An
//   operator clears it (resetBudgetLatch()).
//   Interactive chat and the grounded bar are COUNTED but EXEMPT from the
//   latch: a trip must not brick the one surface you need to diagnose it.
//
// THE RESUME (13.11.6, FIX-C1). Clearing the latch was not enough to resume.
// The ledger still held the hour that caused the trip, so the first call after
// the operator's reset re-breached the hour ceiling and re-latched instantly:
// the button worked, the app went back to paused, and nothing said why. So the
// reset carries a FORGIVENESS POINT (`budget.resumed_at`): the HOUR windows —
// spend and calls — are measured from the resume onwards, because an operator
// who presses resume has read the reason and accepted the hour already spent.
//   The DAY windows are NOT forgiven. The 13.4.x incident was a nine-hour,
// $41 runaway: that is what the daily ceiling is for, and a rate limiter you
// can acknowledge must not become a total you can wish away. So resuming buys
// the rest of the day's budget and no more — and this is still not auto-resume
// (SPD-02's wrong mode): nothing about the clock clears anything. A human does.
//
// THE HOLD (13.11.6, FIX-C1). A latch that only throws at the spawn site is a
// latch every lane discovers the expensive way: it builds the bundle, opens a
// run, is refused, records the failure, walks a retry ladder and — after three
// strikes — DEAD-LETTERS the work and stamps the rows, so the backlog is
// consumed without ever being understood. Ten of those in a row trip the S0.7
// breaker, which pauses the lane 30 minutes and then re-arms against a
// condition that by construction never clears on its own: spin, refuse,
// re-trip, forever. That is what the user's 13.11.5 install did for three
// hours (one `media` run every ~50 s, every one BUDGET_EXCEEDED).
//
//   `backgroundModelHold()` is the question a background lane asks BEFORE it
//   starts work: "may I spend right now?". Held means STAND DOWN, not fail —
//   nothing is dispatched, nothing is stamped, no attempt is recorded, no run
//   row is written, nothing is dead-lettered, and the next tick after an
//   operator resets the latch dispatches exactly what was waiting. It is the
//   same shape settings/steps.ts already uses for a switched-off step (SET-01)
//   and executor/queue-job.ts already uses for the queue.
//
//   A held lane is LOUD: `reportBackgroundHold()` writes one `[budget] HELD`
//   line per lane per minute. Standing down quietly would reproduce the
//   original defect in a new place — the C3 heartbeat counts refusals, and a
//   lane that never asks is refused zero times.
//
// THE KILL SWITCH (S0.8, T0-13; SPD-03). `app_state.model_activity_paused`
//   is checked at the same choke point, first. It is the human's "Stop all
//   model activity": NOTHING is exempt — not chat, not the bar — because the
//   switch means exactly what it says. It never expires (no MAX_MANUAL_PAUSE_MS
//   here: a kill switch that self-resumes after an hour is not a kill switch),
//   it survives restart, and only the same switch turns it off. In-flight
//   children are not killed: admitted work completes, new work is refused.
//
// ACCOUNTING. Calls are counted when ADMITTED (so concurrent in-flight calls
// count), cost is added when the CLI reports it. The ledger is minute buckets
// over the trailing 24 hours, persisted as JSON under `app_state.budget.ledger`
// so a restart does not forget the last hour either.
//
// HERMETICITY. Under vitest, a suite that has not pointed SUPERTWIN_DB_PATH /
// SUPERTWIN_HOME at a scratch location gets an in-memory store — the same
// rule traces/context.ts follows: an unrelated suite exercising the transport
// must never write into the developer's real ~/SuperTwinV13. The budget's own
// tests use a temp DB and so hit the real app_state path.
// ===========================================================================

import { resolveDbPath } from "../db/connection.js";
import { appStateDelete, appStateGet, appStateSet } from "../db/ingest.js";
import { isProductionDbPath } from "../home-guard.js";
import { currentTraceMeta } from "../traces/context.js";

export interface BudgetCeilings {
  /**
   * Per CALL, handed to the CLI as `--max-budget-usd` (S0.4, T1-1). Not a
   * window: the CLI itself stops the run. A runaway guard an order of
   * magnitude above the ≤ $0.006 target, never a working limit.
   */
  usdPerCall: number;
  usdPerHour: number;
  usdPerDay: number;
  callsPerHour: number;
  callsPerDay: number;
}

/** Plan §3 S0.2. Env overrides exist for ops, never lower than zero. */
export const DEFAULT_CEILINGS: Readonly<BudgetCeilings> = Object.freeze({
  usdPerCall: 0.5,
  usdPerHour: 3,
  usdPerDay: 15,
  callsPerHour: 400,
  callsPerDay: 3000,
});

/** `app_state` keys. The latch key is the one the plan names. */
export const BUDGET_TRIPPED_KEY = "budget_tripped_at";
export const BUDGET_TRIPPED_REASON_KEY = "budget_tripped_reason";
export const BUDGET_LEDGER_KEY = "budget.ledger";
/**
 * ISO time of the operator's last reset — the point the HOUR windows are
 * measured from, so that pressing resume actually resumes (FIX-C1).
 */
export const BUDGET_RESUMED_KEY = "budget.resumed_at";
/** The kill switch. Value is the ISO time it was thrown; absent = running. */
export const MODEL_ACTIVITY_PAUSED_KEY = "model_activity_paused";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

/** One minute of spend. `m` is the epoch minute. */
interface Bucket {
  m: number;
  calls: number;
  usd: number;
}

/** What the budget reads and writes. Keyed like app_state. */
export interface BudgetStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

// ---- stores ----------------------------------------------------------------

function appStateStore(): BudgetStore {
  return {
    get: appStateGet,
    set: appStateSet,
    delete: appStateDelete,
  };
}

const memory = new Map<string, string>();
const memoryStore: BudgetStore = {
  get: (k) => memory.get(k) ?? null,
  set: (k, v) => void memory.set(k, v),
  delete: (k) => void memory.delete(k),
};

let storeOverride: BudgetStore | null = null;

/**
 * Under vitest with no scratch DB configured the store is memory-only, so a
 * transport test never touches the real home. Everywhere else: app_state.
 */
function store(): BudgetStore {
  if (storeOverride) return storeOverride;
  if (process.env.VITEST && isProductionDbPath(resolveDbPath())) return memoryStore;
  return appStateStore();
}

/** Test seam: pin a store (null restores the default selection). */
export function setBudgetStore(s: BudgetStore | null): void {
  storeOverride = s;
}

/** Test seam: forget the memory store and any pinned store. */
export function resetBudgetForTests(): void {
  memory.clear();
  storeOverride = null;
  holdLoggedAt.clear();
}

// ---- ceilings --------------------------------------------------------------

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The active ceilings: defaults, each overridable by SUPERTWIN_BUDGET_*. */
export function budgetCeilings(): BudgetCeilings {
  return {
    usdPerCall: envNumber("SUPERTWIN_BUDGET_USD_PER_CALL", DEFAULT_CEILINGS.usdPerCall),
    usdPerHour: envNumber("SUPERTWIN_BUDGET_USD_PER_HOUR", DEFAULT_CEILINGS.usdPerHour),
    usdPerDay: envNumber("SUPERTWIN_BUDGET_USD_PER_DAY", DEFAULT_CEILINGS.usdPerDay),
    callsPerHour: envNumber("SUPERTWIN_BUDGET_CALLS_PER_HOUR", DEFAULT_CEILINGS.callsPerHour),
    callsPerDay: envNumber("SUPERTWIN_BUDGET_CALLS_PER_DAY", DEFAULT_CEILINGS.callsPerDay),
  };
}

// ---- ledger ----------------------------------------------------------------

function loadLedger(s: BudgetStore, now: number): Bucket[] {
  const raw = s.get(BUDGET_LEDGER_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const floor = Math.floor((now - DAY_MS) / MINUTE_MS);
  const out: Bucket[] = [];
  for (const b of parsed) {
    if (
      b &&
      typeof b === "object" &&
      typeof (b as Bucket).m === "number" &&
      typeof (b as Bucket).calls === "number" &&
      typeof (b as Bucket).usd === "number" &&
      (b as Bucket).m >= floor
    ) {
      out.push({ m: (b as Bucket).m, calls: (b as Bucket).calls, usd: (b as Bucket).usd });
    }
  }
  return out;
}

function saveLedger(s: BudgetStore, ledger: Bucket[]): void {
  s.set(BUDGET_LEDGER_KEY, JSON.stringify(ledger));
}

function bucketFor(ledger: Bucket[], now: number): Bucket {
  const m = Math.floor(now / MINUTE_MS);
  const last = ledger[ledger.length - 1];
  if (last && last.m === m) return last;
  const b: Bucket = { m, calls: 0, usd: 0 };
  ledger.push(b);
  return b;
}

export interface WindowTotals {
  calls: number;
  usd: number;
}

/**
 * Spend and calls in the trailing `windowMs`, never counting anything before
 * `sinceMs` (the operator's resume point; 0 = count the whole window). The
 * resume MINUTE itself counts: a call admitted seconds after the tap is spend
 * the resume is responsible for.
 */
function totals(ledger: Bucket[], now: number, windowMs: number, sinceMs = 0): WindowTotals {
  const windowFloor = Math.floor((now - windowMs) / MINUTE_MS);
  const resumeFloor = sinceMs > 0 ? Math.floor(sinceMs / MINUTE_MS) - 1 : Number.NEGATIVE_INFINITY;
  const floor = Math.max(windowFloor, resumeFloor);
  let calls = 0;
  let usd = 0;
  for (const b of ledger) {
    if (b.m > floor) {
      calls += b.calls;
      usd += b.usd;
    }
  }
  return { calls, usd };
}

// ---- the latch -------------------------------------------------------------

/** The operator's last reset as epoch ms; 0 when there has never been one. */
function resumedAtMs(s: BudgetStore): number {
  const raw = s.get(BUDGET_RESUMED_KEY);
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

export interface BudgetStatus {
  trippedAt: string | null;
  trippedReason: string | null;
  /** ISO time the kill switch was thrown; null while model activity runs. */
  modelActivityPausedAt: string | null;
  /**
   * ISO time of the operator's last reset, or null. `hour` is measured from
   * here (FIX-C1), so a surface showing "$X of $3 this hour" shows the same
   * number the gate is about to compare — never a forgiven hour the ceiling
   * has already stopped charging for.
   */
  resumedAt: string | null;
  hour: WindowTotals;
  day: WindowTotals;
  ceilings: BudgetCeilings;
}

/** Current windows, latch and kill switch, for /api/ops and the tests. */
export function budgetStatus(now: number = Date.now()): BudgetStatus {
  const s = store();
  const ledger = loadLedger(s, now);
  const resumed = resumedAtMs(s);
  return {
    trippedAt: s.get(BUDGET_TRIPPED_KEY),
    trippedReason: s.get(BUDGET_TRIPPED_REASON_KEY),
    modelActivityPausedAt: s.get(MODEL_ACTIVITY_PAUSED_KEY),
    resumedAt: s.get(BUDGET_RESUMED_KEY),
    hour: totals(ledger, now, HOUR_MS, resumed),
    day: totals(ledger, now, DAY_MS),
    ceilings: budgetCeilings(),
  };
}

// ---- the kill switch -------------------------------------------------------

/** True while "Stop all model activity" is on. Persisted; never expires. */
export function isModelActivityPaused(): boolean {
  return store().get(MODEL_ACTIVITY_PAUSED_KEY) !== null;
}

/**
 * Throw or release the kill switch. Idempotent: throwing it twice keeps the
 * first timestamp. Releasing it does NOT clear a budget latch — those are two
 * different facts (the human's choice vs. a ceiling breach).
 */
export function setModelActivityPaused(paused: boolean, now: number = Date.now()): void {
  const s = store();
  if (paused) {
    if (s.get(MODEL_ACTIVITY_PAUSED_KEY) !== null) return;
    s.set(MODEL_ACTIVITY_PAUSED_KEY, new Date(now).toISOString());
    console.error("[budget] STOP ALL MODEL ACTIVITY — no new `claude` process will spawn until the switch is released.");
  } else {
    if (s.get(MODEL_ACTIVITY_PAUSED_KEY) === null) return;
    s.delete(MODEL_ACTIVITY_PAUSED_KEY);
    holdLoggedAt.clear();
    console.error("[budget] model activity resumed by the operator.");
  }
}

export class ModelActivityPausedError extends Error {
  readonly code = "MODEL_ACTIVITY_PAUSED" as const;
  readonly pausedAt: string;
  constructor(pausedAt: string) {
    super(
      `MODEL_ACTIVITY_PAUSED: "Stop all model activity" has been on since ${pausedAt}. ` +
        "No process was spawned. Release the switch in Settings > General to resume.",
    );
    this.name = "ModelActivityPausedError";
    this.pausedAt = pausedAt;
  }
}

/** True once the latch is set. Never clears on its own. */
export function isBudgetTripped(): boolean {
  return store().get(BUDGET_TRIPPED_KEY) !== null;
}

/** Set the latch (idempotent — the first trip's timestamp and reason stand). */
export function tripBudget(reason: string, now: number = Date.now()): void {
  const s = store();
  if (s.get(BUDGET_TRIPPED_KEY) !== null) return;
  s.set(BUDGET_TRIPPED_KEY, new Date(now).toISOString());
  s.set(BUDGET_TRIPPED_REASON_KEY, reason);
  console.error(`[budget] TRIPPED — ${reason}. Background model activity is paused until an operator resets the latch.`);
}

/** The operator's explicit reset. Nothing else clears the latch. */
export function resetBudgetLatch(now: number = Date.now()): void {
  const s = store();
  const was = s.get(BUDGET_TRIPPED_KEY);
  s.delete(BUDGET_TRIPPED_KEY);
  s.delete(BUDGET_TRIPPED_REASON_KEY);
  // FIX-C1: the hour that caused the trip is forgiven from here, or the first
  // call after the reset would re-breach it and re-latch on the spot. The day
  // is not forgiven — see the header.
  s.set(BUDGET_RESUMED_KEY, new Date(now).toISOString());
  holdLoggedAt.clear();
  if (was !== null) {
    const day = totals(loadLedger(s, now), now, DAY_MS);
    console.error(
      `[budget] latch reset by the operator (was tripped at ${was}) — the hour is forgiven from now; ` +
        `today still stands at ${day.calls} calls / $${day.usd.toFixed(2)}. Held lanes resume on their next tick.`,
    );
  }
}

// ---- the hold --------------------------------------------------------------

/** Which switch is holding background model work. */
export type ModelHoldKind = "kill-switch" | "budget";

/** The answer to "may a background lane spend right now?". */
export interface ModelWorkHold {
  held: boolean;
  kind: ModelHoldKind | null;
  /** ISO time the hold began (the trip, or the switch being thrown). */
  since: string | null;
  /** The ceiling that was breached, when the hold is the budget latch. */
  reason: string | null;
  /** One line, already phrased for a log or a queue's `reason` field. */
  label: string | null;
}

const RUNNING: Readonly<ModelWorkHold> = Object.freeze({
  held: false,
  kind: null,
  since: null,
  reason: null,
  label: null,
});

/**
 * May a BACKGROUND lane start model work right now?
 *
 * The kill switch first (it means everything), then the ceiling latch. This is
 * a pure lookup — no ledger arithmetic, no writes — so a lane may ask it on
 * every tick. It deliberately does NOT consider the current window: a lane
 * that is merely close to a ceiling still works, and the ceiling itself is
 * enforced where it must be, at the spawn site in `admitCall`.
 *
 * Interactive callers (chat, the grounded bar) never ask: they are exempt from
 * the latch by `isLatchExempt`, so that the surface you would use to diagnose
 * a trip keeps answering.
 */
export function backgroundModelHold(): ModelWorkHold {
  const s = store();
  const pausedAt = s.get(MODEL_ACTIVITY_PAUSED_KEY);
  if (pausedAt !== null) {
    return {
      held: true,
      kind: "kill-switch",
      since: pausedAt,
      reason: null,
      label: `"Stop all model activity" has been on since ${pausedAt}`,
    };
  }
  const trippedAt = s.get(BUDGET_TRIPPED_KEY);
  if (trippedAt !== null) {
    const reason = s.get(BUDGET_TRIPPED_REASON_KEY);
    return {
      held: true,
      kind: "budget",
      since: trippedAt,
      reason,
      label: `the spend ceiling was reached at ${trippedAt}${reason ? ` — ${reason}` : ""}`,
    };
  }
  return RUNNING;
}

/** Convenience for the call sites that only branch on it. */
export function isBackgroundModelHeld(): boolean {
  return backgroundModelHold().held;
}

/** At most one `[budget] HELD` line per lane per minute. */
export const HOLD_LOG_INTERVAL_MS = 60_000;

const holdLoggedAt = new Map<string, number>();

/**
 * Ask the hold AND say so in the operator log, at most once a minute per lane.
 *
 * A lane that stands down silently is the original defect wearing a different
 * hat: worker.log would read the same whether the pipeline was idle, dead, or
 * hard-stopped. The line names the lane, the switch and the way out.
 */
export function reportBackgroundHold(
  lane: string,
  now: number = Date.now(),
  log: (line: string) => void = (line) => console.error(line),
): ModelWorkHold {
  const hold = backgroundModelHold();
  if (!hold.held) {
    holdLoggedAt.delete(lane);
    return hold;
  }
  const last = holdLoggedAt.get(lane);
  if (last === undefined || now - last >= HOLD_LOG_INTERVAL_MS) {
    holdLoggedAt.set(lane, now);
    log(
      `[budget] HELD — ${lane} is standing down: ${hold.label}. ` +
        "Nothing is dropped and nothing is stamped; the work waits. " +
        "Resume from the banner in the app, or POST /api/ops/budget/reset.",
    );
  }
  return hold;
}

/** Test seam: forget which lanes have already logged their hold. */
export function resetHoldLogForTests(): void {
  holdLoggedAt.clear();
}

// ---- exemption -------------------------------------------------------------

/** What the spawn site knows about the caller. */
export interface BudgetCallMeta {
  pass: string;
  caller: string;
}

/**
 * Interactive surfaces: the chat turn (server/chat, pass "chat") and the
 * grounded bar (grounded/router + grounded/handlers, passes `bar-*`). Counted,
 * never blocked by the latch.
 */
export function isLatchExempt(meta: BudgetCallMeta | null): boolean {
  if (!meta) return false;
  if (meta.pass === "chat") return true;
  if (meta.caller.startsWith("grounded/")) return true;
  if (meta.pass.startsWith("bar-")) return true;
  return false;
}

// ---- the gate --------------------------------------------------------------

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED" as const;
  readonly reason: string;
  readonly status: BudgetStatus;
  constructor(reason: string, status: BudgetStatus) {
    super(
      `BUDGET_EXCEEDED: ${reason}. ` +
        `hour=${status.hour.calls} calls/$${status.hour.usd.toFixed(2)} ` +
        `day=${status.day.calls} calls/$${status.day.usd.toFixed(2)}; ` +
        `tripped_at=${status.trippedAt ?? "now"}. No process was spawned.`,
    );
    this.name = "BudgetExceededError";
    this.reason = reason;
    this.status = status;
  }
}

function breach(ledger: Bucket[], now: number, c: BudgetCeilings, hourSince = 0): string | null {
  const hour = totals(ledger, now, HOUR_MS, hourSince);
  const day = totals(ledger, now, DAY_MS);
  // Calls: the Nth call is allowed, the (N+1)th is not.
  if (hour.calls + 1 > c.callsPerHour) return `${hour.calls} calls in the last hour (ceiling ${c.callsPerHour})`;
  if (day.calls + 1 > c.callsPerDay) return `${day.calls} calls in the last day (ceiling ${c.callsPerDay})`;
  // Spend: cost is known only after a call, so the check is "already at/over".
  if (hour.usd >= c.usdPerHour) return `$${hour.usd.toFixed(2)} spent in the last hour (ceiling $${c.usdPerHour})`;
  if (day.usd >= c.usdPerDay) return `$${day.usd.toFixed(2)} spent in the last day (ceiling $${c.usdPerDay})`;
  return null;
}

/**
 * The gate. Call right after assertTraceContext and BEFORE spawn.
 *
 *   kill switch on                -> throw, for EVERY caller (SPD-03)
 *   latched and not exempt        -> throw (no auto-resume)
 *   would breach a ceiling        -> latch; exempt proceeds, otherwise throw
 *   otherwise                     -> count the call and proceed
 *
 * `meta` defaults to the active trace scope; a scope-less call (enforcement
 * off in a transport test) is treated as background.
 */
export function admitCall(
  meta: BudgetCallMeta | null = currentTraceMeta(),
  now: number = Date.now(),
): void {
  const s = store();
  const pausedAt = s.get(MODEL_ACTIVITY_PAUSED_KEY);
  if (pausedAt !== null) throw new ModelActivityPausedError(pausedAt);

  const ceilings = budgetCeilings();
  const ledger = loadLedger(s, now);
  const exempt = isLatchExempt(meta);
  const resumed = resumedAtMs(s);

  const reason = breach(ledger, now, ceilings, resumed);
  if (reason) tripBudget(reason, now);

  const tripped = s.get(BUDGET_TRIPPED_KEY);
  if (tripped !== null && !exempt) {
    const why = reason ?? s.get(BUDGET_TRIPPED_REASON_KEY) ?? "budget latch set";
    throw new BudgetExceededError(why, {
      trippedAt: tripped,
      trippedReason: s.get(BUDGET_TRIPPED_REASON_KEY),
      modelActivityPausedAt: null,
      resumedAt: s.get(BUDGET_RESUMED_KEY),
      hour: totals(ledger, now, HOUR_MS, resumed),
      day: totals(ledger, now, DAY_MS),
      ceilings,
    });
  }

  bucketFor(ledger, now).calls += 1;
  saveLedger(s, ledger);
}

/** Add what one CLI invocation cost, once the result line reports it. */
export function recordCallCost(usd: number | undefined, now: number = Date.now()): void {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return;
  const s = store();
  const ledger = loadLedger(s, now);
  bucketFor(ledger, now).usd += usd;
  saveLedger(s, ledger);
}
