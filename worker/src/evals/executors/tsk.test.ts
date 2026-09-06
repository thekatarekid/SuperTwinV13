// ===========================================================================
// TSK / SCH / FUP executor (V6 P1 S5.2): the six code cases run against the
// real fixtures in evals/v13 through the real product code — canned decide.v9
// / followup.v1 output where a pass is involved, the clock pinned to
// FIXTURE_NOW, zero model calls, sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { tskExecutor } from "./tsk.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-tsk-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("tasks");
  const r = await tskExecutor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  // No canned answer ever reaches the ledger: the fixtures cost nothing.
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  return r;
}

interface SectionOut {
  id: string;
  label: string;
  tasks: { title: string; score: number; due_label: string | null; action: string | null; why: string[] }[];
}

describe("tasks executor (TSK-01..02, SCH-01..03, FUP-01)", () => {
  it("TSK-01: nine tasks land in six sections, each row scored with its factors", async () => {
    const r = await run("TSK-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as { sections: SectionOut[]; order: string };
    expect(out.order).toBe("Needs you → Today → This week → Later → Waiting on others → Done today");
    const by = new Map(out.sections.map((s) => [s.id, s]));
    expect(by.get("needs_you")!.tasks.map((t) => t.title)).toEqual([
      "Approve the villa advance payment",
      "Aisle or window for the 18 Dec flight?",
    ]);
    expect(by.get("today")!.tasks.map((t) => t.title)).toEqual([
      "Call the villa owner about the pool",
      "Collect Karan's 5k share",
      "Check the concert booking window",
    ]);
    expect(by.get("waiting")!.tasks[0]!.title).toBe("Karan books the cab");
    expect(by.get("done_today")!.tasks[0]!.title).toBe("Reply to Priya about Sunday");
    expect(by.get("later")!.tasks).toEqual([]);
    // The hover explanation: every factor that moved the score, in words.
    expect(by.get("needs_you")!.tasks[0]!.why).toContain("gate +50: waiting for your approval");
    expect(by.get("today")!.tasks[0]!.due_label).toBe("1 day overdue");
    expect(by.get("needs_you")!.tasks[0]!.action).toBe("approve");
    expect(r.metrics!.section_today).toBe(3);
  });

  it("TSK-02: four plan gaps become four tasks, every one marked suggested", async () => {
    const r = await run("TSK-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as { tasks: { title: string; type: string; marked_suggested: boolean }[] };
    expect(out.tasks).toHaveLength(4);
    expect(out.tasks.every((t) => t.marked_suggested)).toBe(true);
    expect(r.metrics!.suggested).toBe(4);
  });

  it("SCH-01: the wait-until step starts at 09:55 IST with a poll plan and a stop", async () => {
    const r = await run("SCH-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as {
      task: { status: string; schedule: Record<string, unknown> };
      stop_condition: { until: string | null; max_polls: number | null };
    };
    expect(out.task.status).toBe("scheduled");
    expect(out.task.schedule).toMatchObject({
      mode: "auto",
      step: "wait-until",
      fire_at: "2026-08-30T04:25:00.000Z",
      window_opens_at: "2026-08-30T04:30:00.000Z",
    });
    expect(out.stop_condition.max_polls).toBe(20);
    expect(out.stop_condition.until).toBe("2026-08-30T11:00+05:30");
  });

  it("SCH-02: the due check reads first, asks by code, and never builds a provider", async () => {
    const r = await run("SCH-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as {
      wakeup: { checks: { asked: number; escalated: number; modelCalls: number } };
      logged: string[];
      task_status: string;
    };
    expect(out.wakeup.checks).toMatchObject({ asked: 1, escalated: 0, modelCalls: 0 });
    expect(out.logged).toContain("ask_done");
    expect(out.task_status).toBe("open");
    expect(r.gateObservations).toEqual([{ gateId: "clock_only_call", passed: true, counted: true }]);
  });

  it("SCH-03: both slept-through wake-ups execute, each showing its delay, and nothing re-fires", async () => {
    const r = await run("SCH-03");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as {
      wake: { fired: { task: string; late: boolean; delay: string }[]; max_delay: string };
      fire_reason: string | null;
      closure_check_late_by: string | null;
      next_tick: { fired: number };
    };
    expect(out.wake.fired).toEqual([
      { task: "Check the concert booking window", late: true, delay: "2h 00m late" },
    ]);
    expect(out.wake.max_delay).toBe("2h 00m late");
    expect(out.fire_reason).toContain("120 min late");
    expect(out.closure_check_late_by).toBe("1h 30m late");
    expect(out.next_tick.fired).toBe(0);
  });

  it("FUP-01: three follow-ups, each suggested with its because, all joined to the plan", async () => {
    const r = await run("FUP-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as {
      followups: { title: string; type: string; because: string }[];
      plan_after: string[];
    };
    expect(out.followups).toHaveLength(3);
    expect(out.followups.every((f) => f.type === "suggested")).toBe(true);
    expect(out.followups.every((f) => f.because.startsWith("because: villa booked"))).toBe(true);
    expect(out.plan_after).toEqual([
      "book flights",
      "lock the villa",
      "Advance payment reminder for Casa Anjuna",
      "Draft the packing list",
      "Web check-in CCU-GOI",
    ]);
  });
});
