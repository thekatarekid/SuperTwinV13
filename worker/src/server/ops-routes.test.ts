// ===========================================================================
// HTTP tests for the ops surface routes (build item 4.4).
//
// Everything here goes over the real server against a real temp DB, because
// the module's whole contract is "thin over the owning modules": the meter is
// `scheduler/queue`'s coverage, the quarantine list is `work_queue` rows, the
// undo is `claims/undo`'s reverse-replay. A fake would prove nothing.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-ops-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const db = await import("../db/index.js");
const { getDb } = await import("../db/connection.js");
const queue = await import("../scheduler/queue.js");
const { resourcePool } = await import("../providers/pool.js");
const budget = await import("../providers/budget.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { startServer } = await import("./index.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
let quarantinedId: string;

beforeAll(async () => {
  db.runMigrations();
  register(claudeLocalProvider);

  // Coverage + queue state the import panel reads.
  queue.writeCoverage({ scopeKind: "global", scopeId: "all", horizon: "d7", totalUnits: 40, doneUnits: 25 });
  const a = queue.enqueueWork({ stage: "extract", unitKind: "session", unitId: "sess-ok", priority: 5 });
  const b = queue.enqueueWork({ stage: "extract", unitKind: "session", unitId: "sess-bad", priority: 7 });
  expect(a.action).toBe("inserted");
  expect(b.action).toBe("inserted");
  quarantinedId = b.id;
  queue.claimWork({ limit: 10 });
  queue.completeWork(a.id);
  queue.failWork(quarantinedId, { action: "quarantine" });

  // One open question, the way the resolution ladder writes one.
  getDb()
    .prepare(
      `INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES ('qst-1', 'identity', 'entity_pair', 'e1|e2', 'Are these the same person?',
               '["same","different","later"]', 'open')`,
    )
    .run();

  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/ops/import", () => {
  it("serves coverage, depth and lane state from one read", async () => {
    const res = await fetch(`${base}/api/ops/import`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coverage: { horizon: string; totalUnits: number; doneUnits: number; fraction: number }[];
      depth: Record<string, number>;
      lanes: { lane: string; paused: boolean; limit: number }[];
    };
    const recent = body.coverage.find((c) => c.horizon === "d7")!;
    expect(recent.totalUnits).toBe(40);
    expect(recent.doneUnits).toBe(25);
    expect(body.depth.done).toBe(1);
    expect(body.depth.quarantined).toBe(1);
    expect(body.lanes.map((l) => l.lane)).toContain("llm:enrichment");
  });
});

describe("quarantine browser", () => {
  it("lists quarantined units and replays one back to ready after a fix", async () => {
    const list = await fetch(`${base}/api/ops/quarantine`);
    const { items } = (await list.json()) as { items: { id: string; unitId: string; state: string }[] };
    expect(items.map((i) => i.id)).toContain(quarantinedId);

    const replay = await fetch(`${base}/api/ops/quarantine/${encodeURIComponent(quarantinedId)}/replay`, {
      method: "POST",
    });
    expect(replay.status).toBe(200);
    expect(queue.queueDepth().quarantined).toBe(0);
    expect(queue.queueDepth().ready).toBe(1);

    // Replaying again is a 404: only a quarantined row moves.
    const again = await fetch(`${base}/api/ops/quarantine/${encodeURIComponent(quarantinedId)}/replay`, {
      method: "POST",
    });
    expect(again.status).toBe(404);
  });
});

describe("question queue", () => {
  it("lists open questions, defers on 'later' and records a real answer", async () => {
    const list = await fetch(`${base}/api/ops/questions`);
    const { questions } = (await list.json()) as {
      questions: { id: string; question: string; options: string[] }[];
    };
    expect(questions.map((q) => q.id)).toContain("qst-1");
    expect(questions[0]!.options).toContain("different");

    // "later" defers — the row stays open.
    const later = await fetch(`${base}/api/ops/questions/qst-1/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "later" }),
    });
    expect(((await later.json()) as { deferred: boolean }).deferred).toBe(true);
    const stillOpen = await fetch(`${base}/api/ops/questions`);
    expect(((await stillOpen.json()) as { questions: unknown[] }).questions).toHaveLength(1);

    // A real answer closes it with the answer stored verbatim.
    const same = await fetch(`${base}/api/ops/questions/qst-1/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "same" }),
    });
    expect(same.status).toBe(200);
    const row = getDb().prepare(`SELECT status, answer_json FROM questions WHERE id = 'qst-1'`).get() as {
      status: string;
      answer_json: string;
    };
    expect(row.status).toBe("answered");
    expect(JSON.parse(row.answer_json)).toEqual({ answer: "same" });

    // Answering a closed question is a 404, and a bodyless answer a 400.
    const closed = await fetch(`${base}/api/ops/questions/qst-1/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "same" }),
    });
    expect(closed.status).toBe(404);
    const empty = await fetch(`${base}/api/ops/questions/qst-1/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });
});

describe("lane pause/resume", () => {
  it("pauses one lane, shows the countdown, and resumes it early", async () => {
    const pause = await fetch(`${base}/api/ops/lanes/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane: "llm:enrichment", ms: 60_000 }),
    });
    expect(pause.status).toBe(200);
    expect(resourcePool.isPaused("llm:enrichment")).toBe(true);
    // The pause is the lane's alone — understanding keeps its slots (§9.4).
    expect(resourcePool.isPaused("llm:understanding")).toBe(false);

    const lanes = await fetch(`${base}/api/ops/lanes`);
    const body = (await lanes.json()) as { lanes: { lane: string; paused: boolean; pausedForMs: number }[] };
    const enrich = body.lanes.find((l) => l.lane === "llm:enrichment")!;
    expect(enrich.paused).toBe(true);
    expect(enrich.pausedForMs).toBeGreaterThan(0);

    const resume = await fetch(`${base}/api/ops/lanes/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane: "llm:enrichment" }),
    });
    expect(resume.status).toBe(200);
    expect(resourcePool.isPaused("llm:enrichment")).toBe(false);
  });

  it("a manual pause is not clipped to an hour (T0-13: MAX_MANUAL_PAUSE_MS is gone)", async () => {
    const sixHours = 6 * 3600_000;
    const pause = await fetch(`${base}/api/ops/lanes/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane: "scrape", ms: sixHours }),
    });
    expect(pause.status).toBe(200);
    const body = (await pause.json()) as { pausedForMs: number };
    expect(body.pausedForMs).toBeGreaterThan(sixHours - 5_000);
    resourcePool.resumeLane("scrape");
  });

  it("refuses an unknown lane", async () => {
    const res = await fetch(`${base}/api/ops/lanes/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane: "llm:everything" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("kill switch and spend (S0.8, SPD-03)", () => {
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  interface Spend {
    modelActivityPausedAt: string | null;
    trippedAt: string | null;
    hour: { calls: number; usd: number };
    day: { calls: number; usd: number };
    ceilings: { usdPerHour: number };
  }

  it("GET /api/ops/spend reads the windows, the latch and the switch", async () => {
    const res = await fetch(`${base}/api/ops/spend`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Spend;
    expect(body.modelActivityPausedAt).toBeNull();
    expect(body.trippedAt).toBeNull();
    expect(body.hour.calls).toBe(0);
    expect(body.ceilings.usdPerHour).toBe(3);
  });

  it("POST /api/ops/model-activity persists the switch in app_state and releases it", async () => {
    const on = await fetch(`${base}/api/ops/model-activity`, json({ paused: true }));
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as Spend;
    expect(onBody.modelActivityPausedAt).not.toBeNull();
    expect(budget.isModelActivityPaused()).toBe(true);
    // The row the worker checks before every spawn.
    const row = getDb()
      .prepare("SELECT value FROM app_state WHERE key = 'model_activity_paused'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(onBody.modelActivityPausedAt);

    const off = await fetch(`${base}/api/ops/model-activity`, json({ paused: false }));
    expect(off.status).toBe(200);
    expect(((await off.json()) as Spend).modelActivityPausedAt).toBeNull();
    expect(budget.isModelActivityPaused()).toBe(false);
  });

  it("refuses a body without a boolean", async () => {
    const res = await fetch(`${base}/api/ops/model-activity`, json({ paused: "yes" }));
    expect(res.status).toBe(400);
  });

  it("POST /api/ops/budget/reset clears the latch and leaves the switch alone", async () => {
    budget.tripBudget("test trip");
    await fetch(`${base}/api/ops/model-activity`, json({ paused: true }));
    const res = await fetch(`${base}/api/ops/budget/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Spend;
    expect(body.trippedAt).toBeNull();
    expect(body.modelActivityPausedAt).not.toBeNull();
    await fetch(`${base}/api/ops/model-activity`, json({ paused: false }));
  });
});

describe("run undo", () => {
  // The shipped 13.4.1 build had the "undo run" link in Settings pointing at a
  // route that did not exist — every click 404'd as "unknown ops route".
  interface UndoBody {
    runId: string;
    reversible: number;
    skipped: number;
    reversed?: number;
    items: { targetId: string; action: string; reversible: boolean; skipReason: string | null }[];
  }

  it("previews the blast radius on GET, then reverses it on POST", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_u1','Undo me','active')`).run();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_u2','Other','active')`).run();
    db.prepare(
      `INSERT INTO episodes (id, space_id, state, summary) VALUES ('ep_u1','sp_u2','open','moved')`,
    ).run();
    db.prepare(
      `INSERT INTO decisions (id, run_id, pass, target_kind, target_id, action, old_json, reason)
       VALUES ('dec_u1','run_u1','decide','episode','ep_u1','attach','{"spaceId":"sp_u1"}','same thread')`,
    ).run();
    db.prepare(
      `INSERT INTO decisions (id, run_id, pass, target_kind, target_id, action, old_json)
       VALUES ('dec_u2','run_u1','user','space','sp_u1','approve','{"status":"proposed"}')`,
    ).run();

    // GET is a pure preview: it must state what would happen and change nothing.
    const preview = (await (await fetch(`${base}/api/ops/runs/run_u1/undo`)).json()) as UndoBody;
    expect(preview.runId).toBe("run_u1");
    expect(preview.items).toHaveLength(2);
    expect(preview.reversible).toBe(1);
    expect(preview.skipped).toBe(1); // the human's approve row
    expect(preview.items.find((i) => i.targetId === "sp_u1")!.skipReason).toMatch(/human/i);
    expect(
      (db.prepare(`SELECT space_id FROM episodes WHERE id = 'ep_u1'`).get() as { space_id: string })
        .space_id,
    ).toBe("sp_u2");

    const res = await fetch(`${base}/api/ops/runs/run_u1/undo`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UndoBody;
    expect(body.reversed).toBe(1);
    expect(
      (db.prepare(`SELECT space_id FROM episodes WHERE id = 'ep_u1'`).get() as { space_id: string })
        .space_id,
    ).toBe("sp_u1");
    // The human's row is still standing.
    expect(
      (db.prepare(`SELECT reversed_at FROM decisions WHERE id = 'dec_u2'`).get() as {
        reversed_at: string | null;
      }).reversed_at,
    ).toBeNull();
  });

  it("an unknown run id is an empty preview, not a 404 and not a crash", async () => {
    const res = await fetch(`${base}/api/ops/runs/run_missing/undo`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UndoBody;
    expect(body.items).toHaveLength(0);
    expect(body.reversible).toBe(0);
  });
});
