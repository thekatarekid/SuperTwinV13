// ===========================================================================
// P3.1 activation tests — decide-apply (schedules + follow-ups act through
// the code-side policy gate) and the next-step pass (spec §11.3). Stubbed
// LLM, real temp DB, mocked clock — no live model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import type { Provider, Usage } from "../providers/types.js";
import {
  applyFollowups,
  applySchedule,
  emptyScheduleCounts,
  replayDeferredOutputs,
} from "./decide-apply.js";
import { drainNextStepQueue, enqueueNextStep, noteExecutorCompletion } from "./next-step.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-nextstep-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-29T10:00:00Z");
const USAGE: Usage = {
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
};

function stubProvider(responses: string[]): Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "stub",
    calls,
    cancel: () => false,
    async send(opts) {
      calls.push(opts.message);
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? "{}";
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", sessionId: "s", usage: USAGE });
      return { sessionId: "s", usage: USAGE, freshFallback: false, status: "ok" };
    },
  };
}

function seedSpace(): void {
  const db = getDb();
  db.prepare(`INSERT INTO spaces (id, label, status, goal) VALUES ('sp_goa', 'goa dec trip', 'active', 'trip')`).run();
}

function seedTask(id: string, title: string, riskClass: string, opts: { confidence?: number; due?: string } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, risk_class, status, confidence, due)
       VALUES (?, 'sp_goa', ?, 'explicit', ?, 'open', ?, ?)`,
    )
    .run(id, title, riskClass, opts.confidence ?? 0.9, opts.due ?? null);
}

function taskRow(id: string): { status: string; schedule_json: string | null } {
  return getDb().prepare(`SELECT status, schedule_json FROM tasks WHERE id = ?`).get(id) as {
    status: string;
    schedule_json: string | null;
  };
}

describe("applySchedule (P3.1 — the policy gate in action)", () => {
  it("auto-schedules a matched auto-class task: status 'scheduled', announce decision row", () => {
    seedSpace();
    seedTask("tsk_ci", "web check-in", "auto", { confidence: 0.9 });
    const counts = emptyScheduleCounts();
    applySchedule(
      "sp_goa",
      { task: "web check-in", fire_at: "2026-12-16T07:00+05:30", recurrence: null, mode: "auto", reason: "opens T-48h" },
      null,
      counts,
      NOW,
    );
    expect(counts.schedulesAuto).toBe(1);
    const row = taskRow("tsk_ci");
    expect(row.status).toBe("scheduled");
    const sched = JSON.parse(row.schedule_json ?? "null") as Record<string, unknown>;
    expect(sched.mode).toBe("auto");
    expect(sched.fire_at).toBe("2026-12-16T01:30:00.000Z");
    const dec = getDb()
      .prepare(`SELECT action, new_json FROM decisions WHERE target_id = 'tsk_ci' AND action = 'schedule'`)
      .get() as { action: string; new_json: string };
    expect(dec.new_json).toContain("Scheduled: web check-in");
  });

  it("confirms (never auto) for a non-auto-class task, keeping it un-scheduled until the user says so", () => {
    seedSpace();
    seedTask("tsk_pay", "Pay pool deposit", "approve-final", { confidence: 0.95 });
    const counts = emptyScheduleCounts();
    applySchedule(
      "sp_goa",
      { task: "Pay pool deposit", fire_at: "2026-09-01T09:00:00Z", recurrence: null, mode: "auto", reason: "due" },
      null,
      counts,
      NOW,
    );
    expect(counts.schedulesAuto).toBe(0);
    expect(counts.schedulesProposed).toBe(1);
    const row = taskRow("tsk_pay");
    expect(row.status).toBe("open");
    expect(JSON.parse(row.schedule_json ?? "null")).toMatchObject({ mode: "confirm", proposed: true });
  });

  it("SCH-06: rejects a past fire time — no mutation, no carrier task, a decisions row only", () => {
    seedSpace();
    const counts = emptyScheduleCounts();
    applySchedule(
      "sp_goa",
      { task: "web check-in", fire_at: "2026-06-05T10:00:00Z", recurrence: null, mode: "auto", reason: "stale" },
      null,
      counts,
      NOW,
    );
    expect(counts.schedulesRejected).toBe(1);
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
    expect(n).toBe(0);
    const dec = getDb()
      .prepare(`SELECT reason FROM decisions WHERE action = 'reject_schedule'`)
      .get() as { reason: string };
    expect(dec.reason).toContain("past");
  });

  it("normalizes and caps a polling pattern into schedule_json (SCH-02)", () => {
    seedSpace();
    seedTask("tsk_tix", "check ticket window", "auto", { confidence: 0.9 });
    const counts = emptyScheduleCounts();
    applySchedule(
      "sp_goa",
      {
        task: "check ticket window",
        fire_at: "2026-08-30T09:55:00+05:30",
        recurrence: null,
        mode: "auto",
        reason: "window opens 10am; start 09:55, poll until open",
        polling: { interval_min: 2, until: "2026-08-30T11:00:00+05:30", max: 100 },
      },
      null,
      counts,
      NOW,
    );
    const sched = JSON.parse(taskRow("tsk_tix").schedule_json ?? "null") as {
      polling: { intervalMs: number; maxPolls: number };
    };
    expect(sched.polling.intervalMs).toBe(120_000);
    expect(sched.polling.maxPolls).toBe(30); // capped
  });

  it("is idempotent: a task already carrying a schedule is skipped", () => {
    seedSpace();
    seedTask("tsk_ci", "web check-in", "auto", { confidence: 0.9 });
    const counts = emptyScheduleCounts();
    const sched = { task: "web check-in", fire_at: "2026-12-16T07:00+05:30", recurrence: null, mode: "auto" as const, reason: null };
    applySchedule("sp_goa", sched, null, counts, NOW);
    applySchedule("sp_goa", sched, null, counts, NOW);
    expect(counts.schedulesAuto).toBe(1);
    expect(counts.schedulesSkipped).toBe(1);
  });
});

describe("applyFollowups", () => {
  it("caps at 2 per trigger (FUP-01 followup-flood) and keeps the because spine (FUP-05)", () => {
    seedSpace();
    const counts = emptyScheduleCounts();
    applyFollowups(
      "sp_goa",
      [
        { title: "Web check-in", because: "flights booked ✓" },
        { title: "Book airport cab", because: "flights booked ✓" },
        { title: "Pack bags", because: "flights booked ✓" },
      ],
      null,
      counts,
      NOW,
    );
    expect(counts.followupsCreated).toBe(2);
    expect(counts.followupsSkipped).toBe(1);
    const rows = getDb()
      .prepare(`SELECT evidence_json FROM tasks ORDER BY title`)
      .all() as { evidence_json: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.evidence_json).toContain("because: flights booked ✓");
  });

  it("FUP-04: an inline recurring schedule confirms even on a clean parent closure", () => {
    seedSpace();
    const counts = emptyScheduleCounts();
    applyFollowups(
      "sp_goa",
      [
        {
          title: "Pay rent (October)",
          because: "September rent paid ✓",
          risk_class: "auto",
          confidence: 0.95,
          schedule: {
            task: "Pay rent (October)",
            fire_at: "2026-10-01T09:00:00Z",
            recurrence: "monthly, anchor the 1st",
            mode: "auto",
            reason: "recurring template",
          },
        },
      ],
      null,
      counts,
      NOW,
    );
    expect(counts.followupsCreated).toBe(1);
    expect(counts.schedulesAuto).toBe(0);
    expect(counts.schedulesProposed).toBe(1);
    const row = getDb()
      .prepare(`SELECT status, schedule_json FROM tasks WHERE title = 'Pay rent (October)'`)
      .get() as { status: string; schedule_json: string };
    expect(row.status).toBe("open");
    expect(JSON.parse(row.schedule_json)).toMatchObject({ mode: "confirm" });
  });

  it("dedupes against an open task with the same title", () => {
    seedSpace();
    seedTask("tsk_ci", "Web check-in", "auto");
    const counts = emptyScheduleCounts();
    applyFollowups("sp_goa", [{ title: "web check-in", because: "x" }], null, counts, NOW);
    expect(counts.followupsCreated).toBe(0);
    expect(counts.followupsSkipped).toBe(1);
  });
});

describe("replayDeferredOutputs — the P1 pen opens", () => {
  it("replays held schedules + follow-ups through the live policy and marks rows activated, once", () => {
    seedSpace();
    seedTask("tsk_ci", "web check-in", "auto", { confidence: 0.9 });
    const db = getDb();
    db.prepare(
      `INSERT INTO deferred_outputs (id, space_id, kind, payload_json, created_by)
       VALUES ('def_1', 'sp_goa', 'schedule', ?, 'decide')`,
    ).run(JSON.stringify({ task: "web check-in", fire_at: "2026-12-16T07:00+05:30", mode: "auto" }));
    db.prepare(
      `INSERT INTO deferred_outputs (id, space_id, kind, payload_json, created_by)
       VALUES ('def_2', 'sp_goa', 'followup', ?, 'decide')`,
    ).run(JSON.stringify({ title: "Shortlist villas", because: "flights booked" }));
    // A stale one rejects cleanly instead of time-traveling.
    db.prepare(
      `INSERT INTO deferred_outputs (id, space_id, kind, payload_json, created_by)
       VALUES ('def_3', 'sp_goa', 'schedule', ?, 'decide')`,
    ).run(JSON.stringify({ task: "old check-in", fire_at: "2026-06-05T10:00:00Z", mode: "auto" }));

    const report = replayDeferredOutputs(NOW);
    expect(report.replayed).toBe(3);
    expect(report.counts.schedulesAuto).toBe(1);
    expect(report.counts.followupsCreated).toBe(1);
    expect(report.counts.schedulesRejected).toBe(1);
    expect(taskRow("tsk_ci").status).toBe("scheduled");
    const statuses = db
      .prepare(`SELECT status FROM deferred_outputs ORDER BY id`)
      .all() as { status: string }[];
    expect(statuses.map((s) => s.status)).toEqual(["activated", "activated", "activated"]);

    const again = replayDeferredOutputs(NOW);
    expect(again.replayed).toBe(0);
  });
});

describe("next-step pass (spec §11.3)", () => {
  function seedClosedTask(): void {
    seedSpace();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, space_id, title, type, risk_class, status, closed_at)
         VALUES ('tsk_fl', 'sp_goa', 'Book flights', 'explicit', 'approve-final', 'done', '2026-08-29T09:00:00Z')`,
      )
      .run();
  }

  it("enqueues durably, deduped per task, and only for tasks with a space", () => {
    seedClosedTask();
    expect(enqueueNextStep("tsk_fl", "closure")).toBe(true);
    expect(noteExecutorCompletion("tsk_fl")).toBe(false); // pending trigger already exists
    expect(enqueueNextStep("tsk_missing", "closure")).toBe(false);
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM deferred_outputs WHERE kind = 'next_step'`).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("drains: runs the pass, applies the follow-ups with provenance, consumes the trigger", async () => {
    seedClosedTask();
    enqueueNextStep("tsk_fl", "executor_completion");
    const provider = stubProvider([
      JSON.stringify({
        followups: [
          {
            title: "Web check-in CCU-GOI",
            because: "flights booked ✓",
            category: "scheduling",
            risk_class: "auto",
            confidence: 0.9,
            schedule: {
              task: "Web check-in CCU-GOI",
              fire_at: "2026-12-16T07:00+05:30",
              mode: "auto",
              reason: "opens T-48h before departure",
            },
          },
        ],
      }),
    ]);
    const out = await drainNextStepQueue({ provider, now: () => NOW });
    expect(out).toHaveLength(1);
    expect(out[0].result.status).toBe("ok");
    expect(out[0].result.counts.followupsCreated).toBe(1);
    expect(out[0].result.counts.schedulesAuto).toBe(1);
    const db = getDb();
    const task = db
      .prepare(`SELECT status, evidence_json FROM tasks WHERE title = 'Web check-in CCU-GOI'`)
      .get() as { status: string; evidence_json: string };
    expect(task.status).toBe("scheduled");
    expect(task.evidence_json).toContain("because: flights booked ✓");
    const row = db
      .prepare(`SELECT status FROM deferred_outputs WHERE kind = 'next_step'`)
      .get() as { status: string };
    expect(row.status).toBe("activated");
  });

  it("FUP-03: an empty answer creates nothing and still consumes the trigger", async () => {
    seedClosedTask();
    enqueueNextStep("tsk_fl", "closure");
    const out = await drainNextStepQueue({
      provider: stubProvider([JSON.stringify({ followups: [] })]),
      now: () => NOW,
    });
    expect(out[0].result.counts.followupsCreated).toBe(0);
    const db = getDb();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare(`SELECT status FROM deferred_outputs WHERE kind = 'next_step'`).get() as { status: string }).status,
    ).toBe("activated");
  });

  it("retires an unrunnable trigger whose task's space vanished", async () => {
    seedClosedTask();
    enqueueNextStep("tsk_fl", "closure");
    const db = getDb();
    db.prepare(`DELETE FROM tasks WHERE id = 'tsk_fl'`).run();
    const out = await drainNextStepQueue({ provider: stubProvider(["{}"]), now: () => NOW });
    expect(out[0].result.status).toBe("failed");
    expect(
      (db.prepare(`SELECT status FROM deferred_outputs WHERE kind = 'next_step'`).get() as { status: string }).status,
    ).toBe("dismissed");
  });
});
