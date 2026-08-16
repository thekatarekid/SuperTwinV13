// ===========================================================================
// [CODE] The arc binding ladder — arch §11.2, build item 2.5.
//
//   ① BRIDGES                                            [CODE]  precision ~1.0
//   ② ENTITY OVERLAP  weighted Jaccard ≥ 0.5             [CODE]
//   ③ TOPIC SIMILARITY  calibrated, bar HIGHER than episode attach   [ML]
//   ④ ADJUDICATION  P-AG2 → join | new | unsure→ASK USER            [LLM-M]
//
//   ambient episodes join ONLY via ① or ②
//   new arcs stay PROVISIONAL until reconcile
//
// FIVE RULES, ALL FROM §11.2, AND WHY EACH ONE IS HERE
//
//   1. THE ORDER IS THE PRECISION ORDER. A bridge is a shared literal, so it is
//      checked first and never overruled by a score. Rungs are tried top down
//      and the first one that fires ends the ladder — evals L-001..L-008 assert
//      exactly that ("bridges run first").
//
//   2. RUNG ③ NOMINATES; IT NEVER JOINS. This is the one place the arc ladder
//      is deliberately stricter than the episode gate it mirrors. An episode
//      attach that goes wrong loses one afternoon inside one stream; an arc
//      join that goes wrong welds two unrelated months of a life together
//      across sources. So a calibrated `arc_topic` score — on bars already
//      strictly above `episode_topic` (§10.3) — decides only whether the
//      question is worth a model call, and rung ④ decides the answer. Evals
//      L-018..L-023 pose scores from 0.68 to 0.88 and expect P-AG2 on every
//      one of them: "adjudication only at ladder step 4".
//
//   3. AMBIENT JOINS VIA ① OR ② ONLY. A screen frame or an ambient audio
//      window is topically similar to everything the day contained. Rungs ③
//      and ④ are closed to it whatever the score says (evals L-024..L-027,
//      gate `arcs_no_similarity_only_ambient`).
//
//   4. NO ADJUDICATOR IS NOT A FAILURE — IT IS `defer`. P-AG2 is off the
//      first-paint path (§9.5.1). With no adjudicator injected the episode is
//      parked in a PROVISIONAL arc, zero model calls are spent, first paint
//      proceeds, and reconcile picks the question up later.
//
//   5. `un` GOES TO THE USER. Never a silent new arc, never a retry.
//
// This file builds no prompt and calls no model. Rung ④ is an injected seam,
// exactly like the episode engine's judge, so every rule above is testable
// offline and a frozen answer can be replayed through the real ladder.
// ===========================================================================

import {
  scoreCalibratedPair,
  type PairDecision,
  type ScorePairOptions,
} from "../retrieval/calibration.js";
import {
  parseAg2Response,
  type Ag2Candidate,
  type Ag2Verdict,
  AG2_MAX_CANDIDATES,
} from "../prompts/p-ag2.js";
import type { AliasTable } from "../wire/aliases.js";
import type { WireViolation } from "../wire/tolerance.js";
import { bridgePartnersOf } from "../bridges/extract.js";
import {
  overlapJoins,
  weightedOverlap,
  type AnchorRef,
  type OverlapMeasure,
} from "./key.js";

/** The [ML] rung's use case. Its bars sit strictly above `episode_topic`. */
export const ARC_USE_CASE = "arc_topic" as const;

/** §12.6 — a `jn` under this bar is not a join. A wrong merge destroys. */
export const ARC_JOIN_CONFIDENCE_FLOOR = 0.6;

// ---- the inputs ------------------------------------------------------------

/** The episode being placed on the ladder. */
export interface LadderEpisode {
  id: string;
  label: string | null;
  /** `whatsapp`, `browser`, `calendar` — what makes a join CROSS-source. */
  sourceId: string | null;
  /**
   * True when this episode came from an ambient stream (§2.1). Rungs ③ and ④
   * are closed to it. The caller reads it off the stream manifest; the ladder
   * never guesses it, because guessing it wrong opens the rung §11.2 shuts.
   */
  ambient?: boolean;
  anchors: readonly AnchorRef[];
  /**
   * Every id of this episode that a bridge could have been written against —
   * the episode id, its session ids, its event ids. Rung ① is a set
   * intersection over these, not a text comparison.
   */
  bridgeIds?: readonly string[];
  span?: string | null;
  summary?: string | null;
}

/** One existing (COMMITTED) arc the episode might belong to. */
export interface LadderCandidate {
  arcId: string;
  label: string | null;
  sourceIds?: readonly string[];
  anchors: readonly AnchorRef[];
  /** Bridgeable ids of this arc's member episodes. */
  bridgeIds?: readonly string[];
  /**
   * RAW cosine against this arc's topic vector, or null when the [ML] layer did
   * not measure one. Null is "not measured" and never scores as "far".
   */
  cosine?: number | null;
}

// ---- rung ① ----------------------------------------------------------------

export interface BridgeHit {
  arcId: string;
  kind: string;
  valueNorm: string;
  leftId: string;
  rightId: string;
  confidence: number;
}

/**
 * The bridge reader. Injected so the ladder is testable without a database and
 * so the eval harness can pose a bridge without writing one.
 */
export type BridgeReader = (episodeIds: readonly string[]) => readonly {
  kind: string;
  value_norm: string;
  left_id: string;
  right_id: string;
  confidence: number;
}[];

/** The default: the mirrored `bridges` rows item 2.4 writes. */
export const dbBridgeReader: BridgeReader = (ids) => ids.flatMap((id) => bridgePartnersOf(id));

/**
 * Rung ①. Every bridge leaving the episode, kept when its far end is a member
 * of a candidate arc. Strongest bridge wins; ties break on arc id so two runs
 * over the same evidence never disagree.
 */
export function bridgeRung(
  episode: LadderEpisode,
  candidates: readonly LadderCandidate[],
  read: BridgeReader,
): BridgeHit | null {
  const from = [...new Set([episode.id, ...(episode.bridgeIds ?? [])])].filter((id) => id !== "");
  if (from.length === 0 || candidates.length === 0) return null;

  const owner = new Map<string, string>();
  for (const candidate of candidates) {
    for (const id of [...(candidate.bridgeIds ?? [])]) {
      if (id !== "" && !owner.has(id)) owner.set(id, candidate.arcId);
    }
  }
  if (owner.size === 0) return null;

  const mine = new Set(from);
  const hits: BridgeHit[] = [];
  for (const row of read(from)) {
    // A mirrored row points both ways; the far end is whichever side is not us.
    const far = mine.has(row.left_id) ? row.right_id : row.left_id;
    const arcId = owner.get(far);
    if (arcId === undefined) continue;
    hits.push({
      arcId,
      kind: row.kind,
      valueNorm: row.value_norm,
      leftId: row.left_id,
      rightId: row.right_id,
      confidence: Number.isFinite(row.confidence) ? row.confidence : 0,
    });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.confidence - a.confidence || (a.arcId < b.arcId ? -1 : a.arcId > b.arcId ? 1 : 0));
  return hits[0] ?? null;
}

// ---- rung ② ----------------------------------------------------------------

export interface OverlapScore extends OverlapMeasure {
  arcId: string;
  joins: boolean;
}

/** Rung ②, over every candidate. Best first, ties on arc id. */
export function overlapRung(
  episode: LadderEpisode,
  candidates: readonly LadderCandidate[],
): OverlapScore[] {
  return candidates
    .map((candidate) => {
      const measure = weightedOverlap(episode.anchors, candidate.anchors);
      return { arcId: candidate.arcId, ...measure, joins: overlapJoins(measure) };
    })
    .sort((a, b) => b.score - a.score || (a.arcId < b.arcId ? -1 : a.arcId > b.arcId ? 1 : 0));
}

// ---- rung ③ ----------------------------------------------------------------

export interface SimilarityScore {
  arcId: string;
  decision: PairDecision;
  /** True when this candidate is worth a P-AG2 call. */
  nominated: boolean;
}

/**
 * Rung ③. Calibrated, on the `arc_topic` scale, and it NOMINATES rather than
 * joins (rule 2 above). A candidate whose cosine was never measured is not
 * scored at all — absence of a vector is not evidence of a different matter —
 * and an uncalibrated model nominates nobody, because a number nobody measured
 * is not a reason to spend a model call.
 */
export function similarityRung(
  candidates: readonly LadderCandidate[],
  opts: ScorePairOptions = {},
): SimilarityScore[] {
  const out: SimilarityScore[] = [];
  for (const candidate of candidates) {
    const cos = candidate.cosine;
    if (typeof cos !== "number" || !Number.isFinite(cos)) continue;
    const decision = scoreCalibratedPair(ARC_USE_CASE, cos, opts);
    out.push({
      arcId: candidate.arcId,
      decision,
      nominated: decision.verdict === "same" || decision.verdict === "unsure",
    });
  }
  return out.sort(
    (a, b) => (b.decision.score ?? -1) - (a.decision.score ?? -1) ||
      (a.arcId < b.arcId ? -1 : a.arcId > b.arcId ? 1 : 0),
  );
}

// ---- rung ④ — the injected seam --------------------------------------------

export interface AdjudicationRequest {
  episode: LadderEpisode;
  /** The nominated arcs, already shaped for §12.6's USER block. */
  candidates: Ag2Candidate[];
}

export interface AdjudicationAnswer {
  /** The model's answer, verbatim. */
  response: string;
  /** The alias table the prompt was built with — how `e1`/`n2` become ids. */
  table: AliasTable;
  model?: string;
  /** Calls actually spent. Defaults to 1. */
  calls?: number;
}

/** P-AG2's caller implements this. The ladder never builds a prompt. */
export type ArcAdjudicator = (req: AdjudicationRequest) => AdjudicationAnswer | null;

// ---- the result ------------------------------------------------------------

export type LadderRung = "bridge" | "overlap" | "similarity" | "adjudication";

export type LadderDecision =
  /** Bound to `arcId`. */
  | "join"
  /** No arc fits: a PROVISIONAL arc, minted by reconcile. */
  | "new"
  /** P-AG2 said `un`: the user decides, and nothing is bound meanwhile. */
  | "ask_user"
  /** Rung ④ was warranted but unavailable. Provisional, zero model calls. */
  | "defer";

export interface LadderResult {
  episodeId: string;
  decision: LadderDecision;
  /** The rung that produced the decision, or null when nothing was offered. */
  rung: LadderRung | null;
  arcId: string | null;
  confidence: number;
  modelCalls: number;
  ambient: boolean;
  bridge: BridgeHit | null;
  overlaps: OverlapScore[];
  similarities: SimilarityScore[];
  /** Arc ids rung ③ put in front of rung ④. */
  nominated: string[];
  /** What P-AG2 said, whatever code then did with it. */
  verdict: Ag2Verdict | null;
  /** Why the verdict was not honoured, when it was not. */
  demotedReason: string | null;
  violations: WireViolation[];
  /** The question the user is owed on `ask_user`. */
  question: string | null;
  reason: string;
}

export interface LadderOptions extends ScorePairOptions {
  bridges?: BridgeReader;
  adjudicator?: ArcAdjudicator | null;
  maxCandidates?: number;
}

function ag2CandidateOf(
  candidate: LadderCandidate,
  overlap: OverlapScore | undefined,
  similarity: SimilarityScore | undefined,
): Ag2Candidate {
  return {
    arcId: candidate.arcId,
    label: candidate.label,
    sourceIds: candidate.sourceIds ?? [],
    anchorEntityIds: candidate.anchors.map((a) => a.entityId),
    bridge: null,
    overlap: overlap ? overlap.score : null,
    similarity: similarity ? similarity.decision.score : null,
  };
}

function base(episode: LadderEpisode, ambient: boolean): LadderResult {
  return {
    episodeId: episode.id,
    decision: "new",
    rung: null,
    arcId: null,
    confidence: 0,
    modelCalls: 0,
    ambient,
    bridge: null,
    overlaps: [],
    similarities: [],
    nominated: [],
    verdict: null,
    demotedReason: null,
    violations: [],
    question: null,
    reason: "",
  };
}

/**
 * Run the ladder for one episode. Pure with respect to the database except for
 * the injected bridge read: nothing here writes a row. `arcs/provisional.ts`
 * turns the result into arc membership or a provisional arc, and it is the only
 * thing that does.
 */
export function runArcLadder(
  episode: LadderEpisode,
  candidates: readonly LadderCandidate[],
  opts: LadderOptions = {},
): LadderResult {
  const ambient = episode.ambient === true;
  const result = base(episode, ambient);

  if (candidates.length === 0) {
    result.reason = "no existing arc was offered — this episode starts a provisional arc";
    return result;
  }

  // ① BRIDGES. A shared literal is near-proof and outranks every score below.
  const hit = bridgeRung(episode, candidates, opts.bridges ?? dbBridgeReader);
  result.bridge = hit;
  if (hit !== null) {
    result.decision = "join";
    result.rung = "bridge";
    result.arcId = hit.arcId;
    result.confidence = hit.confidence;
    result.reason = `bridge ${hit.kind} ${hit.valueNorm} ties this episode to ${hit.arcId}`;
    return result;
  }

  // ② ENTITY OVERLAP.
  const overlaps = overlapRung(episode, candidates);
  result.overlaps = overlaps;
  const joinable = overlaps.find((o) => o.joins);
  if (joinable !== undefined) {
    result.decision = "join";
    result.rung = "overlap";
    result.arcId = joinable.arcId;
    result.confidence = joinable.score;
    result.reason =
      `weighted entity overlap ${joinable.score.toFixed(2)} ≥ 0.5 with ${joinable.arcId} ` +
      `on ${joinable.shared.join(",")}`;
    return result;
  }

  // §11.2: ambient episodes join ONLY via ① or ②. The ladder stops here for
  // them, whatever a topic vector would have said.
  if (ambient) {
    const best = overlaps[0];
    result.reason =
      `ambient episode: rungs ③ and ④ are closed to it, and no bridge or entity overlap fired` +
      (best ? ` (best overlap ${best.score.toFixed(2)})` : "");
    return result;
  }

  // ③ TOPIC SIMILARITY — nominate, never join.
  const similarities = similarityRung(candidates, opts);
  result.similarities = similarities;
  const nominated = similarities.filter((s) => s.nominated);
  result.nominated = nominated.map((s) => s.arcId);
  if (nominated.length === 0) {
    const blocked = similarities.find((s) => s.decision.verdict === "blocked");
    result.reason = blocked
      ? `no candidate could be scored: ${blocked.decision.reason}`
      : "no candidate cleared the arc_topic band — nothing to adjudicate";
    return result;
  }

  // ④ ADJUDICATION. Off the first-paint path: with no adjudicator the episode
  // is deferred to a provisional arc and NOT a single call is spent.
  const adjudicator = opts.adjudicator ?? null;
  const cap = Math.max(1, Math.floor(opts.maxCandidates ?? AG2_MAX_CANDIDATES));
  const byId = new Map(candidates.map((c) => [c.arcId, c] as const));
  const overlapById = new Map(overlaps.map((o) => [o.arcId, o] as const));
  const simById = new Map(similarities.map((s) => [s.arcId, s] as const));
  const offered = nominated
    .slice(0, cap)
    .map((s) => byId.get(s.arcId))
    .filter((c): c is LadderCandidate => c !== undefined)
    .map((c) => ag2CandidateOf(c, overlapById.get(c.arcId), simById.get(c.arcId)));

  if (adjudicator === null) {
    result.decision = "defer";
    result.rung = "adjudication";
    result.reason =
      `${offered.length} candidate(s) cleared the arc_topic band but P-AG2 is not on this path — ` +
      `the episode waits in a provisional arc (§9.5.1)`;
    return result;
  }

  const answer = adjudicator({ episode, candidates: offered });
  if (answer === null) {
    result.decision = "defer";
    result.rung = "adjudication";
    result.reason = "P-AG2 was warranted but returned nothing — the episode waits in a provisional arc";
    return result;
  }

  result.modelCalls = answer.calls ?? 1;
  const parsed = parseAg2Response(answer.response, answer.table, episode.id);
  result.violations = parsed.violations;
  result.verdict = parsed.verdict;
  result.rung = "adjudication";

  if (parsed.verdict === null) {
    result.decision = "defer";
    result.reason = "P-AG2 produced no usable V line — the episode waits in a provisional arc";
    return result;
  }

  const verdict = parsed.verdict;
  const confidence = verdict.confidence ?? 0;
  if (verdict.verdict === "unsure") {
    result.decision = "ask_user";
    result.confidence = confidence;
    result.question = arcQuestion(episode, offered);
    result.reason = `P-AG2 answered "un": ${verdict.reason || "evidence underdetermines it"}`;
    return result;
  }
  if (verdict.verdict === "new") {
    result.reason = `P-AG2 answered "nw": ${verdict.reason || "no candidate is the same matter"}`;
    return result;
  }

  // `jn`. Two refusals, both keeping what the model said beside what code did.
  const offeredIds = new Set(offered.map((c) => c.arcId));
  if (verdict.arcId === null || !offeredIds.has(verdict.arcId)) {
    result.demotedReason =
      `join target ${verdict.arcAlias ?? "-"} is not an arc offered to this call`;
    result.reason = `P-AG2 answered "jn" naming an off-roster arc — treated as new`;
    return result;
  }
  if (confidence < ARC_JOIN_CONFIDENCE_FLOOR) {
    result.demotedReason = `join confidence ${confidence} < ${ARC_JOIN_CONFIDENCE_FLOOR}`;
    result.reason = `P-AG2 answered "jn" below the join floor — treated as new`;
    return result;
  }

  result.decision = "join";
  result.arcId = verdict.arcId;
  result.confidence = confidence;
  result.reason = `P-AG2 answered "jn": ${verdict.reason || "same matter"}`;
  return result;
}

/** The words the user is asked when rung ④ says `un`. */
export function arcQuestion(episode: LadderEpisode, candidates: readonly Ag2Candidate[]): string {
  const names = candidates
    .map((c) => (c.label ?? "").trim())
    .filter((n) => n !== "")
    .slice(0, 3);
  const what = episode.label ?? "this";
  return names.length === 0
    ? `Does "${what}" belong to an existing thread?`
    : `Does "${what}" belong to ${names.map((n) => `"${n}"`).join(" or ")}, or is it its own thread?`;
}
