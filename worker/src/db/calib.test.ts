// ===========================================================================
// Unit tests for db/calib.ts over a real temp SQLite DB (build item 0.7).
//
// What is under test here is storage discipline, not policy:
//
//   - a floor is only ever written as a cosine in [0, 1) for a KNOWN use case,
//     because a bad row read back later is indistinguishable from a good one;
//   - a re-measurement REPLACES its row rather than accumulating a second one;
//   - the vector sources are filtered by (model, dim), so a floor can never be
//     measured across two embedding spaces;
//   - a missing table reads as "no data", never as a crash on the boot path.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CALIB_USE_CASES,
  CALIB_VECTOR_SOURCES,
  calibTablePresent,
  clearCalib,
  countCalibVectors,
  isCalibUseCase,
  putCalib,
  putCalibRows,
  readAllCalib,
  readCalib,
  readCalibForModel,
  readCalibVectors,
  resetCalibCacheForTests,
} from "./calib.js";
import { closeDb, getDb } from "./connection.js";
import { encodeVector } from "./embeddings.js";
import { runMigrations } from "./index.js";

const MODEL = "Xenova/multilingual-e5-small";
const DIM = 4;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-calib-db-"));
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

function vec(values: number[]): Buffer {
  return encodeVector(Float32Array.from(values));
}

/** Seed `n` episode vectors in one embedding space. */
function seedEpisodeVectors(n: number, model = MODEL, dim = DIM): void {
  const db = getDb();
  const ep = db.prepare(`INSERT INTO episodes (id) VALUES (?)`);
  const emb = db.prepare(
    `INSERT INTO episode_embeddings (episode_id, vec, model, dim) VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `ep-${model}-${dim}-${i}`;
      ep.run(id);
      const values = Array.from({ length: dim }, (_, k) => Math.sin(i + k + 1));
      emb.run(id, vec(values), model, dim);
    }
  })();
}

describe("use cases", () => {
  it("names exactly the six the architecture lists, in order", () => {
    expect([...CALIB_USE_CASES]).toEqual([
      "entity_name",
      "entity_rich_text",
      "episode_topic",
      "arc_topic",
      "claim_text",
      "loop_intent",
    ]);
  });

  it("recognises its own use cases and nothing else", () => {
    for (const uc of CALIB_USE_CASES) expect(isCalibUseCase(uc)).toBe(true);
    expect(isCalibUseCase("entity")).toBe(false);
    expect(isCalibUseCase("")).toBe(false);
    expect(isCalibUseCase(null)).toBe(false);
  });

  it("has a vector source for every use case", () => {
    for (const uc of CALIB_USE_CASES) {
      const src = CALIB_VECTOR_SOURCES[uc];
      expect(src.table.length).toBeGreaterThan(0);
      const exists = getDb()
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(src.table);
      expect(exists, `${uc} reads ${src.table}`).toBeTruthy();
    }
  });
});

describe("rows", () => {
  it("has the table after migration 0020", () => {
    expect(calibTablePresent()).toBe(true);
  });

  it("reads back nothing before anything is measured", () => {
    expect(readCalib(MODEL, "entity_name")).toBeNull();
    expect(readCalibForModel(MODEL)).toEqual([]);
    expect(readAllCalib()).toEqual([]);
  });

  it("round-trips a measured floor", () => {
    putCalib({
      model: MODEL,
      useCase: "claim_text",
      floor: 0.8237,
      nPairs: 1000,
      measuredAt: "2026-08-15T10:00:00.000Z",
    });
    expect(readCalib(MODEL, "claim_text")).toEqual({
      model: MODEL,
      useCase: "claim_text",
      floor: 0.8237,
      nPairs: 1000,
      measuredAt: "2026-08-15T10:00:00.000Z",
    });
  });

  it("REPLACES a row on re-measurement instead of accumulating one", () => {
    putCalib({ model: MODEL, useCase: "arc_topic", floor: 0.8, nPairs: 1000 });
    putCalib({ model: MODEL, useCase: "arc_topic", floor: 0.84, nPairs: 2000 });
    const rows = readCalibForModel(MODEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].floor).toBeCloseTo(0.84, 10);
    expect(rows[0].nPairs).toBe(2000);
  });

  it("keeps one row per (model, use_case) — a model swap does not overwrite", () => {
    putCalib({ model: MODEL, useCase: "arc_topic", floor: 0.82, nPairs: 1000 });
    putCalib({ model: "other/model", useCase: "arc_topic", floor: 0.41, nPairs: 1000 });
    expect(readCalib(MODEL, "arc_topic")?.floor).toBeCloseTo(0.82, 10);
    expect(readCalib("other/model", "arc_topic")?.floor).toBeCloseTo(0.41, 10);
    expect(readAllCalib()).toHaveLength(2);
  });

  it("writes six independent rows, one per use case", () => {
    putCalibRows(
      CALIB_USE_CASES.map((useCase, i) => ({
        model: MODEL,
        useCase,
        floor: 0.7 + i / 100,
        nPairs: 1000 + i,
      })),
    );
    const rows = readCalibForModel(MODEL);
    expect(rows.map((r) => r.useCase)).toEqual([...CALIB_USE_CASES]);
    expect(new Set(rows.map((r) => r.floor)).size).toBe(6);
  });

  it("refuses a floor that is not a cosine in [0, 1)", () => {
    for (const bad of [1, 1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        putCalib({ model: MODEL, useCase: "loop_intent", floor: bad, nPairs: 1000 }),
      ).toThrow(/floor must be a cosine/);
    }
    expect(readCalib(MODEL, "loop_intent")).toBeNull();
  });

  it("refuses an unknown use case", () => {
    expect(() =>
      putCalib({
        model: MODEL,
        // deliberately outside the union — this is the runtime guard
        useCase: "entity" as never,
        floor: 0.8,
        nPairs: 1000,
      }),
    ).toThrow(/unknown calibration use case/);
  });

  it("refuses a negative pair count", () => {
    expect(() =>
      putCalib({ model: MODEL, useCase: "loop_intent", floor: 0.8, nPairs: -1 }),
    ).toThrow(/n_pairs/);
  });

  it("hides a hand-written row whose floor or use case is unusable", () => {
    getDb()
      .prepare(
        `INSERT INTO embedder_calib (model, use_case, floor, measured_at, n_pairs)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(MODEL, "entity", 0.8, "2026-08-15T10:00:00.000Z", 1000);
    getDb()
      .prepare(
        `INSERT INTO embedder_calib (model, use_case, floor, measured_at, n_pairs)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(MODEL, "claim_text", 1.0, "2026-08-15T10:00:00.000Z", 1000);
    // Both rows are on disk; neither is readable as a calibration.
    expect(readCalib(MODEL, "claim_text")).toBeNull();
    expect(readAllCalib()).toEqual([]);
  });

  it("clears by model, by use case, or entirely", () => {
    putCalib({ model: MODEL, useCase: "arc_topic", floor: 0.8, nPairs: 1000 });
    putCalib({ model: MODEL, useCase: "claim_text", floor: 0.8, nPairs: 1000 });
    putCalib({ model: "other/model", useCase: "arc_topic", floor: 0.4, nPairs: 1000 });

    expect(clearCalib({ model: MODEL, useCase: "arc_topic" })).toBe(1);
    expect(clearCalib({ useCase: "arc_topic" })).toBe(1);
    expect(clearCalib({ model: MODEL })).toBe(1);
    expect(readAllCalib()).toEqual([]);
    expect(clearCalib()).toBe(0);
  });
});

describe("vector sources", () => {
  it("counts and reads only the requested (model, dim)", () => {
    seedEpisodeVectors(10, MODEL, DIM);
    seedEpisodeVectors(4, "other/model", DIM);
    seedEpisodeVectors(3, MODEL, 8);

    expect(countCalibVectors("episode_topic", { model: MODEL, dim: DIM })).toBe(10);
    expect(countCalibVectors("episode_topic", { model: "other/model", dim: DIM })).toBe(4);
    expect(countCalibVectors("episode_topic", { model: MODEL, dim: 8 })).toBe(3);

    const vectors = readCalibVectors("episode_topic", { model: MODEL, dim: DIM });
    expect(vectors).toHaveLength(10);
    for (const v of vectors) expect(v.length).toBe(DIM);
  });

  it("reads arc_topic out of the episode-topic space (there is no arc_embeddings)", () => {
    seedEpisodeVectors(6);
    expect(CALIB_VECTOR_SOURCES.arc_topic.table).toBe("episode_embeddings");
    expect(countCalibVectors("arc_topic", { model: MODEL, dim: DIM })).toBe(6);
  });

  it("counts zero for a use case whose corpus is empty", () => {
    seedEpisodeVectors(6);
    expect(countCalibVectors("claim_text", { model: MODEL, dim: DIM })).toBe(0);
    expect(readCalibVectors("claim_text", { model: MODEL, dim: DIM })).toEqual([]);
  });

  it("drops a row whose blob disagrees with its own dim", () => {
    seedEpisodeVectors(2);
    const db = getDb();
    db.prepare(`INSERT INTO episodes (id) VALUES ('ep-bad')`).run();
    db.prepare(
      `INSERT INTO episode_embeddings (episode_id, vec, model, dim) VALUES (?, ?, ?, ?)`,
    ).run("ep-bad", vec([1, 2]), MODEL, DIM);
    expect(countCalibVectors("episode_topic", { model: MODEL, dim: DIM })).toBe(3);
    expect(readCalibVectors("episode_topic", { model: MODEL, dim: DIM })).toHaveLength(2);
  });

  it("honours the read limit", () => {
    seedEpisodeVectors(20);
    expect(readCalibVectors("episode_topic", { model: MODEL, dim: DIM }, 5)).toHaveLength(5);
  });
});

describe("a database without the V2 tables", () => {
  it("reads as no-data and refuses to write, instead of throwing on boot", () => {
    // A bare DB file: no migrations at all, so `embedder_calib` is absent.
    const bare = join(tmpDir, "bare.db");
    new Database(bare).close();
    closeDb();
    resetCalibCacheForTests();
    process.env.SUPERTWIN_DB_PATH = bare;
    // getDb() runs migrations, so drop the table back out to model the case.
    getDb().prepare(`DROP TABLE embedder_calib`).run();
    getDb().prepare(`DROP TABLE episode_embeddings`).run();
    resetCalibCacheForTests();

    expect(calibTablePresent()).toBe(false);
    expect(readCalib(MODEL, "arc_topic")).toBeNull();
    expect(readAllCalib()).toEqual([]);
    expect(readCalibForModel(MODEL)).toEqual([]);
    expect(countCalibVectors("episode_topic", { model: MODEL, dim: DIM })).toBe(0);
    expect(readCalibVectors("episode_topic", { model: MODEL, dim: DIM })).toEqual([]);
    expect(clearCalib()).toBe(0);
    expect(() => putCalib({ model: MODEL, useCase: "arc_topic", floor: 0.8, nPairs: 1000 })).toThrow(
      /migration 0020/,
    );
  });
});
