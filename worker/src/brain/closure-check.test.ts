// ===========================================================================
// Closure checks (V6 P1 S3.7, DEC-03 / SCH-02): check_at is a lookup first.
// Nothing new → the "done?" card by code, zero calls; new committed evidence
// → the space goes back to Decide on those episodes; uncommitted → waits.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { CLOSURE_CHECK_KIND, DEFAULT_CHECK_DELAY_MS, runClosureChecks, scheduleClosureCheck } from "./closure-check.js";

let tmpDir: string;
const NOW = new Date("2026-08-29T03:30:00Z");
const STREAM = "goa-gang@g.us";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-closure-check-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa', 'Goa trip', 'active')`).run();
  db.prepare(`INSERT INTO tasks (id, space_id, title, type, status, risk_class, owner) VALUES ('tsk_pay', 'sp_goa', 'Collect Karan share', 'explicit', 'open', 'advise-only', 'self')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function wa(tsMs: number, text: string, i: number): EventEnvelope {
  return {
    ts: new Date(tsMs).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: STREAM,
    actor: "contact:karan",
    roles: { sender: "contact:karan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `cc:${i}` },
  };
}

/** One committed episode on the space, holding the given event ids. */
function episode(id: string, eventIds: string[]): void {
  const db = getDb();
  const stream = db.prepare(`SELECT stream_id FROM events WHERE id = ?`).get(eventIds[0]) as { stream_id: string };
  db.prepare(`INSERT INTO episodes (id, stream_id, space_id, state, summary) VALUES (?, ?, 'sp_goa', 'open', 'x')`).run(id, stream.stream_id);
  addEpisodeEvents(id, eventIds);
}

function schedule(checkAt: string | null = "2026-08-30T09:00+05:30"): boolean {
  return scheduleClosureCheck({ taskId: "tsk_pay", spaceId: "sp_goa", taskTitle: "Collect Karan share", checkAt, now: NOW, runId: null });
}

describe("scheduleClosureCheck", () => {
  it("writes one durable row with the instant, idempotent per pending task, task untouched", () => {
    const first = appendEvents([wa(NOW.getTime() - 60_000, "paying tonight pakka", 1)], NOW.getTime());
    episode("ep_1", first.ids);
    expect(schedule()).toBe(true);
    expect(schedule()).toBe(false);
    const db = getDb();
    const rows = db.prepare(`SELECT payload_json, status FROM deferred_outputs WHERE kind = ?`).all(CLOSURE_CHECK_KIND) as { payload_json: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({ taskId: "tsk_pay", checkAt: "2026-08-30T03:30:00.000Z", sinceTs: NOW.toISOString() });
    expect((db.prepare(`SELECT status FROM tasks WHERE id = 'tsk_pay'`).get() as { status: string }).status).toBe("open");
    expect((db.prepare(`SELECT action FROM decisions WHERE target_id = 'tsk_pay'`).get() as { action: string }).action).toBe("check_at");
  });

  it("defaults a missing instant to now + DEFAULT_CHECK_DELAY_MS", () => {
    schedule(null);
    const row = getDb().prepare(`SELECT payload_json FROM deferred_outputs WHERE kind = ?`).get(CLOSURE_CHECK_KIND) as { payload_json: string };
    expect(JSON.parse(row.payload_json).checkAt).toBe(new Date(NOW.getTime() + DEFAULT_CHECK_DELAY_MS).toISOString());
  });
});

describe("runClosureChecks", () => {
  it("is a no-op before the check is due", () => {
    const ev = appendEvents([wa(NOW.getTime() - 60_000, "paying tonight", 1)], NOW.getTime());
    episode("ep_1", ev.ids);
    schedule();
    const r = runClosureChecks(new Date("2026-08-29T12:00:00Z"));
    expect(r).toEqual({ asked: 0, escalated: 0, waiting: 0, retired: 0, modelCalls: 0 });
    expect((getDb().prepare(`SELECT status FROM deferred_outputs WHERE kind = ?`).get(CLOSURE_CHECK_KIND) as { status: string }).status).toBe("deferred");
  });

  it("nothing new → the done? card by code, no model call, task still open (SCH-02 clock_only_call = 0)", () => {
    const ev = appendEvents([wa(NOW.getTime() - 60_000, "paying tonight", 1)], NOW.getTime());
    episode("ep_1", ev.ids);
    schedule();
    const r = runClosureChecks(new Date("2026-08-30T03:31:00Z"));
    expect(r).toMatchObject({ asked: 1, escalated: 0, modelCalls: 0 });
    const db = getDb();
    expect((db.prepare(`SELECT status FROM tasks WHERE id = 'tsk_pay'`).get() as { status: string }).status).toBe("open");
    const ask = db.prepare(`SELECT new_json FROM decisions WHERE action = 'ask_done'`).get() as { new_json: string };
    expect(JSON.parse(ask.new_json)).toMatchObject({ card: "done?", modelCalls: 0 });
    expect((db.prepare(`SELECT status FROM deferred_outputs WHERE kind = ?`).get(CLOSURE_CHECK_KIND) as { status: string }).status).toBe("activated");
    expect((db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  });

  it("new committed evidence → Decide is enqueued on those episodes, not on the clock", () => {
    const ev = appendEvents([wa(NOW.getTime() - 60_000, "paying tonight", 1)], NOW.getTime());
    episode("ep_1", ev.ids);
    schedule();
    const later = appendEvents([wa(NOW.getTime() + 3_600_000, "done, sent 5k", 2)], NOW.getTime() + 3_700_000);
    episode("ep_2", later.ids);
    const r = runClosureChecks(new Date("2026-08-30T03:31:00Z"));
    expect(r).toMatchObject({ asked: 0, escalated: 1, modelCalls: 0 });
    const q = getDb().prepare(`SELECT pending_episode_ids FROM decide_queue WHERE space_id = 'sp_goa'`).get() as { pending_episode_ids: string };
    expect(JSON.parse(q.pending_episode_ids)).toEqual(["ep_2"]);
  });

  it("new but uncommitted events → the check waits for commit", () => {
    const ev = appendEvents([wa(NOW.getTime() - 60_000, "paying tonight", 1)], NOW.getTime());
    episode("ep_1", ev.ids);
    schedule();
    appendEvents([wa(NOW.getTime() + 3_600_000, "done, sent 5k", 2)], NOW.getTime() + 3_700_000);
    const r = runClosureChecks(new Date("2026-08-30T03:31:00Z"));
    expect(r).toMatchObject({ asked: 0, escalated: 0, waiting: 1 });
    expect((getDb().prepare(`SELECT status FROM deferred_outputs WHERE kind = ?`).get(CLOSURE_CHECK_KIND) as { status: string }).status).toBe("deferred");
  });

  it("a task closed meanwhile retires its check", () => {
    schedule();
    getDb().prepare(`UPDATE tasks SET status = 'done' WHERE id = 'tsk_pay'`).run();
    const r = runClosureChecks(new Date("2026-08-30T03:31:00Z"));
    expect(r).toMatchObject({ retired: 1 });
  });
});
