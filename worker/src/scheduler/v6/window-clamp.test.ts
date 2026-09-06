// ===========================================================================
// TIM-04 in code (V6 P1 S3.7): a schedule never fires before the instant the
// evidence says the window opens. No poll plan → exactly the window; a poll
// plan → at most POLL_LEAD_MAX_MS ahead. The clamp only ever delays, and the
// clamped instant is what the policy classifies (past/future) and returns.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { POLL_LEAD_MAX_MS, clampToWindow, evaluateSchedulePolicy } from "./schedule-policy.js";

const NOW = new Date("2026-08-29T03:30:00Z");
// UA-847 departs SFO 2026-12-02 11:30 PDT (18:30Z). Check-in opens T-48h in PDT: 2026-11-30 11:30 PDT = 18:30Z.
const WINDOW = "2026-11-30T18:30:00Z";

describe("clampToWindow", () => {
  it("leaves a fire at or after the window alone", () => {
    expect(clampToWindow(WINDOW, WINDOW, false)).toEqual({ fireAt: WINDOW, moved: null });
    expect(clampToWindow("2026-11-30T19:00:00Z", WINDOW, false).moved).toBeNull();
  });

  it("moves an early fire to the window when there is no poll plan (the tz-blind IST fire)", () => {
    // 11:30 IST T-48h — the TIM-04 failure mode — is 12.5 h early.
    const r = clampToWindow("2026-11-30T06:00:00Z", WINDOW, false);
    expect(r.fireAt).toBe("2026-11-30T18:30:00.000Z");
    expect(r.moved).toMatch(/TIM-04: never fire early/);
  });

  it("lets a poll plan lead the window by at most POLL_LEAD_MAX_MS (SCH-01's 09:55 for 10:00)", () => {
    const open = "2026-08-30T04:30:00Z"; // 10:00 IST
    const fiveBefore = "2026-08-30T04:25:00Z";
    expect(clampToWindow(fiveBefore, open, true)).toEqual({ fireAt: fiveBefore, moved: null });
    const wayBefore = clampToWindow("2026-08-30T02:00:00Z", open, true);
    expect(wayBefore.fireAt).toBe(new Date(Date.parse(open) - POLL_LEAD_MAX_MS).toISOString());
    expect(wayBefore.moved).toMatch(/poll lead/);
    // without a poll plan the same 09:55 fire moves to 10:00
    expect(clampToWindow(fiveBefore, open, false).fireAt).toBe("2026-08-30T04:30:00.000Z");
  });

  it("ignores an absent or unparsable window", () => {
    expect(clampToWindow("2026-08-30T04:25:00Z", null, false).moved).toBeNull();
    expect(clampToWindow("2026-08-30T04:25:00Z", "next tuesday", false).moved).toBeNull();
    expect(clampToWindow(null, WINDOW, false)).toEqual({ fireAt: null, moved: null });
  });
});

describe("evaluateSchedulePolicy with a window", () => {
  it("auto fires at the window, not at the model's early instant, and says why", () => {
    const v = evaluateSchedulePolicy({
      requestedMode: "auto",
      riskClass: "auto",
      confidence: 0.9,
      fireAt: "2026-11-30T06:00:00Z",
      recurrence: null,
      now: NOW,
      windowOpensAt: WINDOW,
    });
    expect(v.decision).toBe("auto");
    expect(v.fireAt?.toISOString()).toBe("2026-11-30T18:30:00.000Z");
    expect(v.reasons[0]).toMatch(/precedes the window open/);
  });

  it("a window in the past still rejects — the clamp never resurrects a past fire", () => {
    const v = evaluateSchedulePolicy({
      requestedMode: "auto",
      riskClass: "auto",
      confidence: 0.9,
      fireAt: "2026-06-01T00:00:00Z",
      recurrence: null,
      now: NOW,
      windowOpensAt: "2026-06-05T00:45:00Z",
    });
    expect(v.decision).toBe("reject");
  });

  it("without a window the verdict is unchanged", () => {
    const v = evaluateSchedulePolicy({
      requestedMode: "auto",
      riskClass: "auto",
      confidence: 0.9,
      fireAt: "2026-12-16T01:30:00Z",
      recurrence: null,
      now: NOW,
    });
    expect(v.decision).toBe("auto");
    expect(v.fireAt?.toISOString()).toBe("2026-12-16T01:30:00.000Z");
  });
});
