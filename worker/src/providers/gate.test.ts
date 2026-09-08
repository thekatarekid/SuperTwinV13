import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TraceRecord } from "../traces/store.js";
import { withTraceContext } from "../traces/context.js";
import {
  BUDGET_TRIPPED_KEY,
  BUDGET_TRIPPED_REASON_KEY,
  MODEL_ACTIVITY_PAUSED_KEY,
  budgetStatus,
  resetBudgetForTests,
  setBudgetStore,
  type BudgetStore,
} from "./budget.js";
import {
  ProviderGateError,
  runGatedProviderAttempt,
} from "./gate.js";
import { get, register } from "./registry.js";
import {
  resetSpendHeartbeatForTests,
  spendHeartbeatLine,
} from "./spend-heartbeat.js";
import type {
  LegacyProviderResult,
  Provider,
  ProviderAuthState,
  ProviderStreamEvent,
  SendOptions,
} from "./types.js";
import { emptyUsage } from "./usage.js";

const state = new Map<string, string>();
const budgetStore: BudgetStore = {
  get: (key) => state.get(key) ?? null,
  set: (key, value) => void state.set(key, value),
  delete: (key) => void state.delete(key),
};

beforeEach(() => {
  state.clear();
  resetBudgetForTests();
  setBudgetStore(budgetStore);
  resetSpendHeartbeatForTests();
});

afterEach(() => {
  resetSpendHeartbeatForTests();
  resetBudgetForTests();
});

function result(): LegacyProviderResult {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    usage: emptyUsage(),
    freshFallback: false,
    status: "ok",
  };
}

class GatedFakeProvider implements Provider {
  readonly id: string;
  calls = 0;
  auth: ProviderAuthState = { status: "ready", error: null };
  readonly order: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  cancel(): boolean {
    return false;
  }

  async send(opts: SendOptions): Promise<LegacyProviderResult> {
    return runGatedProviderAttempt({
      providerId: this.id,
      runId: opts.runId,
      attempt: 1,
      model: opts.model ?? null,
      systemPrompt: null,
      packedContext: opts.message,
      onEvent: opts.onEvent,
      checkQuota: () => void this.order.push("quota"),
      authState: () => {
        this.order.push("auth");
        return this.auth;
      },
      execute: async (onEvent) => {
        this.order.push("send");
        this.calls += 1;
        onEvent({ type: "delta", text: "ok" });
        return result();
      },
    });
  }
}

async function sendThroughRegistry(provider: GatedFakeProvider): Promise<LegacyProviderResult> {
  register(provider);
  const resolved = get(provider.id);
  if (!resolved) throw new Error("fake provider was not registered");
  return withTraceContext(
    { pass: "orient", caller: "providers/gate.test" },
    () => resolved.send({ runId: "fake-run", message: "hello", onEvent: () => {} }),
  );
}

describe("shared provider gate", () => {
  it("blocks a registry-resolved provider at the kill switch before quota, auth, or send", async () => {
    state.set(MODEL_ACTIVITY_PAUSED_KEY, "2026-09-08T00:00:00.000Z");
    const fake = new GatedFakeProvider("fake-gate-kill");

    await expect(sendThroughRegistry(fake)).rejects.toMatchObject({
      code: "MODEL_ACTIVITY_PAUSED",
    });
    expect(fake.calls).toBe(0);
    expect(fake.order).toEqual([]);
    expect(budgetStatus().hour.calls).toBe(0);
  });

  it("blocks a registry-resolved provider at the budget latch before quota, auth, or send", async () => {
    state.set(BUDGET_TRIPPED_KEY, "2026-09-08T00:00:00.000Z");
    state.set(BUDGET_TRIPPED_REASON_KEY, "test latch");
    const fake = new GatedFakeProvider("fake-gate-budget");

    await expect(sendThroughRegistry(fake)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    expect(fake.calls).toBe(0);
    expect(fake.order).toEqual([]);
    expect(budgetStatus().hour.calls).toBe(0);
  });

  it("checks quota before auth and does not admit a signed-out provider", async () => {
    const fake = new GatedFakeProvider("fake-gate-auth");
    fake.auth = { status: "signed_out", error: null };

    await expect(sendThroughRegistry(fake)).rejects.toEqual(
      expect.objectContaining<Partial<ProviderGateError>>({ code: "AUTH_REQUIRED" }),
    );
    expect(fake.order).toEqual(["quota", "auth"]);
    expect(fake.calls).toBe(0);
    expect(budgetStatus().hour.calls).toBe(0);
    expect(spendHeartbeatLine(Date.now())).toContain("AUTH_REQUIRED ×1");
  });

  it("admits, streams, accounts, and traces one physical attempt exactly once", async () => {
    const fake = new GatedFakeProvider("fake-gate-success");
    const events: ProviderStreamEvent[] = [];
    const traces: TraceRecord[] = [];

    register(fake);
    const resolved = get(fake.id)!;
    await withTraceContext(
      { pass: "orient", caller: "providers/gate.test", sink: (trace) => traces.push(trace) },
      () => resolved.send({ runId: "trace-run", message: "hello", onEvent: (event) => events.push(event) }),
    );

    expect(fake.order).toEqual(["quota", "auth", "send"]);
    expect(fake.calls).toBe(1);
    expect(budgetStatus().hour.calls).toBe(1);
    expect(events).toEqual([{ type: "delta", text: "ok" }]);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      run_id: "trace-run",
      attempt: 1,
      model: null,
      raw_output: "ok",
      status: "ok",
    });
  });

  it("traces an admitted neutral error result with its typed error code", async () => {
    const traces: TraceRecord[] = [];

    await withTraceContext(
      { pass: "orient", caller: "providers/gate.test", sink: (trace) => traces.push(trace) },
      () => runGatedProviderAttempt({
        providerId: "chatgpt-oauth",
        runId: "typed-error-run",
        attempt: 1,
        model: "gpt-test",
        systemPrompt: null,
        packedContext: "hello",
        onEvent: () => {},
        execute: async () => ({
          continuation: null,
          usage: emptyUsage(),
          freshFallback: false,
          status: "error" as const,
          errorCode: "TRANSPORT_ERROR" as const,
        }),
      }),
    );

    expect(budgetStatus().hour.calls).toBe(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.status).toBe("TRANSPORT_ERROR");
  });

  it("accounts the last usage event when an admitted attempt throws", async () => {
    const traces: TraceRecord[] = [];
    const usage = {
      inputTokens: 11,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 7,
      costUsd: 0.25,
    };

    await expect(withTraceContext(
      { pass: "orient", caller: "providers/gate.test", sink: (trace) => traces.push(trace) },
      () => runGatedProviderAttempt({
        providerId: "chatgpt-oauth",
        runId: "throw-after-usage",
        attempt: 1,
        model: "gpt-test",
        systemPrompt: null,
        packedContext: "hello",
        onEvent: () => {},
        execute: async (onEvent) => {
          onEvent({ type: "usage", usage });
          throw Object.assign(new Error("transport failed"), { code: "TRANSPORT_ERROR" });
        },
      }),
    )).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });

    expect(budgetStatus().hour.calls).toBe(1);
    expect(spendHeartbeatLine(Date.now())).toContain("18 tok");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      status: "TRANSPORT_ERROR",
      tokens_4way: {
        input: 11,
        cache_creation: 0,
        cache_read: 0,
        output: 7,
      },
      cost_usd: 0.25,
    });
  });
});
