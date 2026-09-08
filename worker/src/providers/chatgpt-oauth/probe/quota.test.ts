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
      credits: { remaining: "8", secret: "drop" },
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
    { plan_type: "plus", account: { flagged: true }, rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } } },
    { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1, reset_at: 1 }, limited: true } },
    { plan_type: "plus", account: { is_flagged: true }, rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } } },
    { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1, reset_at: 1 }, rate_limited: true } },
    { plan_type: "plus", restriction: true, rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } } },
    { plan_type: "plus", captcha: true, rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } } },
  ])("marks quota or account restrictions unhealthy", (payload) => {
    expect(parseProbeQuota(payload).healthy).toBe(false);
  });

  it("rejects empty and malformed quota payloads", () => {
    expect(() => parseProbeQuota({})).toThrow(/plan_type/);
    expect(() => parseProbeQuota({ plan_type: "plus", rate_limit: {} })).toThrow(/primary window/);
    expect(() => parseProbeQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 1, reset_at: 1 },
        secondary_window: { used_percent: "bad", reset_at: 1 },
      },
    })).toThrow(/secondary window/);
    expect(() => parseProbeQuota({
      plan_type: "plus",
      credits: { remaining: "unknown" },
      rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } },
    })).toThrow(/credits balance/);
  });

  it("treats an explicit null secondary window as absent but rejects malformed non-null objects", () => {
    expect(parseProbeQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 1, reset_at: 1 },
        secondary_window: null,
      },
    })).toEqual({
      planType: "plus",
      primary: { usedPercent: 1, resetAt: 1 },
      healthy: true,
      restrictionSignal: false,
    });
    expect(() => parseProbeQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 1, reset_at: 1 },
        secondary_window: { used_percent: null, reset_at: null },
      },
    })).toThrow(/secondary window/);
  });

  it("accepts a secondary window with finite usage and optional reset while ignoring limit_window_seconds", () => {
    expect(parseProbeQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 1, reset_at: 1 },
        secondary_window: { used_percent: 4, limit_window_seconds: 604_800 },
      },
    }).secondary).toEqual({ usedPercent: 4 });
    expect(parseProbeQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 1, reset_at: 1 },
        secondary_window: { used_percent: 4, reset_at: null },
      },
    }).secondary).toEqual({ usedPercent: 4 });
  });

  it.each([{}, 1.5, 253_402_300_799_001, "x".repeat(129)])(
    "rejects a malformed present secondary reset_at: %s",
    (reset_at) => {
      expect(() => parseProbeQuota({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 1, reset_at: 1 },
          secondary_window: { used_percent: 4, reset_at },
        },
      })).toThrow(/secondary window/);
    },
  );

  it.each([
    ["non-finite used percent", { plan_type: "plus", rate_limit: { primary_window: { used_percent: Infinity, reset_at: 1 } } }],
    ["absurd used percent", { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1_001, reset_at: 1 } } }],
    ["fractional numeric reset", { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1, reset_at: 1.5 } } }],
    ["absurd numeric reset", { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1, reset_at: 253_402_300_799_001 } } }],
    ["unbounded reset string", { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1, reset_at: "x".repeat(129) } } }],
    ["unbounded plan", { plan_type: "x".repeat(129), rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } } }],
  ])("rejects hostile outward quota numeric/string metadata: %s", (_label, payload) => {
    expect(() => parseProbeQuota(payload)).toThrow();
  });

  it.each([Infinity, 1_000_000_001])("rejects unsafe credits balance %s", (remaining) => {
    expect(() => parseProbeQuota({
      plan_type: "plus",
      credits: { remaining },
      rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } },
    })).toThrow(/credits balance/);
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
    expect(() => compareProbeQuota(start, {
      ...end,
      secondary: { usedPercent: 1, resetAt: 1 },
    })).toThrow(/secondary window changed shape/);
  });
});
