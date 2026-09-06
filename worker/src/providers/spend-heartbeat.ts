// ===========================================================================
// [CODE] Spend heartbeat — `[spend] 60s: …` in the operator log
// (build V6 P1 S0.8, backlog T0-13; GoldenEvals SPD-06).
//
// WHY. The 13.4.x incident ran for nine hours with nothing in worker.log that
// said how much the model was being called. The ledger in budget.ts knows,
// but a ledger you have to query is not a heartbeat. One line a minute,
// written from the only spawn site's completion path, means an operator
// tailing the log can read the burn rate without opening anything.
//
// SHAPE.  [spend] 60s: 27 calls, 1.9M tok, ~$2.20 | run 8h56m: 3,410 calls, 96.1M tok, ~$41.02
//         └ the last interval ──────────────────┘   └ since this worker booted ───────────────┘
//
// Every CLI invocation that returns a result line is counted once via
// noteSpend(usage) — the same place recordCallCost() runs. Tokens are the
// undivided total (input + cache create + cache read + output): the number
// you compare with the bill, not the one that flatters it.
//
// The timer is started once by worker main() (and stopped on shutdown); a
// test injects its own clock and log. noteSpend() never starts a timer, so a
// transport test that happens to complete a fake call leaves no interval
// behind.
//
// ---------------------------------------------------------------------------
// REFUSALS ARE NOT SILENCE (13.11.6 · C3)
//
// WHAT WAS BROKEN. On the user's own install the pipeline burned the $3 hourly
// ceiling in 41 minutes, latched `budget_tripped_at`, and from then on threw
// BUDGET_EXCEEDED at the gate BEFORE spawn — roughly once a minute, forever,
// because the latch never clears on its own. Every heartbeat after the trip
// read:
//
//     [spend] 60s: 0 calls, 0 tok, ~$0.00 | run 3h07m: 144 calls, 3.2M tok, ~$3.11
//
// Calls are counted when ADMITTED, so a refused call is admitted zero times.
// A pipeline being refused sixty times an hour and a pipeline that never
// started are the same line. That line is what sent the investigation looking
// for a dispatcher that had never run, when in fact the dispatcher was running
// and being turned away at the door.
//
// THE RULE. Count what was refused, next to what was admitted, with the code
// that refused it — and when an interval admitted nothing while refusing
// something, say BLOCKED, because that is the state:
//
//     [spend] 60s: 0 calls, 0 tok, ~$0.00 | run 3h07m: 144 calls, … | BLOCKED: 12 refused this interval (BUDGET_EXCEEDED ×12), 240 since boot
//
// The clause is absent when nothing was refused, so a genuinely idle minute
// still reads exactly as it always did.
// ===========================================================================

import type { Usage } from "./types.js";

export const SPEND_HEARTBEAT_MS = 60_000;

interface Counters {
  calls: number;
  tokens: number;
  usd: number;
}

const zero = (): Counters => ({ calls: 0, tokens: 0, usd: 0 });

const window: Counters = zero();
const total: Counters = zero();
/** Refusals at the gate, by code. Interval map is cleared on every tick. */
const windowRefusals = new Map<string, number>();
const totalRefusals = new Map<string, number>();
let bootedAt: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Every token the call touched, cached or not. */
export function usageTokens(u: Usage | undefined): number {
  if (!u) return 0;
  const n = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(u.inputTokens) + n(u.cacheCreationInputTokens) + n(u.cacheReadInputTokens) + n(u.outputTokens);
}

/** Count one completed CLI invocation. Called beside recordCallCost(). */
export function noteSpend(usage: Usage | undefined): void {
  const tokens = usageTokens(usage);
  const usd = typeof usage?.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : 0;
  window.calls += 1;
  window.tokens += tokens;
  window.usd += usd;
  total.calls += 1;
  total.tokens += tokens;
  total.usd += usd;
}

/**
 * The refusing code, as the log should name it. `BudgetExceededError` and
 * `ModelActivityPausedError` both carry a literal `code`; anything else falls
 * back to its class name so an unexpected pre-spawn throw is still countable
 * rather than silently absent.
 */
export function refusalCode(err: unknown): string {
  if (typeof err === "string" && err.trim() !== "") return err.trim();
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.trim() !== "") return code.trim();
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
  }
  return "REFUSED";
}

/**
 * Count one call the gate turned away BEFORE spawn. Called from the same spawn
 * site as noteSpend(), on the throwing path instead of the completing one, so
 * "nothing ran" and "nothing was allowed to run" stop being the same line.
 */
export function noteRefusal(err: unknown): void {
  const code = refusalCode(err);
  windowRefusals.set(code, (windowRefusals.get(code) ?? 0) + 1);
  totalRefusals.set(code, (totalRefusals.get(code) ?? 0) + 1);
}

function sumCounts(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/** `BUDGET_EXCEEDED ×12, MEDIA_UNAVAILABLE ×1` — commonest first, then a-z. */
function fmtCodes(m: Map<string, number>): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${code} ×${n}`)
    .join(", ");
}

/**
 * The refusal clause, or "" when the gate turned nobody away. BLOCKED is the
 * word for an interval that admitted nothing and refused something — the exact
 * state a bare "0 calls" made look like an idle pipeline.
 */
export function refusalClause(): string {
  const interval = sumCounts(windowRefusals);
  const run = sumCounts(totalRefusals);
  if (interval === 0 && run === 0) return "";
  if (interval === 0) return ` | 0 refused this interval, ${run.toLocaleString("en-US")} since boot`;
  const tag = window.calls === 0 ? "BLOCKED: " : "";
  return (
    ` | ${tag}${interval.toLocaleString("en-US")} refused this interval` +
    ` (${fmtCodes(windowRefusals)}), ${run.toLocaleString("en-US")} since boot`
  );
}

/** 1.9M / 41.2K / 812 — three significant figures at most, like the bill. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 8h56m, 0h03m — hours never roll into days; a nine-hour run reads as 9h. */
export function formatUptime(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function fmt(c: Counters): string {
  return `${c.calls.toLocaleString("en-US")} calls, ${formatTokens(c.tokens)} tok, ~$${c.usd.toFixed(2)}`;
}

/** The line as written. Exported so a test can pin the exact shape. */
export function spendHeartbeatLine(now: number, intervalMs: number = SPEND_HEARTBEAT_MS): string {
  const since = bootedAt ?? now;
  return (
    `[spend] ${Math.round(intervalMs / 1000)}s: ${fmt(window)}` +
    ` | run ${formatUptime(now - since)}: ${fmt(total)}${refusalClause()}`
  );
}

export interface SpendHeartbeatOptions {
  intervalMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export interface SpendHeartbeatHandle {
  /** Write one line now and reset the interval counters (what the timer does). */
  tick(): string;
  stop(): void;
}

/**
 * Start the once-a-minute line. Idempotent per process: a second start stops
 * the first timer. The interval is unref'd so it never keeps a dying worker
 * alive; main() also stops it explicitly on shutdown.
 */
export function startSpendHeartbeat(opts: SpendHeartbeatOptions = {}): SpendHeartbeatHandle {
  const intervalMs = opts.intervalMs ?? SPEND_HEARTBEAT_MS;
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now;
  stopSpendHeartbeat();
  bootedAt = now();
  const tick = (): string => {
    const line = spendHeartbeatLine(now(), intervalMs);
    log(line);
    Object.assign(window, zero());
    windowRefusals.clear();
    return line;
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { tick, stop: stopSpendHeartbeat };
}

export function stopSpendHeartbeat(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: forget every counter and the boot time. */
export function resetSpendHeartbeatForTests(): void {
  stopSpendHeartbeat();
  Object.assign(window, zero());
  Object.assign(total, zero());
  windowRefusals.clear();
  totalRefusals.clear();
  bootedAt = null;
}
