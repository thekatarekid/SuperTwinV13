// ===========================================================================
// [ML] Embedder calibration — arch §10.3 ("Embedder calibration — a
// prerequisite, not an optimisation"), §10.5 ladder rung ③, build item 0.7.
//
// The shipped embedder does not score unrelated text at ~0. `multilingual-e5-small`
// scores two random, unrelated strings at ~0.75–0.85, so an absolute bar of
// "0.85 means the same thing" sits INSIDE the noise: in a prior run 50 of 54
// comparisons collapsed to "same" and 30 of 62 claims were folded across
// topics. The fix is not a better constant. There is no good constant — the
// floor moves with the model AND with the kind of text being compared.
//
// So the floor is MEASURED:
//
//   1. sample ≥1,000 random unrelated pairs from the vectors already stored
//      for one (model, dim) space and one use case;
//   2. take the high quantile of their cosines — the top of the noise band;
//   3. persist it per (model, use_case) in `embedder_calib`;
//   4. score every later pair as `(cos − floor) / (1 − floor)`, so 0 means
//      "no closer than two unrelated things" and 1 means "identical".
//
// And when there is no measurement — a cold install, a swapped model, a row
// older than the staleness limit — the [ML] rung is DISABLED for that use
// case. Pairs route to the agent, or to the question queue when no agent is
// available. Nothing here ever guesses a threshold; arch §14.2 gates
// "similarity run with stale/absent calibration" at > 0, i.e. never.
//
// Bars are on the NORMALISED scale, not on raw cosine, and they are per use
// case. `arc_topic` sits strictly above `episode_topic` (arch §11.2 rung ③:
// "calibrated, bar HIGHER than episode attach") — joining two weeks of life
// into one arc is a bigger claim than attaching one session to an episode.
// ===========================================================================

import {
  CALIB_USE_CASES,
  countCalibVectors,
  putCalib,
  readCalib,
  readCalibVectors,
  type CalibRow,
  type CalibUseCase,
} from "../db/calib.js";
import {
  MAX_MEASURABLE_FLOOR,
  MIN_CALIB_PAIRS,
  MIN_CALIB_VECTORS,
  measureFloor,
  normalizedScore,
  type FloorMeasurement,
} from "./calibration-floor.js";
import { assertRichText } from "./calibration-text.js";
import { getEmbedder } from "./embedder.js";
import { activeEmbeddingModel } from "./model-registry.js";
import { cosine } from "./semantic.js";

// One import site for the whole calibration surface: the measurement half
// (./calibration-floor) and the rich-text guard (./calibration-text) are split
// for size, not because a caller should have to know which is which.
export { CALIB_USE_CASES, type CalibUseCase };
export {
  CalibrationError,
  DEFAULT_CALIB_SEED,
  FLOOR_QUANTILE,
  MAX_MEASURABLE_FLOOR,
  MIN_CALIB_PAIRS,
  MIN_CALIB_VECTORS,
  NEAR_DUPLICATE_COS,
  measureFloor,
  normalizedScore,
  samplePairs,
  type FloorMeasurement,
  type MeasureFloorOptions,
} from "./calibration-floor.js";
export {
  BareStringComparisonError,
  RICH_TEXT_MIN_CHARS,
  RICH_TEXT_MIN_TOKENS,
  assertRichText,
  buildRichText,
  isRichText,
  type RichTextParts,
} from "./calibration-text.js";

// ---- Staleness ------------------------------------------------------------

/** Older than this and the calibration is STALE — the rung blocks. */
export const CALIB_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Older than this and startup RE-MEASURES it, though it still counts as valid
 * meanwhile. Arch §10.3 ¶5: calibration "is refined as the corpus grows".
 */
export const CALIB_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

// ---- Bars -----------------------------------------------------------------

/** Normalised-score bars for one use case. */
export interface UseCaseBars {
  /** At or above this the [ML] rung may decide "same" on its own. */
  bind: number;
  /** At or above this (and below `bind`) the pair goes to the agent. */
  band: number;
}

/**
 * The bars, on the normalised 0..1 scale. `entity_name` is the highest bar of
 * the entity pair because a name channel carries the least context; `arc_topic`
 * sits strictly above `episode_topic` on BOTH bars, which is asserted below and
 * again in the tests.
 */
export const USE_CASE_BARS: Readonly<Record<CalibUseCase, UseCaseBars>> = {
  entity_name: { bind: 0.72, band: 0.45 },
  entity_rich_text: { bind: 0.62, band: 0.38 },
  episode_topic: { bind: 0.55, band: 0.32 },
  arc_topic: { bind: 0.7, band: 0.45 },
  claim_text: { bind: 0.66, band: 0.4 },
  loop_intent: { bind: 0.6, band: 0.36 },
};

/**
 * The one ordering the architecture states outright. Checked at module load so
 * a future edit to the table above cannot quietly invert it.
 */
export function assertBarOrdering(bars = USE_CASE_BARS): void {
  const arc = bars.arc_topic;
  const ep = bars.episode_topic;
  if (!(arc.bind > ep.bind) || !(arc.band > ep.band)) {
    throw new Error(
      `calibration: arc_topic bars must be strictly higher than episode_topic ` +
        `(arc bind ${arc.bind}/band ${arc.band} vs episode bind ${ep.bind}/band ${ep.band})`,
    );
  }
  for (const useCase of CALIB_USE_CASES) {
    const b = bars[useCase];
    if (!(b.bind > b.band) || b.band < 0 || b.bind > 1) {
      throw new Error(`calibration: bars for ${useCase} are not an ordered 0..1 band`);
    }
  }
}

assertBarOrdering();

// ---- Freshness ------------------------------------------------------------

export type CalibrationState = "ready" | "missing" | "stale";

export interface CalibrationVerdict {
  useCase: CalibUseCase;
  model: string;
  state: CalibrationState;
  /** The measured floor, or null when there is nothing usable to read. */
  floor: number | null;
  measuredAt: string | null;
  nPairs: number | null;
  ageMs: number | null;
  /** Why, in words, for the status surface and the failure diff. */
  reason: string;
}

export interface CalibrationLookupOptions {
  model?: string;
  now?: number;
  /** Injected row, so a caller holding one need not re-read it. */
  row?: CalibRow | null;
}

function activeModelId(): string {
  return activeEmbeddingModel().id;
}

/** Judge one (model, use_case): ready, never measured, or too old / too thin. */
export function calibrationFor(
  useCase: CalibUseCase,
  opts: CalibrationLookupOptions = {},
): CalibrationVerdict {
  const model = opts.model ?? activeModelId();
  const now = opts.now ?? Date.now();
  const row = opts.row !== undefined ? opts.row : readCalib(model, useCase);

  const base = { useCase, model, floor: null, measuredAt: null, nPairs: null, ageMs: null };
  if (!row) {
    return {
      ...base,
      state: "missing",
      reason: `no calibration row for (${model}, ${useCase}) — the floor has never been measured`,
    };
  }

  const measuredMs = row.measuredAt ? Date.parse(row.measuredAt) : Number.NaN;
  const ageMs = Number.isFinite(measuredMs) ? now - measuredMs : null;
  const detail = {
    ...base,
    floor: row.floor,
    measuredAt: row.measuredAt,
    nPairs: row.nPairs,
    ageMs,
  };

  if (ageMs === null) {
    return {
      ...detail,
      state: "stale",
      reason: `calibration for (${model}, ${useCase}) has no readable measured_at`,
    };
  }
  if ((row.nPairs ?? 0) < MIN_CALIB_PAIRS) {
    return {
      ...detail,
      state: "stale",
      reason: `calibration for (${model}, ${useCase}) was measured from ${row.nPairs ?? 0} pairs, fewer than the ${MIN_CALIB_PAIRS} required`,
    };
  }
  if (ageMs > CALIB_STALE_MS) {
    return {
      ...detail,
      state: "stale",
      reason: `calibration for (${model}, ${useCase}) is ${Math.floor(ageMs / 86_400_000)}d old, past the ${Math.floor(CALIB_STALE_MS / 86_400_000)}d limit`,
    };
  }
  return {
    ...detail,
    state: "ready",
    reason: `floor ${row.floor.toFixed(4)} from ${row.nPairs} pairs at ${row.measuredAt}`,
  };
}

/** Every use case's verdict for one model — the status surface. */
export function calibrationStatus(opts: CalibrationLookupOptions = {}): CalibrationVerdict[] {
  return CALIB_USE_CASES.map((useCase) => calibrationFor(useCase, opts));
}

/**
 * Whether the [ML] similarity rung may run at all for this use case. The one
 * question every similarity caller must ask BEFORE it embeds anything.
 */
export function similarityRungEnabled(
  useCase: CalibUseCase,
  opts: CalibrationLookupOptions = {},
): boolean {
  return calibrationFor(useCase, opts).state === "ready";
}

// ---- Pair decisions -------------------------------------------------------

/** Where a pair goes next. `ml` is the only one this module decides itself. */
export type SimilarityRoute = "ml" | "agent" | "question_queue";

export type PairVerdict = "same" | "unsure" | "different" | "blocked";

export interface PairDecision {
  useCase: CalibUseCase;
  route: SimilarityRoute;
  verdict: PairVerdict;
  /** Normalised score, or null when the rung was blocked (never a guess). */
  score: number | null;
  cosine: number | null;
  bars: UseCaseBars;
  calibration: CalibrationVerdict;
  reason: string;
}

export interface ScorePairOptions extends CalibrationLookupOptions {
  /**
   * False when no adjudicating agent is available (bootstrap batch, offline
   * run): blocked pairs go to the question queue instead of nowhere.
   */
  agentAvailable?: boolean;
}

/**
 * Route one pair. This is the only place a cosine becomes a decision.
 *
 * With no usable calibration the cosine is not scored, not compared, and not
 * reported — it is not information yet. The pair leaves for the agent or the
 * question queue with the reason attached.
 */
export function scoreCalibratedPair(
  useCase: CalibUseCase,
  cos: number,
  opts: ScorePairOptions = {},
): PairDecision {
  const calibration = calibrationFor(useCase, opts);
  const bars = USE_CASE_BARS[useCase];

  if (calibration.state !== "ready" || calibration.floor === null) {
    return blocked(calibration, opts, `[ML] similarity disabled: ${calibration.reason}`);
  }

  const score = normalizedScore(cos, calibration.floor);
  if (score >= bars.bind) {
    return {
      useCase,
      route: "ml",
      verdict: "same",
      score,
      cosine: cos,
      bars,
      calibration,
      reason: `normalised ${score.toFixed(3)} ≥ bind bar ${bars.bind}`,
    };
  }
  if (score >= bars.band) {
    const route: SimilarityRoute = opts.agentAvailable === false ? "question_queue" : "agent";
    return {
      useCase,
      route,
      verdict: "unsure",
      score,
      cosine: cos,
      bars,
      calibration,
      reason: `normalised ${score.toFixed(3)} is in the ${bars.band}–${bars.bind} band`,
    };
  }
  return {
    useCase,
    route: "ml",
    verdict: "different",
    score,
    cosine: cos,
    bars,
    calibration,
    reason: `normalised ${score.toFixed(3)} < band floor ${bars.band}`,
  };
}

/**
 * A pair this module refuses to judge. No score and no cosine — reporting one
 * is what makes a blocked comparison look like a weak match downstream.
 */
function blocked(
  calibration: CalibrationVerdict,
  opts: ScorePairOptions,
  reason: string,
): PairDecision {
  return {
    useCase: calibration.useCase,
    route: opts.agentAvailable === false ? "question_queue" : "agent",
    verdict: "blocked",
    score: null,
    cosine: null,
    bars: USE_CASE_BARS[calibration.useCase],
    calibration,
    reason,
  };
}

export interface ScoreRichTextOptions extends ScorePairOptions {
  /** Text→vector. Defaults to the loaded embedder. */
  embed?: (texts: readonly string[]) => Promise<Float32Array[]>;
}

/**
 * Route a pair given as TEXT — the entry point every similarity caller should
 * use, because it is the one that enforces both rules at once:
 *
 *   1. the gate is checked BEFORE anything is embedded, so a cold install
 *      spends no model time discovering it may not use the answer, and
 *   2. bare short strings are refused outright.
 */
export async function scoreRichTextPair(
  useCase: CalibUseCase,
  left: string,
  right: string,
  opts: ScoreRichTextOptions = {},
): Promise<PairDecision> {
  const calibration = calibrationFor(useCase, opts);
  if (calibration.state !== "ready" || calibration.floor === null) {
    // Blocked: no embedding, no cosine, no guessed threshold.
    return blocked(calibration, opts, `[ML] similarity disabled: ${calibration.reason}`);
  }
  assertRichText(left, `scoreRichTextPair(${useCase}, left)`);
  assertRichText(right, `scoreRichTextPair(${useCase}, right)`);

  const embed = opts.embed ?? defaultEmbed;
  const [a, b] = await embed([left, right]);
  if (!a || !b) {
    // The calibration is fine; the EMBEDDER produced nothing. Same routing,
    // different reason — and still no invented number.
    return blocked(calibration, opts, "[ML] similarity skipped: the embedder returned no vector");
  }
  // The verdict already read the row, so hand it back rather than re-reading.
  return scoreCalibratedPair(useCase, cosine(a, b), { ...opts, row: toRowLike(calibration) });
}

function toRowLike(verdict: CalibrationVerdict): CalibRow {
  return {
    model: verdict.model,
    useCase: verdict.useCase,
    floor: verdict.floor ?? 0,
    measuredAt: verdict.measuredAt,
    nPairs: verdict.nPairs,
  };
}

async function defaultEmbed(texts: readonly string[]): Promise<Float32Array[]> {
  const embedder = await getEmbedder();
  if (!embedder) return [];
  return embedder.embed(texts, "passage");
}

// ---- Startup --------------------------------------------------------------

export type CalibrationOutcomeStatus =
  | "measured"
  | "fresh"
  | "insufficient-vectors"
  | "degenerate"
  | "failed";

export interface UseCaseCalibrationOutcome {
  useCase: CalibUseCase;
  status: CalibrationOutcomeStatus;
  floor: number | null;
  nPairs: number;
  vectors: number;
  reason: string;
}

export interface StartupCalibrationReport {
  model: string;
  dim: number;
  ranAt: string;
  outcomes: UseCaseCalibrationOutcome[];
  /** The use cases whose [ML] rung is live after this pass. */
  enabled: CalibUseCase[];
}

export interface StartupCalibrationOptions {
  model?: string;
  dim?: number;
  now?: number;
  seed?: number;
  pairs?: number;
  /** Re-measure even rows that are still fresh. */
  force?: boolean;
}

/**
 * Measure and persist every use case's floor for the active embedding space.
 *
 * Called at boot, and safe to call again: a row younger than CALIB_REFRESH_MS
 * is left alone, an older one is re-measured against the grown corpus, and a
 * use case with too few vectors is SKIPPED — leaving its rung blocked, which
 * is what a cold install must look like.
 *
 * A model swap needs no special case: the new model has no rows, so every use
 * case measures from scratch against vectors written in the new space, and
 * until it does, every rung is off.
 */
export function runStartupCalibration(
  opts: StartupCalibrationOptions = {},
): StartupCalibrationReport {
  const spec = activeEmbeddingModel();
  const model = opts.model ?? spec.id;
  const dim = opts.dim ?? spec.dim;
  const now = opts.now ?? Date.now();
  const ranAt = new Date(now).toISOString();
  const key = { model, dim };

  const outcomes: UseCaseCalibrationOutcome[] = [];
  for (const useCase of CALIB_USE_CASES) {
    outcomes.push(calibrateUseCase(useCase, key, now, opts));
  }

  const enabled = CALIB_USE_CASES.filter(
    (useCase) => calibrationFor(useCase, { model, now }).state === "ready",
  );
  return { model, dim, ranAt, outcomes, enabled };
}

function calibrateUseCase(
  useCase: CalibUseCase,
  key: { model: string; dim: number },
  now: number,
  opts: StartupCalibrationOptions,
): UseCaseCalibrationOutcome {
  const existing = calibrationFor(useCase, { model: key.model, now });
  if (
    !opts.force &&
    existing.state === "ready" &&
    existing.ageMs !== null &&
    existing.ageMs < CALIB_REFRESH_MS
  ) {
    return {
      useCase,
      status: "fresh",
      floor: existing.floor,
      nPairs: existing.nPairs ?? 0,
      vectors: 0,
      reason: existing.reason,
    };
  }

  const available = countCalibVectors(useCase, key);
  if (available < MIN_CALIB_VECTORS) {
    return {
      useCase,
      status: "insufficient-vectors",
      floor: null,
      nPairs: 0,
      vectors: available,
      reason: `${available} stored vectors for ${useCase} in ${key.model}/${key.dim}, below the ${MIN_CALIB_VECTORS} needed — [ML] similarity stays disabled`,
    };
  }

  let measurement: FloorMeasurement;
  try {
    measurement = measureFloor(readCalibVectors(useCase, key), {
      pairs: opts.pairs ?? MIN_CALIB_PAIRS,
      seed: opts.seed,
    });
  } catch (err) {
    return {
      useCase,
      status: "failed",
      floor: null,
      nPairs: 0,
      vectors: available,
      reason: (err as Error).message,
    };
  }

  if (measurement.floor >= MAX_MEASURABLE_FLOOR) {
    return {
      useCase,
      status: "degenerate",
      floor: measurement.floor,
      nPairs: measurement.nPairs,
      vectors: measurement.vectors,
      reason: `measured floor ${measurement.floor.toFixed(4)} leaves no usable range below ${MAX_MEASURABLE_FLOOR} — not persisted, [ML] similarity stays disabled`,
    };
  }

  putCalib({
    model: key.model,
    useCase,
    floor: measurement.floor,
    nPairs: measurement.nPairs,
    measuredAt: new Date(now).toISOString(),
  });
  return {
    useCase,
    status: "measured",
    floor: measurement.floor,
    nPairs: measurement.nPairs,
    vectors: measurement.vectors,
    reason: `floor ${measurement.floor.toFixed(4)} (mean ${measurement.mean.toFixed(4)}, max ${measurement.max.toFixed(4)}) from ${measurement.nPairs} unrelated pairs`,
  };
}
