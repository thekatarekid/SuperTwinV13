// ===========================================================================
// Floor measurement + normalisation (build item 0.7; evals V-001…V-008).
//
// The measurement runs against a CONSTRUCTED reference corpus
// (__fixtures__/reference-corpus.ts) rather than the real ONNX embedder: the
// property being tested is that the measured floor lands where the
// architecture says e5's floor lands (0.70–0.90, "~0.75–0.85" in the evals
// doc), and a fixture whose geometry is stated in the open makes that a real
// assertion instead of a snapshot of whatever a model happened to output.
//
// ── On V-004…V-008 ─────────────────────────────────────────────────────────
// The evals doc's Assert column is the normative statement:
// `score = (cos − floor) / (1 − floor)`. Its Expect column carries "~" values
// (0.24, 0.65, 0.88, 0.0, 0.41) that are illustrative and not self-consistent
// — solving each of them for the floor gives 0.816, 0.800, 0.750 and 0.814
// rather than the 0.83 the rows state. The formula is what is implemented and
// what is asserted below, exactly; the ordering and the clamp the Expect
// column describes are asserted too.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  CalibrationError,
  FLOOR_QUANTILE,
  MIN_CALIB_PAIRS,
  MIN_CALIB_VECTORS,
  NEAR_DUPLICATE_COS,
  measureFloor,
  normalizedScore,
  samplePairs,
} from "./calibration-floor.js";
import { referenceCorpus, relatedPair } from "./__fixtures__/reference-corpus.js";
import { cosine } from "./semantic.js";

/** The band the build doc requires on a reference corpus. */
const FLOOR_MIN = 0.7;
const FLOOR_MAX = 0.9;

describe("measured floor on the reference corpus", () => {
  // V-001 / V-002 / V-003 — the same corpus, three sample sizes.
  for (const pairs of [1000, 1500, 2000]) {
    it(`V-00${pairs === 1000 ? 1 : pairs === 1500 ? 2 : 3}: ${pairs} random unrelated pairs put the floor in 0.70–0.90`, () => {
      const corpus = referenceCorpus({ count: 400 });
      const measured = measureFloor(corpus.vectors, { pairs });

      expect(measured.nPairs).toBe(pairs);
      expect(measured.nPairs).toBeGreaterThanOrEqual(MIN_CALIB_PAIRS);
      expect(measured.floor).toBeGreaterThanOrEqual(FLOOR_MIN);
      expect(measured.floor).toBeLessThanOrEqual(FLOOR_MAX);
      // The evals doc's tighter reading of the same band.
      expect(measured.floor).toBeGreaterThanOrEqual(0.75);
      expect(measured.floor).toBeLessThanOrEqual(0.85);
    });
  }

  it("is stable across sample sizes — a floor is a measurement, not a draw", () => {
    const corpus = referenceCorpus({ count: 400 });
    const a = measureFloor(corpus.vectors, { pairs: 1000 }).floor;
    const b = measureFloor(corpus.vectors, { pairs: 2000 }).floor;
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  it("is deterministic: same corpus and seed, same floor", () => {
    const corpus = referenceCorpus({ count: 400 });
    expect(measureFloor(corpus.vectors, { seed: 7 }).floor).toBe(
      measureFloor(corpus.vectors, { seed: 7 }).floor,
    );
  });

  it("sits ABOVE the mean — the floor is the top of the noise band", () => {
    const corpus = referenceCorpus({ count: 400 });
    const m = measureFloor(corpus.vectors);
    expect(m.floor).toBeGreaterThan(m.mean);
    expect(m.floor).toBeLessThanOrEqual(m.max);
    expect(FLOOR_QUANTILE).toBeGreaterThan(0.5);
  });

  it("leaves a genuinely related pair scoring well above zero", () => {
    const corpus = referenceCorpus({ count: 400 });
    const { floor } = measureFloor(corpus.vectors);
    const [a, b] = relatedPair(corpus);
    const related = cosine(a, b);
    // The whole point of calibration: raw cosine says 0.92 for BOTH an
    // unrelated pair (0.80) and a related one (0.92); normalised, the
    // unrelated pair is 0 and the related one is not.
    expect(related).toBeGreaterThan(floor);
    expect(normalizedScore(related, floor)).toBeGreaterThan(0.4);
    expect(normalizedScore(m_unrelatedCos(corpus), floor)).toBeLessThan(0.2);
  });

  it("rises with a corpus that is all one topic — and that is reported, not hidden", () => {
    const corpus = referenceCorpus({ count: 200, topics: 1 });
    const m = measureFloor(corpus.vectors);
    expect(m.floor).toBeGreaterThan(FLOOR_MAX);
  });
});

/** A cosine between two vectors that are on different topics. */
function m_unrelatedCos(corpus: ReturnType<typeof referenceCorpus>): number {
  const i = 0;
  const j = corpus.topicOf.findIndex((t) => t !== corpus.topicOf[i]);
  return cosine(corpus.vectors[i], corpus.vectors[j]);
}

describe("measurement guards", () => {
  it("refuses a corpus too small to yield 1,000 distinct pairs", () => {
    const corpus = referenceCorpus({ count: MIN_CALIB_VECTORS - 1 });
    expect(() => measureFloor(corpus.vectors)).toThrow(CalibrationError);
    expect(() => measureFloor(corpus.vectors)).toThrow(/below the 48 needed/);
  });

  it("accepts exactly MIN_CALIB_VECTORS (48·47/2 = 1,128 pairs)", () => {
    const corpus = referenceCorpus({ count: MIN_CALIB_VECTORS });
    const m = measureFloor(corpus.vectors);
    expect(m.nPairs).toBe(MIN_CALIB_PAIRS);
    expect(m.vectors).toBe(MIN_CALIB_VECTORS);
  });

  it("drops near-duplicate pairs instead of letting them drag the floor up", () => {
    const corpus = referenceCorpus({ count: 400 });
    const cloned = [...corpus.vectors];
    // 40 exact duplicates of one vector: every pair among them is cos 1.0.
    for (let i = 0; i < 40; i++) cloned.push(corpus.vectors[0]);
    const m = measureFloor(cloned);
    expect(m.nearDuplicatesDropped).toBeGreaterThan(0);
    expect(m.floor).toBeLessThanOrEqual(FLOOR_MAX);
    expect(NEAR_DUPLICATE_COS).toBeLessThan(1);
  });

  it("throws rather than measuring from a corpus that is one string repeated", () => {
    const one = referenceCorpus({ count: 1 }).vectors[0];
    const all = Array.from({ length: 200 }, () => one);
    expect(() => measureFloor(all)).toThrow(/usable unrelated pairs/);
  });
});

describe("pair sampling", () => {
  it("returns distinct, ordered, in-range pairs", () => {
    const pairs = samplePairs(400, 1000, 42);
    expect(pairs).toHaveLength(1000);
    const seen = new Set<string>();
    for (const [i, j] of pairs) {
      expect(i).toBeLessThan(j);
      expect(j).toBeLessThan(400);
      seen.add(`${i}:${j}`);
    }
    expect(seen.size).toBe(1000);
  });

  it("caps at the number of pairs that exist", () => {
    expect(samplePairs(10, 1000, 1)).toHaveLength(45);
  });

  it("is seed-stable and seed-sensitive", () => {
    expect(samplePairs(400, 50, 1)).toEqual(samplePairs(400, 50, 1));
    expect(samplePairs(400, 50, 1)).not.toEqual(samplePairs(400, 50, 2));
  });
});

describe("score = (cos − floor) / (1 − floor)", () => {
  const F = 0.83;

  it("V-004: cos 0.86 over floor 0.83", () => {
    expect(normalizedScore(0.86, F)).toBeCloseTo((0.86 - F) / (1 - F), 12);
    expect(normalizedScore(0.86, F)).toBeCloseTo(0.1765, 3);
  });

  it("V-005: cos 0.93 over floor 0.83", () => {
    expect(normalizedScore(0.93, F)).toBeCloseTo((0.93 - F) / (1 - F), 12);
    expect(normalizedScore(0.93, F)).toBeCloseTo(0.5882, 3);
  });

  it("V-006: cos 0.97 over floor 0.83", () => {
    expect(normalizedScore(0.97, F)).toBeCloseTo((0.97 - F) / (1 - F), 12);
    expect(normalizedScore(0.97, F)).toBeCloseTo(0.8235, 3);
  });

  it("V-007: cos 0.80 below floor 0.83 is exactly 0, never negative", () => {
    expect(normalizedScore(0.8, F)).toBe(0);
    expect(normalizedScore(0.0, F)).toBe(0);
    expect(normalizedScore(-1, F)).toBe(0);
  });

  it("V-008: cos 0.89 over floor 0.83", () => {
    expect(normalizedScore(0.89, F)).toBeCloseTo((0.89 - F) / (1 - F), 12);
    expect(normalizedScore(0.89, F)).toBeCloseTo(0.3529, 3);
  });

  it("is monotonic and ordered exactly as V-004…V-008 describe", () => {
    const scores = [0.8, 0.86, 0.89, 0.93, 0.97].map((c) => normalizedScore(c, F));
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(new Set(scores.slice(1)).size).toBe(4);
  });

  it("is 1 at cos 1 and 0 at the floor itself", () => {
    expect(normalizedScore(1, F)).toBe(1);
    expect(normalizedScore(F, F)).toBe(0);
    expect(normalizedScore(1.5, F)).toBe(1);
  });

  it("rescales the SAME cosine differently under a different floor", () => {
    // Which is the reason the floor is per (model, use_case) at all.
    expect(normalizedScore(0.86, 0.83)).toBeCloseTo(0.1765, 3);
    expect(normalizedScore(0.86, 0.5)).toBeCloseTo(0.72, 3);
  });

  it("refuses a floor that is not a cosine in [0, 1) rather than dividing by zero", () => {
    for (const bad of [1, 1.2, -0.1, Number.NaN]) {
      expect(() => normalizedScore(0.9, bad)).toThrow(/floor must be a cosine/);
    }
  });

  it("treats a non-finite cosine as no similarity", () => {
    expect(normalizedScore(Number.NaN, F)).toBe(0);
  });
});
