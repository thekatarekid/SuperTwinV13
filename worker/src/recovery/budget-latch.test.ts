// ===========================================================================
// [TEST] The budget latch on an EXISTING home (V6 P1 S6e · E2, second half).
//
// Two questions, both asked of a home that is already damaged:
//
//   1. Is the halt VISIBLE and CLEARABLE? The latch never clears on its own
//      (SPD-02), so a latched home relaunches latched. `HaltBanner` covers the
//      in-app half on every tab (FIX-C3); this file covers the worker half —
//      one boot line before anything can ask to spend — and the clearing path
//      end to end, including the trap the user actually fell into: they reset
//      at 16:53 and the pipeline re-latched at 17:38.
//
//   2. Do the CEILINGS fit a real first import? The last two cases replay the
//      user's own ledger — 302 admitted calls and $6.20 across four hours,
//      read off `app_state.budget.ledger` on their install — through the real
//      `admitCall` gate. Raw, it trips: that is the fact on disk. De-inflated
//      by the retry storm that caused it (and has since been fixed), the same
//      import fits, and the case pins the margin so a future change that
//      pushes a first import back over the wall fails here instead of on
//      someone's install.
//
// Zero model calls: nothing in this file spawns anything.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { appStateGet } from "../db/ingest.js";
import {
  admitCall,
  backgroundModelHold,
  budgetCeilings,
  BudgetExceededError,
  budgetStatus,
  BUDGET_RESUMED_KEY,
  BUDGET_TRIPPED_KEY,
  BUDGET_TRIPPED_REASON_KEY,
  isBudgetTripped,
  recordCallCost,
  reportBackgroundHold,
  resetBudgetForTests,
  resetBudgetLatch,
  setBudgetStore,
  setModelActivityPaused,
  tripBudget,
  type BudgetStore,
} from "../providers/budget.js";
import { haltReport, reportHaltOnBoot } from "./halt-report.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-latch-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetBudgetForTests();
});

afterEach(() => {
  resetBudgetForTests();
  setBudgetStore(null);
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A background caller — never exempt from the latch. */
const BACKGROUND = { pass: "orient", caller: "brain/orient" };

function memoryStore(): BudgetStore {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    delete: (k) => void m.delete(k),
  };
}

// ---------------------------------------------------------------------------
// Visible on launch
// ---------------------------------------------------------------------------

describe("a latched home says so at boot", () => {
  it("names the ceiling, the time and the way out — before anything can spend", () => {
    tripBudget("$3.07 spent in the last hour (ceiling $3)", Date.parse("2026-09-06T17:38:06.843Z"));
    const lines: string[] = [];
    const report = reportHaltOnBoot((l) => lines.push(l));

    expect(report.held).toBe(true);
    expect(report.kind).toBe("budget");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[budget\] HALTED AT BOOT/);
    expect(lines[0]).toContain("$3.07 spent in the last hour (ceiling $3)");
    expect(lines[0]).toContain("2026-09-06T17:38:06.843Z");
    // The way out, named in the same breath as the problem.
    expect(lines[0]).toContain("POST /api/ops/budget/reset");
    expect(lines[0]).toContain("banner");
    // And the windows, so the operator can see whether a resume will stick.
    expect(lines[0]).toMatch(/hour \d+\/400 calls/);
    expect(lines[0]).toMatch(/day .*\/\$15\.00/);
  });

  it("the latch is read from app_state, which is what survives the restart", () => {
    // Exactly the two rows the user's install still carries.
    tripBudget("$3.07 spent in the last hour (ceiling $3)", Date.parse("2026-09-06T17:38:06.843Z"));
    expect(appStateGet(BUDGET_TRIPPED_KEY)).toBe("2026-09-06T17:38:06.843Z");
    expect(appStateGet(BUDGET_TRIPPED_REASON_KEY)).toBe("$3.07 spent in the last hour (ceiling $3)");
    // A "restart": the module keeps nothing in memory that the row does not say.
    resetBudgetForTests();
    expect(isBudgetTripped()).toBe(true);
    expect(haltReport().held).toBe(true);
  });

  it("the kill switch outranks the latch in the boot line too", () => {
    tripBudget("ceiling", Date.parse("2026-09-06T17:38:06.843Z"));
    setModelActivityPaused(true, Date.parse("2026-09-06T18:00:00.000Z"));
    const report = haltReport();
    expect(report.kind).toBe("kill-switch");
    expect(report.line).toContain("Stop all model activity");
    expect(report.line).toContain("/api/ops/model-activity");
  });

  it("a healthy home still gets a line — silence is not evidence of health", () => {
    const lines: string[] = [];
    const report = reportHaltOnBoot((l) => lines.push(l));
    expect(report.held).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[budget\] running — hour 0\/400 calls · \$0\.00\/\$3\.00/);
  });
});

// ---------------------------------------------------------------------------
// Clearable in one action
// ---------------------------------------------------------------------------

describe("clearing the latch", () => {
  it("one action clears it and every background lane is released", () => {
    tripBudget("$3.07 spent in the last hour (ceiling $3)");
    expect(backgroundModelHold().held).toBe(true);
    const held: string[] = [];
    expect(reportBackgroundHold("consolidation", Date.now(), (l) => held.push(l)).held).toBe(true);
    expect(held[0]).toMatch(/\[budget\] HELD — consolidation is standing down/);

    resetBudgetLatch();

    expect(isBudgetTripped()).toBe(false);
    expect(backgroundModelHold().held).toBe(false);
    expect(haltReport().held).toBe(false);
    const after: string[] = [];
    expect(reportBackgroundHold("consolidation", Date.now(), (l) => after.push(l)).held).toBe(false);
    expect(after).toEqual([]);
  });

  it("the hour that caused the trip is forgiven, so the resume actually resumes", () => {
    // The user's own sequence: a full hour of spend, a trip, a reset — and,
    // before FIX-C1, an instant re-latch on the very next call.
    setBudgetStore(memoryStore());
    const t0 = Date.parse("2026-09-06T17:00:00.000Z");
    // 38 minutes at $0.08 leaves the trailing hour at $3.04 — over the ceiling,
    // but only checked when the NEXT call asks.
    for (let m = 0; m < 38; m++) {
      admitCall(BACKGROUND, t0 + m * 60_000);
      recordCallCost(0.08, t0 + m * 60_000);
    }
    const trip = t0 + 38 * 60_000;
    expect(() => admitCall(BACKGROUND, trip)).toThrow(BudgetExceededError);
    expect(isBudgetTripped()).toBe(true);

    const resumeAt = trip + 60_000;
    resetBudgetLatch(resumeAt);
    expect(appStateGet(BUDGET_RESUMED_KEY) ?? budgetStatus(resumeAt).resumedAt).toBe(
      new Date(resumeAt).toISOString(),
    );

    // Seconds later, with $3.20 still inside the trailing hour: admitted.
    expect(() => admitCall(BACKGROUND, resumeAt + 5_000)).not.toThrow();
    expect(isBudgetTripped()).toBe(false);
    expect(budgetStatus(resumeAt + 5_000).hour.usd).toBe(0);
  });

  it("the DAY is not forgiven — a resume buys the rest of the day, not a clean slate", () => {
    setBudgetStore(memoryStore());
    const t0 = Date.parse("2026-09-06T09:00:00.000Z");
    // $15.20 spread thin enough that no single hour ever breaches.
    for (let m = 0; m < 400; m++) {
      const at = t0 + m * 60_000;
      try {
        admitCall(BACKGROUND, at);
      } catch {
        break;
      }
      recordCallCost(0.038, at);
    }
    const end = t0 + 400 * 60_000;
    expect(budgetStatus(end).day.usd).toBeGreaterThanOrEqual(budgetCeilings().usdPerDay);
    expect(isBudgetTripped()).toBe(true);

    resetBudgetLatch(end);
    // The hour is clean, so the next call is admitted — and re-trips on the
    // DAY, which is the ceiling that is actually still breached.
    expect(() => admitCall(BACKGROUND, end + 1_000)).toThrow(/spent in the last day/);
    expect(isBudgetTripped()).toBe(true);
  });

  it("clearing the latch never releases the kill switch — two different facts", () => {
    tripBudget("ceiling");
    setModelActivityPaused(true);
    resetBudgetLatch();
    expect(isBudgetTripped()).toBe(false);
    expect(backgroundModelHold().kind).toBe("kill-switch");
    setModelActivityPaused(false);
    expect(backgroundModelHold().held).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Do the ceilings fit a real first import?
// ---------------------------------------------------------------------------

/**
 * The user's OWN first import, read off `app_state.budget.ledger` on their
 * install: one entry per minute that spent anything, `[minutes since the first
 * bucket, calls admitted, dollars]`. 302 calls, $6.20, four hours, one trip.
 */
const MEASURED_FIRST_IMPORT: readonly (readonly [number, number, number])[] = [
  [0, 4, 0], [1, 10, 0.2231], [2, 10, 0.1572], [3, 10, 0.1522], [4, 5, 0.0475],
  [5, 4, 0.0703], [6, 4, 0.1045], [7, 11, 0.0925], [8, 0, 0.0256], [9, 5, 0.0821],
  [10, 9, 0.0707], [11, 4, 0.2626], [12, 4, 0.0425], [13, 0, 0.032], [14, 1, 0],
  [16, 3, 0.1615], [17, 4, 0.1939], [18, 9, 0.0636], [19, 2, 0.0438], [20, 11, 0.2643],
  [21, 2, 0.0542], [22, 5, 0.1554], [23, 9, 0.1839], [24, 9, 0.1941], [25, 9, 0.3711],
  [26, 0, 0.0585], [127, 1, 0], [128, 5, 0.1043], [129, 3, 0.048], [130, 2, 0.0296],
  [132, 3, 0.0693], [133, 2, 0.0648], [134, 4, 0.0554], [135, 3, 0.0332], [136, 7, 0.1638],
  [137, 4, 0], [138, 0, 0.125], [139, 9, 0.1542], [140, 4, 0.0829], [142, 0, 0.0672],
  [144, 4, 0], [145, 1, 0.0332], [146, 4, 0.032], [147, 3, 0.1289], [148, 4, 0.0127],
  [150, 5, 0.0331], [152, 6, 0.0442], [153, 11, 0.2454], [154, 14, 0.3675], [155, 11, 0.3743],
  [156, 20, 0.2891], [157, 8, 0.0503], [169, 1, 0], [170, 19, 0.3912], [171, 0, 0.0912],
];

/**
 * The retry storm's inflation factor. Before FIX-C2's per-entry evidence drop,
 * ONE bad evidence span sank the whole item, which held the item's events,
 * which failed the bundle, which was re-attempted twice more at full context —
 * so a large share of the calls above are the same work paid for repeatedly.
 * The factor is the workflow's measured estimate, not a law; the two cases
 * below bracket the answer either side of it.
 */
const RETRY_STORM_FACTOR = 1.5;

interface Replay {
  admitted: number;
  usd: number;
  tripped: boolean;
  trippedReason: string | null;
  peakHourUsd: number;
  peakHourCalls: number;
}

/**
 * Replay a minute profile through the REAL gate — never a re-implementation of
 * it. The ledger only records calls that were ADMITTED, so a profile read off
 * a real install stops dead at the trip; the replay therefore asks for one
 * more call a minute after the last bucket, which is the call the pipeline
 * actually made next and had refused.
 */
function replay(profile: readonly (readonly [number, number, number])[], divisor: number): Replay {
  setBudgetStore(memoryStore());
  const t0 = Date.parse("2026-09-06T14:48:00.000Z");
  const out: Replay = { admitted: 0, usd: 0, tripped: false, trippedReason: null, peakHourUsd: 0, peakHourCalls: 0 };
  const ask = (at: number): void => {
    try {
      admitCall(BACKGROUND, at);
      out.admitted += 1;
    } catch (err) {
      if (!out.tripped) {
        out.tripped = true;
        out.trippedReason = err instanceof BudgetExceededError ? err.reason : String(err);
      }
    }
  };
  for (const [minute, calls, usd] of profile) {
    const at = t0 + minute * 60_000;
    const want = Math.round(calls / divisor);
    for (let i = 0; i < want; i++) ask(at);
    if (usd > 0) {
      recordCallCost(usd / divisor, at);
      out.usd += usd / divisor;
    }
    const w = budgetStatus(at);
    out.peakHourUsd = Math.max(out.peakHourUsd, w.hour.usd);
    out.peakHourCalls = Math.max(out.peakHourCalls, w.hour.calls);
  }
  ask(t0 + (profile[profile.length - 1]![0] + 1) * 60_000);
  return out;
}

describe("the ceilings against a real first import", () => {
  it("the import AS MEASURED goes over the hour ceiling — this is what happened", () => {
    const r = replay(MEASURED_FIRST_IMPORT, 1);
    expect(r.admitted).toBe(302);
    expect(r.usd).toBeCloseTo(6.2, 1);
    // The peak trailing hour, to the cent the user's own
    // `budget_tripped_reason` row records: "$3.07 spent in the last hour".
    expect(r.peakHourUsd).toBeGreaterThanOrEqual(budgetCeilings().usdPerHour);
    expect(r.peakHourUsd).toBeLessThan(3.2);
    expect(r.tripped).toBe(true);
    expect(r.trippedReason).toMatch(/spent in the last hour \(ceiling \$3\)/);
  });

  it("the same import without the retry storm fits inside them", () => {
    const r = replay(MEASURED_FIRST_IMPORT, RETRY_STORM_FACTOR);
    const c = budgetCeilings();
    expect(r.tripped).toBe(false);
    // The binding ceiling is dollars per hour, and the margin is real but not
    // generous — the peak hour lands around 69% of it.
    expect(r.peakHourUsd).toBeLessThan(c.usdPerHour);
    expect(r.peakHourUsd / c.usdPerHour).toBeLessThan(0.75);
    // Calls per hour is nowhere near binding: about a quarter of 400.
    expect(r.peakHourCalls / c.callsPerHour).toBeLessThan(0.35);
    expect(r.usd).toBeLessThan(c.usdPerDay);
  });

  it("the margin is stated, not assumed: +40% still fits, +50% does not", () => {
    // Spend scales with load, so the headroom is arithmetic on the measured
    // peak rather than a guess. Pinning it here means a future change that
    // makes a first import 50% heavier — a new pass, a bigger pack, a lane
    // without a cache — fails in this file instead of on someone's install.
    const peak = replay(MEASURED_FIRST_IMPORT, RETRY_STORM_FACTOR).peakHourUsd;
    const ceiling = budgetCeilings().usdPerHour;
    expect(peak * 1.4).toBeLessThan(ceiling);
    expect(peak * 1.5).toBeGreaterThanOrEqual(ceiling);
  });
});
