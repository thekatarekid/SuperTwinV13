// ===========================================================================
// Schedule timer service (build P3.2) — clock-mocked, incl. the SCH-08 shape:
// a machine asleep at a fire time late-executes on wake when the window still
// holds, skips with a note when it passed, and can never double-fire. Real
// temp DB, no model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { DEFAULT_LATE_WINDOW_MS } from "./schedule-policy.js";
import { bootTimers, tickTimers, type TimerFire } from "./timers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-timers-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const FIRE_AT = "2026-12-16T01:30:00.000Z";
const T = (offsetMs: number): Date => new Date(Date.parse(FIRE_AT) + offsetMs);

function seedScheduled(
  id: string,
  schedule: Record<string, unknown>,
  opts: { status?: string; due?: string } = {},
): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO spaces (id, label, status) VALUES ('sp_goa', 'goa', 'active')`).run();
  db.prepare(
    `INSERT INTO tasks (id, space_id, title, type, risk_class, status, due, schedule_json)
     VALUES (?, 'sp_goa', ?, 'explicit', 'auto', ?, ?, ?)`,
  ).run(id, `task ${id}`, opts.status ?? "scheduled", opts.due ?? null, JSON.stringify(schedule));
}

function autoSchedule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fire_at: FIRE_AT,
    recurrence: null,
    mode: "auto",
    source: "inferred",
    polling: null,
    reason: "opens T-48h",
    ...extra,
  };
}

function task(id: string): { status: string; schedule_json: string } {
  return getDb().prepare(`SELECT status, schedule_json FROM tasks WHERE id = ?`).get(id) as {
    status: string;
    schedule_json: string;
  };
}

function executorRuns(): { task_id: string; payload_json: string }[] {
  return getDb()
    .prepare(`SELECT task_id, payload_json FROM deferred_outputs WHERE kind = 'executor_run' ORDER BY created_at`)
    .all() as { task_id: string; payload_json: string }[];
}

describe("tickTimers — fire + double-fire guard", () => {
  it("fires a due auto schedule exactly once: executor_run row + decisions row + status executing", () => {
    seedScheduled("tsk_ci", autoSchedule());
    const first = tickTimers(T(1000));
    expect(first.fired).toHaveLength(1);
    expect(first.fired[0]).toMatchObject({ taskId: "tsk_ci", late: false, poll: null });
    expect(task("tsk_ci").status).toBe("executing");
    expect(executorRuns()).toHaveLength(1);
    const dec = getDb()
      .prepare(`SELECT action FROM decisions WHERE target_id = 'tsk_ci' AND pass = 'timer'`)
      .all() as { action: string }[];
    expect(dec.map((d) => d.action)).toEqual(["fire_schedule"]);

    // Same instant again — the claim already flipped the row: NO double fire.
    const second = tickTimers(T(1000));
    expect(second.fired).toHaveLength(0);
    expect(executorRuns()).toHaveLength(1);
  });

  it("does not fire early, and never fires a confirm-mode or un-scheduled task", () => {
    seedScheduled("tsk_early", autoSchedule());
    seedScheduled("tsk_confirm", { ...autoSchedule(), mode: "confirm", proposed: true }, { status: "open" });
    const report = tickTimers(T(-60_000));
    expect(report.fired).toHaveLength(0);
    expect(task("tsk_early").status).toBe("scheduled");
    expect(task("tsk_confirm").status).toBe("open");
  });

  it("hands fires to an injected sink instead of the default queue", () => {
    seedScheduled("tsk_ci", autoSchedule());
    const seen: TimerFire[] = [];
    tickTimers(T(0), (f) => seen.push(f));
    expect(seen).toHaveLength(1);
    expect(executorRuns()).toHaveLength(0); // the injected sink replaced the durable default
  });
});

describe("tickTimers — sleep-wake recovery (SCH-08)", () => {
  it("late-executes a fire missed during sleep while the window holds, flagged late and traced", () => {
    seedScheduled("tsk_ci", autoSchedule());
    // Asleep at 01:30; wake 3 hours later — inside the default late window.
    const report = tickTimers(T(3 * 3_600_000));
    expect(report.fired).toHaveLength(1);
    expect(report.fired[0].late).toBe(true);
    const sched = JSON.parse(task("tsk_ci").schedule_json) as { late?: boolean; fired_at?: string };
    expect(sched.late).toBe(true);
    const dec = getDb()
      .prepare(`SELECT reason FROM decisions WHERE target_id = 'tsk_ci' AND action = 'fire_schedule'`)
      .get() as { reason: string };
    expect(dec.reason).toContain("late fire");
    const run = JSON.parse(executorRuns()[0].payload_json) as { late: boolean };
    expect(run.late).toBe(true);
  });

  it("skips with a note once the window passed: task back to open, no executor run, decision row", () => {
    seedScheduled("tsk_ci", autoSchedule());
    const report = tickTimers(T(DEFAULT_LATE_WINDOW_MS + 60_000));
    expect(report.fired).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(task("tsk_ci").status).toBe("open");
    expect(executorRuns()).toHaveLength(0);
    const dec = getDb()
      .prepare(`SELECT reason FROM decisions WHERE target_id = 'tsk_ci' AND action = 'schedule_skipped'`)
      .get() as { reason: string };
    expect(dec.reason).toContain("window passed");
    // Resolved, not lost: a later tick does nothing more.
    expect(tickTimers(T(DEFAULT_LATE_WINDOW_MS + 120_000)).skipped).toHaveLength(0);
  });

  it("honors the task's own due date as the validity bound over the default window", () => {
    seedScheduled("tsk_ci", autoSchedule(), { due: T(3_600_000).toISOString() });
    const report = tickTimers(T(2 * 3_600_000)); // 2h late, due passed 1h ago
    expect(report.skipped).toHaveLength(1);
    expect(task("tsk_ci").status).toBe("open");
  });
});

describe("tickTimers — polling patterns (interval/until/cap)", () => {
  it("re-arms each poll fire on the interval and stops at the cap", () => {
    seedScheduled(
      "tsk_tix",
      autoSchedule({ polling: { intervalMs: 120_000, until: null, maxPolls: 3 } }),
    );
    const r1 = tickTimers(T(0));
    expect(r1.fired[0].poll).toBe(1);
    expect(r1.rearmed).toEqual(["tsk_tix"]);
    expect(task("tsk_tix").status).toBe("scheduled"); // armed for the next poll

    expect(tickTimers(T(60_000)).fired).toHaveLength(0); // next poll not due yet
    const r2 = tickTimers(T(120_000));
    expect(r2.fired[0].poll).toBe(2);

    const r3 = tickTimers(T(240_000));
    expect(r3.fired[0].poll).toBe(3);
    expect(r3.rearmed).toHaveLength(0); // cap reached — terminal fire
    expect(task("tsk_tix").status).toBe("executing");
    expect(tickTimers(T(360_000)).fired).toHaveLength(0);
    expect(executorRuns()).toHaveLength(3);
  });

  it("stops re-arming when the next poll would pass 'until'", () => {
    seedScheduled(
      "tsk_tix",
      autoSchedule({ polling: { intervalMs: 120_000, until: T(90_000).toISOString(), maxPolls: 20 } }),
    );
    const r1 = tickTimers(T(0));
    expect(r1.fired).toHaveLength(1);
    expect(r1.rearmed).toHaveLength(0); // next poll at +120s > until at +90s
    expect(task("tsk_tix").status).toBe("executing");
  });

  it("ends the loop early when the executor completes the task between polls", () => {
    seedScheduled(
      "tsk_tix",
      autoSchedule({ polling: { intervalMs: 120_000, until: null, maxPolls: 5 } }),
    );
    tickTimers(T(0));
    getDb().prepare(`UPDATE tasks SET status = 'done' WHERE id = 'tsk_tix'`).run();
    expect(tickTimers(T(120_000)).fired).toHaveLength(0);
  });
});

describe("bootTimers", () => {
  it("opens the P1 deferred pen, then ticks: a held auto candidate schedules and (if due) fires", () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa', 'goa', 'active')`).run();
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, risk_class, status, confidence)
       VALUES ('tsk_ci', 'sp_goa', 'web check-in', 'explicit', 'auto', 'open', 0.9)`,
    ).run();
    db.prepare(
      `INSERT INTO deferred_outputs (id, space_id, kind, payload_json, created_by)
       VALUES ('def_1', 'sp_goa', 'schedule', ?, 'decide')`,
    ).run(JSON.stringify({ task: "web check-in", fire_at: FIRE_AT, mode: "auto" }));

    // Boot BEFORE the fire time: replay activates the schedule, nothing fires.
    const quiet = bootTimers(T(-3_600_000));
    expect(quiet.fired).toHaveLength(0);
    expect(task("tsk_ci").status).toBe("scheduled");
    expect(
      (db.prepare(`SELECT status FROM deferred_outputs WHERE id = 'def_1'`).get() as { status: string }).status,
    ).toBe("activated");

    // Next boot lands after the fire time (slept through it): late fire.
    const woke = bootTimers(T(600_000));
    expect(woke.fired).toHaveLength(1);
    expect(woke.fired[0].late).toBe(true);
  });
});
