// ===========================================================================
// The lead-time job (V6 P1 S5.3): one tick shortly after boot, then hourly.
// Each tick is a LOOKUP — plan rows materialised, spaces opened at T minus
// lead time, finished plans closed. Zero model calls; a failure never stops
// the worker (same shape as tiers/tiering.ts startTieringJob).
// ===========================================================================

import { runLeadTimeTick, type PlanTickReport } from "./store.js";

export const CALENDAR_TICK_INTERVAL_MS = 60 * 60 * 1000;
export const CALENDAR_BOOT_DELAY_MS = 20 * 1000;

export interface CalendarJob {
  stop(): void;
  /** One tick now (boot, tests, an operator). */
  runNow(now?: Date): PlanTickReport;
}

export function startCalendarJob(
  opts: { intervalMs?: number; bootDelayMs?: number; log?: (line: string) => void; clock?: () => Date } = {},
): CalendarJob {
  const log = opts.log ?? ((line: string) => console.error(line));
  const clock = opts.clock ?? (() => new Date());
  let stopped = false;

  const runNow = (now: Date = clock()): PlanTickReport => {
    const report = runLeadTimeTick(now);
    if (report.planned > 0 || report.opened.length > 0 || report.finished > 0) {
      log(`[calendar] planned=${report.planned} opened=${report.opened.length} finished=${report.finished} wish=${report.wishOnly}`);
    }
    return report;
  };

  const guarded = (): void => {
    if (stopped) return;
    try {
      runNow();
    } catch (err) {
      log(`[calendar] tick failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const boot = setTimeout(guarded, opts.bootDelayMs ?? CALENDAR_BOOT_DELAY_MS);
  boot.unref?.();
  const timer = setInterval(guarded, opts.intervalMs ?? CALENDAR_TICK_INTERVAL_MS);
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
