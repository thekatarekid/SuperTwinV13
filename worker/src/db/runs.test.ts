// ===========================================================================
// Unit tests for db/runs.ts over a real temp SQLite DB. Moved here when the old
// store module was deleted (V2 §3.2).
//
// The three reads exist for reasons the assertions below pin down:
//
//   - listRuns carries BOTH cache columns, because `input_tokens` alone is a
//     measured ~0.03% of what a run costs;
//   - mediaSpend is the only place media reading's spend is visible at all, it
//     being deliberately kept out of the chat quota;
//   - mediaQueueCounts is the backfill progress the UI shows.
//
// A cost of null is never $0: a run that died before the CLI reported one has
// no cost figure, and rendering that as zero would understate the window.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "./connection.js";
import { runMigrations } from "./index.js";
import {
  addEvaluation,
  evaluationSummary,
  evaluationsAll,
  isEvalOutputType,
  listRuns,
  mediaQueueCounts,
  mediaSpend,
} from "./runs.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-runs-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RunSeed {
  kind: string;
  role?: string | null;
  model?: string | null;
  input?: number;
  cacheCreation?: number;
  cacheRead?: number;
  output?: number;
  costUsd?: number | null;
  createdAt?: string;
}

function seedRun(runId: string, seed: RunSeed): void {
  getDb()
    .prepare(
      `INSERT INTO extraction_runs
         (provider, session_id, run_id, kind, prompt_chars, input_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
          cost_usd, duration_ms, status, error_code, model, role, created_at)
       VALUES ('claude-local', NULL, ?, ?, 0, ?, ?, ?, ?, ?, 100, 'ok', NULL, ?, ?, ?)`,
    )
    .run(
      runId,
      seed.kind,
      seed.input ?? 0,
      seed.cacheCreation ?? 0,
      seed.cacheRead ?? 0,
      seed.output ?? 0,
      seed.costUsd ?? null,
      seed.model ?? null,
      seed.role ?? null,
      seed.createdAt ?? new Date().toISOString(),
    );
}

function insertEvent(id: string, status: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, ts, kind, text, media_desc_status)
       VALUES (?, '2026-06-20T10:00:00.000Z', 'message', 'photo', ?)`,
    )
    .run(id, status);
}

describe("listRuns", () => {
  it("carries both cache columns and the cost the run reported", () => {
    seedRun("r1", {
      kind: "chat",
      role: "chat",
      model: "claude-haiku-4-5-20251001",
      input: 17,
      cacheCreation: 10_472,
      cacheRead: 18_764,
      output: 149,
      costUsd: 0.0421,
    });

    const [row] = listRuns(10);
    expect(row).toMatchObject({
      process: "chat",
      model: "claude-haiku-4-5-20251001",
      input_tokens: 17,
      cache_creation_input_tokens: 10_472,
      cache_read_input_tokens: 18_764,
      output_tokens: 149,
      cost_usd: 0.0421,
      status: "ok",
    });
    // The id is stringified for the wire, never left as a raw rowid number.
    expect(typeof row.id).toBe("string");
  });

  it("reports a run that never reported a cost as null, not zero", () => {
    seedRun("r2", { kind: "chat", role: "chat", costUsd: null });
    expect(listRuns(10)[0].cost_usd).toBeNull();
  });

  it("falls back to the run kind for rows logged before roles existed", () => {
    seedRun("r3", { kind: "extraction", role: null });
    expect(listRuns(10)[0].process).toBe("extraction");
    expect(listRuns(10)[0].model).toBe("");
  });
});

describe("mediaSpend", () => {
  it("sums media runs only, and weights the total the way billing does", () => {
    seedRun("m1", {
      kind: "media",
      role: "media",
      input: 10,
      cacheCreation: 100,
      cacheRead: 1000,
      output: 20,
      costUsd: 0.01,
    });
    seedRun("m2", {
      kind: "media",
      role: "media",
      input: 5,
      cacheCreation: 0,
      cacheRead: 2000,
      output: 10,
      costUsd: 0.02,
    });
    seedRun("c1", { kind: "chat", role: "chat", input: 999, output: 999 });

    const spend = mediaSpend(60 * 60 * 1000);
    expect(spend).toEqual({
      inputTokens: 15,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 3000,
      outputTokens: 30,
      // 15 + 100*1.25 + 3000*0.1 + 30
      billableTokens: 470,
      costUsd: 0.03,
      runCount: 2,
    });
  });

  it("counts a media run logged before the role column existed", () => {
    seedRun("m3", { kind: "media", role: null, input: 7, output: 3 });
    expect(mediaSpend(60 * 60 * 1000).runCount).toBe(1);
  });

  it("excludes runs older than the window", () => {
    seedRun("m4", {
      kind: "media",
      role: "media",
      input: 100,
      createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    expect(mediaSpend(60 * 60 * 1000)).toMatchObject({
      inputTokens: 0,
      runCount: 0,
      costUsd: null,
    });
  });

  it("reports no cost at all as null rather than $0", () => {
    seedRun("m5", { kind: "media", role: "media", input: 12, costUsd: null });
    expect(mediaSpend(60 * 60 * 1000).costUsd).toBeNull();
  });
});

describe("mediaQueueCounts", () => {
  it("counts rows per status and ignores the ones the UI does not show", () => {
    insertEvent("evt_a", "pending");
    insertEvent("evt_b", "pending");
    insertEvent("evt_c", "done");
    insertEvent("evt_d", "unsupported");
    insertEvent("evt_e", "error");
    insertEvent("evt_f", "skipped");
    insertEvent("evt_g", null);

    expect(mediaQueueCounts()).toEqual({
      pending: 2,
      done: 1,
      unsupported: 1,
      error: 1,
    });
  });

  it("reports an empty queue when nothing has been described", () => {
    expect(mediaQueueCounts()).toEqual({
      pending: 0,
      done: 0,
      unsupported: 0,
      error: 0,
    });
  });
});

describe("evaluations", () => {
  it("accepts only the output types the routes know about", () => {
    expect(isEvalOutputType("chat_answer")).toBe(true);
    expect(isEvalOutputType("arc")).toBe(false);
    expect(isEvalOutputType(42)).toBe(false);
  });

  it("records verdicts and sums them per output type", () => {
    addEvaluation({ outputType: "chat_answer", outputId: "a1", verdict: "up" });
    addEvaluation({ outputType: "chat_answer", outputId: "a2", verdict: "down", note: "wrong date" });
    addEvaluation({ outputType: "task", outputId: "t1", verdict: "up" });

    expect(evaluationSummary()).toEqual({
      chat_answer: { up: 1, down: 1 },
      task: { up: 1, down: 0 },
    });

    const all = evaluationsAll();
    expect(all).toHaveLength(3);
    expect(all[1]).toMatchObject({
      output_type: "chat_answer",
      output_id: "a2",
      verdict: "down",
      note: "wrong date",
    });
  });
});
