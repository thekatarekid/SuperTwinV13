// ===========================================================================
// The brief job (V6 P1 S4.6): one tick a minute, so a set time is noticed
// within a minute of arriving. Same shape as tiers/tiering.ts and
// calendar/job.ts — a failing tick is logged and never stops the worker.
//
// A tick is a LOOKUP first: dueSlot() is arithmetic, and when a slot is due
// the delta is a handful of COUNTs. The lane spends a model call only on the
// set times where the world model actually moved, so the ~1 tick/minute here
// costs nothing on a quiet machine.
// ===========================================================================

import type { JsonPassDeps } from "../brain/llm.js";
import { briefTick, type BriefTickReport } from "./run.js";

export const BRIEF_TICK_INTERVAL_MS = 60_000;
export const BRIEF_BOOT_DELAY_MS = 25_000;

export interface BriefJob {
  stop(): void;
  /** One tick now (boot, tests, an operator). */
  runNow(now?: Date): Promise<BriefTickReport>;
}

export function startBriefJob(
  opts: {
    intervalMs?: number;
    bootDelayMs?: number;
    log?: (line: string) => void;
    clock?: () => Date;
    deps?: JsonPassDeps;
  } = {},
): BriefJob {
  const log = opts.log ?? ((line: string) => console.error(line));
  const clock = opts.clock ?? (() => new Date());
  let running: Promise<BriefTickReport> | null = null;
  let stopped = false;

  const runNow = (now: Date = clock()): Promise<BriefTickReport> => {
    if (running) return running;
    running = briefTick({ now, deps: opts.deps })
      .then((report) => {
        if (report.status === "composed") {
          log(
            `[brief] ${report.slot} composed — ${report.items} item(s), ` +
              `${report.delta.rows} changed row(s), calls=${report.modelCalls}` +
              `${report.violations.length > 0 ? ` violations=${report.violations.join(",")}` : ""}`,
          );
        } else if (report.due && report.reason !== "not_due") {
          log(`[brief] ${report.due.slot} skipped (${report.reason}) — no call, no card`);
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
      log(`[brief] tick failed (continuing): ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const boot = setTimeout(guarded, opts.bootDelayMs ?? BRIEF_BOOT_DELAY_MS);
  boot.unref?.();
  const timer = setInterval(guarded, opts.intervalMs ?? BRIEF_TICK_INTERVAL_MS);
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
