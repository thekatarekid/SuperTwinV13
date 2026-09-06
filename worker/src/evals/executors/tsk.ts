// ===========================================================================
// [CODE] TSK / SCH / FUP — tasks and scheduler executor (GoldenEvals V6 P1 §5
// TSK-01..02, SCH-01..03, FUP-01; build S5.2).
//
// Deterministic, zero model calls, clock pinned to FIXTURE_NOW. Each case seeds
// its own space, drives the REAL product code (tasks/priority.ts,
// brain/decide-pass.ts → decide-apply → schedule-policy, brain/closure-check.ts,
// tasks/closure-rules.ts, scheduler/v6/timers.ts through tasks/wakeups.ts,
// brain/next-step.ts) with a canned provider where a pass output is needed,
// then reads the database back and asserts. What is graded is the code around
// the model: sections + explained score, "suggested is marked and uncapped",
// the wait-until step, a wake-up as a lookup (clock_only_call = 0), missed
// fires executing on wake with the delay shown, follow-ups joining the plan.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { scheduleClosureCheck, CLOSURE_CHECK_KIND } from "../../brain/closure-check.js";
import type { JsonPassDeps } from "../../brain/llm.js";
import { runNextStepPass } from "../../brain/next-step.js";
import { listPrioritizedTasks, type Section, SECTIONS } from "../../tasks/priority.js";
import { formatDelay, runWakeupLookups } from "../../tasks/wakeups.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import type { GateInput } from "../gates.js";
import { FIXTURE_NOW, fixtureNow } from "./clock.js";
import { cannedProvider, cleanup as cleanupDec, runDecCase } from "./dec.js";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}

interface SeededSpace {
  spaceId: string;
  taskIds: string[];
}

/** Seed a space + tasks straight from the fixture's setup (no events needed). */
function seedSpace(id: string, setup: Record<string, unknown>): SeededSpace {
  const db = getDb();
  const sp = rec(setup.space);
  const spaceId = str(sp.id) ?? `sp_${id.toLowerCase()}`;
  db.prepare(
    `INSERT INTO spaces (id, label, goal, status, plan_json, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, 'eval', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(spaceId, str(sp.label) ?? `eval ${id}`, str(sp.goal), str(sp.status) ?? "active", sp.plan === undefined ? null : JSON.stringify(sp.plan));
  const taskIds: string[] = [];
  for (const t of list(setup.tasks)) {
    const tid = str(t.id) ?? `tsk_${id.toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, due, status,
                          schedule_json, evidence_json, created_by, confidence, closed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'eval', ?, ?, ?)`,
    ).run(
      tid,
      spaceId,
      str(t.title) ?? "task",
      str(t.type) ?? "explicit",
      str(t.category),
      str(t.risk_class) ?? "advise-only",
      str(t.owner) ?? "self",
      str(t.due),
      str(t.status) ?? "open",
      t.schedule === undefined ? null : JSON.stringify(t.schedule),
      num(t.confidence, 0.9),
      str(t.closed_at),
      str(t.created_at) ?? new Date(FIXTURE_NOW.getTime() - 3_600_000).toISOString(),
    );
    taskIds.push(tid);
  }
  return { spaceId, taskIds };
}

function cleanupSpace(s: SeededSpace): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM deferred_outputs WHERE space_id = ?`).run(s.spaceId);
    db.prepare(`DELETE FROM tasks WHERE space_id = ?`).run(s.spaceId);
    db.prepare(`DELETE FROM spaces WHERE id = ?`).run(s.spaceId);
  })();
}

/** Every case in this file is deterministic: the provider is canned or absent. */
const NO_CALLS = { model_calls: 0 };

// ---------------------------------------------------------------------------
// TSK-01 — prioritized sections, score explained
// ---------------------------------------------------------------------------

function tsk01(id: string, setup: Record<string, unknown>, expected: Record<string, unknown>): ExecutorResult {
  const seeded = seedSpace(id, setup);
  try {
    const listed = listPrioritizedTasks({ now: fixtureNow(), spaceId: seeded.spaceId });
    const counts = Object.fromEntries(listed.sections.map((s) => [s.id, s.tasks.length])) as Record<Section, number>;
    const want = rec(expected.sections);
    const violations: Violation[] = [];
    for (const s of SECTIONS) {
      const w = num(want[s], 0);
      if (counts[s] !== w) violations.push({ label: "wrong-section", note: `${s}: ${counts[s]} task(s), expected ${w}` });
    }
    if (listed.total !== seeded.taskIds.length) {
      violations.push({ label: "flat-list", note: `${listed.total} of ${seeded.taskIds.length} tasks placed` });
    }
    const unexplained = listed.sections.flatMap((s) => s.tasks).filter((t) => t.why.length === 0 || typeof t.score !== "number");
    if (unexplained.length > 0) {
      violations.push({ label: "unexplained-score", note: `${unexplained.length} row(s) carry no factors: ${unexplained.map((t) => t.title).join(", ")}` });
    }
    // Within a section the order is the score, descending.
    for (const s of listed.sections) {
      for (let i = 1; i < s.tasks.length; i += 1) {
        if (s.tasks[i]!.score > s.tasks[i - 1]!.score) violations.push({ label: "unexplained-score", note: `${s.id} is not ordered by score` });
      }
    }
    return {
      ok: violations.length === 0,
      output: {
        sections: listed.sections.map((s) => ({
          id: s.id,
          label: s.label,
          tasks: s.tasks.map((t) => ({ title: t.title, score: t.score, due_label: t.due_label, action: t.action, why: t.why.map((f) => `${f.factor} ${f.delta >= 0 ? "+" : ""}${f.delta}: ${f.note}`) })),
        })),
        order: listed.sections.map((s) => s.label).join(" → "),
      },
      violations,
      metrics: { ...NO_CALLS, tasks: listed.total, ...Object.fromEntries(SECTIONS.map((s) => [`section_${s}`, counts[s]])) },
      notes: ["code decides section and score; every row carries its factors (hover explanation)"],
    };
  } finally {
    cleanupSpace(seeded);
  }
}

// ---------------------------------------------------------------------------
// TSK-02 — suggested is marked and uncapped (canned decide.v9 → real pass)
// ---------------------------------------------------------------------------

async function tsk02(id: string, setup: Record<string, unknown>, expected: Record<string, unknown>): Promise<ExecutorResult> {
  const run = await runDecCase(id, setup);
  try {
    const want = num(expected.suggested, 4);
    const suggested = run.tasks.filter((t) => t.type === "suggested");
    const violations: Violation[] = [];
    if (suggested.length !== want) violations.push({ label: "capped", note: `${suggested.length} suggested task(s) created, expected ${want}` });
    const unmarked = run.tasks.filter((t) => t.type !== "suggested" && t.owner === "self");
    if (unmarked.length > 0) violations.push({ label: "unmarked", note: `${unmarked.length} plan-gap task(s) not typed suggested: ${unmarked.map((t) => t.title).join(", ")}` });
    if (run.result.applied.tasksSkipped > 0) violations.push({ label: "capped", note: `${run.result.applied.tasksSkipped} task(s) skipped by a budget` });
    if (run.result.status !== "ok" && run.result.status !== "repaired") violations.push({ label: "pass-failed", note: `decide ${run.result.status}` });
    return {
      ok: violations.length === 0,
      output: {
        tasks: run.tasks.map((t) => ({ title: t.title, type: t.type, marked_suggested: t.type === "suggested", status: t.status })),
        applied: run.result.applied,
      },
      violations,
      metrics: { ...NO_CALLS, canned_answers: run.providerCalls, suggested: suggested.length },
      notes: ["no suggested-task budget: if the plan needs it, it exists; dedupe by open title is the only filter"],
    };
  } finally {
    cleanupDec(run.seeded);
  }
}

// ---------------------------------------------------------------------------
// SCH-01 — wait-until: a step just before the window with a poll plan + stop
// ---------------------------------------------------------------------------

async function sch01(id: string, setup: Record<string, unknown>, expected: Record<string, unknown>): Promise<ExecutorResult> {
  const run = await runDecCase(id, setup);
  try {
    const violations: Violation[] = [];
    const task = run.tasks.find((t) => t.schedule_json !== null);
    const sched = task?.schedule_json ? rec(JSON.parse(task.schedule_json)) : null;
    const wantFire = str(expected.fire_at) ?? "2026-08-30T04:25:00.000Z";
    const wantWindow = str(expected.window_opens_at) ?? "2026-08-30T04:30:00.000Z";
    if (!task || !sched) {
      violations.push({ label: "no-step", note: "no task carries a schedule" });
    } else {
      if (task.status !== "scheduled" || sched.mode !== "auto") violations.push({ label: "ask-for-obvious", note: `status ${task.status}, mode ${String(sched.mode)} — a read-only check should schedule auto` });
      if (sched.fire_at !== wantFire) violations.push({ label: "wrong-time", note: `fire_at ${String(sched.fire_at)} ≠ ${wantFire} (09:55 IST)` });
      if (sched.step !== "wait-until") violations.push({ label: "no-step", note: `schedule is not a wait-until step (step=${String(sched.step)})` });
      if (sched.window_opens_at !== wantWindow) violations.push({ label: "early-fire", note: `window_opens_at ${String(sched.window_opens_at)} ≠ ${wantWindow}` });
      const polling = rec(sched.polling);
      if (Object.keys(polling).length === 0) violations.push({ label: "single-shot", note: "no poll plan" });
      else {
        if (typeof polling.until !== "string" && typeof polling.maxPolls !== "number") violations.push({ label: "no-stop", note: "poll plan has no stop condition (until / maxPolls)" });
        if (typeof polling.until === "string" && Date.parse(polling.until) <= Date.parse(wantWindow)) violations.push({ label: "no-stop", note: `until ${polling.until} is not after the window opens` });
      }
    }
    if (run.result.status !== "ok" && run.result.status !== "repaired") violations.push({ label: "pass-failed", note: `decide ${run.result.status}` });
    return {
      ok: violations.length === 0,
      output: {
        task: task ? { title: task.title, status: task.status, schedule: sched } : null,
        stop_condition: sched ? { until: rec(sched.polling).until ?? null, max_polls: rec(sched.polling).maxPolls ?? null, and: "the task leaving 'scheduled' when the executor completes it" } : null,
        decisions: run.decisions.map((d) => d.action),
      },
      violations,
      gateObservations: [{ gateId: "auto_schedule_policy_violation", passed: !violations.some((v) => v.label === "early-fire"), counted: true }],
      metrics: { ...NO_CALLS, canned_answers: run.providerCalls },
      notes: ["fire_at leads the window by ≤ POLL_LEAD_MAX_MS only because a poll plan exists (TIM-04 clamp); the policy, not the prompt, decides"],
    };
  } finally {
    cleanupDec(run.seeded);
  }
}

// ---------------------------------------------------------------------------
// SCH-02 — a wake-up is a lookup first (clock_only_call = 0)
// ---------------------------------------------------------------------------

function sch02(id: string, setup: Record<string, unknown>): ExecutorResult {
  const seeded = seedSpace(id, setup);
  try {
    const now = fixtureNow();
    const taskId = seeded.taskIds[0]!;
    const title = (getDb().prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId) as { title: string }).title;
    // The check was set two hours ago for one hour ago; the machine wakes now.
    scheduleClosureCheck({
      taskId,
      spaceId: seeded.spaceId,
      taskTitle: title,
      checkAt: new Date(now.getTime() - 3_600_000).toISOString(),
      now: new Date(now.getTime() - 2 * 3_600_000),
      runId: null,
      reason: "one-sided intent",
    });
    const report = runWakeupLookups(now, () => undefined);
    const decisions = getDb()
      .prepare(`SELECT action, new_json FROM decisions WHERE target_kind = 'task' AND target_id = ? ORDER BY rowid`)
      .all(taskId) as { action: string; new_json: string | null }[];
    const ask = decisions.find((d) => d.action === "ask_done");
    const violations: Violation[] = [];
    if (report.checks.modelCalls !== 0 || report.modelCalls !== 0) violations.push({ label: "clock-only-call", note: "a lookup reported a model call" });
    if (report.checks.escalated !== 0 || report.nextStepsPending !== 0) violations.push({ label: "clock-only-call", note: `the wake-up reached for the model with nothing new (escalated ${report.checks.escalated}, next-steps ${report.nextStepsPending})` });
    if (report.checks.asked !== 1) violations.push({ label: "silent-noop", note: `expected one "done?" card by code, got ${report.checks.asked}` });
    if (!ask) violations.push({ label: "silent-noop", note: "the no-op was not logged (no ask_done decision)" });
    else if (rec(JSON.parse(ask.new_json ?? "{}")).modelCalls !== 0) violations.push({ label: "clock-only-call", note: "ask_done row does not record modelCalls 0" });
    const task = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
    if (task.status !== "open") violations.push({ label: "one-sided-close", note: `task is ${task.status}` });
    return {
      ok: violations.length === 0,
      output: {
        wakeup: { timers: report.timers, checks: report.checks, past_due: report.pastDue, next_steps_pending: report.nextStepsPending },
        logged: decisions.map((d) => d.action),
        task_status: task.status,
      },
      violations,
      gateObservations: [{ gateId: "clock_only_call", passed: !violations.some((v) => v.label === "clock-only-call"), counted: true }],
      metrics: { ...NO_CALLS, asked: report.checks.asked, escalated: report.checks.escalated },
      notes: ["the check read the space's streams (nothing newer than the anchor) and wrote the done? card itself — no provider was constructed"],
    };
  } finally {
    cleanupSpace(seeded);
  }
}

// ---------------------------------------------------------------------------
// SCH-03 — missed wake-ups fire on wake, with the delay shown
// ---------------------------------------------------------------------------

function sch03(id: string, setup: Record<string, unknown>, expected: Record<string, unknown>): ExecutorResult {
  const seeded = seedSpace(id, setup);
  try {
    const now = fixtureNow();
    const db = getDb();
    const scheduled = db.prepare(`SELECT id, title FROM tasks WHERE space_id = ? AND status = 'scheduled'`).get(seeded.spaceId) as { id: string; title: string } | undefined;
    const checked = db.prepare(`SELECT id, title FROM tasks WHERE space_id = ? AND status = 'open'`).get(seeded.spaceId) as { id: string; title: string } | undefined;
    const checkLateMs = num(expected.check_late_ms, 90 * 60_000);
    if (checked) {
      scheduleClosureCheck({
        taskId: checked.id,
        spaceId: seeded.spaceId,
        taskTitle: checked.title,
        checkAt: new Date(now.getTime() - checkLateMs).toISOString(),
        now: new Date(now.getTime() - 3 * 3_600_000),
        runId: null,
      });
    }
    const first = runWakeupLookups(now, () => undefined);
    const second = runWakeupLookups(new Date(now.getTime() + 1000), () => undefined);
    const wantDelay = num(expected.fire_delay_ms, 2 * 3_600_000);
    const fire = first.timers.fired.find((f) => f.taskId === scheduled?.id);
    const violations: Violation[] = [];
    if (!scheduled) violations.push({ label: "bad-seed", note: "no scheduled task seeded" });
    if (!fire) violations.push({ label: "lost-fire", note: "the missed fire did not execute on wake" });
    else {
      if (!fire.late) violations.push({ label: "delay-hidden", note: "fire not flagged late" });
      if (fire.delayMs !== wantDelay) violations.push({ label: "delay-hidden", note: `delayMs ${fire.delayMs} ≠ ${wantDelay}` });
    }
    const fireDecision = scheduled
      ? (db.prepare(`SELECT reason FROM decisions WHERE target_id = ? AND action = 'fire_schedule' ORDER BY rowid DESC`).get(scheduled.id) as { reason: string | null } | undefined)
      : undefined;
    if (!fireDecision?.reason || !/min late/.test(fireDecision.reason)) violations.push({ label: "delay-hidden", note: `fire decision does not show the delay: ${fireDecision?.reason ?? "(none)"}` });
    if (second.timers.fired.length > 0) violations.push({ label: "double-fire", note: `re-fired ${second.timers.fired.length}x on the next tick` });
    const ask = checked
      ? (db.prepare(`SELECT new_json FROM decisions WHERE target_id = ? AND action = 'ask_done' ORDER BY rowid DESC`).get(checked.id) as { new_json: string | null } | undefined)
      : undefined;
    const askLate = ask ? rec(JSON.parse(ask.new_json ?? "{}")).lateByMs : undefined;
    if (checked && first.checks.asked !== 1) violations.push({ label: "lost-fire", note: `missed closure check: asked ${first.checks.asked}` });
    if (checked && askLate !== checkLateMs) violations.push({ label: "delay-hidden", note: `closure check lateByMs ${String(askLate)} ≠ ${checkLateMs}` });
    if (first.modelCalls !== 0 || first.checks.modelCalls !== 0) violations.push({ label: "clock-only-call", note: "the wake-up made a model call" });
    return {
      ok: violations.length === 0,
      output: {
        wake: {
          fired: first.timers.fired.map((f) => ({ task: f.title, late: f.late, delay: formatDelay(f.delayMs) })),
          skipped: first.timers.skipped,
          checks: first.checks,
          max_delay: formatDelay(first.maxDelayMs),
        },
        fire_reason: fireDecision?.reason ?? null,
        closure_check_late_by: typeof askLate === "number" ? formatDelay(askLate) : null,
        next_tick: { fired: second.timers.fired.length, note: "atomic status claim = no double fire" },
      },
      violations,
      gateObservations: [{ gateId: "clock_only_call", passed: !violations.some((v) => v.label === "clock-only-call"), counted: true }],
      metrics: { ...NO_CALLS, fired: first.timers.fired.length, max_delay_ms: first.maxDelayMs, asked: first.checks.asked },
      notes: ["the timer classifies a slept-through fire late/expired from its window; the delay rides the fire and its decisions row"],
    };
  } finally {
    cleanupSpace(seeded);
  }
}

// ---------------------------------------------------------------------------
// FUP-01 — completion spawns follow-ups into the plan
// ---------------------------------------------------------------------------

async function fup01(id: string, setup: Record<string, unknown>, expected: Record<string, unknown>): Promise<ExecutorResult> {
  const seeded = seedSpace(id, setup);
  const provider = cannedProvider(JSON.stringify(setup.followup ?? { followups: [] }));
  try {
    const now = fixtureNow();
    const closed = seeded.taskIds[0]!;
    const deps: JsonPassDeps = {
      provider,
      now: () => new Date(now.getTime()),
      recordRun: () => `eval-${id}`,
      logExtractionRun: () => undefined,
    };
    const result = await runNextStepPass(closed, "closure", deps);
    const db = getDb();
    const tasks = db
      .prepare(`SELECT id, title, type, category, risk_class, due, status, evidence_json FROM tasks WHERE space_id = ? AND id != ? ORDER BY rowid`)
      .all(seeded.spaceId, closed) as { id: string; title: string; type: string; category: string | null; risk_class: string; due: string | null; status: string; evidence_json: string }[];
    const planJson = (db.prepare(`SELECT plan_json FROM spaces WHERE id = ?`).get(seeded.spaceId) as { plan_json: string | null }).plan_json;
    const plan = planJson ? (JSON.parse(planJson) as string[]) : [];
    const wantTitles = (Array.isArray(expected.followups) ? expected.followups : []).map(String);
    const violations: Violation[] = [];
    if (result.status !== "ok" && result.status !== "repaired") violations.push({ label: "pass-failed", note: `next-step ${result.status}: ${result.error?.message ?? ""}` });
    if (tasks.length === 0) violations.push({ label: "dead-end", note: "nothing follows the booking" });
    for (const want of wantTitles) {
      const hit = tasks.find((t) => t.title.toLowerCase().includes(want.toLowerCase()));
      if (!hit) {
        violations.push({ label: "dead-end", note: `no follow-up matching "${want}"` });
        continue;
      }
      if (hit.type !== "suggested") violations.push({ label: "unmarked", note: `"${hit.title}" typed ${hit.type}` });
      if (!/because/i.test(hit.evidence_json)) violations.push({ label: "random-tasks-feel", note: `"${hit.title}" carries no because` });
      if (!plan.some((p) => p.toLowerCase() === hit.title.toLowerCase())) violations.push({ label: "not-in-plan", note: `"${hit.title}" did not join the plan` });
    }
    if (result.counts.followupsSkipped > 0) violations.push({ label: "capped", note: `${result.counts.followupsSkipped} follow-up(s) skipped` });
    return {
      ok: violations.length === 0,
      output: {
        followups: tasks.map((t) => ({ title: t.title, type: t.type, category: t.category, risk_class: t.risk_class, due: t.due, because: (JSON.parse(t.evidence_json) as { quote?: string }[]).map((e) => e.quote).join("; ") })),
        plan_before: setup.space ? rec(setup.space).plan ?? null : null,
        plan_after: plan,
        counts: result.counts,
      },
      violations,
      metrics: { ...NO_CALLS, canned_answers: provider.calls, followups: tasks.length, plan_steps: plan.length },
      notes: ["canned followup.v1 output through the real next-step pass; every follow-up is a suggested task with its because and a step in the plan"],
    };
  } finally {
    cleanupSpace(seeded);
  }
}

export const tskExecutor: Executor = async ({ fixture }) => {
  const setup = rec(fixture.setup);
  const expected = rec(fixture.expected);
  switch (fixture.id) {
    case "TSK-01":
      return tsk01(fixture.id, setup, expected);
    case "TSK-02":
      return tsk02(fixture.id, setup, expected);
    case "SCH-01":
      return sch01(fixture.id, setup, expected);
    case "SCH-02":
      return sch02(fixture.id, setup);
    case "SCH-03":
      return sch03(fixture.id, setup, expected);
    case "FUP-01":
      return fup01(fixture.id, setup, expected);
    default: {
      const gates: GateInput[] = [];
      return { ok: false, output: { error: `no tasks executor for ${fixture.id}` }, violations: [{ label: "unknown-case", note: fixture.id }], gateObservations: gates };
    }
  }
};

export { CLOSURE_CHECK_KIND };
