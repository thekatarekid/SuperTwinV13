// ===========================================================================
// FIX-C1 — a HARD stop must not feed the S0.7 breaker.
//
// The user's 13.11.5 install latched the $3/hour ceiling and then refused
// every background call before spawn. Those refusals reached the pool as
// ordinary failures, so ten in a row tripped the `llm:understanding` breaker
// (worker.log:4405), which pauses the lane 30 minutes and then RE-ARMS. Half
// an hour later the lane resumed, was refused ten more times, and tripped
// again — llm:live did the same at 15:32:22Z. A circuit breaker exists to stop
// a lane hammering a broken dependency; pointed at a latch only a human clears
// it becomes a metronome, and every tick of it costs a `runs` row.
//
// So: BUDGET_EXCEEDED and MODEL_ACTIVITY_PAUSED are their own decision —
// `action: "hold"`, `hardStop: true` — they move NEITHER streak, pause
// nothing, and spend none of the unit's retry budget. SPD-07's own shape (ten
// consecutive CLI_ERRORs DO trip) is asserted here too, because the whole
// point is that the breaker still works for the thing it is for.
//
// Pure decision logic. ZERO model calls, no database.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { BREAKER_FAILURES, ResourcePool, classifyFailure, isHardStop, isRefusal } from "./pool.js";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

/** The failure the gate actually produced on the user's machine, verbatim. */
const BUDGET = {
  code: "BUDGET_EXCEEDED",
  message:
    "BUDGET_EXCEEDED: $3.11 spent in the last hour (ceiling $3). hour=144 calls/$3.11 " +
    "day=144 calls/$3.11; tripped_at=2026-09-06T15:12:59.534Z. No process was spawned.",
} as const;

const KILLED = {
  code: "MODEL_ACTIVITY_PAUSED",
  message: 'MODEL_ACTIVITY_PAUSED: "Stop all model activity" has been on since 2026-09-06T15:12:59.534Z.',
} as const;

describe("FIX-C1 — hard stops are classified as holds", () => {
  it("the pre-spawn refusals are hard stops, and nothing else is", () => {
    expect(isHardStop(BUDGET)).toBe(true);
    expect(isHardStop(KILLED)).toBe(true);
    expect(isHardStop({ code: "CLI_ERROR", message: "exit 1" })).toBe(false);
    expect(isHardStop({ code: "QUOTA_EXCEEDED", message: "usage limit" })).toBe(false);
    expect(isHardStop({ code: "TIMEOUT" })).toBe(false);
  });

  it("a hard stop is not a refusal — it is its own decision", () => {
    // It must not be read as an outage: an outage backs off and passes, and no
    // amount of backoff clears a latch. (The message carries "$3" and "hour",
    // neither of which REFUSAL_RE matches — asserted so a future ceiling
    // wording cannot silently reclassify the latch as a rate limit.)
    expect(isRefusal(BUDGET)).toBe(false);
    expect(isRefusal(KILLED)).toBe(false);

    const d = classifyFailure(BUDGET, 0);
    expect(d.action).toBe("hold");
    expect(d.reason).toBe("hard-stop");
    expect(d.hardStop).toBe(true);
    expect(d.spendsRetryBudget).toBe(false); // the unit did nothing wrong
    expect(d.waitMs).toBe(0); // there is no wait that helps
    expect(d.breakerTripped).toBeUndefined();
  });

  it("the retry budget is irrelevant: a hard stop holds however many retries were spent", () => {
    for (const spent of [0, 1, 2, 3, 9]) {
      expect(classifyFailure(BUDGET, spent).action).toBe("hold");
      expect(classifyFailure(KILLED, spent).action).toBe("hold");
    }
  });
});

describe("FIX-C1 — the breaker does not spin against a permanent condition", () => {
  it("a hundred consecutive budget refusals: no trip, no pause, no banner, no streak", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });

    for (let i = 0; i < BREAKER_FAILURES * 10; i++) {
      const d = pool.noteFailure("llm:understanding", BUDGET, 0);
      expect(d.action).toBe("hold");
      expect(d.breakerTripped).toBeUndefined();
    }

    expect(pool.consecutiveFailures("llm:understanding")).toBe(0);
    expect(pool.isPaused("llm:understanding")).toBe(false);
    expect(pool.breakers()).toEqual([]);
    expect(pool.breakerFor("llm:understanding")).toBeNull();
  });

  it("the kill switch behaves identically on the live lane", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < BREAKER_FAILURES + 5; i++) pool.noteFailure("llm:live", KILLED, 0);
    expect(pool.consecutiveFailures("llm:live")).toBe(0);
    expect(pool.isPaused("llm:live")).toBe(false);
    expect(pool.breakers()).toEqual([]);
  });

  it("a hard stop does not blank a real failure streak that was already building", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    const boom = { code: "CLI_ERROR", message: "exit 1" } as const;

    for (let i = 0; i < BREAKER_FAILURES - 1; i++) pool.noteFailure("llm:understanding", boom, 0);
    expect(pool.consecutiveFailures("llm:understanding")).toBe(BREAKER_FAILURES - 1);
    // A latch in the middle is not a success and not a failure: it says nothing
    // about whether the lane works, so it must leave the count exactly as it is.
    pool.noteFailure("llm:understanding", BUDGET, 0);
    expect(pool.consecutiveFailures("llm:understanding")).toBe(BREAKER_FAILURES - 1);
    expect(pool.isPaused("llm:understanding")).toBe(false);
  });

  it("SPD-07 still holds: ten consecutive real errors DO trip the lane", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    const boom = { code: "CLI_ERROR", message: "exit 1" } as const;
    let tripped = false;
    for (let i = 0; i < BREAKER_FAILURES; i++) {
      tripped = pool.noteFailure("llm:understanding", boom, 0).breakerTripped === true;
    }
    expect(tripped).toBe(true);
    expect(pool.isPaused("llm:understanding")).toBe(true);
    expect(pool.breakers()).toHaveLength(1);
  });
});
