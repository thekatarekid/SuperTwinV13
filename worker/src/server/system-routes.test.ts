// ===========================================================================
// HTTP tests for GET /api/runs — the runs viewer's read.
//
// The viewer used to ask for the newest 50 and call that the log (v6 §7). It
// pages now, so what these assert is the paging contract: a window into the
// table by offset, newest first, and a short page as the only signal that
// there is nothing older.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-runs-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");

type ServerHandle = { port: number; close(): Promise<void> };

interface RunRow {
  id: string;
  process: string;
  model: string;
  status: string;
  created_at: string;
}

let server: ServerHandle;
let base: string;

/** How many runs are seeded: more than one page, and not a whole number of them. */
const SEEDED = 130;

async function runs(query: string): Promise<RunRow[]> {
  const res = await fetch(`${base}/api/runs${query}`);
  return ((await res.json()) as { runs: RunRow[] }).runs;
}

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);
  for (let i = 0; i < SEEDED; i++) {
    db.logRun({
      provider: "claude-local",
      sessionId: null,
      runId: `run-${i}`,
      kind: "media",
      promptChars: 0,
      inputTokens: i,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      durationMs: 10,
      status: "ok",
      errorCode: null,
      role: "media",
      model: "claude-haiku-4-5-20251001",
    });
  }
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/runs", () => {
  it("pages by offset, and the pages tile the table without repeating a row", async () => {
    const first = await runs("?limit=50");
    const second = await runs("?limit=50&offset=50");
    const third = await runs("?limit=50&offset=100");
    expect(first.length).toBe(50);
    expect(second.length).toBe(50);
    // The last page is short, which is what tells the caller to stop asking.
    expect(third.length).toBe(SEEDED - 100);

    const ids = [...first, ...second, ...third].map((r) => r.id);
    expect(new Set(ids).size).toBe(SEEDED);
  });

  it("reaches runs the first page cannot, so the viewer can list them all", async () => {
    const all = await runs("?limit=1000");
    const last = await runs(`?limit=10&offset=${SEEDED - 1}`);
    expect(all.length).toBe(SEEDED);
    expect(last.length).toBe(1);
    expect(last[0].id).toBe(all[all.length - 1].id);
  });

  it("answers an offset past the end with nothing, not with the first page", async () => {
    expect(await runs(`?limit=10&offset=${SEEDED + 10}`)).toEqual([]);
  });

  it("ignores a garbage limit/offset rather than failing the read", async () => {
    const rows = await runs("?limit=abc&offset=-4");
    expect(rows.length).toBe(100); // the default page
    expect(rows[0].process).toBe("media");
  });
});
