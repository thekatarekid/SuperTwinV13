// ===========================================================================
// Task-list routes (V6 P1 S5.2) through the handler contract: the ONE
// prioritized list with its explained score, and the one-tap answers to a
// "done?" card. Temp DB, no server, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { handleTasksRoute } from "./tasks-routes.js";

/** Sat 2026-08-29 09:00 IST. */
const NOW = new Date("2026-08-29T03:30:00.000Z");
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-tasks-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  getDb().prepare(`INSERT INTO spaces (id, label, status, created_by) VALUES ('sp_1', 'Goa trip', 'active', 'test')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function task(id: string, title: string, opts: { status?: string; due?: string | null } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, due, status,
                          evidence_json, created_by, confidence, created_at)
       VALUES (?, 'sp_1', ?, 'explicit', 'transaction', 'advise-only', 'self', ?, ?, '[]', 'test', 0.9,
               '2026-08-20T03:30:00.000Z')`,
    )
    .run(id, title, opts.due ?? null, opts.status ?? "open");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number | null; body: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { method: string }).method = method;
  (req as { url: string }).url = path;
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
  const handled = await handleTasksRoute(req, res, { now: () => NOW });
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

describe("handleTasksRoute", () => {
  it("declines paths it does not own — the executor's own task routes included", async () => {
    expect((await call("GET", "/api/spaces")).handled).toBe(false);
    expect((await call("GET", "/api/tasks/tsk_1/run")).handled).toBe(false);
    expect((await call("POST", "/api/tasks/tsk_1/execute")).handled).toBe(false);
    expect((await call("DELETE", "/api/tasks")).handled).toBe(false);
  });

  it("GET /api/tasks renders the six sections with an explained score on every row", async () => {
    task("t_gate", "Approve the villa advance", { status: "needs_approval" });
    task("t_today", "Collect Karan's 5k share", { due: "2026-08-29" });
    const r = await call("GET", "/api/tasks");
    expect(r.status).toBe(200);
    expect(r.body.tz).toBe("Asia/Kolkata");
    expect(r.body.generated_at).toBe(NOW.toISOString());
    expect(r.body.sections.map((s: any) => s.id)).toEqual([
      "needs_you",
      "today",
      "this_week",
      "later",
      "waiting",
      "done_today",
    ]);
    expect(r.body.total).toBe(2);
    const row = r.body.sections[0].tasks[0];
    expect(row).toMatchObject({ id: "t_gate", action: "approve", space_label: "Goa trip", suggested: false });
    expect(row.why.length).toBeGreaterThan(0);
    expect(r.body.sections[1].tasks[0]).toMatchObject({ id: "t_today", due_label: "today" });
  });

  it("honours ?tz= and ?space=, and falls back to the default zone on nonsense", async () => {
    getDb().prepare(`INSERT INTO spaces (id, label, status, created_by) VALUES ('sp_2', 'Rent', 'active', 'test')`).run();
    task("t_a", "A", { due: "2026-08-29" });
    getDb()
      .prepare(
        `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, due, status, evidence_json, created_by, confidence)
         VALUES ('t_b', 'sp_2', 'B', 'explicit', 'advise-only', 'self', '2026-08-29', 'open', '[]', 'test', 0.9)`,
      )
      .run();
    expect((await call("GET", "/api/tasks?space=sp_2")).body.total).toBe(1);
    expect((await call("GET", "/api/tasks?tz=America/New_York")).body.tz).toBe("America/New_York");
    expect((await call("GET", "/api/tasks?tz=Mars/Olympus")).body.tz).toBe("Asia/Kolkata");
  });

  it("POST /done closes on the user's word and queues the follow-up pass", async () => {
    task("t_pay", "Collect Karan's 5k share", { due: "2026-08-27" });
    const r = await call("POST", "/api/tasks/t_pay/done");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: "t_pay", status: "done", next_step_queued: true });
    expect((getDb().prepare(`SELECT status FROM tasks WHERE id = 't_pay'`).get() as any).status).toBe("done");
  });

  it("POST /cancel closes as cancelled, never as done", async () => {
    task("t_ferry", "Book the ferry");
    const r = await call("POST", "/api/tasks/t_ferry/cancel");
    expect(r.body).toEqual({ id: "t_ferry", status: "cancelled", next_step_queued: false });
  });

  it("POST /not-yet keeps it open", async () => {
    task("t_pay", "Collect Karan's 5k share", { due: "2026-08-27" });
    const r = await call("POST", "/api/tasks/t_pay/not-yet");
    expect(r.body).toEqual({ id: "t_pay", status: "open", next_step_queued: false });
  });

  it("answers 404 for a task that does not exist", async () => {
    const r = await call("POST", "/api/tasks/nope/done");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "unknown task" });
  });
});
