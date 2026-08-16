// ===========================================================================
// Embedder calibration — the gate, the per-use-case bars, and startup
// (build item 0.7; evals V-009…V-015, plus the two acceptance boxes:
// "stale calib blocks similarity" and "a cold install does not run similarity
// before calibration").
//
// The invariant every test here circles is arch §14.2's calib gate:
// "similarity run with stale/absent calibration" must stay at ZERO. So the
// assertions are mostly about what does NOT happen — no score, no cosine, no
// embedding call — when there is no measurement to normalise against.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CALIB_USE_CASES,
  CALIB_VECTOR_SOURCES,
  putCalib,
  readCalib,
  readCalibForModel,
  resetCalibCacheForTests,
  type CalibUseCase,
} from "../db/calib.js";
import { closeDb, getDb } from "../db/connection.js";
import { encodeVector } from "../db/embeddings.js";
import { runMigrations } from "../db/index.js";
import {
  BareStringComparisonError,
  CALIB_REFRESH_MS,
  CALIB_STALE_MS,
  MIN_CALIB_PAIRS,
  MIN_CALIB_VECTORS,
  USE_CASE_BARS,
  assertBarOrdering,
  assertRichText,
  buildRichText,
  calibrationFor,
  calibrationStatus,
  isRichText,
  normalizedScore,
  runStartupCalibration,
  scoreCalibratedPair,
  scoreRichTextPair,
  similarityRungEnabled,
} from "./calibration.js";
import { listEmbeddingModels, setActiveEmbeddingModelId } from "./model-registry.js";
import { referenceCorpus } from "./__fixtures__/reference-corpus.js";

const MODEL_A = listEmbeddingModels()[0];
const MODEL_B = listEmbeddingModels()[1];
const DAY = 86_400_000;
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-calibration-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  resetCalibCacheForTests();
  runMigrations();
});

afterEach(() => {
  closeDb();
  resetCalibCacheForTests();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Seeding --------------------------------------------------------------

/** The parent row each vector table needs before it will accept a vector. */
const PARENTS: Record<string, (id: string) => { sql: string; args: unknown[] }> = {
  entity_embeddings: (id) => ({ sql: `INSERT INTO entities (id, type) VALUES (?, 'person')`, args: [id] }),
  episode_embeddings: (id) => ({ sql: `INSERT INTO episodes (id) VALUES (?)`, args: [id] }),
  claim_embeddings: (id) => ({
    sql: `INSERT INTO claim_versions (id, claim_key, stated_at) VALUES (?, ?, '2026-01-01T00:00:00Z')`,
    args: [id, `key-${id}`],
  }),
  loop_embeddings: (id) => ({
    sql: `INSERT INTO loops (id, loop_key) VALUES (?, ?)`,
    args: [id, `key-${id}`],
  }),
};

/**
 * Put `count` reference-corpus vectors into the table one use case reads from,
 * tagged with (model, dim). This is the corpus a startup calibration measures.
 */
function seedVectors(
  useCase: CalibUseCase,
  count: number,
  model = MODEL_A.id,
  dim = MODEL_A.dim,
  seed = 20260815,
): void {
  const src = CALIB_VECTOR_SOURCES[useCase];
  const corpus = referenceCorpus({ count, dim, seed });
  const db = getDb();
  const parent = PARENTS[src.table];
  const insert = db.prepare(
    `INSERT INTO ${src.table} (${src.idColumn}, ${src.vecColumn}, model, dim) VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `${src.table}-${model}-${dim}-${i}`;
      const p = parent(id);
      db.prepare(p.sql).run(...(p.args as never[]));
      insert.run(id, encodeVector(corpus.vectors[i]), model, dim);
    }
  })();
}

/** Write a calibration row directly, at a chosen age. */
function seedCalib(
  useCase: CalibUseCase,
  opts: { ageMs?: number; nPairs?: number; floor?: number; model?: string; measuredAt?: string } = {},
): void {
  putCalib({
    model: opts.model ?? MODEL_A.id,
    useCase,
    floor: opts.floor ?? 0.82,
    nPairs: opts.nPairs ?? MIN_CALIB_PAIRS,
    measuredAt: opts.measuredAt ?? new Date(NOW - (opts.ageMs ?? DAY)).toISOString(),
  });
}

// ---- Bars (V-009 … V-014) -------------------------------------------------

describe("per-use-case thresholds", () => {
  it("gives every one of the six use cases its own bars", () => {
    for (const useCase of CALIB_USE_CASES) {
      const bars = USE_CASE_BARS[useCase];
      expect(bars, useCase).toBeDefined();
      expect(bars.bind).toBeGreaterThan(bars.band);
      expect(bars.band).toBeGreaterThanOrEqual(0);
      expect(bars.bind).toBeLessThanOrEqual(1);
    }
  });

  it("V-012 vs V-011: the arc_topic bar is STRICTLY higher than episode_topic", () => {
    expect(USE_CASE_BARS.arc_topic.bind).toBeGreaterThan(USE_CASE_BARS.episode_topic.bind);
    expect(USE_CASE_BARS.arc_topic.band).toBeGreaterThan(USE_CASE_BARS.episode_topic.band);
    expect(() => assertBarOrdering()).not.toThrow();
  });

  it("refuses an inverted bar table rather than shipping it", () => {
    expect(() =>
      assertBarOrdering({
        ...USE_CASE_BARS,
        arc_topic: { bind: 0.4, band: 0.2 },
      }),
    ).toThrow(/strictly higher/);
    expect(() =>
      assertBarOrdering({ ...USE_CASE_BARS, claim_text: { bind: 0.2, band: 0.5 } }),
    ).toThrow(/ordered 0..1 band/);
  });

  it("the same normalised score binds an episode but only bands an arc", () => {
    for (const useCase of CALIB_USE_CASES) seedCalib(useCase, { floor: 0.8 });
    // floor 0.8, cos 0.92 → normalised 0.60: above the episode bind bar
    // (0.55), inside the arc band (0.45–0.70).
    const cos = 0.92;
    expect(normalizedScore(cos, 0.8)).toBeCloseTo(0.6, 10);
    const episode = scoreCalibratedPair("episode_topic", cos, { now: NOW });
    const arc = scoreCalibratedPair("arc_topic", cos, { now: NOW });
    expect(episode.verdict).toBe("same");
    expect(episode.route).toBe("ml");
    expect(arc.verdict).toBe("unsure");
    expect(arc.route).toBe("agent");
  });

  for (const useCase of CALIB_USE_CASES) {
    // V-009 … V-014, one per use case.
    it(`${useCase} gets its own (model, use_case) row and gate`, () => {
      expect(readCalib(MODEL_A.id, useCase)).toBeNull();
      expect(similarityRungEnabled(useCase, { model: MODEL_A.id, now: NOW })).toBe(false);

      seedCalib(useCase, { floor: 0.81 });

      const row = readCalib(MODEL_A.id, useCase);
      expect(row?.useCase).toBe(useCase);
      expect(row?.floor).toBeCloseTo(0.81, 10);
      expect(similarityRungEnabled(useCase, { model: MODEL_A.id, now: NOW })).toBe(true);
      // Calibrating one use case does not calibrate any other.
      for (const other of CALIB_USE_CASES) {
        if (other === useCase) continue;
        expect(similarityRungEnabled(other, { model: MODEL_A.id, now: NOW })).toBe(false);
      }
    });
  }
});

// ---- Freshness ------------------------------------------------------------

describe("calibration freshness", () => {
  it("reads a recent, well-sampled row as ready", () => {
    seedCalib("claim_text", { ageMs: 2 * DAY });
    const verdict = calibrationFor("claim_text", { model: MODEL_A.id, now: NOW });
    expect(verdict.state).toBe("ready");
    expect(verdict.floor).toBeCloseTo(0.82, 10);
    expect(verdict.ageMs).toBe(2 * DAY);
  });

  it("reads a never-measured row as missing", () => {
    const verdict = calibrationFor("claim_text", { model: MODEL_A.id, now: NOW });
    expect(verdict.state).toBe("missing");
    expect(verdict.floor).toBeNull();
    expect(verdict.reason).toMatch(/never been measured/);
  });

  it("reads an old row as stale", () => {
    seedCalib("claim_text", { ageMs: CALIB_STALE_MS + DAY });
    const verdict = calibrationFor("claim_text", { model: MODEL_A.id, now: NOW });
    expect(verdict.state).toBe("stale");
    expect(verdict.reason).toMatch(/past the 30d limit/);
  });

  it("reads an under-sampled row as stale, however recent", () => {
    seedCalib("claim_text", { ageMs: 1000, nPairs: 300 });
    const verdict = calibrationFor("claim_text", { model: MODEL_A.id, now: NOW });
    expect(verdict.state).toBe("stale");
    expect(verdict.reason).toMatch(/300 pairs, fewer than the 1000 required/);
  });

  it("reads an unreadable measured_at as stale", () => {
    seedCalib("claim_text", { measuredAt: "not-a-date" });
    expect(calibrationFor("claim_text", { model: MODEL_A.id, now: NOW }).state).toBe("stale");
  });

  it("reports all six use cases at once", () => {
    seedCalib("arc_topic");
    const status = calibrationStatus({ model: MODEL_A.id, now: NOW });
    expect(status.map((s) => s.useCase)).toEqual([...CALIB_USE_CASES]);
    expect(status.filter((s) => s.state === "ready")).toHaveLength(1);
    expect(status.filter((s) => s.state === "missing")).toHaveLength(5);
  });
});

// ---- The gate -------------------------------------------------------------

describe("stale or absent calibration blocks the [ML] rung", () => {
  it("routes to the agent with no score and no cosine when the row is missing", () => {
    const decision = scoreCalibratedPair("entity_rich_text", 0.97, { model: MODEL_A.id, now: NOW });
    expect(decision.verdict).toBe("blocked");
    expect(decision.route).toBe("agent");
    expect(decision.score).toBeNull();
    expect(decision.cosine).toBeNull();
    expect(decision.reason).toMatch(/\[ML\] similarity disabled/);
  });

  it("routes to the question queue when no agent is available", () => {
    const decision = scoreCalibratedPair("entity_rich_text", 0.97, {
      model: MODEL_A.id,
      now: NOW,
      agentAvailable: false,
    });
    expect(decision.route).toBe("question_queue");
    expect(decision.score).toBeNull();
  });

  it("blocks on a STALE row even though a floor is sitting right there", () => {
    seedCalib("entity_rich_text", { ageMs: CALIB_STALE_MS + DAY, floor: 0.8 });
    const decision = scoreCalibratedPair("entity_rich_text", 0.99, { model: MODEL_A.id, now: NOW });
    expect(decision.verdict).toBe("blocked");
    expect(decision.score).toBeNull();
    // 0.99 over a 0.8 floor would have been 0.95 — a confident bind. The point
    // is that an old floor is not evidence, however convenient its number is.
    expect(normalizedScore(0.99, 0.8)).toBeGreaterThan(USE_CASE_BARS.entity_rich_text.bind);
  });

  it("blocks on an under-sampled row", () => {
    seedCalib("loop_intent", { nPairs: MIN_CALIB_PAIRS - 1 });
    expect(similarityRungEnabled("loop_intent", { model: MODEL_A.id, now: NOW })).toBe(false);
    expect(scoreCalibratedPair("loop_intent", 0.99, { model: MODEL_A.id, now: NOW }).route).toBe(
      "agent",
    );
  });

  it("decides same / unsure / different once calibration is ready", () => {
    seedCalib("entity_rich_text", { floor: 0.8 });
    const opts = { model: MODEL_A.id, now: NOW };
    const same = scoreCalibratedPair("entity_rich_text", 0.95, opts);
    const unsure = scoreCalibratedPair("entity_rich_text", 0.9, opts);
    const different = scoreCalibratedPair("entity_rich_text", 0.82, opts);

    expect(same.verdict).toBe("same");
    expect(same.route).toBe("ml");
    expect(same.score).toBeCloseTo(0.75, 10);
    expect(unsure.verdict).toBe("unsure");
    expect(unsure.route).toBe("agent");
    expect(different.verdict).toBe("different");
    expect(different.route).toBe("ml");
    expect(different.score).toBeCloseTo(0.1, 10);
  });

  it("sends an in-band pair to the question queue when no agent is available", () => {
    seedCalib("entity_rich_text", { floor: 0.8 });
    const decision = scoreCalibratedPair("entity_rich_text", 0.9, {
      model: MODEL_A.id,
      now: NOW,
      agentAvailable: false,
    });
    expect(decision.verdict).toBe("unsure");
    expect(decision.route).toBe("question_queue");
  });
});

// ---- V-015: a swapped model ----------------------------------------------

describe("V-015 — the embedding model is swapped", () => {
  it("blocks every rung until the new model's floor has been measured", async () => {
    seedVectors("episode_topic", 64, MODEL_A.id, MODEL_A.dim);
    const first = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    expect(first.enabled).toContain("episode_topic");
    expect(similarityRungEnabled("episode_topic", { model: MODEL_A.id, now: NOW })).toBe(true);

    // The swap: app_state now points at another model, and its rows do not exist.
    setActiveEmbeddingModelId(MODEL_B.id);
    expect(similarityRungEnabled("episode_topic", { now: NOW })).toBe(false);
    const blocked = scoreCalibratedPair("episode_topic", 0.99, { now: NOW });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.calibration.model).toBe(MODEL_B.id);

    // Startup re-measures — but the corpus is still in the OLD model's space,
    // so there is nothing to measure yet and the rung stays off.
    const afterSwap = runStartupCalibration({ now: NOW });
    expect(afterSwap.model).toBe(MODEL_B.id);
    expect(afterSwap.enabled).toEqual([]);
    expect(afterSwap.outcomes.find((o) => o.useCase === "episode_topic")?.status).toBe(
      "insufficient-vectors",
    );

    // Once vectors exist in the new space, the floor is measured there.
    seedVectors("episode_topic", 64, MODEL_B.id, MODEL_B.dim, 4242);
    const remeasured = runStartupCalibration({ now: NOW });
    expect(remeasured.enabled).toContain("episode_topic");
    const rowB = readCalib(MODEL_B.id, "episode_topic");
    expect(rowB?.nPairs).toBe(MIN_CALIB_PAIRS);
    // The old model's row is untouched — a swap back does not re-measure.
    expect(readCalib(MODEL_A.id, "episode_topic")?.floor).toBeCloseTo(
      first.outcomes.find((o) => o.useCase === "episode_topic")?.floor ?? -1,
      10,
    );
  });
});

// ---- Cold install ---------------------------------------------------------

describe("a cold install", () => {
  it("calibrates nothing, enables nothing, and guesses nothing", () => {
    const report = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    expect(report.enabled).toEqual([]);
    expect(report.outcomes).toHaveLength(6);
    for (const outcome of report.outcomes) {
      expect(outcome.status).toBe("insufficient-vectors");
      expect(outcome.floor).toBeNull();
      expect(outcome.reason).toMatch(/\[ML\] similarity stays disabled/);
    }
    expect(readCalibForModel(MODEL_A.id)).toEqual([]);
    for (const useCase of CALIB_USE_CASES) {
      expect(similarityRungEnabled(useCase, { model: MODEL_A.id, now: NOW })).toBe(false);
    }
  });

  it("does not embed anything before calibration exists", async () => {
    const embed = vi.fn(async () => [] as Float32Array[]);
    const decision = await scoreRichTextPair(
      "entity_rich_text",
      buildRichText({ name: "Rahul Sharma", aliases: ["Rahul"], quote: "call the plumber" }),
      buildRichText({ name: "Rahul S", aliases: ["Rahul"], quote: "plumber is coming" }),
      { model: MODEL_A.id, now: NOW, embed },
    );
    expect(embed).not.toHaveBeenCalled();
    expect(decision.verdict).toBe("blocked");
    expect(decision.score).toBeNull();
  });

  it("skips a use case whose corpus is one vector short of measurable", () => {
    seedVectors("claim_text", MIN_CALIB_VECTORS - 1, MODEL_A.id, MODEL_A.dim);
    const report = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    const claim = report.outcomes.find((o) => o.useCase === "claim_text");
    expect(claim?.status).toBe("insufficient-vectors");
    expect(claim?.vectors).toBe(MIN_CALIB_VECTORS - 1);
    expect(readCalib(MODEL_A.id, "claim_text")).toBeNull();
  });
});

// ---- Startup measurement --------------------------------------------------

describe("startup calibration", () => {
  it("measures, persists and enables one use case at a time", () => {
    seedVectors("loop_intent", 64);
    const report = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });

    expect(report.enabled).toEqual(["loop_intent"]);
    const loop = report.outcomes.find((o) => o.useCase === "loop_intent");
    expect(loop?.status).toBe("measured");
    expect(loop?.nPairs).toBe(MIN_CALIB_PAIRS);
    expect(loop?.floor).toBeGreaterThanOrEqual(0.7);
    expect(loop?.floor).toBeLessThanOrEqual(0.9);

    const row = readCalib(MODEL_A.id, "loop_intent");
    expect(row?.floor).toBeCloseTo(loop?.floor ?? -1, 10);
    expect(row?.measuredAt).toBe(new Date(NOW).toISOString());
  });

  it("measures arc_topic and episode_topic as separate rows", () => {
    seedVectors("episode_topic", 64);
    const report = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    expect(report.enabled.sort()).toEqual(["arc_topic", "episode_topic"]);
    expect(readCalib(MODEL_A.id, "arc_topic")).not.toBeNull();
    expect(readCalib(MODEL_A.id, "episode_topic")).not.toBeNull();
  });

  it("leaves a fresh row alone and re-measures an ageing one", () => {
    seedVectors("loop_intent", 64);
    seedCalib("loop_intent", { ageMs: DAY, floor: 0.5 });
    const fresh = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    expect(fresh.outcomes.find((o) => o.useCase === "loop_intent")?.status).toBe("fresh");
    expect(readCalib(MODEL_A.id, "loop_intent")?.floor).toBeCloseTo(0.5, 10);

    seedCalib("loop_intent", { ageMs: CALIB_REFRESH_MS + DAY, floor: 0.5 });
    const refreshed = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    expect(refreshed.outcomes.find((o) => o.useCase === "loop_intent")?.status).toBe("measured");
    expect(readCalib(MODEL_A.id, "loop_intent")?.floor).toBeGreaterThan(0.7);
  });

  it("re-measures a fresh row when forced", () => {
    seedVectors("loop_intent", 64);
    seedCalib("loop_intent", { ageMs: DAY, floor: 0.5 });
    const report = runStartupCalibration({
      model: MODEL_A.id,
      dim: MODEL_A.dim,
      now: NOW,
      force: true,
    });
    expect(report.outcomes.find((o) => o.useCase === "loop_intent")?.status).toBe("measured");
  });

  it("refuses to persist a degenerate floor", () => {
    // 64 copies of one vector: every pair is cos 1.0, so there is no floor to
    // measure and nothing above it to score.
    const one = referenceCorpus({ count: 1, dim: MODEL_A.dim }).vectors[0];
    const db = getDb();
    db.transaction(() => {
      for (let i = 0; i < 64; i++) {
        db.prepare(`INSERT INTO loops (id, loop_key) VALUES (?, ?)`).run(`lp-${i}`, `k-${i}`);
        db.prepare(
          `INSERT INTO loop_embeddings (loop_id, vec, model, dim) VALUES (?, ?, ?, ?)`,
        ).run(`lp-${i}`, encodeVector(one), MODEL_A.id, MODEL_A.dim);
      }
    })();

    const report = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    const loop = report.outcomes.find((o) => o.useCase === "loop_intent");
    expect(["degenerate", "failed"]).toContain(loop?.status);
    expect(readCalib(MODEL_A.id, "loop_intent")).toBeNull();
    expect(report.enabled).toEqual([]);
  });

  it("is idempotent — running it twice changes nothing", () => {
    seedVectors("loop_intent", 64);
    const first = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    const second = runStartupCalibration({ model: MODEL_A.id, dim: MODEL_A.dim, now: NOW });
    expect(second.outcomes.find((o) => o.useCase === "loop_intent")?.status).toBe("fresh");
    expect(second.enabled).toEqual(first.enabled);
  });
});

// ---- Rich text ------------------------------------------------------------

describe("never compare bare short strings", () => {
  it("knows a bare name from rich text", () => {
    expect(isRichText("Ma")).toBe(false);
    expect(isRichText("Rahul")).toBe(false);
    expect(isRichText("plumber")).toBe(false);
    expect(isRichText("name: Rahul Sharma · aliases: Rahul")).toBe(true);
  });

  it("composes rich text in a stable field order", () => {
    const text = buildRichText({
      name: "Rahul Sharma",
      aliases: ["Rahul", "RS"],
      cooccurring: ["Ma", "plumber"],
      quote: "call the plumber tomorrow",
    });
    expect(text).toBe(
      "name: Rahul Sharma · aliases: Rahul, RS · with: Ma, plumber · quote: call the plumber tomorrow",
    );
    expect(isRichText(text)).toBe(true);
  });

  it("throws rather than embedding a bare string", () => {
    expect(() => assertRichText("Ma", "test")).toThrow(BareStringComparisonError);
    expect(() => assertRichText("Ma", "test")).toThrow(/bare short string/);
  });

  it("refuses a bare-string comparison even with calibration ready", async () => {
    seedCalib("entity_name", { floor: 0.8 });
    const embed = vi.fn(async () => []);
    await expect(
      scoreRichTextPair("entity_name", "Ma", "Max", { model: MODEL_A.id, now: NOW, embed }),
    ).rejects.toThrow(BareStringComparisonError);
    expect(embed).not.toHaveBeenCalled();
  });

  it("scores rich text against the measured floor", async () => {
    seedCalib("entity_rich_text", { floor: 0.8 });
    const corpus = referenceCorpus({ count: 400 });
    const embed = vi.fn(async () => [corpus.vectors[0], corpus.vectors[40]]);
    const decision = await scoreRichTextPair(
      "entity_rich_text",
      buildRichText({ name: "Rahul Sharma", aliases: ["Rahul"], quote: "call the plumber" }),
      buildRichText({ name: "Rahul S", aliases: ["Rahul"], quote: "the plumber came" }),
      { model: MODEL_A.id, now: NOW, embed },
    );
    expect(embed).toHaveBeenCalledTimes(1);
    expect(decision.cosine).not.toBeNull();
    expect(decision.score).not.toBeNull();
    expect(decision.calibration.state).toBe("ready");
  });

  it("blocks rather than guessing when the embedder returns nothing", async () => {
    seedCalib("entity_rich_text", { floor: 0.8 });
    const decision = await scoreRichTextPair(
      "entity_rich_text",
      buildRichText({ name: "Rahul Sharma", aliases: ["Rahul"], quote: "call the plumber" }),
      buildRichText({ name: "Rahul S", aliases: ["Rahul"], quote: "the plumber came" }),
      { model: MODEL_A.id, now: NOW, embed: async () => [] },
    );
    expect(decision.verdict).toBe("blocked");
    expect(decision.score).toBeNull();
  });
});
