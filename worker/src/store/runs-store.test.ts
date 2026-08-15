// ===========================================================================
// Unit tests for the two reads over extraction_runs: the runs viewer's row
// shape (listRuns) and media reading's own spend line (mediaSpend).
//
// Both exist because `input_tokens` alone is a measured ~0.03% of what a run
// costs — the rest arrives as cache creation + cache read — and because media
// spend is deliberately kept out of the chat quota, so this is the only place
// it is visible at all.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { extractionDb, listRuns, mediaSpend } from "./store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-runs-store-test-"));
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
  extractionDb()
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
  });

  it("reports a run that never reported a cost as null, not zero", () => {
    seedRun("r2", { kind: "chat", role: "chat", costUsd: null });
    expect(listRuns(10)[0].cost_usd).toBeNull();
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
