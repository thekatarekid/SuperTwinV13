import { beforeEach, describe, expect, it } from "vitest";

import {
  CHATGPT_QUOTA_TRIPPED_KEY,
  DEFAULT_CHATGPT_QUOTA_SHARE,
  assertProviderQuotaAvailable,
  chatGptQuotaStatus,
  invalidateChatGptQuotaIdentity,
  recordChatGptQuotaSnapshot,
  recordChatGptRateLimited,
  resetBudgetLatch,
  resetBudgetForTests,
  resetChatGptQuotaLatch,
  setBudgetStore,
  setChatGptQuotaCeilingShare,
  type BudgetStore,
} from "./budget.js";

const values = new Map<string, string>();
const ID = "a".repeat(64);
const store: BudgetStore = {
  get: (key) => values.get(key) ?? null,
  set: (key, value) => void values.set(key, value),
  delete: (key) => void values.delete(key),
};

beforeEach(() => {
  values.clear();
  resetBudgetForTests();
  setBudgetStore(store);
});

describe("ChatGPT provider quota ceiling", () => {
  it("states a conservative half-plan default and keeps cost unknown", () => {
    expect(chatGptQuotaStatus()).toEqual({
      state: "unknown", resetAt: null, ceilingShare: DEFAULT_CHATGPT_QUOTA_SHARE,
      consumedShare: null, trippedAt: null,
    });
  });

  it("latches when SuperTwin consumes its configured share and never clears on time", () => {
    const resetAt = "2026-09-10T00:00:00.000Z";
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 10, resetAt }, 1_000);
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 55, resetAt }, 2_000);
    expect(chatGptQuotaStatus()).toMatchObject({ state: "exhausted", consumedShare: 1 });
    expect(values.get(CHATGPT_QUOTA_TRIPPED_KEY)).toBe(new Date(2_000).toISOString());
    expect(() => assertProviderQuotaAvailable("chatgpt-oauth")).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    expect(() => assertProviderQuotaAvailable("claude-local")).not.toThrow();
  });

  it("requires a human reset and rebases without erasing the observed window", () => {
    setChatGptQuotaCeilingShare(0.25);
    const resetAt = "2026-09-10T00:00:00.000Z";
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 20, resetAt }, 1_000);
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 40, resetAt }, 2_000);
    resetChatGptQuotaLatch(3_000);
    expect(chatGptQuotaStatus()).toMatchObject({ state: "available", consumedShare: 0, ceilingShare: 0.25 });
    expect(() => assertProviderQuotaAvailable("chatgpt-oauth")).not.toThrow();
  });

  it("is cleared by the existing operator budget-reset control", () => {
    const resetAt = "2026-09-10T00:00:00.000Z";
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 0, resetAt }, 1_000);
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 50, resetAt }, 2_000);
    resetBudgetLatch(3_000);
    expect(chatGptQuotaStatus()).toMatchObject({ state: "available", consumedShare: 0, trippedAt: null });
  });

  it("starts a new baseline when the plan window resets and rejects hostile polling", () => {
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 80, resetAt: "2026-09-10T00:00:00.000Z" }, Date.parse("2026-09-09T00:00:00Z"));
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 2, resetAt: "2026-09-11T00:00:00.000Z" }, Date.parse("2026-09-10T00:00:01Z"));
    expect(chatGptQuotaStatus()).toMatchObject({ state: "available", consumedShare: 0 });
    expect(() => recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 101, resetAt: null })).toThrow();
  });

  it("rejects premature reset changes and tracks primary/secondary independently", () => {
    const now = Date.parse("2026-09-09T00:00:00Z");
    recordChatGptQuotaSnapshot({ identity: ID, windows: [
      { kind: "primary", usedPercent: 10, resetAt: "2026-09-10T00:00:00Z" },
      { kind: "secondary", usedPercent: 60, resetAt: "2026-09-16T00:00:00Z" },
    ] }, now);
    expect(() => recordChatGptQuotaSnapshot({ identity: ID, windows: [
      { kind: "primary", usedPercent: 0, resetAt: "2026-09-11T00:00:00Z" },
    ] }, now + 1)).toThrow("unverified");
    recordChatGptQuotaSnapshot({ identity: ID, windows: [
      { kind: "primary", usedPercent: 15, resetAt: "2026-09-10T00:00:00Z" },
      { kind: "secondary", usedPercent: 80, resetAt: "2026-09-16T00:00:00Z" },
    ] }, now + 2);
    expect(chatGptQuotaStatus()).toMatchObject({ state: "exhausted", consumedShare: 1,
      resetAt: "2026-09-16T00:00:00Z" });
  });

  it("allocates half of remaining headroom and rejects an unverified decrease", () => {
    const resetAt = "2026-09-10T00:00:00.000Z";
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 60, resetAt }, 1_000);
    expect(() => recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 59, resetAt }, 2_000)).toThrow();
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 80, resetAt }, 3_000);
    expect(chatGptQuotaStatus()).toMatchObject({ state: "exhausted", consumedShare: 1 });
  });

  it("invalidates account-bound state and keeps transient rate limits out of the hard latch", () => {
    recordChatGptQuotaSnapshot({ identity: ID, usedPercent: 10, resetAt: "2026-09-10T00:00:00.000Z" }, 1_000);
    recordChatGptRateLimited(ID, 30_000, 2_000);
    expect(values.get(CHATGPT_QUOTA_TRIPPED_KEY)).toBeUndefined();
    invalidateChatGptQuotaIdentity("b".repeat(64));
    expect(chatGptQuotaStatus()).toMatchObject({ state: "unknown", consumedShare: null, trippedAt: null });
  });
});
