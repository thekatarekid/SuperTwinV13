// ===========================================================================
// Review-queue + drill-down routes (build P1.7): home fetch, review queue,
// proposal approve/reject (with decision rows), "why?" decisions with trace
// linkage, trace reads, and the dev seed's end-to-end acceptance path.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { handleReviewRoute, seedReviewFixture } from "./review-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-review-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
): Promise<{ handled: boolean; status: number | null; body: any }> {
  const req = { method, url: path } as IncomingMessage;
  let status: number | null = null;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const handled = await handleReviewRoute(req, res);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

describe("handleReviewRoute", () => {
  it("declines paths it does not own", async () => {
    expect((await call("GET", "/api/health")).handled).toBe(false);
    expect((await call("GET", "/api/spaces")).handled).toBe(false);
  });

  it("serves the review queue and the composed home fetch", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO spaces (id, label, status) VALUES ('sp1', 'Hampi trek Oct', 'proposed')`,
    ).run();
    db.prepare(
      `INSERT INTO spaces (id, label, status) VALUES ('sp2', 'Goa trip', 'active')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, status, space_id) VALUES ('t1', 'Book villa', 'open', 'sp2')`,
    ).run();

    const review = await call("GET", "/api/review");
    expect(review.status).toBe(200);
    expect(review.body.review.map((s: any) => s.id)).toEqual(["sp1"]);

    const home = await call("GET", "/api/home");
    expect(home.status).toBe(200);
    expect(home.body.today.map((t: any) => t.id)).toEqual(["t1"]);
    expect(home.body.spaces.map((s: any) => s.id)).toEqual(["sp2"]);
    expect(home.body.review.map((s: any) => s.id)).toEqual(["sp1"]);
    expect(home.body.recent_understanding).toEqual([]);
  });

  it("approves a proposed space end-to-end from the dev seed (acceptance path)", async () => {
    const seed = seedReviewFixture();
    expect(seed.space_id).toBeTruthy();

    // Review queue shows the proposal with its evidence.
    const review = await call("GET", "/api/review");
    const proposal = review.body.review.find((s: any) => s.id === seed.space_id);
    expect(proposal.label).toBe("Hampi trek in October");
    expect(JSON.parse(proposal.exemplars_json).length).toBe(2);

    // "why?" — the create decision, linked to its trace.
    const why = await call("GET", `/api/decisions/space/${seed.space_id}`);
    expect(why.status).toBe(200);
    expect(why.body.decisions[0].action).toBe("create");
    expect(why.body.decisions[0].traceId).toBe(seed.trace_id);

    // Trace drill-down.
    const trace = await call("GET", `/api/trace/${seed.trace_id}`);
    expect(trace.status).toBe(200);
    expect(trace.body.trace.pass).toBe("decide");

    // Approve: proposed -> active, and a decision row records the flip.
    const approve = await call("POST", `/api/proposals/${seed.space_id}/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.space.status).toBe("active");
    const afterWhy = await call("GET", `/api/decisions/space/${seed.space_id}`);
    expect(afterWhy.body.decisions[0].action).toBe("approve");
    expect(JSON.parse(afterWhy.body.decisions[0].oldJson).status).toBe("proposed");

    // The queue is now empty; a second approve is a 404 (not idempotent noise).
    expect((await call("GET", "/api/review")).body.review).toEqual([]);
    expect((await call("POST", `/api/proposals/${seed.space_id}/approve`)).status).toBe(404);
  });

  it("rejects a proposal without deleting it", async () => {
    getDb()
      .prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp1', 'Noise space', 'proposed')`)
      .run();
    const reject = await call("POST", "/api/proposals/sp1/reject");
    expect(reject.status).toBe(200);
    expect(reject.body.space.status).toBe("rejected");
    // Still in the table (reversible), just out of the queue.
    expect(getDb().prepare(`SELECT status FROM spaces WHERE id = 'sp1'`).get()).toEqual({
      status: "rejected",
    });
  });

  it("dev seed is idempotent while the proposal is open", () => {
    const first = seedReviewFixture();
    const second = seedReviewFixture();
    expect(second.space_id).toBe(first.space_id);
    expect(second.decision_id).toBe(first.decision_id);
    expect(second.trace_id).toBe(first.trace_id);
  });

  it("404s an unknown trace", async () => {
    expect((await call("GET", "/api/trace/nope")).status).toBe(404);
  });
});
