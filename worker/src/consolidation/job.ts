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
//                    ON ITS OWN TIMER, not a slot at the end of the minute
//                    tick — see EXTRACT STARVATION below.
//   every hour     - the rolling T2 over what changed since the last roll:
//                    merge questions / split suggestions / dormancy over
//                    touched spaces, second-look processing, unsorted review.
//                    Nothing written since the last roll → no model call, the
//                    roll is logged as a no-op (V6 S3.9, CON-01).
//   when idle      - the T3 deep pass over items touched since the last one
//                    (at most daily, machine idle and on power).
//
// Every duty is fenced: one failing tick logs and the next tick still runs.
//
// EXTRACT STARVATION (V6 P1 S6e Finish gate). The minute tick is serialised —
// `if (running) return` — so a duty placed after the Decide drain waits for
// every model call the Decide drain makes. Measured end to end on a seeded
// corpus: run 1 reached Extract at ~75 s and drained; run 2, same corpus, same
// ceiling, spent TWELVE MINUTES in one tick's Decide drain and the Extract
// duty never ran at all — 66 episodes queued, `extract runs in the ledger: 0`,
// claims 0. A clock inside a tick that returns early when the tick is busy is
// not its own clock. So the duty now has its own interval and its own re-entry
// guard, and `tick()` still calls it (both paths share `extractRunning`, so
// they can never overlap). The ceiling is untouched: at most one drain per
// EXTRACT_INTERVAL_MS, at most EXTRACT_CALLS_PER_TICK calls in it.
//
// The cadence clock also only advances on a drain that actually CLAIMED work.
// An idle or held look is a lookup, not a spend; advancing on it burned five
// minutes of the fresh-install window on an empty queue — which is exactly the
// window in which the first episodes land.
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
  /**
   * The Extract duty alone, on demand. Its own entry point because it is on
   * its own timer: a `tick()` already in flight must not be able to hold it.
   */
  extractTick(): Promise<void>;
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
  let extractRunning = false;

  /**
   * The Extract duty. Shared by the minute tick and its own timer; the one
   * `extractRunning` guard is what makes that safe. Free unless the cadence is
   * due AND the queue has something, and the clock only advances on a drain
   * that claimed work (see EXTRACT STARVATION at the top of this file).
   */
  const extractTick = async (): Promise<void> => {
    if (opts.extract === false) return;
    if (extractRunning) return;
    if (Date.now() - lastExtractAt < extractMs) return;
    extractRunning = true;
    try {
      const report = await extractDrainTick({ deps, log });
      if (report.status === "drained") lastExtractAt = Date.now();
      const line = extractDrainLogLine(report);
      if (line !== null) log(line);
    } catch (err) {
      log(`[consolidation] extract drain failed: ${(err as Error).message}`);
    } finally {
      extractRunning = false;
    }
  };

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

      // V6 P1 E1: the memory half of the reduce step, paced on its own clock
      // (default every 5 minutes), because this duty is the one that spends
      // per episode: two batched calls per drain is 24 an hour, ceiling
      // included. Empty queue → zero calls, no line. Called here AS WELL AS on
      // its own timer, so `job.tick()` remains one full cycle; the shared
      // `extractRunning` guard keeps the two entry points from overlapping.
      await extractTick();

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

  // The Extract duty's OWN heartbeat. It polls on the minute tick's cadence
  // (or faster, if the drain cadence itself is shorter) and spends only when
  // `lastExtractAt` says it is due — so a Decide drain that runs for twelve
  // minutes cannot hold the memory half of understanding behind it.
  const extractTimer = setInterval(() => {
    void extractTick();
  }, Math.max(1_000, Math.min(extractMs, intervalMs)));
  extractTimer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      clearInterval(extractTimer);
    },
    tick,
    extractTick,
  };
}
