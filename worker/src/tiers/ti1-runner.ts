// ===========================================================================
// [LLM-S] The real P-TI1 transport — arch §12.11, build item 1.2.
//
// ../prompts/p-ti1.ts owns the prompt and the parser; ./derive.ts owns the
// decision and the write. Between them there was NOTHING: `backfillTiers`
// declares a `resolveAmbiguous` seam and every caller in the tree passed a
// frozen fixture into it. This file is the production side of that seam.
//
// Three properties it exists to hold, all of them about money:
//
//   OPT-IN     nothing here runs unless the caller asks for it. ../tiers/
//              ensure.ts defaults the model OFF and §12.11's "unsure -> tx"
//              covers every ambiguous channel for free.
//   BOUNDED    <= 10 channels per call (P_TI1.maxChannelsPerCall, applied by
//              `chunkChannels`) and a hard ceiling on the number of calls,
//              enforced by the caller and reported back.
//   SILENT ON  a transport failure returns NO verdicts, never a guess. The
//   FAILURE    channels then take the unsure default, which is the same place
//              they would have landed with the model switched off.
//
// The `resolveAmbiguous` seam is SYNCHRONOUS and `runPrompt` is not, so the
// call is PREFETCHED: the ambiguous channels are gathered, resolved here, and
// the verdicts handed to `backfillTiers` as an already-answered function. That
// is the same shape `prefetchJudge` uses for P-EP2 (../scheduler/episode-pass).
// ===========================================================================

import { getProcessEnabled, getSelectedModel } from "../db/settings.js";
import { legendFor } from "../prompts/legend.js";
import {
  P_TI1,
  P_TI1_SYSTEM,
  buildTi1Prompt,
  chunkChannels,
  parseTi1Response,
  type Ti1Channel,
  type Ti1Verdict,
} from "../prompts/p-ti1.js";
import { runPrompt, type RunnerDeps } from "../prompts/runner.js";

/** §12.11's answer shape — one `J.channel` line per channel. */
export const P_TI1_TAGS = ["J.channel"] as const;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function ti1Legend(): string {
  return legendFor({
    callType: P_TI1.id,
    tags: [...P_TI1_TAGS],
    aliases: ["stream", "entity"],
  });
}

/** What the tier backfill needs from the model, and nothing more. */
export type Ti1Invoke = (channels: readonly Ti1Channel[]) => Promise<readonly Ti1Verdict[]>;

/**
 * ONE P-TI1 call over up to `P_TI1.maxChannelsPerCall` channels, through the
 * shared prompt runner (item 1.9) — which owns the `runs` row, the lane slot,
 * the bounded repair round and quarantine.
 *
 * Verdicts whose alias did not resolve are DROPPED, not guessed (§5.8.6): an
 * unattributable verdict leaves its channel to the unsure default.
 */
export function ti1RunnerInvoke(
  opts: { cohortId?: string | null; deps?: RunnerDeps } = {},
): Ti1Invoke {
  return async (channels) => {
    if (channels.length === 0) return [];
    if (!getProcessEnabled("classify")) return [];
    const batch = channels.slice(0, P_TI1.maxChannelsPerCall);
    const prompt = buildTi1Prompt(batch);
    const result = await runPrompt(
      {
        callType: P_TI1.id,
        legend: ti1Legend(),
        instructions: P_TI1_SYSTEM,
        user: prompt.user,
        role: "classify",
        // The boot backfill belongs to no cohort, and `runs.cohort_id` is a FK
        // onto `cohorts`: a sentinel id ("-") fails the constraint and loses
        // the very row that was meant to account for the call. NULL is the
        // stated decision `recordRun` documents — see PromptCallSpec.cohortId.
        cohortId: opts.cohortId ?? null,
        model: getSelectedModel("classify"),
        // One unit per call is a lie the quarantine table would have to live
        // with, so the batch parks under its first channel — the same stream
        // the alias table mints `c1` for.
        unit: { kind: "stream", id: batch[0]!.streamId },
        // §9.5.1: P-TI1 is barred from the first-paint path, so it takes the
        // enrichment half of the pool and never competes with understanding.
        lane: "enrichment",
        timeoutMs: P_TI1.timeoutSeconds * 1000,
      },
      opts.deps ?? {},
    );
    if (result.status === "failed" || result.status === "quarantined") return [];
    if (result.responses.length === 0) return [];
    return parseTi1Response(result.responses.join("\n"), prompt.table).verdicts;
  };
}

export interface Ti1BatchReport {
  /** Channels handed in. */
  channels: number;
  /** Calls actually made — never more than `maxCalls`. */
  calls: number;
  /** Channels a call was never bought for, because the budget ran out. */
  skipped: number;
  verdicts: Ti1Verdict[];
}

/**
 * Resolve a whole ambiguous set, ten channels at a time, under a hard call
 * ceiling. The channels the ceiling cuts off are simply not asked about — they
 * take §12.11's unsure default in `backfillTiers` and are re-offered on the
 * next pass, so a budget stop loses accuracy, never coverage.
 */
export async function resolveTi1Batches(
  channels: readonly Ti1Channel[],
  invoke: Ti1Invoke,
  maxCalls: number,
): Promise<Ti1BatchReport> {
  const report: Ti1BatchReport = { channels: channels.length, calls: 0, skipped: 0, verdicts: [] };
  const batches = chunkChannels(channels);
  for (const batch of batches) {
    if (report.calls >= maxCalls) {
      report.skipped += batch.length;
      continue;
    }
    report.calls += 1;
    report.verdicts.push(...(await invoke(batch)));
  }
  return report;
}
