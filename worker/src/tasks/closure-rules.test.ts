// ===========================================================================
// Closure rules — the code half (V6 P1 S5.2, Product_V6 §11.12.9-13):
// past due with nothing new asks "done?" BY CODE (a lookup first), repeated
// silence goes dormant and never deletes, and the user's one tap closes as
// done or as cancelled — never the other. Pinned clock, temp DB, zero calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scheduleClosureCheck } from "../brain/closure-check.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { answerDone, ASKS_BEFORE_DORMANT, sweepPastDue } from "./closure-rules.js";

/** Sat 2026-08-29 09:00 IST. */
const NOW = new Date("2026-08-29T03:30:00.000Z");
const DAY = 24 * 3_600_000;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-closure-rules-"));
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

function task(id: string, due: string | null, status = "open", space: string | null = "sp_1"): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, due, status, evidence_json,
                          created_by, confidence, created_at)
       VALUES (?, ?, ?, 'explicit', 'advise-only', 'self', ?, ?, '[]', 'test', 0.9, '2026-08-20T03:30:00.000Z')`,
    )
    .run(id, space, `task ${id}`, due, status);
}

const statusOf = (id: string): string =>
  (getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string }).status;

const actions = (id: string): string[] =>
  (
    getDb()
      .prepare(`SELECT action FROM decisions WHERE target_kind = 'task' AND target_id = ? ORDER BY rowid`)
      .all(id) as { action: string }[]
  ).map((d) => d.action);

/** One committed event on the space's stream, newer than `since`. */
function evidenceOn(spaceId: string, streamKey: string, ts: string, text: string): void {
  const db = getDb();
  const appended = appendEvents(
    [
      {
        ts,
        source: "wa",
        kind: "wa.message",
        origin: "live",
        streamKey,
        actor: "contact:karan",
        roles: { sender: "contact:karan", audience: ["self"], receiver: ["self"], mentions: [] },
        payload: { text, external_id: `${streamKey}:${ts}` },
      },
    ],
    Date.parse(ts),
  );
  const eventId = appended.ids[0]!;
  const streamId = (db.prepare(`SELECT stream_id FROM events WHERE id = ?`).get(eventId) as { stream_id: string }).stream_id;
  const epId = `ep_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO episodes (id, stream_id, space_id, state, summary, confidence, first_ts, last_ts, created_by)
     VALUES (?, ?, ?, 'open', ?, 0.9, ?, ?, 'test')`,
  ).run(epId, streamId, spaceId, text, ts, ts);
  addEpisodeEvents(epId, [eventId], "test");
}

describe("sweepPastDue", () => {
  it("leaves a task that is not past due alone", () => {
    task("t_future", "2026-09-05");
    expect(sweepPastDue(NOW)).toMatchObject({ asked: 0, escalated: 0, dormant: 0, cooling: 0, modelCalls: 0 });
    expect(actions("t_future")).toEqual([]);
  });

  it("past due with nothing new asks \"done?\" by code — no model call", () => {
    task("t_late", "2026-08-27");
    const report = sweepPastDue(NOW);
    expect(report).toMatchObject({ asked: 1, escalated: 0, modelCalls: 0 });
    expect(statusOf("t_late")).toBe("open");
    const row = getDb()
      .prepare(`SELECT new_json, reason FROM decisions WHERE target_id = 't_late' AND action = 'ask_done'`)
      .get() as { new_json: string; reason: string };
    const card = JSON.parse(row.new_json) as { card: string; modelCalls: number; askedAt: string; ask: number };
    expect(card).toMatchObject({ card: "done?", modelCalls: 0, ask: 1, askedAt: NOW.toISOString() });
    expect(row.reason).toContain("no model call");
  });

  it("asks once per cooldown, and only asks again a day later", () => {
    task("t_late", "2026-08-27");
    expect(sweepPastDue(NOW).asked).toBe(1);
    expect(sweepPastDue(new Date(NOW.getTime() + 3_600_000))).toMatchObject({ asked: 0, cooling: 1 });
    expect(sweepPastDue(new Date(NOW.getTime() + DAY + 1000)).asked).toBe(1);
  });

  it("past due WITH new committed evidence goes back to Decide, not to a card", () => {
    task("t_late", "2026-08-27");
    evidenceOn("sp_1", "karan@s.whatsapp.net", "2026-08-29T03:00:00.000Z", "sent it just now, check gpay");
    const report = sweepPastDue(NOW);
    expect(report).toMatchObject({ asked: 0, escalated: 1, modelCalls: 0 });
    expect(actions("t_late")).toEqual(["escalate_check"]);
    // The episodes went to the decide queue — the model sees evidence, never a clock.
    const queued = getDb().prepare(`SELECT COUNT(*) AS n FROM decide_queue WHERE space_id = 'sp_1'`).get() as { n: number };
    expect(queued.n).toBe(1);
  });

  it("a pending timed check owns the question — the sweep stands down", () => {
    task("t_late", "2026-08-27");
    scheduleClosureCheck({
      taskId: "t_late",
      spaceId: "sp_1",
      taskTitle: "task t_late",
      checkAt: "2026-08-30T03:30:00.000Z",
      now: NOW,
      runId: null,
    });
    expect(sweepPastDue(NOW)).toMatchObject({ asked: 0, cooling: 1 });
  });

  it("repeated silence downgrades to dormant — never deletes", () => {
    task("t_late", "2026-08-27");
    for (let i = 0; i < ASKS_BEFORE_DORMANT; i += 1) {
      expect(sweepPastDue(new Date(NOW.getTime() + i * (DAY + 1000))).asked).toBe(1);
    }
    const report = sweepPastDue(new Date(NOW.getTime() + ASKS_BEFORE_DORMANT * (DAY + 1000)));
    expect(report).toMatchObject({ dormant: 1, asked: 0, modelCalls: 0 });
    expect(statusOf("t_late")).toBe("dormant");
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(1);
    // Dormant is out of the sweep's way; the row and its history stand.
    expect(sweepPastDue(new Date(NOW.getTime() + 30 * DAY))).toMatchObject({ asked: 0, dormant: 0 });
  });

  it("never touches a closed task, and never calls the model", () => {
    task("t_done", "2026-08-20", "done");
    task("t_cancelled", "2026-08-20", "cancelled");
    expect(sweepPastDue(NOW)).toMatchObject({ asked: 0, escalated: 0, dormant: 0, modelCalls: 0 });
  });
});

describe("answerDone", () => {
  it("done closes on the user's word and queues the follow-up pass", () => {
    task("t_pay", "2026-08-27");
    const r = answerDone("t_pay", "done", NOW);
    expect(r).toMatchObject({ ok: true, status: "done", nextStepQueued: true });
    expect(statusOf("t_pay")).toBe("done");
    const pending = getDb()
      .prepare(`SELECT kind, status FROM deferred_outputs WHERE task_id = 't_pay'`)
      .all() as { kind: string; status: string }[];
    expect(pending).toEqual([{ kind: "next_step", status: "deferred" }]);
  });

  it("cancelled closes as cancelled, never as done, and spawns nothing", () => {
    task("t_ferry", "2026-08-27");
    const r = answerDone("t_ferry", "cancelled", NOW);
    expect(r).toMatchObject({ ok: true, status: "cancelled", nextStepQueued: false });
    expect(statusOf("t_ferry")).toBe("cancelled");
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM deferred_outputs`).get()).toEqual({ n: 0 });
    const row = getDb()
      .prepare(`SELECT reason FROM decisions WHERE target_id = 't_ferry' AND action = 'close'`)
      .get() as { reason: string };
    expect(row.reason).toContain("never done");
  });

  it("not yet keeps it open and clears the standing card", () => {
    task("t_pay", "2026-08-27");
    sweepPastDue(NOW);
    const r = answerDone("t_pay", "not_yet", NOW);
    expect(r).toMatchObject({ ok: true, status: "open" });
    expect(actions("t_pay")).toEqual(["ask_done", "answer_not_yet"]);
    expect(statusOf("t_pay")).toBe("open");
  });

  it("not yet reopens a dormant task the user just touched", () => {
    task("t_old", "2026-08-01", "dormant");
    expect(answerDone("t_old", "not_yet", NOW)).toMatchObject({ ok: true, status: "open" });
    expect(statusOf("t_old")).toBe("open");
  });

  it("closing retires a pending timed check and is idempotent", () => {
    task("t_pay", "2026-08-27");
    scheduleClosureCheck({
      taskId: "t_pay",
      spaceId: "sp_1",
      taskTitle: "task t_pay",
      checkAt: "2026-08-30T03:30:00.000Z",
      now: NOW,
      runId: null,
    });
    answerDone("t_pay", "done", NOW);
    const check = getDb()
      .prepare(`SELECT status FROM deferred_outputs WHERE task_id = 't_pay' AND kind = 'closure_check'`)
      .get() as { status: string };
    expect(check.status).toBe("dismissed");
    // A second tap changes nothing.
    expect(answerDone("t_pay", "done", NOW)).toMatchObject({ ok: true, status: "done", nextStepQueued: false });
    expect(actions("t_pay").filter((a) => a === "close")).toHaveLength(1);
  });

  it("an unknown task is an error, not a silent no-op", () => {
    expect(answerDone("nope", "done", NOW)).toMatchObject({ ok: false, error: "unknown task" });
  });
});
