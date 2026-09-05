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

function totals(ledger: Bucket[], now: number, windowMs: number): WindowTotals {
  const floor = Math.floor((now - windowMs) / MINUTE_MS);
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

export interface BudgetStatus {
  trippedAt: string | null;
  trippedReason: string | null;
  /** ISO time the kill switch was thrown; null while model activity runs. */
  modelActivityPausedAt: string | null;
  hour: WindowTotals;
  day: WindowTotals;
  ceilings: BudgetCeilings;
}

/** Current windows, latch and kill switch, for /api/ops and the tests. */
export function budgetStatus(now: number = Date.now()): BudgetStatus {
  const s = store();
  const ledger = loadLedger(s, now);
  return {
    trippedAt: s.get(BUDGET_TRIPPED_KEY),
    trippedReason: s.get(BUDGET_TRIPPED_REASON_KEY),
    modelActivityPausedAt: s.get(MODEL_ACTIVITY_PAUSED_KEY),
    hour: totals(ledger, now, HOUR_MS),
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
export function resetBudgetLatch(): void {
  const s = store();
  s.delete(BUDGET_TRIPPED_KEY);
  s.delete(BUDGET_TRIPPED_REASON_KEY);
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

function breach(ledger: Bucket[], now: number, c: BudgetCeilings): string | null {
  const hour = totals(ledger, now, HOUR_MS);
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

  const reason = breach(ledger, now, ceilings);
  if (reason) tripBudget(reason, now);

  const tripped = s.get(BUDGET_TRIPPED_KEY);
  if (tripped !== null && !exempt) {
    const why = reason ?? s.get(BUDGET_TRIPPED_REASON_KEY) ?? "budget latch set";
    throw new BudgetExceededError(why, {
      trippedAt: tripped,
      trippedReason: s.get(BUDGET_TRIPPED_REASON_KEY),
      modelActivityPausedAt: null,
      hour: totals(ledger, now, HOUR_MS),
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
