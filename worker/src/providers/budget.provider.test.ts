import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  BudgetExceededError,
  admitProviderCall,
  budgetCeilings,
  hasProviderCallCeilings,
  preflightProviderCall,
  providerCallBudgetStatus,
  resetBudgetForTests,
  resetBudgetLatch,
  setBudgetStore,
  type BudgetStore,
} from "./budget.js";

const HOUR = "SUPERTWIN_BUDGET_CHATGPT_OAUTH_CALLS_PER_HOUR";
const DAY = "SUPERTWIN_BUDGET_CHATGPT_OAUTH_CALLS_PER_DAY";
const savedHour = process.env[HOUR];
const savedDay = process.env[DAY];
const CHAT = { pass: "chat", caller: "server/chat" };
const BACKGROUND = { pass: "orient", caller: "brain/llm" };

function memoryStore(): BudgetStore {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
  };
}

beforeEach(() => {
  delete process.env[HOUR];
  delete process.env[DAY];
  resetBudgetForTests();
  setBudgetStore(memoryStore());
});

afterAll(() => {
  resetBudgetForTests();
  if (savedHour === undefined) delete process.env[HOUR];
  else process.env[HOUR] = savedHour;
  if (savedDay === undefined) delete process.env[DAY];
  else process.env[DAY] = savedDay;
});

describe("provider-scoped call ceilings", () => {
  it("keeps ChatGPT unconfigured until both measured positive limits exist", () => {
    expect(hasProviderCallCeilings("chatgpt-oauth")).toBe(false);
    process.env[HOUR] = "12";
    expect(hasProviderCallCeilings("chatgpt-oauth")).toBe(false);
    process.env[DAY] = "not-a-limit";
    expect(hasProviderCallCeilings("chatgpt-oauth")).toBe(false);
    process.env[DAY] = "120";
    expect(budgetCeilings().providerCalls["chatgpt-oauth"]).toEqual({
      callsPerHour: 12,
      callsPerDay: 120,
    });
  });

  it("preflights without spending and records each provider independently", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    preflightProviderCall("chatgpt-oauth", BACKGROUND, now);
    expect(providerCallBudgetStatus("chatgpt-oauth", now).hourCalls).toBe(0);

    admitProviderCall("claude-local", BACKGROUND, now);
    admitProviderCall("chatgpt-oauth", BACKGROUND, now);
    expect(providerCallBudgetStatus("claude-local", now).hourCalls).toBe(1);
    expect(providerCallBudgetStatus("chatgpt-oauth", now).hourCalls).toBe(1);
  });

  it("blocks request N+1 before admission, including interactive chat", () => {
    process.env[HOUR] = "2";
    process.env[DAY] = "10";
    const now = Date.parse("2026-09-08T12:00:00Z");

    admitProviderCall("chatgpt-oauth", CHAT, now);
    admitProviderCall("chatgpt-oauth", CHAT, now + 1);
    expect(() =>
      admitProviderCall("chatgpt-oauth", CHAT, now + 2)
    ).toThrow(BudgetExceededError);
    expect(providerCallBudgetStatus("chatgpt-oauth", now + 2).hourCalls).toBe(2);
  });

  it("does not charge Claude calls against the ChatGPT override", () => {
    process.env[HOUR] = "1";
    process.env[DAY] = "10";
    const now = Date.parse("2026-09-08T12:00:00Z");

    admitProviderCall("claude-local", BACKGROUND, now);
    admitProviderCall("chatgpt-oauth", BACKGROUND, now + 1);
    expect(providerCallBudgetStatus("chatgpt-oauth", now + 1).hourCalls).toBe(1);
  });

  it("keeps a provider ceiling latched after its rolling window clears", () => {
    process.env[HOUR] = "1";
    process.env[DAY] = "100";
    const now = Date.parse("2026-09-08T12:00:00Z");

    admitProviderCall("chatgpt-oauth", CHAT, now);
    expect(() => admitProviderCall("chatgpt-oauth", CHAT, now + 1)).toThrow(
      BudgetExceededError,
    );
    expect(() =>
      admitProviderCall("chatgpt-oauth", CHAT, now + 2 * 60 * 60 * 1_000)
    ).toThrow(BudgetExceededError);

    resetBudgetLatch(now + 2 * 60 * 60 * 1_000 + 1);
    expect(() =>
      admitProviderCall("chatgpt-oauth", CHAT, now + 2 * 60 * 60 * 1_000 + 2)
    ).not.toThrow();
  });
});
