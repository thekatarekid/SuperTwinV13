// ===========================================================================
// Schedule policy + fire-time math (build P3.1) — deterministic, clock-mocked.
// The auto-vs-confirm decision is a CODE check (SCH-01/02/04/06 shapes) and
// these tests pin every leg of it. No DB, no model.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  AUTO_CONFIDENCE_FLOOR,
  DEFAULT_LATE_WINDOW_MS,
  ON_TIME_GRACE_MS,
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_MIN_MS,
  POLL_MAX_POLLS_CAP,
  classifyFire,
  computeFireTime,
  evaluateSchedulePolicy,
  normalizePolling,
} from "./schedule-policy.js";

const NOW = new Date("2026-08-29T10:00:00Z");

describe("computeFireTime", () => {
  it("parses an offset ISO instant and classifies future vs past against the mocked clock", () => {
    const future = computeFireTime("2026-12-16T07:00+05:30", NOW);
    expect(future.fireAt?.toISOString()).toBe("2026-12-16T01:30:00.000Z");
    expect(future.past).toBe(false);
    expect(future.invalid).toBe(false);

    const past = computeFireTime("2026-06-05T10:00:00Z", NOW);
    expect(past.past).toBe(true);
  });

  it("treats the exact now instant as past (a fire time must be ahead of the clock)", () => {
    expect(computeFireTime(NOW.toISOString(), NOW).past).toBe(true);
  });

  it("flags unparsable garbage as invalid and absence as neither", () => {
    expect(computeFireTime("next tuesday-ish", NOW).invalid).toBe(true);
    expect(computeFireTime(null, NOW)).toEqual({ fireAt: null, invalid: false, past: false });
    expect(computeFireTime("   ", NOW)).toEqual({ fireAt: null, invalid: false, past: false });
  });
});

describe("evaluateSchedulePolicy — the code-side auto/confirm gate", () => {
  const base = {
    requestedMode: "auto" as const,
    riskClass: "auto",
    confidence: 0.9,
    fireAt: "2026-12-16T07:00+05:30",
    recurrence: null,
    now: NOW,
  };

  it("SCH-01: auto-class + high confidence + time-bound → auto, with the fire instant", () => {
    const v = evaluateSchedulePolicy(base);
    expect(v.decision).toBe("auto");
    expect(v.fireAt?.toISOString()).toBe("2026-12-16T01:30:00.000Z");
  });

  it("downgrades to confirm when the task is not auto-class — even though the model asked auto", () => {
    const v = evaluateSchedulePolicy({ ...base, riskClass: "approve-final" });
    expect(v.decision).toBe("confirm");
    expect(v.reasons.join(" ")).toContain("approve-final");
  });

  it("downgrades to confirm below the confidence floor", () => {
    const v = evaluateSchedulePolicy({ ...base, confidence: AUTO_CONFIDENCE_FLOOR - 0.01 });
    expect(v.decision).toBe("confirm");
  });

  it("treats an unmatchable task (risk unknown) as confirm, never auto", () => {
    const v = evaluateSchedulePolicy({ ...base, riskClass: null });
    expect(v.decision).toBe("confirm");
  });

  it("never upgrades: a model-requested confirm stays confirm even when all auto legs hold", () => {
    const v = evaluateSchedulePolicy({ ...base, requestedMode: "confirm" });
    expect(v.decision).toBe("confirm");
  });

  it("SCH-04/FUP-04: ANY recurrence is confirm — subscription-creep is impossible by construction", () => {
    const v = evaluateSchedulePolicy({ ...base, recurrence: "monthly, anchor the 1st" });
    expect(v.decision).toBe("confirm");
    expect(v.reasons.join(" ")).toContain("recurring");
  });

  it("SCH-06: a past fire time with no recurrence REJECTS — the time-traveler never schedules", () => {
    const v = evaluateSchedulePolicy({ ...base, fireAt: "2026-06-05T10:00:00Z" });
    expect(v.decision).toBe("reject");
    expect(v.reasons.join(" ")).toContain("past");
  });

  it("rejects an unparsable fire time and a candidate with no computable time at all", () => {
    expect(evaluateSchedulePolicy({ ...base, fireAt: "whenever" }).decision).toBe("reject");
    expect(evaluateSchedulePolicy({ ...base, fireAt: null }).decision).toBe("reject");
  });

  it("keeps a recurring template with a past next-instance as a confirm with no fire instant", () => {
    const v = evaluateSchedulePolicy({
      ...base,
      fireAt: "2026-06-01T09:00:00Z",
      recurrence: "monthly",
    });
    expect(v.decision).toBe("confirm");
    expect(v.fireAt).toBeNull();
  });
});

describe("normalizePolling — capped patterns (SCH-02)", () => {
  it("accepts interval_min + until + max and converts to ms", () => {
    const p = normalizePolling({ interval_min: 2, until: "2026-12-16T11:00+05:30", max: 20 });
    expect(p).toEqual({ intervalMs: 120_000, until: "2026-12-16T11:00+05:30", maxPolls: 20 });
  });

  it("clamps a runaway pattern to the caps", () => {
    const p = normalizePolling({ interval_ms: 5, max: 100_000 });
    expect(p?.intervalMs).toBe(POLL_INTERVAL_MIN_MS);
    expect(p?.maxPolls).toBe(POLL_MAX_POLLS_CAP);
    const slow = normalizePolling({ interval_min: 600 });
    expect(slow?.intervalMs).toBe(POLL_INTERVAL_MAX_MS);
  });

  it("drops an unparsable until and returns null for a non-object", () => {
    expect(normalizePolling({ until: "soon" })?.until).toBeNull();
    expect(normalizePolling(null)).toBeNull();
    expect(normalizePolling("every 2 min")).toBeNull();
  });
});

describe("classifyFire — the timer's late/skip rule (SCH-08)", () => {
  const fireAt = new Date("2026-08-29T07:00:00Z");

  it("is on_time within the grace, late after it, expired past the window", () => {
    expect(classifyFire(fireAt, new Date(fireAt.getTime() + ON_TIME_GRACE_MS), null)).toBe("on_time");
    expect(classifyFire(fireAt, new Date(fireAt.getTime() + ON_TIME_GRACE_MS + 1), null)).toBe("late");
    expect(classifyFire(fireAt, new Date(fireAt.getTime() + DEFAULT_LATE_WINDOW_MS + 1), null)).toBe(
      "expired",
    );
  });

  it("honors an explicit validity deadline over the default window", () => {
    const until = new Date("2026-08-29T08:00:00Z");
    expect(classifyFire(fireAt, new Date("2026-08-29T07:59:00Z"), until)).toBe("late");
    expect(classifyFire(fireAt, new Date("2026-08-29T08:00:01Z"), until)).toBe("expired");
  });
});
