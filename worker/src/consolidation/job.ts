// ===========================================================================
// The consolidation job (build P1.5) — the production caller for Lane B.
//
// Wired at boot (worker/src/index.ts), one interval, three duties:
//
//   every minute   - sweep newly-activated spaces (spec §9.2: activation =
//                    approved proposal or user-created; the sweep marker keeps
//                    this idempotent),
//                  - flag-triggered T2 ("runs within minutes of a
//                    flag_overlap" — spec §15.2),
//                  - drain the Decide work queue (spec §6.3.2: the REDUCE
//                    step's spaces run parallel-across / serial-per space).
//   every 5 min    - drain the EXTRACT work queue (V6 P1 E1): the memory half
//                    of the same reduce step — claims, people, tone, feelings.
//                    A lookup first (empty queue → zero calls, no line), then
//                    at most two batched calls, then code-only circles.
//   every hour     - the rolling T2 over what changed since the last roll:
//                    merge questions / split suggestions / dormancy over
//                    touched spaces, second-look processing, unsorted review.
//                    Nothing written since the last roll → no model call, the
//                    roll is logged as a no-op (V6 S3.9, CON-01).
//   when idle      - the T3 deep pass over items touched since the last one
//                    (at most daily, machine idle and on power).
//
// Every duty is fenced: one failing tick logs and the next tick still runs.
// ===========================================================================

import { drainDecideQueue } from "../brain/reduce.js";
import { EXTRACT_INTERVAL_MS, extractDrainLogLine, extractDrainTick } from "../brain/extract-drain.js";
import type { JsonPassDeps } from "../brain/llm.js";
import { sweepSpaceOnActivation, unsweptActiveSpaces } from "./sweep.js";
import { runT2 } from "./t2.js";
import { machineIdleAndOnPower, runT3, t3Due } from "./t3.js";
import { checkGraduation } from "./graduation.js";
import { reviewUnsortedWeekly, unsortedReviewDue } from "../spaces/unsorted.js";

export interface ConsolidationJobHandle {
  stop(): void;
  /** One full cycle on demand (tests, and the boot warm-up call). */
  tick(): Promise<void>;
}

export interface ConsolidationJobOptions {
  deps?: JsonPassDeps;
  log?: (line: string) => void;
  intervalMs?: number;
  hourlyMs?: number;
  /** T3's opportunity gate — injectable; default probes macOS idle + AC. */
  idleProbe?: () => Promise<boolean>;
  /** Disable the T3 duty entirely (tests that only exercise T1/T2). */
  t3?: boolean;
  /** How often the Extract drain may spend (V6 P1 E1). */
  extractMs?: number;
  /** Disable the Extract duty entirely (tests that only exercise T1/T2/T3). */
  extract?: boolean;
}

export function startConsolidationJob(opts: ConsolidationJobOptions = {}): ConsolidationJobHandle {
  const log = opts.log ?? (() => {});
  const deps = opts.deps ?? {};
  const intervalMs = opts.intervalMs ?? 60_000;
  const hourlyMs = opts.hourlyMs ?? 3_600_000;
  const extractMs = opts.extractMs ?? EXTRACT_INTERVAL_MS;
  let lastRollAt = 0;
  let lastExtractAt = 0;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // a slow LLM cycle must not stack a second one
    running = true;
    try {
      for (const spaceId of unsweptActiveSpaces()) {
        try {
          const report = await sweepSpaceOnActivation(spaceId, deps);
          if (report.swept && report.candidates > 0) {
            log(
              `[consolidation] sweep ${spaceId}: ${report.attached}/${report.candidates} attached` +
                (report.secondLook > 0 ? ` (${report.secondLook} second-look)` : ""),
            );
          }
        } catch (err) {
          log(`[consolidation] sweep ${spaceId} failed: ${(err as Error).message}`);
        }
      }

      try {
        const due = Date.now() - lastRollAt >= hourlyMs;
        const report = await runT2(deps, { flagsOnly: !due });
        if (due) lastRollAt = Date.now();
        if (due && report.rollSkipped) log("[consolidation] t2 roll: nothing changed since the last roll — no-op, no call");
        if (
          report.flagsProcessed + report.merged + report.mergeSuggestions +
            report.splitSuggestions + report.dormant + report.secondLookConfirmed +
            report.secondLookDetached + report.unsortedArchived >
          0
        ) {
          log(
            `[consolidation] t2${due ? " (roll)" : ""}: flags=${report.flagsProcessed} ` +
              `merged=${report.merged} suggestions=${report.mergeSuggestions + report.splitSuggestions} ` +
              `dormant=${report.dormant} second-look=${report.secondLookConfirmed}+${report.secondLookDetached} ` +
              `unsorted-archived=${report.unsortedArchived}`,
          );
        }
      } catch (err) {
        log(`[consolidation] t2 failed: ${(err as Error).message}`);
      }

      try {
        const decided = await drainDecideQueue(deps);
        if (decided.length > 0) {
          log(`[consolidation] decide: ${decided.length} space(s) reduced`);
        }
      } catch (err) {
        log(`[consolidation] decide drain failed: ${(err as Error).message}`);
      }

      // V6 P1 E1: the memory half of the reduce step. Paced on its own clock
      // (default every 5 minutes) rather than the minute tick, because this
      // duty is the one that spends per episode: two batched calls per drain
      // is 24 an hour, ceiling included. Empty queue → zero calls, no line.
      if (opts.extract !== false) {
        try {
          if (Date.now() - lastExtractAt >= extractMs) {
            lastExtractAt = Date.now();
            const report = await extractDrainTick({ deps, log });
            const line = extractDrainLogLine(report);
            if (line !== null) log(line);
          }
        } catch (err) {
          log(`[consolidation] extract drain failed: ${(err as Error).message}`);
        }
      }

      // S5.1: the weekly unsorted review — a lookup before it is a call. Due
      // every seven days; an unchanged unsorted skips outright with zero
      // calls (SPC-07). Births re-review unsorted on their own via the sweep.
      try {
        if (unsortedReviewDue()) {
          const r = await reviewUnsortedWeekly(deps);
          if (r.skipped) log("[consolidation] unsorted weekly review: nothing landed since the last review — no call");
          else
            log(
              `[consolidation] unsorted weekly review: ${r.changedRows} changed, ` +
                `${r.spacesReviewed} space(s) reviewed, ${r.attached} attached`,
            );
        }
      } catch (err) {
        log(`[consolidation] unsorted review failed: ${(err as Error).message}`);
      }

      // Graduation bookkeeping (S5.1): measure yesterday's gates, graduate
      // propose-only to auto-create after two clean weeks, reset on a false
      // merge. Code-only, must run whether or not the machine ever idles — so
      // it rides the minute tick, not T3.
      try {
        const g = checkGraduation();
        if (g.flipped === "graduated") log("[consolidation] graduation: two clean weeks — space creation is now auto");
        if (g.flipped === "reset") log("[consolidation] graduation: false auto-merge — back to propose-only, clock reset");
      } catch (err) {
        log(`[consolidation] graduation check failed: ${(err as Error).message}`);
      }

      // T3 deep pass: opportunistic — due at most daily, and only when the
      // machine is idle AND on power (spec §15.3).
      if (opts.t3 !== false) {
        try {
          const probe = opts.idleProbe ?? machineIdleAndOnPower;
          if (t3Due() && (await probe())) {
            const report = await runT3();
            log(
              `[consolidation] t3: links=${report.crossLinks} ` +
                `compressed=${report.claimVersionsCompressed} ` +
                `summaries=${report.summariesQueued} ` +
                `expired=${report.ephemeralArchived}`,
            );
          }
        } catch (err) {
          log(`[consolidation] t3 failed: ${(err as Error).message}`);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
    tick,
  };
}
