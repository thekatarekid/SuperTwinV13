// ===========================================================================
// The prepared-action queue job — V6 P1 R2 (Build §7.1 S4.2; Product P1 §17).
//
// S4.2 built `runPreparedQueue()` and deliberately gave it NO caller: "the
// caller decides WHEN, so a queue drain can never surprise the user with
// spend." S4.3 was to wire it and did not, so every prepared action the live
// pass wrote sat in `deferred_outputs` forever — the live path named the work,
// executor-lite could do it, and nothing ever asked. This is the caller, on
// the same footing as the other periodic jobs (tiering, calendar, wake-ups,
// the brief): one guarded tick, boot delay, interval, stop().
//
// THREE RULES, because this is the one periodic job that spends per item:
//
//   A LOOKUP BEFORE A CALL. The tick reads the queue first. Empty queue →
//   return, zero calls, no log line. A quiet machine costs nothing (§P1 rule
//   14: no new event, no model call).
//
//   BOUNDED PER TICK. At most `limit` actions drain per tick (default 2), so
//   a backlog is worked off steadily instead of in one burst that trips a
//   ceiling. Each action carries executor-lite's own cycle and money ceilings
//   on top.
//
//   PAUSED MEANS PAUSED, AND THE QUEUE SURVIVES IT. `runPreparedAction`
//   marks its row 'activated' whatever the outcome — including a session that
//   errored — so draining while "Stop all model activity" is on, or after the
//   budget latch tripped, would BURN the queue: every action marked done, no
//   work performed, nothing to retry. The tick therefore checks both before
//   it drains and leaves the rows exactly where they are. This is not a second
//   gate on spend (the provider still throws before spawn); it is what keeps
//   the pause reversible.
//
// The job itself makes no model call. Everything it costs, executor-lite
// costs, on the actions the live pass already decided were worth doing.
// ===========================================================================

import { listPreparedActions } from "../brain/live.js";
import { isBudgetTripped, isModelActivityPaused } from "../providers/budget.js";
import { assertProviderAuthReady } from "../providers/gate.js";
import {
  resolveLiteModelCall,
  runPreparedQueue,
  type LiteRunDeps,
  type LiteRunResult,
} from "./lite.js";

/** Every two minutes: prepared work is not urgent, but it is not next week. */
export const PREPARED_QUEUE_INTERVAL_MS = 120_000;
/** After the dispatcher and the adapters have settled. */
export const PREPARED_QUEUE_BOOT_DELAY_MS = 40_000;
/** Actions drained per tick. A backlog is worked off, never dumped. */
export const PREPARED_QUEUE_LIMIT = 2;

export type PreparedQueueStatus = "idle" | "drained" | "held";

export interface PreparedQueueReport {
  status: PreparedQueueStatus;
  /** Rows waiting when the tick looked. */
  queued: number;
  /** Rows this tick actually ran. */
  drained: number;
  /** Why nothing ran, when `status` is "held". */
  reason: string | null;
  results: LiteRunResult[];
  modelCalls: number;
}

const EMPTY = (status: PreparedQueueStatus, queued: number, reason: string | null): PreparedQueueReport => ({
  status,
  queued,
  drained: 0,
  reason,
  results: [],
  modelCalls: 0,
});

function permanentProviderHold(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED" ||
      code === "PROVIDER_UNAVAILABLE" || code === "BACKEND_UNSUPPORTED" ||
      code === "BUDGET_EXCEEDED" || code === "MODEL_ACTIVITY_PAUSED"
    ? `${code}: active provider is not runnable — the queue is kept, not burned`
    : null;
}

/**
 * One tick: look, decide, maybe drain. Never throws for a queue reason — a
 * failing action is executor-lite's business and comes back on its result.
 */
export async function preparedQueueTick(
  opts: { limit?: number; deps?: LiteRunDeps } = {},
): Promise<PreparedQueueReport> {
  const limit = Math.max(1, opts.limit ?? PREPARED_QUEUE_LIMIT);
  const queued = listPreparedActions({ status: "deferred", limit: 500 }).length;
  if (queued === 0) return EMPTY("idle", 0, null);
  if (isModelActivityPaused()) return EMPTY("held", queued, "model activity is paused — the queue is kept, not burned");
  if (isBudgetTripped()) return EMPTY("held", queued, "budget latch is set — the queue is kept until an operator resets it");

  // Resolve once for this drain and pass the immutable snapshot through every
  // action. Auth is a lookup here, before any row is activated; the shared
  // provider gate repeats it immediately before transport.
  let resolvedCall;
  try {
    resolvedCall = resolveLiteModelCall(opts.deps);
    assertProviderAuthReady(resolvedCall.provider.authState());
  } catch (error) {
    const reason = permanentProviderHold(error);
    if (reason) return EMPTY("held", queued, reason);
    throw error;
  }

  let results: LiteRunResult[];
  try {
    results = await runPreparedQueue({ ...(opts.deps ?? {}), resolvedCall, limit });
  } catch (error) {
    const reason = permanentProviderHold(error);
    if (reason) return EMPTY("held", queued, reason);
    throw error;
  }
  return {
    status: "drained",
    queued,
    drained: results.length,
    reason: null,
    results,
    modelCalls: results.reduce((n, r) => n + r.modelCalls, 0),
  };
}

export interface PreparedQueueJob {
  stop(): void;
  /** One tick now (boot, tests, an operator). */
  runNow(): Promise<PreparedQueueReport>;
}

export function startPreparedQueueJob(
  opts: {
    intervalMs?: number;
    bootDelayMs?: number;
    limit?: number;
    log?: (line: string) => void;
    deps?: LiteRunDeps;
  } = {},
): PreparedQueueJob {
  const log = opts.log ?? ((line: string) => console.error(line));
  let running: Promise<PreparedQueueReport> | null = null;
  let stopped = false;
  /** Say "held" once per spell, not every two minutes forever. */
  let lastHeldReason: string | null = null;

  const runNow = (): Promise<PreparedQueueReport> => {
    if (running) return running;
    running = preparedQueueTick({
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
    })
      .then((report) => {
        if (report.status === "drained") {
          lastHeldReason = null;
          const by = report.results.reduce<Record<string, number>>((acc, r) => {
            acc[r.status] = (acc[r.status] ?? 0) + 1;
            return acc;
          }, {});
          log(
            `[prepared] drained ${report.drained}/${report.queued} ` +
              `(${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}) calls=${report.modelCalls}`,
          );
        } else if (report.status === "held" && report.reason !== lastHeldReason) {
          lastHeldReason = report.reason;
          log(`[prepared] ${report.queued} action(s) waiting — ${report.reason}`);
        }
        return report;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const guarded = (): void => {
    if (stopped) return;
    runNow().catch((err) =>
      log(`[prepared] tick failed (continuing): ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const boot = setTimeout(guarded, opts.bootDelayMs ?? PREPARED_QUEUE_BOOT_DELAY_MS);
  boot.unref?.();
  const timer = setInterval(guarded, opts.intervalMs ?? PREPARED_QUEUE_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(boot);
      clearInterval(timer);
    },
    runNow,
  };
}
