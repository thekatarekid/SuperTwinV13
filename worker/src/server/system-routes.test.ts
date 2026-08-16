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

// ===========================================================================
// GET /api/usage — the Settings → Usage payload (arch §4.4.4). One request,
// because the token table and the cost line must be two views of one aggregate:
// summing them from two reads with two WHEREs is what made a real $0.69 render
// as "—".
// ===========================================================================

describe("GET /api/usage", () => {
  interface UsagePayload {
    window: string;
    byRole: {
      role: string;
      model: string;
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      totalInputTokens: number;
      outputTokens: number;
      costUsd: number;
      cacheExpectedZero: boolean;
    }[];
    totals: {
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      totalInputTokens: number;
      costUsd: number;
      runCount: number;
    };
    cache: { hitRate: number | null; belowMinimumModels: string[] };
    runs: { ok: number; total: number };
    thisImport: { events: number; spend: { spentUsd: number } };
  }

  beforeAll(async () => {
    const acct = await import("../db/runs.js");
    const conn = await import("../db/connection.js");
    conn
      .getDb()
      .prepare(
        `INSERT INTO cohorts (id, mode, horizon, event_count, state)
         VALUES ('usage-c1', 'bootstrap', 'live', 400, 'done')`,
      )
      .run();
    acct.recordRun({
      role: "extract",
      model: "claude-sonnet-5",
      cohortId: "usage-c1",
      usage: {
        inputTokens: 18,
        cacheCreationInputTokens: 10_651,
        cacheReadInputTokens: 48_000,
        outputTokens: 206,
        costUsd: 0.5,
      },
    });
    acct.recordRun({
      role: "media",
      model: "claude-haiku-4.5",
      cohortId: "usage-c1",
      usage: {
        inputTokens: 1200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 90,
        costUsd: 0.19,
      },
    });
  });

  async function usage(query = ""): Promise<UsagePayload> {
    const res = await fetch(`${base}/api/usage${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as UsagePayload;
  }

  // The 130 runs seeded through db.logRun above are in here too, and that is
  // the point: logRun dual-writes into `runs`, so the two paths that actually
  // spend money on an installed build — chat and background media reading —
  // reach this payload. Before that they wrote `extraction_runs` only, and the
  // Usage board rendered empty over spend that had genuinely happened.
  const LOGGED_RUNS = SEEDED;
  /** sum(0..129) — the input tokens those seeded runs carry. */
  const LOGGED_INPUT = (SEEDED * (SEEDED - 1)) / 2;

  it("returns the token table, the totals, the cache reality and the cost", async () => {
    const u = await usage();
    expect(u.window).toBe("7d");
    // extract/sonnet-5, media/haiku-4.5, and the logged media/haiku-4-5 rows.
    expect(u.byRole.length).toBe(3);
    expect(u.totals.totalInputTokens).toBe(
      18 + 10_651 + 48_000 + 1200 + LOGGED_INPUT,
    );
    // The logged runs reported no cost, which is 0 recorded — never a locally
    // recomputed price — so the CLI's own $0.69 still stands alone.
    expect(u.totals.costUsd).toBeCloseTo(0.69, 10);
    expect(u.runs.total).toBe(2 + LOGGED_RUNS);
  });

  it("the per-role rows sum to the totals — same filter, same row set", async () => {
    const u = await usage();
    const sum = (f: (r: UsagePayload["byRole"][number]) => number) =>
      u.byRole.reduce((n, r) => n + f(r), 0);
    expect(sum((r) => r.totalInputTokens)).toBe(u.totals.totalInputTokens);
    expect(sum((r) => r.costUsd)).toBeCloseTo(u.totals.costUsd, 10);
  });

  it("every row satisfies total_input = read + create + input", async () => {
    for (const r of (await usage()).byRole) {
      expect(r.totalInputTokens).toBe(
        r.cacheReadTokens + r.cacheCreationTokens + r.inputTokens,
      );
    }
  });

  it("flags the haiku rows whose zero cache is expected, not broken", async () => {
    const u = await usage();
    expect(u.cache.belowMinimumModels).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-haiku-4.5",
    ]);
    expect(u.cache.hitRate).toBeCloseTo(48_000 / u.totals.totalInputTokens, 10);
  });

  it("scopes to the running import when asked, and reports its spend", async () => {
    const u = await usage("?window=import");
    expect(u.window).toBe("import");
    expect(u.totals.costUsd).toBeCloseTo(0.69, 10);
    expect(u.thisImport.events).toBe(400);
    expect(u.thisImport.spend.spentUsd).toBeCloseTo(0.69, 10);
  });

  it("estimates a bootstrap from measured history", async () => {
    const res = await fetch(`${base}/api/usage/estimate?events=800`);
    const e = (await res.json()) as { basis: string; projectedUsd: number };
    expect(e.basis).toBe("measured");
    // 400 done events cost $0.69 → $0.001725/event → ~$1.38 for 800.
    expect(e.projectedUsd).toBeCloseTo(1.38, 6);
  });
});
