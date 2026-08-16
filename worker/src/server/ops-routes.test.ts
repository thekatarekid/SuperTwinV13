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
const { writeClaim } = await import("../claims/write.js");
const { resourcePool } = await import("../providers/pool.js");
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

  // Two runs' worth of claim mutations, so undo can prove it reverses ONE.
  getDb()
    .prepare(`INSERT INTO entities (id, type, canonical) VALUES ('ent-1','person','A'), ('ent-2','person','B')`)
    .run();
  writeClaim(
    { kind: "fact", subjectId: "ent-1", predicate: "lives in", text: "lives in Pune", statedAt: "2026-08-01T10:00:00.000Z" },
    { runId: "run-A", actor: "code:extract" },
  );
  writeClaim(
    { kind: "fact", subjectId: "ent-2", predicate: "works at", text: "works at Acme", statedAt: "2026-08-02T10:00:00.000Z" },
    { runId: "run-B", actor: "code:extract" },
  );

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

  it("refuses an unknown lane", async () => {
    const res = await fetch(`${base}/api/ops/lanes/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane: "llm:everything" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ops/runs/:id/undo", () => {
  it("reverses exactly one run and leaves the other run's writes standing", async () => {
    const before = getDb().prepare(`SELECT COUNT(*) AS n FROM claim_versions`).get() as { n: number };
    expect(before.n).toBe(2);

    const res = await fetch(`${base}/api/ops/runs/run-A/undo`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; reversed: string[] };
    expect(body.runId).toBe("run-A");
    expect(body.reversed.length).toBeGreaterThan(0);

    const rows = getDb().prepare(`SELECT text FROM claim_versions`).all() as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual(["works at Acme"]);

    // A second undo of the same run is a no-op.
    const again = await fetch(`${base}/api/ops/runs/run-A/undo`, { method: "POST" });
    expect(((await again.json()) as { reversed: string[] }).reversed).toHaveLength(0);
  });
});
