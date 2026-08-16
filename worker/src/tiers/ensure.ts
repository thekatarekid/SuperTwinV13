// ===========================================================================
// [CODE] `ensureTiers` — the callable form of §9.3 rule 4. Build item 1.2.
//
// `backfillTiers` (./derive.ts) has been correct and UNCALLED since it was
// written: the worker shipped `tier NULL` on all 93 streams a second build
// running, which is the exact regression the rule-4 comment in derive.ts warns
// about. This file is the caller, and it exists because a boot-time call is not
// enough on its own:
//
//   * on a COLD INSTALL boot precedes stream creation, so the boot pass sees
//     zero streams and passes vacuously (coverage = 1 over an empty table);
//   * the streams then arrive over a minute or more of backfill;
//   * so the ingest side must be able to call the SAME function again when the
//     backfill completes, and any later pass must be free when there is
//     nothing to do.
//
// Hence: idempotent, resumable, cheap when there is no gap, and it NEVER
// throws. `backfillTiers` ends in an assertion that throws on anything short of
// 100% coverage — which is right for the assertion and wrong for a boot path,
// so the throw is caught here and turned into a loud log plus `ok: false`. A
// worker that cannot tier its streams still has to serve.
//
// COST. The default is ZERO model calls: the [CODE] heuristics decide the vast
// majority of channels, and §12.11's "unsure -> tx" covers the rest for free.
// P-TI1 (haiku, <= 10 channels a call) is opt-in per call, per env var or per
// app_state key, and is bounded by a hard call ceiling even when it is on.
// ===========================================================================

import { appStateGet } from "../db/ingest.js";
import {
  backfillTiers,
  countChannelMessages,
  cachedVerdictFor,
  deriveTier,
  listStreamFacts,
  readChannelSample,
  sampleFingerprint,
  tierCoverage,
  type BackfillReport,
  type TierCoverage,
} from "./derive.js";
import { resolveTi1Batches, ti1RunnerInvoke, type Ti1Invoke } from "./ti1-runner.js";
import type { Ti1Channel, Ti1Verdict } from "../prompts/p-ti1.js";

/** Opt in to P-TI1 for ambiguous business channels. Unset means OFF. */
export const TIER_MODEL_ENV = "SUPERTWIN_TIER_MODEL";
/** The same switch, persisted, so the user can opt in without a rebuild. */
export const TIER_MODEL_KEY = "tiers.resolve_with_model";
/** …and the ceiling, likewise. */
export const TIER_MODEL_CALLS_KEY = "tiers.max_model_calls";

/**
 * At most 40 channels' worth of haiku in one pass. A pass that hits the ceiling
 * still reaches 100% coverage — the unasked channels take the unsure default —
 * and the next pass picks them up, so this bounds spend without losing work.
 */
export const DEFAULT_MAX_MODEL_CALLS = 4;

export interface EnsureTiersOptions {
  now?: number;
  sampleSize?: number;
  /** Names the caller in the log line: "boot", "backfill_complete", … */
  reason?: string;
  /** Ask P-TI1 about ambiguous channels. Default: the env var / app_state key. */
  resolveWithModel?: boolean;
  /** Hard ceiling on P-TI1 calls in THIS pass. Default: 4 (40 channels). */
  maxModelCalls?: number;
  /** The transport. Tests inject; production gets `ti1RunnerInvoke()`. */
  invoke?: Ti1Invoke;
}

export interface EnsureTiersResult {
  /** False when the coverage assertion failed — logged loudly, never thrown. */
  ok: boolean;
  streams: number;
  assigned: number;
  coverage: number;
  unassigned: string[];
  /** Channels the [CODE] rules could not decide. */
  ambiguous: number;
  /** …of those, answered from the cached verdict, with no call. */
  cached: number;
  /** P-TI1 calls actually made. 0 unless the model was opted in. */
  modelCalls: number;
  modelVerdicts: number;
  /** Ambiguous channels that took §12.11's unsure default instead. */
  defaulted: number;
  report: BackfillReport | null;
  error: Error | null;
}

function envFlag(name: string): boolean | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return raw === "1" || raw.toLowerCase() === "true";
}

function stateFlag(key: string): boolean | null {
  const raw = appStateGet(key);
  if (raw === null || raw.trim() === "") return null;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Explicit option -> app_state -> env -> OFF. Nothing implicitly buys a call. */
export function tierModelEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return stateFlag(TIER_MODEL_KEY) ?? envFlag(TIER_MODEL_ENV) ?? false;
}

function maxModelCalls(explicit?: number): number {
  if (explicit !== undefined) return Math.max(0, Math.floor(explicit));
  const raw = appStateGet(TIER_MODEL_CALLS_KEY);
  // `Number(null)` is 0, and a 0 ceiling read from an ABSENT key would silently
  // switch the model off while reporting that it was on.
  if (raw !== null && raw.trim() !== "") {
    const stored = Number(raw);
    if (Number.isFinite(stored) && stored >= 0) return Math.floor(stored);
  }
  return DEFAULT_MAX_MODEL_CALLS;
}

/**
 * The channels a P-TI1 pass would be for: business channels the [CODE] rules
 * cannot decide AND whose cached verdict does not cover the current sample.
 * Pure — it reads, it never writes, and it never calls anything. This is what
 * makes "how much would this cost" answerable before anything is spent.
 */
export function ambiguousChannels(sampleSize?: number): Ti1Channel[] {
  const out: Ti1Channel[] = [];
  for (const facts of listStreamFacts()) {
    const sample = facts.isBusiness ? readChannelSample(facts.streamId, sampleSize) : [];
    if (deriveTier(facts, sample).tier !== null) continue;
    // §9.3: same sample, same answer, no call.
    if (cachedVerdictFor(facts.streamId, sampleFingerprint(sample))) continue;
    out.push({
      streamId: facts.streamId,
      name: facts.label ?? facts.streamId,
      sample,
      totalMessages: countChannelMessages(facts.streamId),
    });
  }
  return out;
}

/**
 * Every stream carries a tier when this resolves, or the reason it does not is
 * on stderr. Safe to call as often as anything likes: with no gap to close it
 * costs one `SELECT id, tier FROM streams` per stream plus the sample reads,
 * and buys nothing from the model.
 *
 * Callers today: the boot path (../index.ts) and — because boot precedes stream
 * creation on a cold install — ingest, at the `backfill_complete` edge.
 */
export async function ensureTiers(options: EnsureTiersOptions = {}): Promise<EnsureTiersResult> {
  // ---- Serialize. There are THREE production callers now — the boot path, the
  // ingest post-import seal and the bootstrap driver's tick — and on a fresh
  // install their windows overlap. `backfillTiers` itself is synchronous (so
  // the writes cannot interleave), but the optional P-TI1 prefetch is not: two
  // concurrent passes would each compute the same `ambiguousChannels()` and
  // each pay up to `maxModelCalls` for the same channels.
  //
  // Chaining rather than de-duplicating keeps every caller's contract — each
  // still gets a real pass over the CURRENT db — while making the second pass
  // cheap, because the first one's verdicts are cached by the time it reads.
  const mine = inFlight
    .catch(() => undefined)
    .then(() => ensureTiersOnce(options));
  inFlight = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
}

/** Serialization tail for {@link ensureTiers}. Never rejects. */
let inFlight: Promise<void> = Promise.resolve();

async function ensureTiersOnce(options: EnsureTiersOptions = {}): Promise<EnsureTiersResult> {
  const reason = options.reason ?? "manual";
  const now = options.now ?? Date.now();
  const result: EnsureTiersResult = {
    ok: false,
    streams: 0,
    assigned: 0,
    coverage: 0,
    unassigned: [],
    ambiguous: 0,
    cached: 0,
    modelCalls: 0,
    modelVerdicts: 0,
    defaulted: 0,
    report: null,
    error: null,
  };

  try {
    // ---- Phase 1 (optional, opt-in, bounded): buy the verdicts BEFORE the
    // backfill runs. `resolveAmbiguous` is synchronous by design — derive.ts
    // stays offline and testable — so the async call is prefetched and handed
    // in already answered, the way P-EP2's judge is.
    let verdicts: readonly Ti1Verdict[] = [];
    if (tierModelEnabled(options.resolveWithModel)) {
      const channels = ambiguousChannels(options.sampleSize);
      if (channels.length > 0) {
        const invoke = options.invoke ?? ti1RunnerInvoke();
        try {
          const batches = await resolveTi1Batches(channels, invoke, maxModelCalls(options.maxModelCalls));
          verdicts = batches.verdicts;
          result.modelCalls = batches.calls;
          if (batches.skipped > 0) {
            console.error(
              `[tiers] P-TI1 budget reached (${batches.calls} call(s)): ` +
                `${batches.skipped} ambiguous channel(s) take the unsure default this pass`,
            );
          }
        } catch (err) {
          // A missing CLI, a refusal, a timeout: the accuracy of the T2/T4
          // split is lost, the COVERAGE is not. Those channels take the unsure
          // default below and are re-offered on the next pass. A model outage
          // must never be the reason a stream has no tier.
          console.error(
            `[tiers] P-TI1 unavailable — ${channels.length} ambiguous channel(s) ` +
              "default to tx (§12.11) this pass:",
            err,
          );
        }
      }
    }

    const report = backfillTiers({
      now,
      ...(options.sampleSize === undefined ? {} : { sampleSize: options.sampleSize }),
      // Already answered: the seam is a lookup here, not a call.
      ...(verdicts.length === 0 ? {} : { resolveAmbiguous: () => verdicts }),
    });

    result.ok = true;
    result.report = report;
    result.streams = report.streams;
    result.assigned = report.assigned;
    result.coverage = report.coverage;
    result.unassigned = report.unassigned;
    result.ambiguous = report.ambiguous.length;
    result.cached = report.cached.length;
    result.modelVerdicts = report.modelVerdicts;
    result.defaulted = report.defaulted.length;

    console.error(
      `[tiers] backfill (${reason}): ${report.assigned}/${report.streams} streams tiered ` +
        `(coverage ${(report.coverage * 100).toFixed(1)}%) — ` +
        `T1 ${report.byTier.T1} T2 ${report.byTier.T2} T3 ${report.byTier.T3} T4 ${report.byTier.T4}; ` +
        `${report.ambiguous.length} ambiguous (${report.cached.length} cached, ` +
        `${result.modelCalls} P-TI1 call(s), ${report.modelVerdicts} verdict(s), ` +
        `${report.defaulted.length} defaulted to tx)`,
    );
    return result;
  } catch (err) {
    // §9.3 rule 4's assertion is right to throw and wrong to kill the boot: two
    // permanently empty lanes are a loud defect, not a reason to stop serving.
    const coverage: TierCoverage = tierCoverage();
    result.error = err instanceof Error ? err : new Error(String(err));
    result.streams = coverage.streams;
    result.assigned = coverage.assigned;
    result.coverage = coverage.coverage;
    result.unassigned = coverage.unassigned;
    console.error(
      `[tiers] BACKFILL FAILED (${reason}): ${coverage.assigned}/${coverage.streams} streams tiered ` +
        `(coverage ${(coverage.coverage * 100).toFixed(1)}%) — ` +
        `${coverage.unassigned.length} stream(s) have NO TIER and no lane will reach them: ` +
        `${coverage.unassigned.slice(0, 10).join(", ")}`,
    );
    console.error("[tiers] cause:", result.error);
    return result;
  }
}
