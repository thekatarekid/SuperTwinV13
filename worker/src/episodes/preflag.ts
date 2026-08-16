// ===========================================================================
// [ML] The intra-session drift pre-flag — arch §11.1, build item 2.1.
//
// One question, asked before any money is spent: does this session hold ONE
// topic or several? §11.1's ladder is
//
//     hash gate  →  PRE-FLAG (here)  →  1:1 default   or   P-EP2
//
// and the pre-flag is what makes the middle rung free. A session with no
// internal drift and no open episodes in its stream becomes its own episode
// with NO MODEL CALL at all; the [LLM-M] pass is reserved for sessions that
// actually pivot, or streams that have something to attach to.
//
// How the drift is measured: every candidate cut splits the session into a
// prefix and a suffix, each collapsed to its centroid, and the two centroids
// are compared. The cut with the LOWEST similarity is the session's best
// argument for a split, and that one number is routed through the ordinary
// calibrated-pair machinery on the `episode_topic` use case. Drift is declared
// only on a `different` verdict — the band is ambiguity, and ambiguity is
// exactly what P-EP2 exists to settle, so it buys the call too.
//
// THREE RULES THIS FILE WILL NOT BEND
//
//   1. The calibration gate is checked FIRST, before a single cosine is
//      computed (arch §10.3, and item 2.3's acceptance: no similarity call
//      runs on an uncalibrated model). With no usable floor this returns
//      `measured: false` and no score — never a guessed threshold.
//   2. Placeholders carry no topic signal (§12.3), so "[image, description
//      pending]" never splits a session. They are dropped from the drift
//      measurement and stay in the session for everyone else.
//   3. Unmeasured is not "no drift" and it is not "drift". The result says
//      which it is; the ENGINE decides what an unmeasured session costs, and
//      it chooses the cheap default because a wrong split is repairable.
//
// Nothing here reads or writes the database, and nothing here embeds: vectors
// arrive already computed. That keeps the [ML] rung a pure function of its
// inputs, which is the only way its determinism is testable.
// ===========================================================================

import {
  calibrationFor,
  scoreCalibratedPair,
  type CalibUseCase,
  type PairDecision,
  type ScorePairOptions,
} from "../retrieval/calibration.js";
import { cosine } from "../retrieval/semantic.js";

/** Episodes are topical, so the topical space is the one that is calibrated. */
export const EPISODE_USE_CASE: CalibUseCase = "episode_topic";

/** §12.3: "a segment needs ≥2 events". A 1-event block is never a cut. */
export const MIN_BLOCK_EVENTS = 2;

/** One session member, as the pre-flag sees it. */
export interface DriftEvent {
  id: string;
  /** The event's topic vector. Absent means "not embedded", never "empty". */
  vector?: Float32Array | readonly number[] | null;
  /** "[voice note, transcription pending]" and friends — §12.3, no signal. */
  placeholder?: boolean;
}

export interface PreflagOptions extends ScorePairOptions {
  /** Minimum events on each side of a cut. Defaults to `MIN_BLOCK_EVENTS`. */
  minBlock?: number;
}

export type PreflagReason =
  /** The two halves are different topics: buy the P-EP2 call. */
  | "drift"
  /** Measured, and the halves are the same topic. */
  | "single_topic"
  /** Measured, and the answer landed in the band — ambiguous, so still call. */
  | "band"
  /** Too few events carrying signal for any cut to exist. */
  | "too_few_signal_events"
  /** Events exist, but none of them carry a vector. */
  | "no_vectors"
  /** The `episode_topic` floor has never been measured, or has gone stale. */
  | "uncalibrated";

export interface PreflagResult {
  /** True only when the session argues for more than one topic. */
  drift: boolean;
  /** False when no comparison was legitimately possible. Never a guess. */
  measured: boolean;
  /** Normalised score at the best cut, or null when nothing was measured. */
  score: number | null;
  /** Raw cosine at the best cut, or null. */
  cosine: number | null;
  /** Last event of the prefix at the best cut — a HINT for P-EP2, not a cut. */
  cutAfterEventId: string | null;
  /** The hinted blocks, in session order. Empty when nothing was measured. */
  leftEventIds: string[];
  rightEventIds: string[];
  /** How many members carried usable signal. */
  signalEvents: number;
  reason: PreflagReason;
  /** The routing verdict, kept whole for the log. Null when never scored. */
  decision: PairDecision | null;
  detail: string;
}

// ---- vector helpers --------------------------------------------------------

/** Anything vector-shaped becomes a Float32Array; anything else becomes null. */
export function toVector(value: DriftEvent["vector"]): Float32Array | null {
  if (value == null) return null;
  if (value instanceof Float32Array) return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const out = new Float32Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const n = Number(value[i]);
      if (!Number.isFinite(n)) return null;
      out[i] = n;
    }
    return out;
  }
  return null;
}

/**
 * The mean vector. Not normalised: `cosine` divides by both norms itself, so
 * normalising here would only lose precision on the way.
 */
export function centroid(vectors: readonly Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) return null;
    for (let i = 0; i < dim; i += 1) out[i] += v[i]!;
  }
  for (let i = 0; i < dim; i += 1) out[i] /= vectors.length;
  return out;
}

/** Cumulative sums, so every cut's two centroids cost O(dim), not O(n·dim). */
function prefixSums(vectors: readonly Float32Array[]): Float32Array[] {
  const dim = vectors[0]!.length;
  const sums: Float32Array[] = [new Float32Array(dim)];
  for (let i = 0; i < vectors.length; i += 1) {
    const prev = sums[i]!;
    const next = new Float32Array(dim);
    for (let d = 0; d < dim; d += 1) next[d] = prev[d]! + vectors[i]![d]!;
    sums.push(next);
  }
  return sums;
}

function meanBetween(sums: readonly Float32Array[], from: number, to: number): Float32Array {
  const dim = sums[0]!.length;
  const out = new Float32Array(dim);
  const n = to - from;
  for (let d = 0; d < dim; d += 1) out[d] = (sums[to]![d]! - sums[from]![d]!) / n;
  return out;
}

// ---- the pre-flag ----------------------------------------------------------

function unmeasured(
  reason: PreflagReason,
  detail: string,
  signalEvents: number,
  decision: PairDecision | null = null,
): PreflagResult {
  return {
    drift: false,
    measured: false,
    score: null,
    cosine: null,
    cutAfterEventId: null,
    leftEventIds: [],
    rightEventIds: [],
    signalEvents,
    reason,
    decision,
    detail,
  };
}

/**
 * Does this session pivot? Returns the best cut it can argue for, and whether
 * that argument clears the calibrated bar.
 *
 * The events must be in session order — the pre-flag reads a conversation, and
 * a shuffled one has no prefix and no suffix to compare.
 */
export function preflagDrift(
  events: readonly DriftEvent[],
  opts: PreflagOptions = {},
): PreflagResult {
  const minBlock = Math.max(1, Math.floor(opts.minBlock ?? MIN_BLOCK_EVENTS));

  // (1) The gate, before any arithmetic. An uncalibrated space cannot tell a
  // pivot from a paragraph break, and a number produced in it is not evidence.
  const calibration = calibrationFor(EPISODE_USE_CASE, opts);
  if (calibration.state !== "ready" || calibration.floor === null) {
    return unmeasured("uncalibrated", `[ML] drift pre-flag disabled: ${calibration.reason}`, 0);
  }

  // (2) Only members that carry topic signal take part.
  const signal: { id: string; vector: Float32Array }[] = [];
  let placeholders = 0;
  let unembedded = 0;
  for (const event of events) {
    if (event.placeholder === true) {
      placeholders += 1;
      continue;
    }
    const vector = toVector(event.vector);
    if (vector === null) {
      unembedded += 1;
      continue;
    }
    signal.push({ id: event.id, vector });
  }

  if (signal.length === 0) {
    return unmeasured(
      "no_vectors",
      `no member carried a topic vector (${unembedded} unembedded, ${placeholders} placeholders)`,
      0,
    );
  }
  if (signal.length < minBlock * 2) {
    return unmeasured(
      "too_few_signal_events",
      `${signal.length} events with signal cannot make two blocks of ${minBlock}`,
      signal.length,
    );
  }

  const dim = signal[0]!.vector.length;
  if (signal.some((s) => s.vector.length !== dim)) {
    return unmeasured(
      "no_vectors",
      "members were embedded in two different dimensions — the vectors are not comparable",
      signal.length,
    );
  }

  // (3) Every legal cut, and the one that argues hardest for a split.
  const sums = prefixSums(signal.map((s) => s.vector));
  let bestCut = -1;
  let bestCos = Number.POSITIVE_INFINITY;
  for (let cut = minBlock; cut <= signal.length - minBlock; cut += 1) {
    const left = meanBetween(sums, 0, cut);
    const right = meanBetween(sums, cut, signal.length);
    const cos = cosine(left, right);
    // Strictly less: ties keep the EARLIER cut, so the scan is deterministic.
    if (cos < bestCos) {
      bestCos = cos;
      bestCut = cut;
    }
  }

  // (4) One routing decision, on the calibrated scale. `different` is drift;
  // the band is ambiguity, which P-EP2 is the right instrument for.
  const decision = scoreCalibratedPair(EPISODE_USE_CASE, bestCos, opts);
  const cutId = signal[bestCut - 1]!.id;
  const boundary = events.findIndex((e) => e.id === cutId);
  const ordered = events.map((e) => e.id);
  const drift = decision.verdict === "different";
  const reason: PreflagReason =
    decision.verdict === "different" ? "drift" : decision.verdict === "same" ? "single_topic" : "band";

  return {
    drift,
    measured: decision.score !== null,
    score: decision.score,
    cosine: decision.cosine,
    cutAfterEventId: cutId,
    leftEventIds: ordered.slice(0, boundary + 1),
    rightEventIds: ordered.slice(boundary + 1),
    signalEvents: signal.length,
    reason,
    decision,
    detail: decision.reason,
  };
}

/**
 * The one question the engine asks: is the [LLM-M] pass worth buying for this
 * session on drift grounds alone? Open episodes are the OTHER reason to buy it
 * and are not this function's business (§11.1).
 */
export function driftWantsModel(result: PreflagResult): boolean {
  return result.drift || result.reason === "band";
}
