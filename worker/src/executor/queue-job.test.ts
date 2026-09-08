// ===========================================================================
// The prepared-action queue job (V6 P1 R2). ZERO model calls: every fixture
// here is a THIN-CONTEXT action, which executor-lite answers with one combined
// question card before it spends anything (EXE-02), so the whole drain path
// runs offline and the assertions are about the JOB, not the model.
//
// What is pinned:
//   * an empty queue is a lookup and nothing else — no drain, no log line;
//   * a tick drains at most `limit`, oldest first, and the rows it drained
//     leave the queue while the rest stay;
//   * "Stop all model activity" and the budget latch HOLD the queue instead of
//     burning it — `runPreparedAction` resolves a row whatever the outcome, so
//     draining while paused would mark work done that never happened;
//   * two ticks never overlap, and the job stops when it is told to.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import { listPreparedActions, type PreparedActionPayload, type PreparedActionRow } from "../brain/live.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { resetBudgetLatch, setModelActivityPaused, tripBudget } from "../providers/budget.js";
import { providerV2TestDouble } from "../providers/test-support.js";
import { registerV2, resetProviderRegistryForTests } from "../providers/registry.js";
import {
  PREPARED_QUEUE_BOOT_DELAY_MS,
  PREPARED_QUEUE_INTERVAL_MS,
  PREPARED_QUEUE_LIMIT,
  preparedQueueTick,
  startPreparedQueueJob,
} from "./queue-job.js";

const NOW_MS = Date.parse("2026-09-05T10:40:00.000Z");

/**
 * A prepared action with a MISSING required input (`compare` needs dates and a
 * budget). Thin context stops the pass: one question card, zero fetches, zero
 * model calls.
 */
function thin(id: string, createdAt: string): PreparedActionRow {
  const payload = {
    kind: "help_now",
    intent: `comparing villas (${id})`,
    intent_confidence: 0.9,
    action: "compare",
    space: "sp1",
    urgency: "now",
    deadline_at: null,
    inputs: { candidates: ["https://villas.example/sol"] },
    grounded_in: ["e1"],
    reasoning: "they are looking at villas right now",
    groundedEventIds: ["ev_1"],
    surface: "card",
    intentFloor: 0.7,
    bundleKey: "st_1:1-3",
    lane: "live",
    runId: "run_1",
    contentKey: `ck_${id}`,
    preparedAt: createdAt,
  } as unknown as PreparedActionPayload;
  const row: PreparedActionRow = { id, spaceId: "sp1", taskId: null, status: "deferred", createdAt, payload };
  getDb()
    .prepare(
      `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, status, created_by, created_at)
       VALUES (?, ?, ?, 'prepared_action', ?, 'deferred', 'live', ?)`,
    )
    .run(row.id, row.spaceId, row.taskId, JSON.stringify(row.payload), row.createdAt);
  return row;
}

const queued = (): string[] => listPreparedActions({ status: "deferred", limit: 100 }).map((r) => r.id);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-prepared-queue-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  const provider = providerV2TestDouble(async () => {
    throw new Error("thin queue fixture must never send");
  }, { model: { supportsHostTools: true } });
  registerV2({ ...provider, capabilities: { ...provider.capabilities, hostTools: true } });
  getDb().prepare(`INSERT INTO spaces (id, label, goal, status) VALUES ('sp1','Goa trip','villa under 6k','active')`).run();
});

afterEach(() => {
  setModelActivityPaused(false);
  resetBudgetLatch();
  resetProviderRegistryForTests();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("preparedQueueTick", () => {
  it("an empty queue is a lookup: nothing drained, nothing spent", async () => {
    const r = await preparedQueueTick();
    expect(r).toMatchObject({ status: "idle", queued: 0, drained: 0, modelCalls: 0 });
    expect(r.results).toEqual([]);
  });

  it("drains at most `limit` per tick and leaves the rest queued", async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    thin("prep_2", "2026-09-05T10:10:00.000Z");
    thin("prep_3", "2026-09-05T10:20:00.000Z");

    const first = await preparedQueueTick({ limit: 2 });
    expect(first.status).toBe("drained");
    expect(first.queued).toBe(3);
    expect(first.drained).toBe(2);
    // Thin context asks; it never assumes and never spends (EXE-02).
    expect(first.modelCalls).toBe(0);
    expect(first.results.every((r) => r.status === "question")).toBe(true);
    expect(queued()).toEqual(["prep_1"]);

    const second = await preparedQueueTick({ limit: 2 });
    expect(second.drained).toBe(1);
    expect(queued()).toEqual([]);

    // …and a third tick over the drained queue is a lookup again.
    expect((await preparedQueueTick({ limit: 2 })).status).toBe("idle");
  });

  it('"Stop all model activity" HOLDS the queue rather than burning it', async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    setModelActivityPaused(true);
    const r = await preparedQueueTick();
    expect(r.status).toBe("held");
    expect(r.drained).toBe(0);
    expect(String(r.reason)).toContain("paused");
    // The row is untouched — releasing the switch resumes the work.
    expect(queued()).toEqual(["prep_1"]);
    setModelActivityPaused(false);
    expect((await preparedQueueTick()).drained).toBe(1);
  });

  it("a tripped budget latch holds it too, until an operator resets", async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    tripBudget("$3/hour exceeded", NOW_MS);
    const r = await preparedQueueTick();
    expect(r.status).toBe("held");
    expect(String(r.reason)).toContain("budget latch");
    expect(queued()).toEqual(["prep_1"]);
    resetBudgetLatch();
    expect((await preparedQueueTick()).drained).toBe(1);
  });

  it("a signed-out active provider holds the row without sending or activating it", async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    let sends = 0;
    const ready = providerV2TestDouble(async () => {
      sends += 1;
      throw new Error("must not send");
    }, { model: { supportsHostTools: true } });
    registerV2({
      ...ready,
      capabilities: { ...ready.capabilities, hostTools: true },
      authState: () => ({ status: "signed_out", error: null }),
    });

    const r = await preparedQueueTick();
    expect(r.status).toBe("held");
    expect(r.reason).toContain("AUTH_REQUIRED");
    expect(r.drained).toBe(0);
    expect(sends).toBe(0);
    expect(queued()).toEqual(["prep_1"]);
  });
});

describe("startPreparedQueueJob", () => {
  it("has the same shape as the other periodic jobs, and does not tick on its own at boot", async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    const lines: string[] = [];
    // A boot delay and an interval far past this test: nothing fires by itself.
    const job = startPreparedQueueJob({ bootDelayMs: 3_600_000, intervalMs: 3_600_000, log: (l) => lines.push(l) });
    try {
      expect(queued()).toEqual(["prep_1"]);
      const r = await job.runNow();
      expect(r.drained).toBe(1);
      expect(lines.join("\n")).toContain("[prepared] drained 1/1");
    } finally {
      job.stop();
    }
    expect(queued()).toEqual([]);
  });

  it("two ticks never overlap — the second joins the first", async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    thin("prep_2", "2026-09-05T10:10:00.000Z");
    const job = startPreparedQueueJob({ bootDelayMs: 3_600_000, intervalMs: 3_600_000, limit: 2, log: () => {} });
    try {
      const [a, b] = await Promise.all([job.runNow(), job.runNow()]);
      expect(a).toBe(b);
      expect(a.drained).toBe(2);
    } finally {
      job.stop();
    }
  });

  it("says why it is holding once, not every tick", async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    setModelActivityPaused(true);
    const lines: string[] = [];
    const job = startPreparedQueueJob({ bootDelayMs: 3_600_000, intervalMs: 3_600_000, log: (l) => lines.push(l) });
    try {
      await job.runNow();
      await job.runNow();
      expect(lines.filter((l) => l.includes("waiting"))).toHaveLength(1);
    } finally {
      job.stop();
    }
  });

  it("stop() is final: a stopped job never ticks again", async () => {
    thin("prep_1", "2026-09-05T10:00:00.000Z");
    const job = startPreparedQueueJob({ bootDelayMs: 0, intervalMs: 10, log: () => {} });
    job.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(queued()).toEqual(["prep_1"]);
  });

  it("ships the documented cadence", () => {
    expect(PREPARED_QUEUE_INTERVAL_MS).toBe(120_000);
    expect(PREPARED_QUEUE_BOOT_DELAY_MS).toBe(40_000);
    expect(PREPARED_QUEUE_LIMIT).toBe(2);
  });
});
