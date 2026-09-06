// ===========================================================================
// FIX-C1 — `backgroundModelHold()`: the question a lane asks BEFORE it works.
//
// The latch itself is right and stays exactly as SPD-01/SPD-02 specify: it
// throws before spawn and it never clears on its own. What was missing is the
// other half — a way for a lane to KNOW, cheaply, that spending is stopped, so
// it can stand down with its work intact instead of discovering it one refused
// call at a time. Discovering it that way cost the user's install three hours
// of `runs` rows, two breaker trips and a dead-lettered bundle.
//
// The other half of the contract is that standing down is LOUD. A lane that
// holds silently reproduces the original defect in a new place: the C3
// heartbeat counts refusals, and a lane that never asks is refused zero times,
// so worker.log would go back to reading like an idle machine.
//
// ZERO model calls: this file never touches a provider.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CEILINGS,
  HOLD_LOG_INTERVAL_MS,
  admitCall,
  backgroundModelHold,
  budgetStatus,
  isBackgroundModelHeld,
  isBudgetTripped,
  isLatchExempt,
  recordCallCost,
  reportBackgroundHold,
  resetBudgetForTests,
  resetBudgetLatch,
  setBudgetStore,
  setModelActivityPaused,
  tripBudget,
  type BudgetStore,
} from "./budget.js";

/** An in-memory app_state. Nothing here opens a database. */
function memStore(): BudgetStore {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    delete: (k) => void m.delete(k),
  };
}

const T0 = Date.parse("2026-09-06T15:12:59.534Z");
const REASON = "$3.05 spent in the last hour (ceiling $3)";

beforeEach(() => {
  resetBudgetForTests();
  setBudgetStore(memStore());
});

afterEach(() => resetBudgetForTests());

describe("FIX-C1 — backgroundModelHold", () => {
  it("running: nothing held", () => {
    expect(backgroundModelHold()).toEqual({
      held: false,
      kind: null,
      since: null,
      reason: null,
      label: null,
    });
    expect(isBackgroundModelHeld()).toBe(false);
  });

  it("the ceiling latch holds, and names the ceiling and the time", () => {
    tripBudget(REASON, T0);
    const hold = backgroundModelHold();
    expect(hold.held).toBe(true);
    expect(hold.kind).toBe("budget");
    expect(hold.since).toBe(new Date(T0).toISOString());
    expect(hold.reason).toBe(REASON);
    expect(hold.label).toContain(REASON);
  });

  it("the kill switch outranks the latch: it stops strictly more", () => {
    tripBudget(REASON, T0);
    setModelActivityPaused(true, T0 + 1000);
    const hold = backgroundModelHold();
    expect(hold.kind).toBe("kill-switch");
    expect(hold.since).toBe(new Date(T0 + 1000).toISOString());
  });

  it("only the operator's reset releases the latch — not the hour, not the day", () => {
    tripBudget(REASON, T0);
    expect(isBackgroundModelHeld()).toBe(true);
    // SPD-02: the window draining does not clear it. The hold is a lookup of
    // the latch, so this is the same fact read from the other side.
    expect(backgroundModelHold().held).toBe(true);
    resetBudgetLatch();
    expect(isBackgroundModelHeld()).toBe(false);
  });

  it("releasing the kill switch does not release a latch set underneath it", () => {
    tripBudget(REASON, T0);
    setModelActivityPaused(true, T0);
    setModelActivityPaused(false, T0 + 60_000);
    expect(backgroundModelHold().kind).toBe("budget");
  });

  it("the hold is a BACKGROUND question — the bar and chat are exempt by design", () => {
    tripBudget(REASON, T0);
    // The hold never speaks for the interactive surfaces: the latch exemption
    // does (SPD-02, "the bar still answers"). Asserted here so nobody wires
    // backgroundModelHold() into the bar and bricks the diagnostic surface.
    expect(isLatchExempt({ pass: "chat", caller: "server/chat" })).toBe(true);
    expect(isLatchExempt({ pass: "bar-answer.v1", caller: "grounded/handlers" })).toBe(true);
    expect(isLatchExempt({ pass: "orient", caller: "brain/llm" })).toBe(false);
  });
});

describe("FIX-C1 — a held lane is loud", () => {
  it("one line per lane per minute, naming the lane, the switch and the way out", () => {
    const lines: string[] = [];
    const log = (l: string): void => void lines.push(l);
    tripBudget(REASON, T0);

    expect(reportBackgroundHold("the history lane", T0, log).held).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[budget] HELD");
    expect(lines[0]).toContain("the history lane");
    expect(lines[0]).toContain(REASON);
    expect(lines[0]).toContain("/api/ops/budget/reset");

    // A tick every five seconds must not write twelve lines a minute.
    for (let ms = 5_000; ms < HOLD_LOG_INTERVAL_MS; ms += 5_000) {
      reportBackgroundHold("the history lane", T0 + ms, log);
    }
    expect(lines).toHaveLength(1);

    // A minute on, it says so again: a hold that stops being mentioned is a
    // hold nobody tailing the log can tell from an idle machine.
    reportBackgroundHold("the history lane", T0 + HOLD_LOG_INTERVAL_MS, log);
    expect(lines).toHaveLength(2);
  });

  it("each lane speaks for itself", () => {
    const lines: string[] = [];
    const log = (l: string): void => void lines.push(l);
    tripBudget(REASON, T0);
    reportBackgroundHold("the live lane", T0, log);
    reportBackgroundHold("the history lane", T0, log);
    reportBackgroundHold("media descriptions", T0, log);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes("media descriptions"))).toBe(true);
  });

  it("nothing is logged while nothing is held, and the reset re-arms the notice", () => {
    const lines: string[] = [];
    const log = (l: string): void => void lines.push(l);

    expect(reportBackgroundHold("the live lane", T0, log).held).toBe(false);
    expect(lines).toHaveLength(0);

    tripBudget(REASON, T0);
    reportBackgroundHold("the live lane", T0, log);
    expect(lines).toHaveLength(1);

    // Resumed and re-tripped inside the same minute: the second trip is news.
    resetBudgetLatch();
    expect(reportBackgroundHold("the live lane", T0 + 1_000, log).held).toBe(false);
    tripBudget("400 calls in the last hour (ceiling 400)", T0 + 2_000);
    reportBackgroundHold("the live lane", T0 + 3_000, log);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("ceiling 400");
  });
});

describe("FIX-C1 — pressing resume actually resumes", () => {
  const BG = { pass: "orient", caller: "brain/llm" };
  const BAR = { pass: "bar-answer.v1", caller: "grounded/handlers" };

  /** Burn the hourly SPEND ceiling the way the user's install did. */
  function burnTheHour(at: number): void {
    admitCall(BG, at);
    recordCallCost(DEFAULT_CEILINGS.usdPerHour + 0.11, at);
    expect(() => admitCall(BG, at + 1)).toThrow();
    expect(isBudgetTripped()).toBe(true);
  }

  it("the hour that caused the trip is forgiven, so the next call is not refused on the spot", () => {
    burnTheHour(T0);

    // The trap C3's banner had to warn about: the latch clears, the ledger
    // still holds $3.11 of the $3 hour, and the very next call re-latches.
    resetBudgetLatch(T0 + 2_000);
    expect(() => admitCall(BG, T0 + 3_000)).not.toThrow();
    expect(isBudgetTripped()).toBe(false);
    // ...and it keeps working through the rest of that same hour.
    for (let i = 0; i < 20; i++) admitCall(BG, T0 + 4_000 + i);
    expect(isBudgetTripped()).toBe(false);
  });

  it("the surface sees the same hour the gate does — no forgiven spend shown as charged", () => {
    burnTheHour(T0);
    expect(budgetStatus(T0 + 1_000).hour.usd).toBeCloseTo(3.11, 6);

    resetBudgetLatch(T0 + 2_000);
    const after = budgetStatus(T0 + 3_000);
    expect(after.resumedAt).toBe(new Date(T0 + 2_000).toISOString());
    expect(after.hour.usd).toBe(0); // forgiven, and the gate agrees
    // The DAY is untouched: what was spent today was still spent today.
    expect(after.day.usd).toBeCloseTo(3.11, 6);
  });

  it("the day ceiling is NOT forgiven — a resume buys the rest of the day, never more", () => {
    // Five hours of the hourly ceiling: $15.55 today, under the 400/hour
    // call ceiling the whole way.
    let t = T0;
    for (let h = 0; h < 5; h++) {
      admitCall(BG, t);
      recordCallCost(3.11, t);
      resetBudgetLatch(t + 1_000); // the operator keeps pressing resume
      t += 60 * 60_000;
    }
    // The hour is clean; the day is over its ceiling, and that is what stops it.
    expect(budgetStatus(t).hour.usd).toBe(0);
    expect(budgetStatus(t).day.usd).toBeGreaterThan(DEFAULT_CEILINGS.usdPerDay);
    expect(() => admitCall(BG, t)).toThrow(/spent in the last day/);
    // Resuming again does not wish the day away.
    resetBudgetLatch(t + 1_000);
    expect(() => admitCall(BG, t + 2_000)).toThrow(/spent in the last day/);
    // The bar still answers throughout (SPD-02).
    expect(() => admitCall(BAR, t + 3_000)).not.toThrow();
  });

  it("the hourly CALL ceiling is forgiven the same way", () => {
    for (let i = 0; i < DEFAULT_CEILINGS.callsPerHour; i++) admitCall(BG, T0 + i);
    expect(() => admitCall(BG, T0 + 1_000)).toThrow(/calls in the last hour/);
    resetBudgetLatch(T0 + 2_000);
    expect(() => admitCall(BG, T0 + 3_000)).not.toThrow();
  });

  it("a resume is not an auto-resume: without one, the hour draining changes nothing (SPD-02)", () => {
    burnTheHour(T0);
    // Two hours on, the window has rolled off entirely and the latch stands.
    expect(budgetStatus(T0 + 2 * 60 * 60_000).hour.usd).toBe(0);
    expect(() => admitCall(BG, T0 + 2 * 60 * 60_000)).toThrow();
    expect(isBackgroundModelHeld()).toBe(true);
  });
});
