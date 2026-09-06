// ===========================================================================
// [CODE] Stream tier assignment — arch §9.3, build item 1.2.
//
// Every stream gets a tier ONCE, by code, and that tier is the scheduler's
// primary sort key (../tiers/priority.ts owns the sort key itself).
//
//   T1  ENGAGED       is_group = false AND is_business = false
//                     OR is_group = true AND the user has >= 1 message
//   T3  PASSIVE       is_group = true AND the user has 0 messages
//   T2/T4             is_business = true -> split by content: [CODE]
//                     heuristics first (../tiers/classify.ts), and only the
//                     genuinely ambiguous channels go to P-TI1 — ONE haiku
//                     call PER CHANNEL, cached on the stream, never per
//                     message.
//
// Four rules from §9.3 are load-bearing here, and each one is a scar:
//
//   1. TIERING DELAYS, NEVER FILTERS. Nothing in this file drops, skips or
//      shortens work. A T4 channel's real bill is enqueued for exactly the
//      same stages as a T1 conversation's — at a lower priority, and that is
//      the entire difference.
//   2. TIER IS A PROPERTY OF THE STREAM, stored on `streams.tier`, never
//      re-derived per event.
//   3. PROMOTION MUST NEVER ORPHAN EVENTS. A first reply in a group moves it
//      T3 -> T1. In the prior system that transition permanently lost 10 real
//      messages in a 16-minute run, because the events sat below the
//      destination lane's watermark and no lane could reach them again. So a
//      tier change is a RE-SCAN, not a hand-off: every unprocessed event of
//      the stream is re-enqueued at the new priority, and no watermark is ever
//      moved backwards. `rescanOnTierChange` returns the orphan count and the
//      watermark direction so the caller can assert both.
//   4. TIERING MUST ACTUALLY RUN. The prior build shipped `tier NULL` on all
//      97 channels. `backfillTiers` is a boot-time pass over every stream and
//      it ends in a coverage assertion that throws.
//
// The model call is INJECTED (`resolveAmbiguous`), never made here: this file
// stays synchronous, offline and testable, and the P-TI1 wiring lives with the
// prompt in ../prompts/p-ti1.ts.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { classifyBusinessSample, tierForChannelClass } from "./classify.js";
import { isTier, type Tier } from "./priority.js";
import { rescanOnTierChange, type RescanReport } from "./rescan.js";

// ---- the P-TI1 seam --------------------------------------------------------
// The V11 P-TI1 prompt module was pruned in P0.3; its wire types live HERE now
// so the seam stays typed and injectable (`resolveAmbiguous`). The V13 P-TI1
// prompt (a later P1 lane) implements this contract; until then every
// ambiguous business channel falls to §12.11's "unsure -> tx" default.

export interface Ti1Channel {
  /** The real `streams.id`. Never sent to the model — an alias stands in. */
  streamId: string;
  name: string;
  /** Entity ids on the channel; `self` is printed first (§12.11). */
  participantIds?: readonly string[];
  /** The sampled messages, exactly as stored. */
  sample: readonly string[];
  /** How many messages the channel holds in total. */
  totalMessages?: number;
}

export interface Ti1Verdict {
  /** The alias the model wrote, verbatim. */
  alias: string;
  /** The stream it resolves to, or null when the alias is out of roster. */
  streamId: string | null;
  /** `tx` | `pm` — the STW-2 `channel_class` enum. */
  cls: "tx" | "pm";
  /** The stored long form: `transactional` | `promotional`. */
  label: string;
  confidence: number | null;
  reason: string;
  /** The model's own line, kept so nothing is paraphrased downstream. */
  raw: string;
}

/** §12.11 caps a P-TI1 call at 10 channels; the cap is applied here. */
export const TI1_MAX_CHANNELS_PER_CALL = 10;

export function chunkChannels(
  channels: readonly Ti1Channel[],
  size: number = TI1_MAX_CHANNELS_PER_CALL,
): Ti1Channel[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: Ti1Channel[][] = [];
  for (let i = 0; i < channels.length; i += limit) out.push(channels.slice(i, i + limit));
  return out;
}

// ---- facts -----------------------------------------------------------------

export interface StreamFacts {
  streamId: string;
  label: string | null;
  kind: string | null;
  isGroup: boolean;
  isBusiness: boolean;
  /** Messages the user themself sent into this stream. 0 or more. */
  userMessageCount: number;
}

export interface TierDecision {
  /** null means "code cannot decide" — the channel belongs to P-TI1. */
  tier: Tier | null;
  /** Stable rule id. Asserted on, so it never carries prose. */
  rule: string;
  /** `tier.v1` is the V6 P-07 business split (tiers/tiering.ts, S3.8). */
  source: "code" | "p-ti1" | "tier.v1";
  confidence: number | null;
  reason: string;
  needsModel: boolean;
  /**
   * Fingerprint of the sample this decision was made from. Only a P-TI1
   * verdict needs one: it is what makes "re-run only if the channel's
   * character changes" a comparison rather than a promise.
   */
  sampleHash?: string | null;
}

export interface TierChange {
  streamId: string;
  from: Tier | null;
  to: Tier;
  changed: boolean;
}

/** How many of a business channel's messages the heuristics judge. */
export const DEFAULT_SAMPLE_SIZE = 5;

// ---- the [CODE] rules ------------------------------------------------------

/**
 * §9.3's tier table, in the order the doc writes it. The group rules are
 * exhaustive for `is_group = true`, so a group with a business member is still
 * judged as a conversation — which is what it is.
 */
export function deriveTier(facts: StreamFacts, sample: readonly string[] = []): TierDecision {
  if (facts.isGroup) {
    if (facts.userMessageCount > 0) {
      return {
        tier: "T1",
        rule: "group_engaged",
        source: "code",
        confidence: null,
        reason: `group with ${facts.userMessageCount} message(s) from the user`,
        needsModel: false,
      };
    }
    return {
      tier: "T3",
      rule: "group_passive",
      source: "code",
      confidence: null,
      reason: "group the user has never replied in",
      needsModel: false,
    };
  }

  if (!facts.isBusiness) {
    return {
      tier: "T1",
      rule: "dm_person",
      source: "code",
      confidence: null,
      reason: "1:1 conversation with a person",
      needsModel: false,
    };
  }

  const classified = classifyBusinessSample(sample);
  if (classified.verdict === "ambiguous") {
    return {
      tier: null,
      rule: classified.rule,
      source: "code",
      confidence: null,
      reason: classified.reason,
      needsModel: true,
    };
  }
  return {
    tier: tierForChannelClass(classified.verdict),
    rule: classified.rule,
    source: "code",
    confidence: classified.confidence,
    reason: classified.reason,
    needsModel: false,
  };
}

/**
 * §12.11's "Unsure -> tx", applied when P-TI1 returned nothing for a channel it
 * was asked about. Under-prioritising a real bill is the more expensive
 * mistake, and a NULL tier is the mistake §9.3 rule 4 is about — so the
 * fallback is T2, never "leave it unassigned".
 */
export function unresolvedBusinessDecision(): TierDecision {
  return {
    tier: "T2",
    rule: "business_unresolved_default_tx",
    source: "code",
    confidence: null,
    reason: "P-TI1 returned no verdict for this channel; unsure defaults to transactional",
    needsModel: false,
  };
}

/** Turn a P-TI1 verdict into the decision that gets stored. */
export function decisionFromVerdict(verdict: Ti1Verdict): TierDecision {
  return {
    tier: tierForChannelClass(verdict.cls),
    rule: verdict.cls === "tx" ? "business_tx_model" : "business_pm_model",
    source: "p-ti1",
    confidence: verdict.confidence,
    // The model's words, verbatim. Code never rewrites them (§9.3 rule 1's
    // sibling: order model output, never censor it).
    reason: verdict.reason,
    needsModel: false,
  };
}

// ---- database --------------------------------------------------------------

interface StreamRow {
  id: string;
  label: string | null;
  stream_kind: string | null;
  is_business: number;
  tier: string | null;
}

const GROUP_KINDS = new Set(["group", "grp"]);

function factsFromRow(row: StreamRow, userMessageCount: number): StreamFacts {
  return {
    streamId: row.id,
    label: row.label,
    kind: row.stream_kind,
    isGroup: GROUP_KINDS.has((row.stream_kind ?? "").toLowerCase()),
    isBusiness: row.is_business === 1,
    userMessageCount,
  };
}

/**
 * Messages the user themself sent. `from_me` is resolved the way the rest of
 * the worker resolves it — the actor's source-side identity against the
 * source's own recorded self identity — so no source's spelling leaks in here.
 */
function countUserMessages(streamId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM events e
         LEFT JOIN actors a ON a.id = e.actor_id
        WHERE e.stream_id = ?
          AND e.kind IS NOT 'reaction'
          AND a.source_ext_id IS NOT NULL
          AND a.source_ext_id = (
            SELECT value FROM app_state
             WHERE key = 'source.' || e.source_id || '.self_identity'
          )`,
    )
    .get(streamId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function readStreamFacts(streamId: string): StreamFacts | null {
  const row = getDb()
    .prepare(`SELECT id, label, stream_kind, is_business, tier FROM streams WHERE id = ?`)
    .get(streamId) as StreamRow | undefined;
  if (!row) return null;
  return factsFromRow(row, countUserMessages(row.id));
}

export function listStreamFacts(): StreamFacts[] {
  const rows = getDb()
    .prepare(`SELECT id, label, stream_kind, is_business, tier FROM streams ORDER BY id`)
    .all() as StreamRow[];
  return rows.map((row) => factsFromRow(row, countUserMessages(row.id)));
}

/** The channel's own messages, newest first — what §12.11 calls the sample. */
export function readChannelSample(streamId: string, size: number = DEFAULT_SAMPLE_SIZE): string[] {
  const rows = getDb()
    .prepare(
      `SELECT e.text AS text
         FROM events e
         LEFT JOIN actors a ON a.id = e.actor_id
        WHERE e.stream_id = ?
          AND e.kind IS NOT 'reaction'
          AND e.text IS NOT NULL AND TRIM(e.text) <> ''
          AND NOT (
            a.source_ext_id IS NOT NULL
            AND a.source_ext_id = (
              SELECT value FROM app_state
               WHERE key = 'source.' || e.source_id || '.self_identity'
            )
          )
        ORDER BY e.ts DESC, e.id DESC
        LIMIT ?`,
    )
    .all(streamId, Math.max(1, size)) as { text: string }[];
  return rows.map((r) => r.text);
}

export function countChannelMessages(streamId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_id = ? AND kind IS NOT 'reaction'`)
    .get(streamId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function readTier(streamId: string): Tier | null {
  const row = getDb().prepare(`SELECT tier FROM streams WHERE id = ?`).get(streamId) as
    | { tier: string | null }
    | undefined;
  return row && isTier(row.tier) ? row.tier : null;
}

/** Write a decided tier onto the stream, with its provenance. */
export function assignTier(streamId: string, decision: TierDecision): TierChange {
  if (decision.tier === null) {
    throw new Error(`assignTier(${streamId}): the decision is undecided — resolve it before storing`);
  }
  const from = readTier(streamId);
  getDb()
    .prepare(
      `UPDATE streams
          SET tier = @tier,
              tier_rule = @rule,
              tier_source = @source,
              tier_confidence = @confidence,
              tier_reason = @reason,
              tier_sample_hash = @sampleHash,
              tier_assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @streamId`,
    )
    .run({
      streamId,
      tier: decision.tier,
      rule: decision.rule,
      source: decision.source,
      confidence: decision.confidence,
      reason: decision.reason,
      sampleHash: decision.sampleHash ?? null,
    });
  return { streamId, from, to: decision.tier, changed: from !== decision.tier };
}

// ---- re-derivation ---------------------------------------------------------

/**
 * Re-derive one stream's tier and, if it moved, re-scan it. This is the whole
 * T3 -> T1 promotion path: the user replies, the facts change, the tier
 * changes, and every unprocessed event is reachable again at the new priority.
 */
export function retierStream(
  streamId: string,
  options: { now?: number; sampleSize?: number } = {},
): { decision: TierDecision; change: TierChange; rescan: RescanReport | null } {
  const facts = readStreamFacts(streamId);
  if (!facts) throw new Error(`retierStream(${streamId}): no such stream`);
  const sample = facts.isBusiness ? readChannelSample(streamId, options.sampleSize) : [];
  const derived = deriveTier(facts, sample);
  // An undecided business channel keeps the tier it already has rather than
  // dropping to NULL; a re-derivation must never un-assign a stream.
  const decision = derived.tier === null ? (existingDecision(streamId) ?? unresolvedBusinessDecision()) : derived;
  const change = assignTier(streamId, decision);
  const rescan = change.changed
    ? rescanOnTierChange(streamId, { from: change.from, to: change.to, now: options.now })
    : null;
  return { decision, change, rescan };
}

/**
 * A cheap, stable fingerprint of the sample a verdict was formed from (FNV-1a).
 * Not a security hash — its only job is to answer "is this the same channel
 * character as last time", which is exactly what §9.3 says a re-run hangs on.
 */
export function sampleFingerprint(sample: readonly string[]): string {
  let h = 0x811c9dc5;
  const text = sample.join(" ");
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(16).padStart(8, "0")}`;
}

/**
 * The cached P-TI1 verdict for a channel whose sample has not changed, or
 * null — in which case the channel goes back to the model.
 */
export function cachedVerdictFor(streamId: string, hash: string): TierDecision | null {
  const row = getDb()
    .prepare(`SELECT tier_source, tier_sample_hash FROM streams WHERE id = ?`)
    .get(streamId) as { tier_source: string | null; tier_sample_hash: string | null } | undefined;
  if (!row || row.tier_source !== "p-ti1" || row.tier_sample_hash !== hash) return null;
  const decision = existingDecision(streamId);
  return decision ? { ...decision, sampleHash: hash } : null;
}

function existingDecision(streamId: string): TierDecision | null {
  const row = getDb()
    .prepare(`SELECT tier, tier_rule, tier_source, tier_confidence, tier_reason FROM streams WHERE id = ?`)
    .get(streamId) as
    | { tier: string | null; tier_rule: string | null; tier_source: string | null; tier_confidence: number | null; tier_reason: string | null }
    | undefined;
  if (!row || !isTier(row.tier)) return null;
  return {
    tier: row.tier,
    rule: row.tier_rule ?? "cached",
    source: row.tier_source === "p-ti1" ? "p-ti1" : "code",
    confidence: row.tier_confidence,
    reason: row.tier_reason ?? "cached verdict, unchanged",
    needsModel: false,
  };
}

// ---- the boot backfill (§9.3 rule 4) ---------------------------------------

export interface BackfillOptions {
  now?: number;
  sampleSize?: number;
  /**
   * The P-TI1 seam. Given the ambiguous channels, return the model's verdicts.
   * Omitted (or returning nothing for a channel) means "unsure", and §12.11's
   * unsure rule applies — never a NULL tier.
   */
  resolveAmbiguous?: (channels: Ti1Channel[]) => readonly Ti1Verdict[];
}

export interface BackfillReport {
  streams: number;
  assigned: number;
  byTier: Record<Tier, number>;
  /** Channels the code rules could not decide — the P-TI1 batch. */
  ambiguous: string[];
  /** Ambiguous channels answered from the cached verdict, with no call. */
  cached: string[];
  /** Ambiguous channels actually sent to the model. */
  modelChannels: number;
  /** P-TI1 calls it took to cover them — <= 10 channels each (§12.11). */
  modelCalls: number;
  /** Verdicts that came back and were applied. */
  modelVerdicts: number;
  /** Ambiguous channels the model did not answer for. §12.11: unsure -> tx. */
  defaulted: string[];
  changes: TierChange[];
  rescans: RescanReport[];
  coverage: number;
  unassigned: string[];
}

/**
 * Boot-time tier backfill over EVERY stream, ending in a coverage assertion.
 *
 * One P-TI1 batch, not one call per stream and never one per message: the
 * ambiguous channels are gathered first, resolved together (the resolver is
 * responsible for §12.11's <= 10 channels per call), and the verdicts applied.
 */
export function backfillTiers(options: BackfillOptions = {}): BackfillReport {
  const now = options.now ?? Date.now();
  const report: BackfillReport = {
    streams: 0,
    assigned: 0,
    byTier: { T1: 0, T2: 0, T3: 0, T4: 0 },
    ambiguous: [],
    cached: [],
    modelChannels: 0,
    modelCalls: 0,
    modelVerdicts: 0,
    defaulted: [],
    changes: [],
    rescans: [],
    coverage: 0,
    unassigned: [],
  };

  const undecided: { facts: StreamFacts; channel: Ti1Channel; hash: string }[] = [];

  for (const facts of listStreamFacts()) {
    report.streams += 1;
    const sample = facts.isBusiness ? readChannelSample(facts.streamId, options.sampleSize) : [];
    const decision = deriveTier(facts, sample);
    if (decision.tier === null) {
      report.ambiguous.push(facts.streamId);
      const hash = sampleFingerprint(sample);
      // §9.3: the verdict is CACHED on the stream and re-run only if the
      // channel's character changes. Same sample, same answer, no call.
      const cached = cachedVerdictFor(facts.streamId, hash);
      if (cached) {
        report.cached.push(facts.streamId);
        applyDecision(report, facts.streamId, cached, now);
        continue;
      }
      undecided.push({
        facts,
        hash,
        channel: {
          streamId: facts.streamId,
          name: facts.label ?? facts.streamId,
          sample,
          totalMessages: countChannelMessages(facts.streamId),
        },
      });
      continue;
    }
    applyDecision(report, facts.streamId, decision, now);
  }

  if (undecided.length > 0) {
    report.modelChannels = undecided.length;
    report.modelCalls = chunkChannels(undecided.map((u) => u.channel)).length;
    const verdicts = options.resolveAmbiguous?.(undecided.map((u) => u.channel)) ?? [];
    const byStream = new Map<string, Ti1Verdict>();
    for (const verdict of verdicts) {
      if (verdict.streamId) byStream.set(verdict.streamId, verdict);
    }
    for (const { facts, hash } of undecided) {
      const verdict = byStream.get(facts.streamId);
      if (verdict) {
        report.modelVerdicts += 1;
        applyDecision(report, facts.streamId, { ...decisionFromVerdict(verdict), sampleHash: hash }, now);
      } else {
        report.defaulted.push(facts.streamId);
        applyDecision(report, facts.streamId, unresolvedBusinessDecision(), now);
      }
    }
  }

  const coverage = tierCoverage();
  report.coverage = coverage.coverage;
  report.unassigned = coverage.unassigned;
  assertTierCoverage(coverage);
  return report;
}

function applyDecision(report: BackfillReport, streamId: string, decision: TierDecision, now: number): void {
  const change = assignTier(streamId, decision);
  report.assigned += 1;
  report.byTier[decision.tier as Tier] += 1;
  report.changes.push(change);
  if (change.changed) {
    report.rescans.push(rescanOnTierChange(streamId, { from: change.from, to: change.to, now }));
  }
}

export interface TierCoverage {
  streams: number;
  assigned: number;
  /** 1 when every stream has a tier. 1 for an empty install, vacuously. */
  coverage: number;
  unassigned: string[];
}

export function tierCoverage(): TierCoverage {
  const rows = getDb().prepare(`SELECT id, tier FROM streams ORDER BY id`).all() as {
    id: string;
    tier: string | null;
  }[];
  const unassigned = rows.filter((r) => !isTier(r.tier)).map((r) => r.id);
  const assigned = rows.length - unassigned.length;
  return {
    streams: rows.length,
    assigned,
    coverage: rows.length === 0 ? 1 : assigned / rows.length,
    unassigned,
  };
}

export class TierCoverageError extends Error {
  readonly unassigned: string[];
  constructor(coverage: TierCoverage) {
    super(
      `tier backfill left ${coverage.unassigned.length} of ${coverage.streams} streams without a tier: ` +
        `${coverage.unassigned.slice(0, 10).join(", ")}`,
    );
    this.name = "TierCoverageError";
    this.unassigned = coverage.unassigned;
  }
}

/**
 * §9.3 rule 4, as an assertion rather than a hope. Boot fails loudly here
 * instead of running with two permanently empty lanes.
 */
export function assertTierCoverage(coverage: TierCoverage = tierCoverage()): TierCoverage {
  if (coverage.unassigned.length > 0) throw new TierCoverageError(coverage);
  return coverage;
}
