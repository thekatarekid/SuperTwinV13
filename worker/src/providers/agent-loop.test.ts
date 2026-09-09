import { describe, expect, it, vi } from "vitest";

import { AgentTurnLoopError, runAgentTurnLoop, sendProviderRequest } from "./agent-loop.js";
import type { NeutralProviderResult, ProviderRequest, ProviderV2 } from "./types.js";
import { emptyUsage } from "./usage.js";

const tool = { type: "function" as const, name: "weather", description: "Weather", parameters: { type: "object" }, strict: true as const };

function request(maxAgentTurns = 3): ProviderRequest {
  return {
    runId: "loop-1", model: "gpt-test", instructions: "", maxOutputTokens: 100,
    maxAgentTurns, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] }],
    tools: [tool], toolChoice: "auto", parallelToolCalls: false, onEvent: vi.fn(),
  };
}

function provider(turns: Array<(req: ProviderRequest) => NeutralProviderResult>): ProviderV2 & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (req: ProviderRequest) => {
    const turn = turns.shift();
    if (!turn) throw new Error("unexpected provider retry");
    return turn(req);
  });
  return {
    id: "chatgpt-oauth", displayName: "ChatGPT", capabilities: { functionTools: true, hostTools: false, continuation: true, requiresAuthentication: true },
    authState: () => ({ status: "ready", error: null }), catalogue: () => { throw new Error("unused"); },
    send, cancel: () => false, killAll: () => undefined,
  };
}

const ok = (continuation: string | null): NeutralProviderResult => ({
  continuation, usage: { ...emptyUsage(), inputTokens: 1, outputTokens: 2 }, freshFallback: false, status: "ok",
});

describe("SuperTwin-owned agent-turn loop", () => {
  it("correlates validated tool results and continues exactly once", async () => {
    const backend = provider([
      (req) => { req.onEvent({ type: "tool_use", callId: "call-1", name: "weather", input: { city: "Pune" } }); return ok("response-1"); },
      (req) => { expect(req.input).toEqual([{ type: "function_call_output", call_id: "call-1", output: "sunny" }]); expect(req.continuation).toEqual({ token: "response-1" }); return ok(null); },
    ]);
    const execute = vi.fn(async () => "sunny");
    const validate = vi.fn(() => true);
    const result = await runAgentTurnLoop({ provider: backend, request: request(), toolHandlers: { weather: { validate, execute } } });
    expect(result).toMatchObject({ status: "ok", usage: { inputTokens: 2, outputTokens: 4 } });
    expect(backend.send).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith({ city: "Pune" }, { callId: "call-1", signal: undefined });
    expect(validate).toHaveBeenCalledWith({ city: "Pune" }, tool.parameters);
  });

  it("stops cleanly at the cap with typed MAX_TURNS and does not run the capped tool", async () => {
    const backend = provider([(req) => { req.onEvent({ type: "tool_use", callId: "call-cap", name: "weather", input: {} }); return ok("response-cap"); }]);
    const execute = vi.fn(async () => "must not run");
    const result = await runAgentTurnLoop({ provider: backend, request: request(1), toolHandlers: { weather: { validate: () => true, execute } } });
    expect(result).toMatchObject({ status: "error", errorCode: "MAX_TURNS", continuation: "response-cap" });
    expect(execute).not.toHaveBeenCalled();
    expect(backend.send).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown tool", { type: "tool_use" as const, callId: "call-1", name: "shell", input: {} }],
    ["invalid arguments", { type: "tool_use" as const, callId: "call-1", name: "weather", input: { bad: true } }],
  ])("rejects %s without another provider call", async (_name, event) => {
    const backend = provider([(req) => { req.onEvent(event); return ok("response-1"); }]);
    await expect(runAgentTurnLoop({ provider: backend, request: request(), toolHandlers: { weather: { validate: () => false, execute: vi.fn() } } }))
      .rejects.toBeInstanceOf(AgentTurnLoopError);
    expect(backend.send).toHaveBeenCalledOnce();
  });

  it("rejects duplicate call ids across turns and never retries or falls back", async () => {
    const backend = provider([
      (req) => { req.onEvent({ type: "tool_use", callId: "same", name: "weather", input: {} }); return ok("response-1"); },
      (req) => { req.onEvent({ type: "tool_use", callId: "same", name: "weather", input: {} }); return ok("response-2"); },
    ]);
    await expect(runAgentTurnLoop({ provider: backend, request: request(), toolHandlers: { weather: { validate: () => true, execute: async () => "ok" } } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(backend.send).toHaveBeenCalledTimes(2);
  });

  it("rejects an uncorrelated legacy tool call", async () => {
    const backend = provider([(req) => {
      req.onEvent({ type: "tool_use", name: "weather", input: {} });
      return ok("response-1");
    }]);
    await expect(runAgentTurnLoop({ provider: backend, request: request(), toolHandlers: { weather: { validate: () => true, execute: vi.fn() } } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(backend.send).toHaveBeenCalledOnce();
  });

  it("rejects a malformed provider continuation before handlers or another send", async () => {
    const execute = vi.fn(async () => "must not run");
    const backend = provider([(req) => {
      req.onEvent({ type: "tool_use", callId: "call-1", name: "weather", input: {} });
      return ok("bad continuation");
    }]);
    await expect(runAgentTurnLoop({
      provider: backend,
      request: request(),
      toolHandlers: { weather: { validate: () => true, execute } },
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(execute).not.toHaveBeenCalled();
    expect(backend.send).toHaveBeenCalledOnce();
  });

  it("returns a provider transport failure directly without retry or fallback", async () => {
    const failed: NeutralProviderResult = { ...ok(null), status: "error", errorCode: "TRANSPORT_ERROR" };
    const backend = provider([() => failed]);
    await expect(runAgentTurnLoop({ provider: backend, request: request(), toolHandlers: { weather: { validate: () => true, execute: vi.fn() } } }))
      .resolves.toMatchObject({ status: "error", errorCode: "TRANSPORT_ERROR" });
    expect(backend.send).toHaveBeenCalledOnce();
  });

  it("enforces required and none tool choice before any tool execution", async () => {
    const execute = vi.fn(async () => "no");
    const missing = provider([() => ok(null)]);
    await expect(runAgentTurnLoop({ provider: missing, request: { ...request(), toolChoice: "required" }, toolHandlers: { weather: { validate: () => true, execute } } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    const forbidden = provider([(req) => { req.onEvent({ type: "tool_use", callId: "call-1", name: "weather", input: {} }); return ok("response-1"); }]);
    await expect(runAgentTurnLoop({ provider: forbidden, request: { ...request(), toolChoice: "none" }, toolHandlers: { weather: { validate: () => true, execute } } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["bad call", "bad\u0000call", `x${"y".repeat(256)}`])("rejects unsafe call id %j before side effects", async (callId) => {
    const execute = vi.fn(async () => "no");
    const backend = provider([(req) => { req.onEvent({ type: "tool_use", callId, name: "weather", input: {} }); return ok("response-1"); }]);
    await expect(runAgentTurnLoop({ provider: backend, request: request(), toolHandlers: { weather: { validate: () => true, execute } } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the shared maximum of 64 turns", async () => {
    await expect(runAgentTurnLoop({ provider: provider([]), request: request(65), toolHandlers: {} }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("routes the production dispatch seam through the bounded loop with no fallback", async () => {
    const backend = provider([
      (req) => { req.onEvent({ type: "tool_use", callId: "call-prod", name: "weather", input: {} }); return ok("response-prod"); },
      () => ok(null),
    ]);
    const result = await sendProviderRequest({
      provider: backend, request: request(2),
      toolHandlers: { weather: { validate: () => true, execute: async () => "done" } },
    });
    expect(result.status).toBe("ok");
    expect(backend.send).toHaveBeenCalledTimes(2);
  });

  it("rejects a provider without safe continuation before fetch or tool side effects", async () => {
    const execute = vi.fn(async () => "must not run");
    const backend = provider([]);
    Object.defineProperty(backend, "capabilities", { value: {
      ...backend.capabilities, continuation: false,
    } });
    await expect(sendProviderRequest({
      provider: backend,
      request: request(2),
      toolHandlers: { weather: { validate: () => true, execute } },
    })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(backend.send).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
