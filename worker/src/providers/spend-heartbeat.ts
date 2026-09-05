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
  return `[spend] ${Math.round(intervalMs / 1000)}s: ${fmt(window)} | run ${formatUptime(now - since)}: ${fmt(total)}`;
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
  bootedAt = null;
}
