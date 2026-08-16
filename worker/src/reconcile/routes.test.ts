// ===========================================================================
// POST /api/reconcile/run · GET /api/reconcile/status (item 2.6).
//
// The manual cadence. The point of these tests is that the route is a SHELL:
// a hand-triggered pass produces the same report, under the same one run id,
// as a cohort boundary or the nightly timer — and `status` never starts one.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readArcs, writeProvisionalArc } from "../arcs/provisional.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { STEADY_CALL_BUDGET, pendingProvisionalCount, resetReconcileSchedule, resetReconcileSteps } from "./index.js";
import { handleReconcileRoute } from "./routes.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-recroute-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetReconcileSteps();
  resetReconcileSchedule();
});

afterEach(() => {
  resetReconcileSteps();
  resetReconcileSchedule();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Two parallel cohorts that each produced a provisional for the same trip. */
function seedTwins(): void {
  const db = getDb();
  for (const id of ["a1", "a2"]) {
    db.prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, merged_into) VALUES (?, 'person', ?, NULL)`)
      .run(id, id);
  }
  for (const [id, source] of [
    ["ep_wa", "whatsapp"],
    ["ep_cal", "calendar"],
  ] as const) {
    db.prepare(
      `INSERT OR REPLACE INTO episodes (id, stream_id, source_id, topic_label, entity_ids, started_at, ended_at)
       VALUES (?, NULL, ?, 'Goa trip', '["a1","a2"]', '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z')`,
    ).run(id, source);
  }
  writeProvisionalArc({ batchId: "c1", arcKeyCandidate: "x", episodeIds: ["ep_wa"], now: NOW });
  writeProvisionalArc({ batchId: "c2", arcKeyCandidate: "y", episodeIds: ["ep_cal"], now: NOW });
}

describe("POST /api/reconcile/run", () => {
  // Every call site casts `as never` into the route's node-http parameter, so
  // the helper's own return type only has to describe what it actually builds:
  // a method/url pair that streams the body chunks.
  function fakeReq(method: string, url: string, body?: unknown): unknown {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    return {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
  }

  function fakeRes(): { status: number; body: unknown; res: unknown } {
    const out = { status: 0, body: undefined as unknown, res: undefined as unknown };
    out.res = {
      writeHead(status: number) {
        out.status = status;
      },
      end(payload: string) {
        out.body = JSON.parse(payload);
      },
    };
    return out;
  }

  it("runs reconcile and answers with the run id", async () => {
    seedTwins();
    const out = fakeRes();
    const handled = await handleReconcileRoute(
      fakeReq("POST", "/api/reconcile/run", { mode: "bootstrap" }) as never,
      out.res as never,
    );
    expect(handled).toBe(true);
    expect(out.status).toBe(200);
    const body = out.body as { runId: string; changes: number; retracted: unknown[] };
    expect(body.runId).toMatch(/^rec_/);
    expect(body.changes).toBeGreaterThan(0);
    expect(body.retracted).toEqual([]);
  });

  it("scopes the run to a batch when one is named", async () => {
    seedTwins();
    const out = fakeRes();
    await handleReconcileRoute(
      fakeReq("POST", "/api/reconcile/run", { batchId: "c1", mode: "bootstrap" }) as never,
      out.res as never,
    );
    expect((out.body as { batchId: string }).batchId).toBe("c1");
    expect(pendingProvisionalCount()).toBe(1);
  });

  it("rejects a body that is not JSON", async () => {
    const out = fakeRes();
    const req = {
      method: "POST",
      url: "/api/reconcile/run",
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{not json");
      },
    };
    await handleReconcileRoute(req as never, out.res as never);
    expect(out.status).toBe(400);
  });

  it("reports status without running anything", async () => {
    seedTwins();
    const out = fakeRes();
    expect(await handleReconcileRoute(fakeReq("GET", "/api/reconcile/status") as never, out.res as never)).toBe(true);
    const body = out.body as { pendingProvisionals: number; budget: { limit: number }; lastRun: unknown };
    expect(body.pendingProvisionals).toBe(2);
    expect(body.budget.limit).toBe(STEADY_CALL_BUDGET);
    expect(body.lastRun).toBeNull();
    expect(readArcs()).toHaveLength(0);
  });

  it("falls through on a path it does not own", async () => {
    const out = fakeRes();
    expect(await handleReconcileRoute(fakeReq("GET", "/api/runs") as never, out.res as never)).toBe(false);
  });
});
