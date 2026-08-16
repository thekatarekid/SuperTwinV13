// ===========================================================================
// [ML] Floor measurement — the arithmetic half of embedder calibration
// (arch §10.3, build item 0.7). Split out of calibration.ts so the policy
// (what is fresh, what bar a use case carries, where a blocked pair goes)
// stays readable next to the numbers that implement it.
//
// Nothing here touches the database or the model registry: vectors in, one
// measured floor out, deterministically. That is what makes the floor
// testable against a constructed reference corpus.
// ===========================================================================

import { cosine } from "./semantic.js";

// ---- Measurement constants ------------------------------------------------

/** Arch §10.3 ¶2: "≥1,000 random unrelated pairs". Fewer is not a floor. */
export const MIN_CALIB_PAIRS = 1000;

/**
 * The smallest corpus that can yield MIN_CALIB_PAIRS distinct pairs:
 * 48·47/2 = 1,128. Below this the use case stays UNCALIBRATED rather than
 * measured from a handful of pairs whose quantile is noise.
 */
export const MIN_CALIB_VECTORS = 48;

/**
 * Which quantile of the unrelated-pair cosines IS the floor. The mean would
 * leave half the noise band scoring positive; the max is one outlier away from
 * blocking everything. p95 is the top of the band with the tail cut off.
 */
export const FLOOR_QUANTILE = 0.95;

/**
 * Pairs at or above this cosine are the same text embedded twice (a duplicate
 * claim, a re-stated loop), not an unrelated pair. Counting them would drag
 * the floor toward 1 and silently disable the rung.
 */
export const NEAR_DUPLICATE_COS = 0.995;

/**
 * How much more than the target is drawn, so the near-duplicate drops above
 * come out of the surplus and the row still records the pairs it promises.
 */
export const PAIR_OVERSAMPLE = 1.25;

/**
 * A floor this high leaves no usable range above it — `1 − floor` is inside
 * float noise, and every pair would score ~1. Measuring one means the corpus
 * was degenerate (all one topic, or all one string). It is NOT persisted: the
 * rung stays blocked, which is the honest outcome.
 */
export const MAX_MEASURABLE_FLOOR = 0.98;

/**
 * Fixed sampling seed. A floor is a measurement, and a measurement that moves
 * when nothing else did is not one — same corpus in, same floor out, on every
 * machine and every re-run.
 */
export const DEFAULT_CALIB_SEED = 0x5eed_1234;

// ---- Scoring --------------------------------------------------------------

/**
 * `score = (cos − floor) / (1 − floor)` (arch §10.3 ¶2), clamped to 0..1.
 *
 * The clamp at 0 is not cosmetic: a raw cosine BELOW the floor means "less
 * alike than two unrelated things", which is the same information as "not
 * alike", and a negative score leaking into a weighted blend would subtract
 * from unrelated evidence.
 */
export function normalizedScore(cos: number, floor: number): number {
  if (!Number.isFinite(cos)) return 0;
  if (!Number.isFinite(floor) || floor < 0 || floor >= 1) {
    throw new Error(`normalizedScore: floor must be a cosine in [0, 1), got ${floor}`);
  }
  const score = (cos - floor) / (1 - floor);
  if (!(score > 0)) return 0;
  return score > 1 ? 1 : score;
}

// ---- Measurement ----------------------------------------------------------

export interface FloorMeasurement {
  floor: number;
  /** Unrelated pairs the floor was measured from, after near-duplicate drops. */
  nPairs: number;
  vectors: number;
  mean: number;
  median: number;
  max: number;
  nearDuplicatesDropped: number;
}

export interface MeasureFloorOptions {
  /** Target number of unrelated pairs. Default MIN_CALIB_PAIRS. */
  pairs?: number;
  /** Deterministic sampling seed. Same seed + same corpus = same floor. */
  seed?: number;
  quantile?: number;
}

/** Thrown when a floor cannot be measured. Never swallowed into a default. */
export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationError";
  }
}

/**
 * Measure the unrelated-pair floor of one embedding space.
 *
 * "Unrelated" is not a label anyone attached to these vectors — it is what a
 * random pair drawn from a real corpus overwhelmingly IS. The high quantile
 * then absorbs the few genuinely related pairs the draw happens to catch.
 */
export function measureFloor(
  vectors: readonly Float32Array[],
  opts: MeasureFloorOptions = {},
): FloorMeasurement {
  const target = Math.max(1, Math.floor(opts.pairs ?? MIN_CALIB_PAIRS));
  const quantile = opts.quantile ?? FLOOR_QUANTILE;
  const n = vectors.length;
  if (n < MIN_CALIB_VECTORS) {
    throw new CalibrationError(
      `measureFloor: ${n} vectors is below the ${MIN_CALIB_VECTORS} needed for ${MIN_CALIB_PAIRS} distinct pairs`,
    );
  }

  // Draw MORE than the target, because near-duplicates are dropped after the
  // draw: sampling exactly 1,000 and discarding nine of them would leave the
  // floor measured from 991 pairs while the row on disk claimed 1,000.
  const draw = Math.ceil(target * PAIR_OVERSAMPLE);
  const pairs = samplePairs(n, draw, opts.seed ?? DEFAULT_CALIB_SEED);
  const sims: number[] = [];
  let dropped = 0;
  for (const [i, j] of pairs) {
    if (sims.length >= target) break;
    const cos = cosine(vectors[i], vectors[j]);
    if (cos >= NEAR_DUPLICATE_COS) {
      dropped++;
      continue;
    }
    sims.push(cos);
  }
  if (sims.length < Math.min(target, MIN_CALIB_PAIRS)) {
    throw new CalibrationError(
      `measureFloor: only ${sims.length} usable unrelated pairs after dropping ${dropped} near-duplicates`,
    );
  }

  sims.sort((a, b) => a - b);
  const floor = quantileOf(sims, quantile);
  return {
    floor,
    nPairs: sims.length,
    vectors: n,
    mean: sims.reduce((a, b) => a + b, 0) / sims.length,
    median: quantileOf(sims, 0.5),
    max: sims[sims.length - 1],
    nearDuplicatesDropped: dropped,
  };
}

/** Nearest-rank quantile over an ascending array. */
function quantileOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, q));
  const idx = Math.min(sorted.length - 1, Math.floor(clamped * sorted.length));
  return sorted[idx];
}

/**
 * `count` distinct index pairs out of `n` items, deterministically.
 *
 * Two regimes, because rejection sampling degenerates when the requested count
 * approaches the total: a small corpus enumerates every pair and strides
 * through them, a large one draws until it has enough distinct ones.
 */
export function samplePairs(n: number, count: number, seed: number): [number, number][] {
  const possible = (n * (n - 1)) / 2;
  const want = Math.min(count, possible);
  const rand = mulberry32(seed >>> 0);

  if (possible <= count * 4) {
    const all: [number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([i, j]);
    // Fisher–Yates with the seeded generator, then take the first `want`.
    for (let k = all.length - 1; k > 0; k--) {
      const swap = Math.floor(rand() * (k + 1));
      const tmp = all[k];
      all[k] = all[swap];
      all[swap] = tmp;
    }
    return all.slice(0, want);
  }

  const seen = new Set<number>();
  const out: [number, number][] = [];
  let guard = 0;
  const maxDraws = want * 64 + 1024;
  while (out.length < want && guard++ < maxDraws) {
    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * n);
    if (i === j) continue;
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    const key = lo * n + hi;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([lo, hi]);
  }
  return out;
}

/** Small deterministic PRNG — reproducible floors across runs and machines. */
function mulberry32(seed: number): () => number {
  let a = seed || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
