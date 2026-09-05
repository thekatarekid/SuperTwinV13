// ===========================================================================
// HTTP tests for GET /api/latency — the ops surface's latency read (item 4.2).
//
// The route serves three things and this file asserts each comes from the
// PERSISTED marks, not from anything recomputed per request: the per-(model,
// call type) worst-case call summaries, the latest milestone per budget name
// graded against the budget stored with the mark, and the live ledger's
// trailing-day call count against the ≤ 12 quiet-day budget.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-latency-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const marks = await import("../db/latency-marks.js");
const { recordLivePass } = await import("../db/live-ledger.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");

type ServerHandle = { port: number; close(): Promise<void> };

interface LatencyPayload {
  calls: {
    model: string;
    callType: string;
    calls: number;
    worstTtftMs: number | null;
    worstTotalMs: number | null;
    minTokensPerSecond: number | null;
  }[];
  milestones: { name: string; value: number; budget: number; unit: string; met: boolean }[];
  ttftCoverage: number | null;
  budgets: Record<string, number>;
  steady: { callsLast24h: number; budget: number; met: boolean };
}

let server: ServerHandle;
let base: string;

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);

  // Two calls of one type (worst must win), one of another type, same model.
  marks.recordCallMark({ name: "P-CL1", model: "opus", ttftMs: 2_000, totalMs: 12_000, outputTokens: 600 });
  marks.recordCallMark({ name: "P-CL1", model: "opus", ttftMs: 4_400, totalMs: 16_000, outputTokens: 640 });
  marks.recordCallMark({ name: "P-TR1", model: "opus", ttftMs: 250, totalMs: 800, outputTokens: 88 });

  // Milestones: an old breach superseded by a pass, plus a live standing breach.
  marks.recordMilestoneMark({ name: "first_claim", value: 41_000, budget: 30_000, unit: "ms" });
  marks.recordMilestoneMark({ name: "first_claim", value: 17_500, budget: 30_000, unit: "ms" });
  marks.recordMilestoneMark({ name: "silent_gap", value: 96_000, budget: 90_000, unit: "ms" });

  // Three live passes today — the steady-state count the ledger serves.
  for (let i = 0; i < 3; i += 1) recordLivePass("stream-1", Date.now() - i * 60_000, "delta");

  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/latency", () => {
  it("serves worst-case per (model, call type), latest milestones and the daily ledger", async () => {
    const res = await fetch(`${base}/api/latency`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LatencyPayload;

    const cl1 = body.calls.find((c) => c.callType === "P-CL1")!;
    expect(cl1).toMatchObject({ model: "opus", calls: 2, worstTtftMs: 4_400, worstTotalMs: 16_000 });
    // Slowest observed rate: 640 tok / 16 s = 40 tok/s — derived, worst-case.
    expect(cl1.minTokensPerSecond).toBe(40);
    expect(body.calls.find((c) => c.callType === "P-TR1")).toBeTruthy();
    expect(body.ttftCoverage).toBe(1);

    // Latest per milestone: first_claim's newer pass wins; the gap breach shows.
    expect(body.milestones.find((m) => m.name === "first_claim")).toMatchObject({ value: 17_500, met: true });
    expect(body.milestones.find((m) => m.name === "silent_gap")).toMatchObject({ value: 96_000, met: false });

    // The budgets ride along so the panel renders the worker's numbers, and the
    // steady-state count is the ledger's — 3 passes, well under 12.
    expect(body.budgets).toMatchObject({ firstClaimMs: 30_000, spacesTasksMs: 120_000, silentGapMs: 90_000, steadyCallsPerDay: 12 });
    expect(body.steady).toEqual({ callsLast24h: 3, budget: 12, met: true });
  });
});
