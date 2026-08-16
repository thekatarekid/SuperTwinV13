// ===========================================================================
// [ML] Episode topic vectors and the attach gate — arch §11.1 (episodes are
// topical and stream-scoped), §10.3 (calibration is a prerequisite), build
// item 2.3.
//
// Two jobs, and the split between them is the whole point of the file.
//
//   WRITE (embedEpisodeTopic)  — compose the episode's topic text and store one
//     vector per episode in `episode_embeddings`. This runs on ANY install,
//     calibrated or not, because `episode_embeddings` is the very corpus the
//     `episode_topic` floor is measured FROM (db/calib.ts CALIB_VECTOR_SOURCES).
//     Gating the write on calibration would deadlock a cold install: no
//     vectors → no floor → no vectors, forever.
//
//   COMPARE (episodeAttachGate) — the [ML] rung that may say "this session
//     belongs to that open episode". It is GATED. With no measured floor, or a
//     stale one, it embeds nothing, computes no cosine, reports no score, and
//     routes the question to the agent (P-EP2, §12.3) or, when no agent is
//     available, to the question queue. Item 2.3's acceptance is exactly this:
//     no similarity call runs on an uncalibrated model.
//
// WHAT GETS EMBEDDED (item 2.3): `topic_label` + the last 2 session summaries
// + the top entity names — composed in `./embed-text.ts`, which this module
// re-exports whole. Never a bare topic label on its own (arch §10.3 ¶4): two
// short strings sit near the centre of a 384-dimensional space and score high
// against everything, which is how two unrelated afternoons become one
// episode. A composition too thin to be rich text is NOT embedded; it is
// reported as skipped, with its reason.
//
// Scoring is never raw cosine. Every comparison goes through
// `scoreCalibratedPair` on the `episode_topic` use case, i.e. the normalised
// (cos − floor) / (1 − floor) scale with that use case's own bars — which sit
// strictly BELOW the arc bars, because attaching one session to an episode is
// a smaller claim than joining two weeks of life into an arc (§11.2 rung ③).
// ===========================================================================

import { getDb } from "../db/connection.js";
import { decodeVector, encodeVector, type EmbeddingModelKey } from "../db/embeddings.js";
import {
  calibrationFor,
  scoreCalibratedPair,
  type CalibrationVerdict,
  type PairDecision,
  type ScorePairOptions,
  type SimilarityRoute,
} from "../retrieval/calibration.js";
import { getEmbedder } from "../retrieval/embedder.js";
import { activeEmbeddingModel } from "../retrieval/model-registry.js";
import { cosine } from "../retrieval/semantic.js";
import {
  buildEpisodeTopicText,
  collectEpisodeTopicParts,
  episodeTopicTextIsUsable,
  type EpisodeTopicOptions,
} from "./embed-text.js";
import { EPISODE_USE_CASE } from "./preflag.js";

// The text half is a split for size, not a boundary a caller should have to
// know about: one import site for the whole episode-embedding surface.
export { EPISODE_USE_CASE };
export {
  EPISODE_SUMMARY_COUNT,
  MAX_MENTION_SCAN_EVENTS,
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_ENTITIES,
  MAX_TOPIC_TEXT_CHARS,
  buildEpisodeTopicText,
  collectEpisodeTopicParts,
  episodeTopicTextIsUsable,
  summariseSession,
  topEntityNames,
  type EpisodeTopicOptions,
  type EpisodeTopicParts,
} from "./embed-text.js";

// ---- Storage ---------------------------------------------------------------

export interface PutEpisodeEmbeddingParams extends EmbeddingModelKey {
  episodeId: string;
  vector: Float32Array | readonly number[];
}

/** Upsert one episode's topic vector. A dim mismatch is rejected, never padded. */
export function putEpisodeEmbedding(params: PutEpisodeEmbeddingParams): void {
  const vector =
    params.vector instanceof Float32Array ? params.vector : Float32Array.from(params.vector);
  if (vector.length !== params.dim) {
    throw new Error(
      `putEpisodeEmbedding: vector for ${params.episodeId} has ${vector.length} dimensions, expected ${params.dim}`,
    );
  }
  getDb()
    .prepare(
      `INSERT INTO episode_embeddings (episode_id, vec, model, dim)
       VALUES (@episodeId, @vec, @model, @dim)
       ON CONFLICT(episode_id) DO UPDATE SET
         vec = excluded.vec, model = excluded.model, dim = excluded.dim`,
    )
    .run({
      episodeId: params.episodeId,
      vec: encodeVector(vector),
      model: params.model,
      dim: params.dim,
    });
}

/**
 * One episode's vector IN ONE SPACE. The (model, dim) filter is not optional:
 * a vector written by a previous embedder is not a weaker answer here, it is a
 * different geometry, and comparing across the two means nothing.
 */
export function readEpisodeEmbedding(
  episodeId: string,
  key: EmbeddingModelKey,
): Float32Array | null {
  const row = getDb()
    .prepare(
      `SELECT vec FROM episode_embeddings WHERE episode_id = @episodeId AND model = @model AND dim = @dim`,
    )
    .get({ episodeId, model: key.model, dim: key.dim }) as { vec: Buffer } | undefined;
  if (!row) return null;
  const vec = decodeVector(row.vec);
  return vec.length === key.dim ? vec : null;
}

// ---- Writing vectors -------------------------------------------------------

export type EmbedSkipReason = "unknown_episode" | "thin_text" | "no_embedder" | "no_vector";

export interface EmbedEpisodeResult {
  episodeId: string;
  stored: boolean;
  /** The text that was (or would have been) embedded. Always reported. */
  text: string;
  model: string;
  dim: number;
  reason: string;
  skipped: EmbedSkipReason | null;
}

export interface EmbedEpisodeOptions extends EpisodeTopicOptions {
  /** Text→vector. Defaults to the loaded embedder in the active space. */
  embed?: (texts: readonly string[]) => Promise<Float32Array[]>;
  model?: string;
  dim?: number;
}

async function embedTexts(
  texts: readonly string[],
  opts: EmbedEpisodeOptions,
): Promise<Float32Array[]> {
  if (opts.embed) return opts.embed(texts);
  const embedder = await getEmbedder();
  if (!embedder) return [];
  return embedder.embed(texts, "passage");
}

/**
 * Compose and store one episode's topic vector.
 *
 * NOT gated on calibration, on purpose (see the header): this table is the
 * corpus the floor is measured from. What it does refuse is a thin composition
 * — a label alone is not evidence of anything, and a vector for it would be
 * noise that later measures the floor of that very noise.
 */
export async function embedEpisodeTopic(
  episodeId: string,
  opts: EmbedEpisodeOptions = {},
): Promise<EmbedEpisodeResult> {
  const spec = activeEmbeddingModel();
  const model = opts.model ?? spec.id;
  const dim = opts.dim ?? spec.dim;
  const base = { episodeId, model, dim, stored: false as const };

  const parts = collectEpisodeTopicParts(episodeId, opts);
  if (parts === null) {
    return { ...base, text: "", skipped: "unknown_episode", reason: `no episode ${episodeId}` };
  }
  const text = buildEpisodeTopicText(parts);
  if (!episodeTopicTextIsUsable(text)) {
    return {
      ...base,
      text,
      skipped: "thin_text",
      reason: `episode ${episodeId} has no rich topic text yet (label + ${parts.summaries.length} summaries + ${parts.entityNames.length} entities) — not embedded`,
    };
  }

  const vectors = await embedTexts([text], opts);
  const vector = vectors[0];
  if (!vector || vector.length === 0) {
    return {
      ...base,
      text,
      skipped: opts.embed ? "no_vector" : "no_embedder",
      reason: `no vector for episode ${episodeId} — the embedder produced nothing`,
    };
  }
  putEpisodeEmbedding({ episodeId, vector, model, dim });
  return {
    episodeId,
    stored: true,
    text,
    model,
    dim,
    skipped: null,
    reason: `embedded ${text.length} chars into ${model}/${dim}`,
  };
}

/** The same, for a batch. One embed call, in input order. */
export async function embedEpisodeTopics(
  episodeIds: readonly string[],
  opts: EmbedEpisodeOptions = {},
): Promise<EmbedEpisodeResult[]> {
  const out: EmbedEpisodeResult[] = [];
  for (const id of episodeIds) out.push(await embedEpisodeTopic(id, opts));
  return out;
}

// ---- The attach gate -------------------------------------------------------

export interface AttachCandidate {
  episodeId: string;
  /** Injected vector; when absent the stored one for the active space is read. */
  vector?: Float32Array | readonly number[] | null;
}

export interface AttachCandidateScore {
  episodeId: string;
  decision: PairDecision;
}

export type AttachGateDecision =
  /** A calibrated `same`: this session belongs to `episodeId`. */
  | "attach"
  /** Calibrated, and nothing cleared the bar. Mint a new episode. */
  | "new"
  /** The gate will not answer: the judge (P-EP2) or the question queue must. */
  | "escalate";

export interface AttachGateResult {
  /** False when calibration is missing or stale — nothing was embedded. */
  enabled: boolean;
  decision: AttachGateDecision;
  /** `ml` only when this module decided by itself. */
  route: SimilarityRoute;
  /** The attach target, or the best unsure candidate when escalating. */
  episodeId: string | null;
  /** Every candidate that could be compared, best score first. */
  scores: AttachCandidateScore[];
  /** Candidates with no comparable vector, and why. Never scored as "far". */
  unscored: { episodeId: string; reason: string }[];
  calibration: CalibrationVerdict;
  reason: string;
}

export interface AttachGateOptions extends ScorePairOptions, EmbedEpisodeOptions {}

function escalationRoute(opts: AttachGateOptions): SimilarityRoute {
  return opts.agentAvailable === false ? "question_queue" : "agent";
}

function gateOff(
  calibration: CalibrationVerdict,
  opts: AttachGateOptions,
  reason: string,
): AttachGateResult {
  return {
    enabled: false,
    decision: "escalate",
    route: escalationRoute(opts),
    episodeId: null,
    scores: [],
    unscored: [],
    calibration,
    reason,
  };
}

function toVector(value: AttachCandidate["vector"]): Float32Array | null {
  if (value == null) return null;
  if (value instanceof Float32Array) return value.length > 0 ? value : null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = new Float32Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

/**
 * May this session attach to one of its stream's open episodes?
 *
 * The order of operations is the contract:
 *
 *   1. ask calibration FIRST — with no usable floor nothing is embedded, no
 *      cosine is computed, no score is reported, and the pair leaves for the
 *      agent (P-EP2) or the question queue;
 *   2. refuse a bare short session text outright (throws);
 *   3. embed once, compare against each candidate's vector on the calibrated
 *      `episode_topic` scale;
 *   4. `same` → attach to the best one · band → escalate · all `different` →
 *      new. A candidate with no comparable vector is listed as unscored, never
 *      counted as "different" — absence of a vector is not evidence of a
 *      different topic.
 *
 * Candidates must already be stream-scoped (§11.1 rule 3); this module compares
 * what it is given and never widens the set.
 */
export async function episodeAttachGate(
  sessionText: string,
  candidates: readonly AttachCandidate[],
  opts: AttachGateOptions = {},
): Promise<AttachGateResult> {
  const calibration = calibrationFor(EPISODE_USE_CASE, opts);
  if (calibration.state !== "ready" || calibration.floor === null) {
    return gateOff(calibration, opts, `[ML] episode attach gate disabled: ${calibration.reason}`);
  }
  if (candidates.length === 0) {
    return {
      enabled: true,
      decision: "new",
      route: "ml",
      episodeId: null,
      scores: [],
      unscored: [],
      calibration,
      reason: "no open episode was offered — the session is its own episode",
    };
  }

  // Rich text or nothing: a bare label on this path would score against every
  // candidate at once, which is precisely the failure §10.3 ¶4 describes.
  const text = sessionText.trim();
  if (!episodeTopicTextIsUsable(text)) {
    throw new Error(
      `episodeAttachGate: refusing to compare a bare short string (${JSON.stringify(text.slice(0, 40))}) — ` +
        `compose topic label + last 2 session summaries + top entity names first`,
    );
  }

  const spec = activeEmbeddingModel();
  const key: EmbeddingModelKey = { model: opts.model ?? spec.id, dim: opts.dim ?? spec.dim };
  const [probe] = await embedTexts([text], opts);
  if (!probe || probe.length === 0) {
    return gateOff(
      calibration,
      opts,
      "[ML] episode attach gate skipped: the embedder returned no vector",
    );
  }

  const scores: AttachCandidateScore[] = [];
  const unscored: { episodeId: string; reason: string }[] = [];
  for (const candidate of candidates) {
    const stored = toVector(candidate.vector) ?? readEpisodeEmbedding(candidate.episodeId, key);
    if (stored === null) {
      unscored.push({
        episodeId: candidate.episodeId,
        reason: `no topic vector in ${key.model}/${key.dim}`,
      });
      continue;
    }
    if (stored.length !== probe.length) {
      unscored.push({
        episodeId: candidate.episodeId,
        reason: `vector is ${stored.length}-dimensional, the session's is ${probe.length} — not comparable`,
      });
      continue;
    }
    scores.push({
      episodeId: candidate.episodeId,
      // The verdict already read the calibration row; pass it back so a batch
      // of ten candidates costs one read, not ten.
      decision: scoreCalibratedPair(EPISODE_USE_CASE, cosine(probe, stored), {
        ...opts,
        row: {
          model: calibration.model,
          useCase: EPISODE_USE_CASE,
          floor: calibration.floor,
          measuredAt: calibration.measuredAt,
          nPairs: calibration.nPairs,
        },
      }),
    });
  }

  // Best score first; ties keep candidate order, so the scan is deterministic.
  scores.sort((a, b) => (b.decision.score ?? -1) - (a.decision.score ?? -1));

  const best = scores[0];
  if (best && best.decision.verdict === "same") {
    return {
      enabled: true,
      decision: "attach",
      route: "ml",
      episodeId: best.episodeId,
      scores,
      unscored,
      calibration,
      reason: `attach to ${best.episodeId}: ${best.decision.reason}`,
    };
  }

  const unsure = scores.find((s) => s.decision.verdict === "unsure");
  if (unsure) {
    return {
      enabled: true,
      decision: "escalate",
      route: escalationRoute(opts),
      episodeId: unsure.episodeId,
      scores,
      unscored,
      calibration,
      reason: `${unsure.episodeId} is in the band (${unsure.decision.reason}) — the judge decides`,
    };
  }

  if (scores.length === 0) {
    return {
      enabled: true,
      decision: "escalate",
      route: escalationRoute(opts),
      episodeId: null,
      scores,
      unscored,
      calibration,
      reason: `none of the ${candidates.length} candidates had a comparable vector — the judge decides`,
    };
  }

  return {
    enabled: true,
    decision: "new",
    route: "ml",
    episodeId: null,
    scores,
    unscored,
    calibration,
    reason: `all ${scores.length} candidates scored below the band — a new episode`,
  };
}
