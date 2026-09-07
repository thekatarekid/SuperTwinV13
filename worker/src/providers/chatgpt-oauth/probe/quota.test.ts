import { describe, expect, it } from "vitest";

import { compareProbeQuota, parseProbeQuota } from "./quota.js";

describe("Phase 0b quota evidence", () => {
  it("projects only plan, windows, credits, and health", () => {
    expect(parseProbeQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 12.5, reset_at: 2_000_000_000 },
        secondary_window: { used_percent: 4, reset_at: "2026-09-09T00:00:00Z" },
      },
      credits: { remaining: 8, secret: "drop" },
      account_id: "drop",
    })).toEqual({
      planType: "plus",
      primary: { usedPercent: 12.5, resetAt: 2_000_000_000 },
      secondary: { usedPercent: 4, resetAt: "2026-09-09T00:00:00Z" },
      creditsRemaining: 8,
      healthy: true,
      restrictionSignal: false,
    });
  });

  it.each([
    { plan_type: "plus", rate_limit: { primary_window: { used_percent: 100, reset_at: 1 } } },
    { plan_type: "plus", status: "account_flagged", rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } } },
    { plan_type: "plus", warning: "CAPTCHA required", rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } } },
  ])("marks quota or account restrictions unhealthy", (payload) => {
    expect(parseProbeQuota(payload).healthy).toBe(false);
  });

  it("rejects empty and malformed quota payloads", () => {
    expect(() => parseProbeQuota({})).toThrow(/plan_type/);
    expect(() => parseProbeQuota({ plan_type: "plus", rate_limit: {} })).toThrow(/primary window/);
  });

  it("compares healthy start/end evidence and rejects a bad final state", () => {
    const start = parseProbeQuota({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 10, reset_at: 1 } },
    });
    const end = parseProbeQuota({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 15, reset_at: 1 } },
    });
    expect(compareProbeQuota(start, end)).toEqual({
      healthyAtStart: true,
      healthyAtEnd: true,
      primaryUsedPercentDelta: 5,
    });
    expect(() => compareProbeQuota(start, {
      ...end,
      healthy: false,
      restrictionSignal: true,
    })).toThrow(/quota-limited or restricted/);
  });
});
