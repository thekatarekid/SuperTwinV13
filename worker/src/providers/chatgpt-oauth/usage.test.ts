import { describe, expect, it } from "vitest";

import {
  ChatGptUsageError,
  parseChatGptQuota,
  parseChatGptUsage,
  retryAfterMs,
} from "./usage.js";

function expectUsageFailure(operation: () => unknown): void {
  expect(operation).toThrow(ChatGptUsageError);
  try {
    operation();
  } catch (error) {
    expect((error as ChatGptUsageError).code).toBe("BACKEND_UNSUPPORTED");
  }
}

describe("ChatGPT usage projection", () => {
  it("maps totals and cached input as a subset without inventing cost or Claude cache fields", () => {
    expect(parseChatGptUsage({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 100, ignored_secret: "drop" },
      output_tokens_details: { reasoning_tokens: 20 },
      account_id: "drop",
    })).toEqual({
      usage: {
        inputTokens: 120,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 30,
        cachedInputTokens: 100,
      },
      totalTokens: 150,
      reasoningTokens: 20,
    });
    expect(parseChatGptUsage({ input_tokens: 1, output_tokens: 2 }).usage)
      .not.toHaveProperty("costUsd");
    expect(parseChatGptUsage({
      input_tokens: 10,
      output_tokens: 4,
      input_tokens_details: {},
      cached_input_tokens: 3,
      output_tokens_details: {},
      reasoning_tokens: 2,
    })).toMatchObject({
      usage: { cachedInputTokens: 3 },
      reasoningTokens: 2,
    });
  });

  it.each([
    {},
    { input_tokens: 1 },
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 10_000_001 },
    { input_tokens: 1, output_tokens: 1, total_tokens: 9 },
    { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
    { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } },
  ])("rejects malformed or inconsistent counters %#", (payload) => {
    expectUsageFailure(() => parseChatGptUsage(payload));
  });
});

describe("ChatGPT quota projection", () => {
  it("projects bounded account health while dropping raw identifiers", () => {
    const parsed = parseChatGptQuota({
      plan_type: "prolite",
      rate_limit: {
        primary_window: {
          used_percent: 24,
          reset_at: "2026-09-09T00:00:00Z",
          limit_window_seconds: 18_000,
        },
        secondary_window: null,
      },
      credits: { remaining: "8.5", secret: "drop" },
      account_id: "acct-secret",
    });
    expect(parsed).toEqual({
      planType: "prolite",
      primary: {
        usedPercent: 24,
        resetAt: "2026-09-09T00:00:00Z",
        limitWindowSeconds: 18_000,
      },
      creditsRemaining: 8.5,
      healthy: true,
      restrictionSignal: false,
    });
    expect(JSON.stringify(parsed)).not.toContain("acct-secret");
  });

  it("keeps absent and null secondary windows equivalent", () => {
    const base = { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1 } } };
    expect(parseChatGptQuota(base)).not.toHaveProperty("secondary");
    expect(parseChatGptQuota({
      ...base,
      rate_limit: { ...base.rate_limit, secondary_window: null },
    })).not.toHaveProperty("secondary");
  });

  it.each([
    { plan_type: "plus", status: "account_flagged", rate_limit: { primary_window: { used_percent: 1 } } },
    { plan_type: "plus", account: { suspended: true }, rate_limit: { primary_window: { used_percent: 1 } } },
    { plan_type: "plus", warning: "CAPTCHA required", rate_limit: { primary_window: { used_percent: 1 } } },
    { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1 }, rate_limited: true } },
    { plan_type: "plus", account_warning: true, rate_limit: { primary_window: { used_percent: 1 } } },
    { plan_type: "plus", warning: true, rate_limit: { primary_window: { used_percent: 1 } } },
    { plan_type: "plus", captcha: true, rate_limit: { primary_window: { used_percent: 1 } } },
    { plan_type: "plus", restriction: true, rate_limit: { primary_window: { used_percent: 1 } } },
  ])("marks structural account restrictions unhealthy %#", (payload) => {
    expect(parseChatGptQuota(payload).healthy).toBe(false);
  });

  it.each([
    "Your account is not restricted.",
    "This plan is not rate limited.",
    "No suspicious activity detected.",
  ])("does not infer a restriction from benign prose: %s", (notice) => {
    expect(parseChatGptQuota({
      plan_type: "plus",
      notice,
      rate_limit: { primary_window: { used_percent: 1 } },
    })).toMatchObject({ healthy: true, restrictionSignal: false });
  });

  it("marks exhausted primary or secondary windows unhealthy", () => {
    expect(parseChatGptQuota({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 100 } },
    }).healthy).toBe(false);
    expect(parseChatGptQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 1 },
        secondary_window: { used_percent: 100, reset_at: null },
      },
    }).healthy).toBe(false);
  });

  it.each([
    {},
    { plan_type: "plus", rate_limit: {} },
    { plan_type: "plus", rate_limit: { primary_window: { used_percent: Infinity } } },
    { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1, reset_at: "not-a-date" } } },
    { plan_type: "plus", rate_limit: { primary_window: { used_percent: 1 }, secondary_window: {} } },
    { plan_type: "x".repeat(129), rate_limit: { primary_window: { used_percent: 1 } } },
  ])("fails closed on malformed quota payloads %#", (payload) => {
    expectUsageFailure(() => parseChatGptQuota(payload));
  });

  it("redacts structural traps and refuses array subclasses", () => {
    const trapped = new Proxy({}, {
      getPrototypeOf: () => { throw new Error("secret-usage-structure"); },
    });
    let failure: unknown;
    try {
      parseChatGptQuota(trapped);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toBe(
      "ChatGptUsageError: BACKEND_UNSUPPORTED: invalid response structure",
    );
    expect(String(failure)).not.toContain("secret-usage-structure");

    class UnsafeArray extends Array<unknown> {}
    expectUsageFailure(() => parseChatGptQuota({
      plan_type: "plus",
      notices: new UnsafeArray("ok"),
      rate_limit: { primary_window: { used_percent: 1 } },
    }));
  });
});

describe("ChatGPT retry timing", () => {
  const headers = (value: string | null) => ({ get: () => value });

  it("accepts bounded delta seconds and HTTP dates", () => {
    expect(retryAfterMs(headers("12"), 0)).toBe(12_000);
    expect(retryAfterMs(headers("Thu, 01 Jan 1970 00:00:12 GMT"), 2_000)).toBe(10_000);
  });

  it.each([null, "", " 1", "1.5", "999999999", "not-a-date"])(
    "rejects malformed or excessive Retry-After values: %s",
    (value) => expect(retryAfterMs(headers(value), 0)).toBeNull(),
  );

  it("returns null when a header reader throws or returns a non-string value", () => {
    expect(retryAfterMs({ get: () => { throw new Error("secret-header"); } })).toBeNull();
    expect(retryAfterMs({ get: () => 5 as never })).toBeNull();
  });
});
