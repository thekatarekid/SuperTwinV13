// ===========================================================================
// Wake-ups (V6 P1 S5.2): the one clock-driven job of the task layer. Timers,
// closure checks and the past-due sweep are LOOKUPS — zero model calls by
// construction; the next-step drain is the only duty that may call, and only
// when a closure wrote a trigger row. Pinned clock, temp DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scheduleClosureCheck } from "../brain/closure-check.js";
import { enqueueNextStep } from "../brain/next-step.js";
import type { JsonPassDeps } from "../brain/llm.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import type { ProviderV2, Usage } from "../providers/types.js";
import { providerV2TestDouble } from "../providers/test-support.js";
import { formatDelay, runWakeupLookups, runWakeups, startWakeupJob } from "./wakeups.js";

/** Sat 2026-08-29 09:00 IST. */
const NOW = new Date("2026-08-29T03:30:00.000Z");
const USAGE: Usage = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };
let tmpDir: string;

/** A provider that answers with one canned JSON body and counts its calls. */
function cannedProvider(text: string): ProviderV2 & { calls: number } {
  const state = { calls: 0 };
  const provider = providerV2TestDouble(async (opts) => {
      state.calls += 1;
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", continuation: null, usage: USAGE });
      return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" as const };
  });
  return Object.defineProperty(provider, "calls", { get: () => state.calls }) as ProviderV2 & { calls: number };
}

/** A provider that must never be constructed into a call. */
function forbiddenProvider(): ProviderV2 & { calls: number } {
  const state = { calls: 0 };
  const provider = providerV2TestDouble(async (): Promise<never> => {
    state.calls += 1;
    throw new Error("the wake-up reached for the model");
  });
  return Object.defineProperty(provider, "calls", { get: () => state.calls }) as ProviderV2 & { calls: number };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-wakeups-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  getDb()
    .prepare(`INSERT INTO spaces (id, label, status, plan_json, created_by) VALUES ('sp_1', 'Goa trip', 'active', '["book flights"]', 'test')`)
    .run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function task(id: string, opts: { status?: string; due?: string | null; schedule?: unknown; closedAt?: string } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, due, status, schedule_json,
                          evidence_json, created_by, confidence, closed_at, created_at)
       VALUES (?, 'sp_1', ?, 'explicit', 'auto', 'self', ?, ?, ?, '[]', 'test', 0.9, ?, '2026-08-20T03:30:00.000Z')`,
    )
    .run(
      id,
      `task ${id}`,
      opts.due ?? null,
      opts.status ?? "open",
      opts.schedule === undefined ? null : JSON.stringify(opts.schedule),
      opts.closedAt ?? null,
    );
}

describe("formatDelay", () => {
  it("says how late a fire is in words", () => {
    expect(formatDelay(0)).toBe("0m late");
    expect(formatDelay(90 * 60_000)).toBe("1h 30m late");
    expect(formatDelay(2 * 3_600_000)).toBe("2h 00m late");
    expect(formatDelay(-5)).toBe("0m late");
  });
});

describe("runWakeupLookups", () => {
  it("is silent and free when nothing is due", () => {
    task("t_open", { due: "2026-09-30" });
    const r = runWakeupLookups(NOW, () => undefined);
    expect(r).toMatchObject({ nextStepsPending: 0, modelCalls: 0, maxDelayMs: 0 });
    expect(r.timers.fired).toEqual([]);
    expect(r.checks).toMatchObject({ asked: 0, escalated: 0, modelCalls: 0 });
    expect(r.pastDue).toMatchObject({ asked: 0, escalated: 0, modelCalls: 0 });
  });

  it("fires a slept-through step late, with the delay carried on the fire", () => {
    task("t_fire", {
      status: "scheduled",
      schedule: { fire_at: "2026-08-29T01:30:00.000Z", mode: "auto", source: "inferred", reason: "the window opened" },
    });
    const r = runWakeupLookups(NOW, () => undefined);
    expect(r.timers.fired).toHaveLength(1);
    expect(r.timers.fired[0]).toMatchObject({ taskId: "t_fire", late: true, delayMs: 2 * 3_600_000 });
    expect(r.maxDelayMs).toBe(2 * 3_600_000);
    expect(formatDelay(r.maxDelayMs)).toBe("2h 00m late");
    // ...and the decisions row says how late, in words a human reads.
    const row = getDb()
      .prepare(`SELECT reason FROM decisions WHERE target_id = 't_fire' AND action = 'fire_schedule'`)
      .get() as { reason: string };
    expect(row.reason).toContain("120 min late");
    // The next tick fires nothing: the atomic status claim is the guard.
    expect(runWakeupLookups(new Date(NOW.getTime() + 1000), () => undefined).timers.fired).toEqual([]);
  });

  it("runs the due closure check and the past-due sweep in one pass, zero calls", () => {
    task("t_check");
    task("t_late", { due: "2026-08-27" });
    scheduleClosureCheck({
      taskId: "t_check",
      spaceId: "sp_1",
      taskTitle: "task t_check",
      checkAt: "2026-08-29T02:00:00.000Z",
      now: new Date("2026-08-29T00:30:00.000Z"),
      runId: null,
    });
    const r = runWakeupLookups(NOW, () => undefined);
    expect(r.checks).toMatchObject({ asked: 1, escalated: 0, modelCalls: 0 });
    expect(r.pastDue).toMatchObject({ asked: 1, escalated: 0, modelCalls: 0 });
    expect(r.modelCalls).toBe(0);
    const asked = getDb()
      .prepare(`SELECT target_id FROM decisions WHERE action = 'ask_done' ORDER BY rowid`)
      .all() as { target_id: string }[];
    expect(asked.map((a) => a.target_id)).toEqual(["t_check", "t_late"]);
  });

  it("counts pending next-step triggers without running them", () => {
    task("t_done", { status: "done", closedAt: "2026-08-29T03:00:00.000Z" });
    enqueueNextStep("t_done", "closure");
    expect(runWakeupLookups(NOW, () => undefined).nextStepsPending).toBe(1);
    // The trigger is still pending: the lookup counted it, it did not consume it.
    const row = getDb().prepare(`SELECT status FROM deferred_outputs WHERE task_id = 't_done'`).get() as { status: string };
    expect(row.status).toBe("deferred");
  });
});

describe("runWakeups", () => {
  it("makes NO call when no closure wrote a trigger — the lookup comes first", async () => {
    task("t_late", { due: "2026-08-27" });
    const provider = forbiddenProvider();
    const report = await runWakeups(NOW, { provider } as JsonPassDeps, () => undefined);
    expect(report.nextStepsRun).toBe(0);
    expect(report.nextStepsPending).toBe(0);
    expect(provider.calls).toBe(0);
    expect(report.pastDue.asked).toBe(1);
  });

  it("drains the next-step queue only when a trigger exists", async () => {
    task("t_done", { status: "done", closedAt: "2026-08-29T03:00:00.000Z" });
    enqueueNextStep("t_done", "closure");
    const provider = cannedProvider(
      JSON.stringify({ followups: [{ title: "Web check-in", because: "villa booked ✓", category: "scheduling", risk_class: "auto" }] }),
    );
    const deps: JsonPassDeps = {
      provider,
      now: () => new Date(NOW.getTime()),
      recordRun: () => "run-test",
      logExtractionRun: () => undefined,
    };
    const report = await runWakeups(NOW, deps, () => undefined);
    expect(report.nextStepsRun).toBe(1);
    expect(provider.calls).toBe(1);
    const followup = getDb().prepare(`SELECT title, type FROM tasks WHERE id != 't_done'`).get() as { title: string; type: string };
    expect(followup).toEqual({ title: "Web check-in", type: "suggested" });
  });
});

describe("startWakeupJob", () => {
  it("recovers missed fires at boot and stops cleanly", () => {
    task("t_fire", {
      status: "scheduled",
      schedule: { fire_at: "2026-08-29T01:30:00.000Z", mode: "auto", source: "inferred" },
    });
    const lines: string[] = [];
    const job = startWakeupJob({ now: () => NOW, sink: () => undefined, log: (l) => lines.push(l), intervalMs: 3_600_000 });
    try {
      expect((getDb().prepare(`SELECT status FROM tasks WHERE id = 't_fire'`).get() as { status: string }).status).toBe("executing");
      expect(lines.join("\n")).toContain("boot recovery");
      expect(lines.join("\n")).toContain("2h 00m late");
      expect(lines.join("\n")).toContain("model-calls-from-lookups=0");
    } finally {
      job.stop();
    }
  });

  it("runNow re-runs the lookups on demand and never leaves a timer behind", async () => {
    vi.useFakeTimers();
    try {
      task("t_late", { due: "2026-08-27" });
      const job = startWakeupJob({ now: () => NOW, sink: () => undefined, log: () => undefined });
      // Boot already asked once; the same instant re-run finds the card standing.
      const report = await job.runNow();
      expect(report.pastDue).toMatchObject({ asked: 0, cooling: 1, modelCalls: 0 });
      expect(report.nextStepsRun).toBe(0);
      job.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
