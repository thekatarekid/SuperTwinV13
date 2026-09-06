// ===========================================================================
// Budget gate (S0.2, T0-4) and kill switch (S0.8, T0-13) — GoldenEvals
// SPD-01, SPD-02 and SPD-03 as deterministic vitest tests. ZERO live model calls: the only "claude" here is a fake CLI
// that writes a marker file if it is ever spawned — and the point of SPD-01 is
// that it is not.
// ===========================================================================

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateGet } from "../db/ingest.js";
import { withTraceContext } from "../traces/context.js";
import {
  BUDGET_TRIPPED_KEY,
  BudgetExceededError,
  DEFAULT_CEILINGS,
  MODEL_ACTIVITY_PAUSED_KEY,
  ModelActivityPausedError,
  admitCall,
  budgetStatus,
  isBudgetTripped,
  isLatchExempt,
  isModelActivityPaused,
  recordCallCost,
  resetBudgetForTests,
  resetBudgetLatch,
  setModelActivityPaused,
} from "./budget.js";
import { resetSpendHeartbeatForTests, spendHeartbeatLine } from "./spend-heartbeat.js";

const stage = mkdtempSync(join(tmpdir(), "supertwin-budget-"));
const fakeCli = join(stage, "claude");
const spawnMarker = join(stage, "SPAWNED");

const KEYS = [
  "SUPERTWIN_DB_PATH",
  "SUPERTWIN_HOME",
  "CLAUDE_BIN",
  "SUPERTWIN_TRACE_ENFORCE",
  "SUPERTWIN_BUDGET_USD_PER_HOUR",
  "SUPERTWIN_BUDGET_CALLS_PER_HOUR",
] as const;
const saved = new Map<string, string | undefined>();

const BACKGROUND = { pass: "orient", caller: "brain/llm" };
const BAR = { pass: "bar-answer.v1", caller: "grounded/handlers" };
const CHAT = { pass: "chat", caller: "server/chat" };

let dbPath: string;

beforeAll(() => {
  for (const k of KEYS) saved.set(k, process.env[k]);
  writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env node",
      'require("node:fs").writeFileSync(process.env.ST_SPAWN_MARKER, "spawned");',
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCli, 0o755);
  process.env.CLAUDE_BIN = fakeCli;
  process.env.ST_SPAWN_MARKER = spawnMarker;
});

afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.ST_SPAWN_MARKER;
  rmSync(stage, { recursive: true, force: true });
});

beforeEach(() => {
  dbPath = join(mkdtempSync(join(stage, "db-")), "budget.db");
  process.env.SUPERTWIN_DB_PATH = dbPath;
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_BUDGET_USD_PER_HOUR;
  delete process.env.SUPERTWIN_BUDGET_CALLS_PER_HOUR;
  closeDb();
  runMigrations();
  resetBudgetForTests();
  rmSync(spawnMarker, { force: true });
});

afterEach(() => {
  closeDb();
});

/** Admit `n` background calls at time `now` (what n successful spawns do). */
function admitMany(n: number, now: number): void {
  for (let i = 0; i < n; i += 1) admitCall(BACKGROUND, now + i);
}

describe("SPD-01 — ceiling throws before spawn", () => {
  it("400 calls in the hour, then one more: BUDGET_EXCEEDED, no child process, latch set", async () => {
    // Real clock: the provider's own admit uses Date.now().
    const t0 = Date.now() - 60_000;
    admitMany(DEFAULT_CEILINGS.callsPerHour, t0);
    expect(budgetStatus(t0 + 1000).hour.calls).toBe(400);
    expect(isBudgetTripped()).toBe(false);

    // The 401st goes through the REAL provider against the fake CLI. It must
    // reject before spawn: the marker the fake writes must never appear.
    const { claudeLocalProvider } = await import("./claude-local/index.js");
    let error: unknown = null;
    try {
      await withTraceContext(BACKGROUND, () =>
        claudeLocalProvider.send({
          runId: "spd-01",
          message: "hello",
          plainCompletion: true,
          onEvent: () => {},
        }),
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).code).toBe("BUDGET_EXCEEDED");
    expect((error as BudgetExceededError).message).toContain("No process was spawned");
    expect(existsSync(spawnMarker)).toBe(false); // wrong: spawn-then-fail

    // The latch is in app_state, under the key the plan names.
    const tripped = appStateGet(BUDGET_TRIPPED_KEY);
    expect(tripped).not.toBeNull();
    expect(Number.isNaN(Date.parse(tripped as string))).toBe(false);
    // ...and the refused call was not counted.
    expect(budgetStatus().hour.calls).toBe(400);
  });

  it("the refusal reaches the heartbeat: a blocked minute cannot read as an idle one (C3)", async () => {
    // The user's 13.11.5 install: latch set, lanes still asking, every ask
    // refused before spawn — and every `[spend]` line saying "0 calls", which
    // is what a worker whose dispatcher never started also says.
    resetSpendHeartbeatForTests();
    admitMany(DEFAULT_CEILINGS.callsPerHour, Date.now() - 60_000);
    const { claudeLocalProvider } = await import("./claude-local/index.js");
    for (const runId of ["c3-a", "c3-b"]) {
      await expect(
        withTraceContext(BACKGROUND, () =>
          claudeLocalProvider.send({ runId, message: "hello", plainCompletion: true, onEvent: () => {} }),
        ),
      ).rejects.toBeInstanceOf(BudgetExceededError);
    }
    expect(existsSync(spawnMarker)).toBe(false);
    const line = spendHeartbeatLine(Date.now());
    expect(line).toContain("BLOCKED: 2 refused this interval (BUDGET_EXCEEDED ×2), 2 since boot");
    resetSpendHeartbeatForTests();
  });

  it("the spend ceiling trips the same way: $3 in the hour, next background call refused", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitCall(BACKGROUND, t0);
    recordCallCost(2.999, t0);
    admitCall(BACKGROUND, t0 + 1); // still under
    recordCallCost(0.002, t0 + 1); // now $3.001
    expect(() => admitCall(BACKGROUND, t0 + 2)).toThrow(BudgetExceededError);
    expect(isBudgetTripped()).toBe(true);
    expect(budgetStatus(t0 + 2).trippedReason).toMatch(/spent in the last hour/);
  });

  it("a poison fallback pays a second admit: the count is per CLI invocation", async () => {
    // Directly: two admits from one logical run land as two calls.
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitCall(BACKGROUND, t0);
    admitCall(BACKGROUND, t0);
    expect(budgetStatus(t0).hour.calls).toBe(2);
  });

  it("chat and the grounded bar are counted but not blocked by a breach", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitMany(DEFAULT_CEILINGS.callsPerHour, t0);
    // Over the ceiling: the bar call proceeds, and its passage sets the latch.
    expect(() => admitCall(BAR, t0 + 1)).not.toThrow();
    expect(isBudgetTripped()).toBe(true);
    expect(() => admitCall(CHAT, t0 + 2)).not.toThrow();
    expect(budgetStatus(t0 + 3).hour.calls).toBe(402); // counted
    // Background is now refused.
    expect(() => admitCall(BACKGROUND, t0 + 3)).toThrow(BudgetExceededError);
  });

  it("exemption is by trace meta: chat pass, grounded/ callers, bar-* passes", () => {
    expect(isLatchExempt(CHAT)).toBe(true);
    expect(isLatchExempt(BAR)).toBe(true);
    expect(isLatchExempt({ pass: "bar-intent.v1", caller: "grounded/router" })).toBe(true);
    expect(isLatchExempt(BACKGROUND)).toBe(false);
    expect(isLatchExempt({ pass: "media", caller: "media/describe" })).toBe(false);
    expect(isLatchExempt(null)).toBe(false); // no scope = background
  });

  it("the day window trips when the hour would not", () => {
    process.env.SUPERTWIN_BUDGET_CALLS_PER_HOUR = "100000";
    const t0 = Date.parse("2026-09-06T00:00:00Z");
    // 3,000 calls spread over 20 hours: never 400 in one hour.
    for (let i = 0; i < DEFAULT_CEILINGS.callsPerDay; i += 1) {
      admitCall(BACKGROUND, t0 + Math.floor((i * 20 * 3600 * 1000) / DEFAULT_CEILINGS.callsPerDay));
    }
    const t1 = t0 + 21 * 3600 * 1000;
    expect(() => admitCall(BACKGROUND, t1)).toThrow(/calls in the last day/);
  });
});

describe("SPD-02 — latch survives restart", () => {
  it("trip, restart the worker (fresh module state + reopened DB): still tripped; background paused; the bar still answers", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitMany(DEFAULT_CEILINGS.callsPerHour, t0);
    expect(() => admitCall(BACKGROUND, t0 + 1)).toThrow(BudgetExceededError);
    const trippedAt = appStateGet(BUDGET_TRIPPED_KEY);
    expect(trippedAt).not.toBeNull();

    // "Restart": drop every in-memory handle. The DB file is the only carrier.
    closeDb();
    resetBudgetForTests();
    getDb();

    expect(isBudgetTripped()).toBe(true);
    expect(appStateGet(BUDGET_TRIPPED_KEY)).toBe(trippedAt);

    // Background paused — even with the whole hour window aged out.
    const twoHoursLater = t0 + 2 * 3600 * 1000;
    expect(budgetStatus(twoHoursLater).hour.calls).toBe(0);
    expect(() => admitCall(BACKGROUND, twoHoursLater)).toThrow(BudgetExceededError); // wrong: auto-resume
    // The next day, still paused.
    expect(() => admitCall(BACKGROUND, t0 + 26 * 3600 * 1000)).toThrow(BudgetExceededError);

    // The bar still answers.
    expect(() => admitCall(BAR, twoHoursLater)).not.toThrow();
    expect(budgetStatus(twoHoursLater).hour.calls).toBe(1);
  });

  it("only the operator's explicit reset clears it, and the next background call is admitted", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitMany(DEFAULT_CEILINGS.callsPerHour, t0);
    expect(() => admitCall(BACKGROUND, t0 + 1)).toThrow(BudgetExceededError);
    resetBudgetLatch();
    expect(isBudgetTripped()).toBe(false);
    const later = t0 + 2 * 3600 * 1000;
    expect(() => admitCall(BACKGROUND, later)).not.toThrow();
  });

  it("the ledger itself survives a restart: the last hour is not forgotten", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitMany(399, t0);
    recordCallCost(1.25, t0);
    closeDb();
    resetBudgetForTests();
    const s = budgetStatus(t0 + 60_000);
    expect(s.hour.calls).toBe(399);
    expect(s.hour.usd).toBeCloseTo(1.25, 6);
    // One more is the 400th (allowed), the one after is refused.
    expect(() => admitCall(BACKGROUND, t0 + 60_000)).not.toThrow();
    expect(() => admitCall(BACKGROUND, t0 + 60_001)).toThrow(BudgetExceededError);
  });
});

describe("SPD-03 — kill switch", () => {
  it("toggle on: zero new spawns through the real provider, for background AND the bar", async () => {
    const t0 = Date.now();
    setModelActivityPaused(true, t0);
    expect(isModelActivityPaused()).toBe(true);
    // Persisted under the key the plan names, as an ISO time.
    const at = appStateGet(MODEL_ACTIVITY_PAUSED_KEY);
    expect(at).not.toBeNull();
    expect(Number.isNaN(Date.parse(at as string))).toBe(false);

    const { claudeLocalProvider } = await import("./claude-local/index.js");
    for (const meta of [BACKGROUND, BAR, CHAT]) {
      let error: unknown = null;
      try {
        await withTraceContext(meta, () =>
          claudeLocalProvider.send({
            runId: `spd-03-${meta.pass}`,
            message: "hello",
            plainCompletion: true,
            onEvent: () => {},
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ModelActivityPausedError);
      expect((error as ModelActivityPausedError).code).toBe("MODEL_ACTIVITY_PAUSED");
      expect((error as ModelActivityPausedError).message).toContain("No process was spawned");
    }
    expect(existsSync(spawnMarker)).toBe(false);
    // Refused calls are not counted against the ceilings either.
    expect(budgetStatus().hour.calls).toBe(0);
  });

  it("the setting persists across a restart and never self-resumes", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    setModelActivityPaused(true, t0);
    const at = appStateGet(MODEL_ACTIVITY_PAUSED_KEY);

    // "Restart": fresh module state, reopened DB.
    closeDb();
    resetBudgetForTests();
    getDb();
    expect(isModelActivityPaused()).toBe(true);
    expect(appStateGet(MODEL_ACTIVITY_PAUSED_KEY)).toBe(at);
    expect(budgetStatus(t0).modelActivityPausedAt).toBe(at);

    // Wrong: self-resume-after-hour. An hour, a day, a week later: still off.
    for (const later of [t0 + 3600_000 + 1, t0 + 24 * 3600_000, t0 + 7 * 24 * 3600_000]) {
      expect(() => admitCall(BACKGROUND, later)).toThrow(ModelActivityPausedError);
      expect(() => admitCall(BAR, later)).toThrow(ModelActivityPausedError);
    }
  });

  it("only the switch releases it, and it is independent of the budget latch", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitMany(DEFAULT_CEILINGS.callsPerHour, t0);
    expect(() => admitCall(BACKGROUND, t0 + 1)).toThrow(BudgetExceededError);
    expect(isBudgetTripped()).toBe(true);

    setModelActivityPaused(true, t0 + 2);
    // The kill switch wins over the latch's exemptions: the bar is refused too.
    expect(() => admitCall(BAR, t0 + 3)).toThrow(ModelActivityPausedError);

    // Releasing the switch does not clear the latch...
    setModelActivityPaused(false, t0 + 4);
    expect(isModelActivityPaused()).toBe(false);
    expect(isBudgetTripped()).toBe(true);
    expect(() => admitCall(BACKGROUND, t0 + 5)).toThrow(BudgetExceededError);
    expect(() => admitCall(BAR, t0 + 5)).not.toThrow();
    // ...and clearing the latch does not throw the switch.
    setModelActivityPaused(true, t0 + 6);
    resetBudgetLatch();
    expect(isModelActivityPaused()).toBe(true);
    expect(() => admitCall(BACKGROUND, t0 + 7)).toThrow(ModelActivityPausedError);
  });

  it("throwing it twice keeps the first timestamp; releasing an open switch is a no-op", () => {
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    setModelActivityPaused(false, t0);
    expect(appStateGet(MODEL_ACTIVITY_PAUSED_KEY)).toBeNull();
    setModelActivityPaused(true, t0);
    setModelActivityPaused(true, t0 + 60_000);
    expect(appStateGet(MODEL_ACTIVITY_PAUSED_KEY)).toBe(new Date(t0).toISOString());
  });
});

describe("hermeticity", () => {
  it("under vitest with no scratch DB configured the budget never opens the real home", () => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    delete process.env.SUPERTWIN_HOME;
    resetBudgetForTests();
    // Would resolve to ~/SuperTwinV13/supertwinv13.db: the memory store answers.
    const t0 = Date.parse("2026-09-06T10:00:00Z");
    admitCall(BACKGROUND, t0);
    expect(budgetStatus(t0).hour.calls).toBe(1);
    // ...and the temp DB from beforeEach saw nothing.
    process.env.SUPERTWIN_DB_PATH = dbPath;
    resetBudgetForTests();
    expect(budgetStatus(t0).hour.calls).toBe(0);
  });
});
