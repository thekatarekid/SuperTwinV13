// ===========================================================================
// Wake-ups (V6 P1 S5.2, Product_V6_Phase1 §14 "wake-ups are lookups before
// they are calls", GoldenEvals SCH-02 / SCH-03).
//
// ONE job owns every clock-driven duty of the task layer:
//
//   1. timers      scheduler/v6/timers.ts — due scheduled steps fire (the
//                  executor drains them later); a fire missed while the
//                  machine slept executes on wake with its delay shown.
//   2. checks      brain/closure-check.ts — due check_at checks: new evidence
//                  → Decide on the episodes; nothing → "done?" card by code.
//   3. past due    tasks/closure-rules.ts — past-due tasks with nothing new
//                  get the "done?" card by code; repeated silence → dormant.
//   4. next steps  brain/next-step.ts — the ONLY duty that may call the model,
//                  and only when a closure wrote a trigger row: no trigger, no
//                  call. The lookup (a COUNT) runs before the drain.
//
// 1–3 are pure lookups: `modelCalls` is 0 by construction (`clock_only_call`
// hard gate). Everything takes `now`; the production service pins nothing.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { JsonPassDeps } from "../brain/llm.js";
import { runClosureChecks, type ClosureCheckReport } from "../brain/closure-check.js";
import { drainNextStepQueue } from "../brain/next-step.js";
import { bootTimers, tickTimers, TIMER_TICK_INTERVAL_MS, type TimerSink, type TimerTickReport } from "../scheduler/v6/timers.js";
import { sweepPastDue, type PastDueReport } from "./closure-rules.js";

export interface WakeupLookups {
  timers: TimerTickReport;
  checks: ClosureCheckReport;
  pastDue: PastDueReport;
  /** Pending next-step triggers found by the lookup (the drain runs only when > 0). */
  nextStepsPending: number;
  /** Always 0 for the lookups; the next-step drain reports its own calls. */
  modelCalls: 0;
  /** Largest delay among fires that executed past their time (SCH-03 "delay shown"), ms. */
  maxDelayMs: number;
}

export interface WakeupReport extends Omit<WakeupLookups, "modelCalls"> {
  /** Next-step passes that ran (each is one model call when the provider is live). */
  nextStepsRun: number;
}

/** Human delay for logs and cards: "2h 05m late". */
export function formatDelay(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m late` : `${m}m late`;
}

function pendingNextSteps(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM deferred_outputs WHERE kind = 'next_step' AND status = 'deferred'`)
    .get() as { n: number };
  return row.n;
}

/**
 * The lookup half: timers, closure checks, past-due sweep, and a count of
 * pending next-step triggers. Zero model calls, by construction.
 */
export function runWakeupLookups(now: Date, sink?: TimerSink): WakeupLookups {
  const timers = tickTimers(now, sink);
  const checks = runClosureChecks(now);
  const pastDue = sweepPastDue(now);
  const maxDelayMs = Math.max(0, ...timers.fired.map((f) => f.delayMs ?? 0));
  return { timers, checks, pastDue, nextStepsPending: pendingNextSteps(), modelCalls: 0, maxDelayMs };
}

/**
 * One full wake-up: the lookups, then the next-step drain ONLY when a trigger
 * row exists. With none pending this function makes no model call.
 */
export async function runWakeups(now: Date, deps: JsonPassDeps = {}, sink?: TimerSink): Promise<WakeupReport> {
  const lookups = runWakeupLookups(now, sink);
  let nextStepsRun = 0;
  if (lookups.nextStepsPending > 0) {
    const drained = await drainNextStepQueue(deps);
    nextStepsRun = drained.length;
  }
  const { modelCalls: _zero, ...rest } = lookups;
  void _zero;
  return { ...rest, nextStepsRun };
}

export interface WakeupJobHandle {
  stop(): void;
  /** Run one wake-up now (returns its report). */
  runNow(): Promise<WakeupReport>;
}

export interface WakeupJobOptions {
  intervalMs?: number;
  now?: () => Date;
  deps?: JsonPassDeps;
  sink?: TimerSink;
  log?: (line: string) => void;
}

/**
 * Boot: replay the deferred pen + one immediate tick (bootTimers), then the
 * lookups; every interval after that, a full wake-up. A wall-clock gap much
 * larger than the interval is a sleep: the late/expired classification does
 * the work, and the gap plus the largest delay are logged (SCH-03).
 */
export function startWakeupJob(opts: WakeupJobOptions = {}): WakeupJobHandle {
  const intervalMs = opts.intervalMs ?? TIMER_TICK_INTERVAL_MS;
  const nowFn = opts.now ?? (() => new Date());
  const deps = opts.deps ?? {};
  const log = opts.log ?? ((line: string) => console.error(line));
  let lastTick = nowFn().getTime();
  let running = false;

  const describe = (r: WakeupLookups | WakeupReport, prefix: string): void => {
    const fired = r.timers.fired.length;
    const late = r.timers.fired.filter((f) => f.late).length;
    const asked = r.checks.asked + r.pastDue.asked;
    const escalated = r.checks.escalated + r.pastDue.escalated;
    if (fired + r.timers.skipped.length + asked + escalated + r.pastDue.dormant + ("nextStepsRun" in r ? r.nextStepsRun : 0) === 0) return;
    log(
      `[wakeups] ${prefix}: fired=${fired}${late > 0 ? ` (${late} late, max ${formatDelay(r.maxDelayMs)})` : ""} ` +
        `skipped=${r.timers.skipped.length} asked=${asked} escalated=${escalated} dormant=${r.pastDue.dormant}` +
        `${"nextStepsRun" in r ? ` next-steps=${r.nextStepsRun}` : ""} model-calls-from-lookups=0`,
    );
  };

  try {
    const now = nowFn();
    const boot = bootTimers(now, opts.sink);
    const checks = runClosureChecks(now);
    const pastDue = sweepPastDue(now);
    describe(
      { timers: boot, checks, pastDue, nextStepsPending: pendingNextSteps(), modelCalls: 0, maxDelayMs: Math.max(0, ...boot.fired.map((f) => f.delayMs ?? 0)) },
      "boot recovery",
    );
  } catch (err) {
    log(`[wakeups] boot failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = nowFn();
      const gap = now.getTime() - lastTick;
      if (gap > intervalMs * 4) log(`[wakeups] wake: ${Math.round(gap / 1000)}s since last tick — recovering missed fires`);
      lastTick = now.getTime();
      const report = await runWakeups(now, deps, opts.sink);
      describe(report, gap > intervalMs * 4 ? "wake" : "tick");
    } catch (err) {
      log(`[wakeups] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref?.();
  return {
    stop(): void {
      clearInterval(handle);
    },
    async runNow(): Promise<WakeupReport> {
      const now = nowFn();
      lastTick = now.getTime();
      return runWakeups(now, deps, opts.sink);
    },
  };
}
