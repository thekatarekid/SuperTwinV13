// ===========================================================================
// The [ML] drift pre-flag (arch §11.1, build item 2.1).
//
// The calibration gate is exercised against a real `embedder_calib` row in a
// real SQLite DB, because "no similarity call runs on an uncalibrated model"
// is a claim about the row, not about a boolean someone passed in.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { putCalib } from "../db/calib.js";
import { closeDb, runMigrations } from "../db/connection.js";
import { MIN_CALIB_PAIRS } from "../retrieval/calibration-floor.js";
import { centroid, driftWantsModel, preflagDrift, toVector, type DriftEvent } from "./preflag.js";

const MODEL = "test-embedder";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-preflag-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function calibrate(floor = 0.1): void {
  putCalib({
    model: MODEL,
    useCase: "episode_topic",
    floor,
    nPairs: MIN_CALIB_PAIRS,
    measuredAt: new Date(NOW - 86_400_000).toISOString(),
  });
}

const opts = { model: MODEL, now: NOW };

/** Two orthogonal topics, so a pivot is unmistakable and a run is flat. */
const GOA = [1, 0, 0];
const VET = [0, 1, 0];

function ev(id: string, vector: number[] | null, placeholder = false): DriftEvent {
  return { id, vector, placeholder };
}

describe("vector helpers", () => {
  it("takes arrays, Float32Arrays and nothing else", () => {
    expect(toVector([1, 2])).toEqual(new Float32Array([1, 2]));
    expect(toVector(new Float32Array([3]))).toEqual(new Float32Array([3]));
    expect(toVector(null)).toBeNull();
    expect(toVector([])).toBeNull();
    expect(toVector([1, Number.NaN])).toBeNull();
  });

  it("averages a centroid and refuses a ragged one", () => {
    expect(centroid([new Float32Array([2, 0]), new Float32Array([0, 2])])).toEqual(new Float32Array([1, 1]));
    expect(centroid([new Float32Array([1]), new Float32Array([1, 1])])).toBeNull();
    expect(centroid([])).toBeNull();
  });
});

describe("the calibration gate", () => {
  it("refuses to measure anything on an uncalibrated model", () => {
    const result = preflagDrift([ev("1", GOA), ev("2", GOA), ev("3", VET), ev("4", VET)], opts);
    expect(result.measured).toBe(false);
    expect(result.drift).toBe(false);
    expect(result.reason).toBe("uncalibrated");
    expect(result.score).toBeNull();
    expect(result.cosine).toBeNull();
    expect(result.decision).toBeNull();
  });

  it("refuses on a stale row as firmly as on a missing one", () => {
    putCalib({
      model: MODEL,
      useCase: "episode_topic",
      floor: 0.1,
      nPairs: MIN_CALIB_PAIRS,
      measuredAt: new Date(NOW - 400 * 86_400_000).toISOString(),
    });
    expect(preflagDrift([ev("1", GOA), ev("2", GOA), ev("3", VET), ev("4", VET)], opts).reason).toBe(
      "uncalibrated",
    );
  });
});

describe("drift", () => {
  beforeEach(() => calibrate());

  it("flags a session that pivots, and names the cut", () => {
    const result = preflagDrift([ev("1", GOA), ev("2", GOA), ev("3", VET), ev("4", VET)], opts);
    expect(result.drift).toBe(true);
    expect(result.measured).toBe(true);
    expect(result.reason).toBe("drift");
    expect(result.cutAfterEventId).toBe("2");
    expect(result.leftEventIds).toEqual(["1", "2"]);
    expect(result.rightEventIds).toEqual(["3", "4"]);
    expect(driftWantsModel(result)).toBe(true);
  });

  it("does not flag a session that stays on one topic", () => {
    const result = preflagDrift([ev("1", GOA), ev("2", GOA), ev("3", GOA), ev("4", GOA)], opts);
    expect(result.drift).toBe(false);
    expect(result.measured).toBe(true);
    expect(result.reason).toBe("single_topic");
    expect(driftWantsModel(result)).toBe(false);
  });

  it("is deterministic: the same events give the same answer every time", () => {
    const events = [ev("1", GOA), ev("2", GOA), ev("3", VET), ev("4", VET), ev("5", VET)];
    const runs = [1, 2, 3, 4, 5].map(() => preflagDrift(events, opts));
    for (const run of runs) {
      expect(run.cutAfterEventId).toBe(runs[0]!.cutAfterEventId);
      expect(run.score).toBe(runs[0]!.score);
      expect(run.drift).toBe(runs[0]!.drift);
    }
  });

  it("never cuts a block below two events", () => {
    // The only pivot on offer is the last event alone, which is not a segment.
    const result = preflagDrift([ev("1", GOA), ev("2", GOA), ev("3", GOA), ev("4", VET)], opts);
    expect(result.cutAfterEventId).toBe("2");
    expect(result.leftEventIds).toHaveLength(2);
    expect(result.rightEventIds).toHaveLength(2);
  });

  it("§12.3: a placeholder never splits a session", () => {
    const withPlaceholders = preflagDrift(
      [ev("1", GOA), ev("2", GOA), ev("3", null, true), ev("4", GOA), ev("5", GOA)],
      opts,
    );
    expect(withPlaceholders.drift).toBe(false);
    expect(withPlaceholders.signalEvents).toBe(4);
  });

  it("reports too little signal instead of inventing an answer", () => {
    expect(preflagDrift([ev("1", GOA), ev("2", VET)], opts).reason).toBe("too_few_signal_events");
    expect(preflagDrift([ev("1", null), ev("2", null)], opts).reason).toBe("no_vectors");
    expect(preflagDrift([], opts).reason).toBe("no_vectors");
  });

  it("refuses two dimensions rather than compare across them", () => {
    const result = preflagDrift([ev("1", [1, 0]), ev("2", [1, 0]), ev("3", [1, 0, 0]), ev("4", [0, 1, 0])], opts);
    expect(result.measured).toBe(false);
    expect(result.reason).toBe("no_vectors");
  });

  it("buys the call on a band answer without calling it drift", () => {
    // A half-turn between the blocks lands between the band and the bind bar.
    const left = [1, 0];
    const right = [0.5, 0.866];
    const result = preflagDrift([ev("1", left), ev("2", left), ev("3", right), ev("4", right)], opts);
    expect(result.reason).toBe("band");
    expect(result.drift).toBe(false);
    expect(driftWantsModel(result)).toBe(true);
  });
});
