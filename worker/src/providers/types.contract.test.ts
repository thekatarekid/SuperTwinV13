import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  LegacyProviderDoneEvent,
  LegacyProvider,
  LegacyProviderResult,
  LegacyProviderSessionEvent,
  LegacySendOptions,
  NeutralProvider,
  NeutralProviderResult,
  Provider,
  ProviderContinuationEvent,
  ProviderDoneEvent,
  ProviderErrorCode,
  ProviderId,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolUseEvent,
  ProviderV2,
  SendOptions,
} from "./types.js";

type Assert<T extends true> = T;
type IsRequired<T, K extends keyof T> = object extends Pick<T, K> ? false : true;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

// Compile-time guardrails: the transition seam must not make modern fields
// optional or leak provider-wire constants into ProviderRequest.
const contractTypeAssertions: [
  Assert<
    IsRequired<NeutralProvider, "displayName" | "capabilities" | "killAll">
  >,
  Assert<IsRequired<NeutralProviderResult, "continuation">>,
  Assert<
    IsRequired<
      ProviderRequest,
      | "runId"
      | "model"
      | "instructions"
      | "input"
      | "maxOutputTokens"
      | "maxAgentTurns"
      | "onEvent"
    >
  >,
  Assert<HasKey<ProviderRequest, "store"> extends false ? true : false>,
] = [true, true, true, true];

const noopEvent = (_event: ProviderStreamEvent): void => {};

const minimalRequest = {
  runId: "run-minimal",
  model: "model-1",
  instructions: "",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ],
  cache: { mode: "none" },
  maxOutputTokens: 256,
  maxAgentTurns: 1,
  onEvent: noopEvent,
} satisfies ProviderRequest;

describe("provider-neutral type contract", () => {
  it("keeps modern core fields required and wire constants absent", () => {
    expect(contractTypeAssertions.every(Boolean)).toBe(true);
  });

  it("accepts blank instructions, distinct host/function tools, and continuation", () => {
    const request = {
      runId: "run-1",
      model: "model-1",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "hello" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
              detail: "auto",
            },
          ],
        },
        { type: "function_call_output", call_id: "call-1", output: "done" },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
      hostTools: ["Read"],
      toolChoice: "auto",
      continuation: { token: "opaque" },
      text: {
        format: {
          type: "json_schema",
          name: "supertwin_output",
          strict: true,
          schema: { type: "object", properties: {} },
        },
        verbosity: "low",
      },
      maxOutputTokens: 256,
      maxAgentTurns: 1,
      onEvent: noopEvent,
    } satisfies ProviderRequest;

    expect(request.instructions).toBe("");
    expect(request.tools[0].strict).toBe(true);
    expect(request.hostTools).toEqual(["Read"]);
  });

  it("allows a minimal one-turn request with tools and continuation omitted", () => {
    expect(minimalRequest.maxAgentTurns).toBe(1);
    expect(minimalRequest.cache.mode).toBe("none");
    expect("tools" in minimalRequest).toBe(false);
    expect("continuation" in minimalRequest).toBe(false);
  });

  it("keeps continuation required and sessionId only as a deprecated alias", () => {
    const result = {
      continuation: null,
      usage: {
        inputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 1,
      },
      freshFallback: false,
      status: "ok",
    } satisfies NeutralProviderResult;

    expect(result.continuation).toBeNull();
    expectTypeOf<NeutralProviderResult>().toHaveProperty("continuation");
  });

  it("types continuation, done, and correlated tool-use stream events", () => {
    const continuation = {
      type: "continuation",
      token: "opaque",
    } satisfies ProviderContinuationEvent;
    const toolUse = {
      type: "tool_use",
      callId: "call-1",
      name: "lookup",
      input: { query: "hello" },
    } satisfies ProviderToolUseEvent;
    const done = {
      type: "done",
      continuation: null,
      usage: {
        inputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 1,
      },
    } satisfies ProviderDoneEvent;

    expect([continuation, toolUse, done].map((event) => event.type)).toEqual([
      "continuation",
      "tool_use",
      "done",
    ]);
  });

  it("requires the complete neutral provider surface", async () => {
    const provider = {
      id: "chatgpt-oauth",
      displayName: "ChatGPT",
      capabilities: {
        functionTools: true,
        hostTools: false,
        continuation: true,
        requiresAuthentication: true,
      },
      authState: () => ({ status: "ready", error: null }),
      catalogue: () => ({
        providerId: "chatgpt-oauth",
        mode: "discovered",
        source: "account",
        discoveredAt: "2026-09-08T00:00:00.000Z",
        revision: "revision-1",
        error: null,
        models: [],
      }),
      send: async (): Promise<NeutralProviderResult> => ({
        continuation: null,
        usage: {
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
        },
        freshFallback: false,
        status: "ok",
      }),
      cancel: () => false,
      killAll: () => {},
    } satisfies Provider<"neutral">;

    expect(provider.id).toBe("chatgpt-oauth");
    expect((await provider.send()).continuation).toBeNull();
  });

  it("keeps the complete legacy and Phase 1 error-code union closed", () => {
    const codes = {
      TIMEOUT: true,
      SPAWN_FAILED: true,
      CLI_ERROR: true,
      POISONED_SESSION: true,
      CANCELLED: true,
      QUOTA_EXCEEDED: true,
      BUDGET_EXCEEDED: true,
      MODEL_ACTIVITY_PAUSED: true,
      MAX_TURNS: true,
      BAD_REQUEST: true,
      AUTH_REQUIRED: true,
      AUTH_EXPIRED: true,
      PROVIDER_UNAVAILABLE: true,
      MODEL_UNAVAILABLE: true,
      CAPABILITY_UNSUPPORTED: true,
      BACKEND_UNSUPPORTED: true,
      RATE_LIMITED: true,
      TRANSPORT_ERROR: true,
    } satisfies Record<ProviderErrorCode, true>;

    expect(Object.keys(codes)).toHaveLength(18);
  });

  it("rejects fields and values outside the closed contract", () => {
    const withStore = {
      ...minimalRequest,
      // @ts-expect-error `store` is a provider-wire constant, not neutral input.
      store: false,
    } satisfies ProviderRequest;
    const withFreeFormEffort = {
      ...minimalRequest,
      reasoning: {
        budget: "low",
        // @ts-expect-error Effort is the closed ThinkingBudget subset.
        effort: "minimal",
      },
    } satisfies ProviderRequest;
    const withBadCacheMode = {
      ...minimalRequest,
      cache: {
        // @ts-expect-error Cache mode is closed.
        mode: "automatic",
      },
    } satisfies ProviderRequest;
    const withBadCacheTtl = {
      ...minimalRequest,
      cache: {
        mode: "implicit",
        // @ts-expect-error Only the verified 30m TTL is accepted.
        ttl: "1h",
      },
    } satisfies ProviderRequest;
    const withBuiltInTool = {
      ...minimalRequest,
      tools: [
        {
          // @ts-expect-error Only function tools cross this boundary.
          type: "web_search",
          name: "search",
          description: "",
          parameters: {},
          strict: true,
        },
      ],
    } satisfies ProviderRequest;
    const withLooseTool = {
      ...minimalRequest,
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "",
          parameters: {},
          // @ts-expect-error Neutral tools are strict in this contract version.
          strict: false,
        },
      ],
    } satisfies ProviderRequest;
    // @ts-expect-error Provider IDs are closed and provider-scoped.
    const unknownProvider: ProviderId = "other-provider";

    expect([
      withStore,
      withFreeFormEffort,
      withBadCacheMode,
      withBadCacheTtl,
      withBuiltInTool,
      withLooseTool,
      unknownProvider,
    ]).toHaveLength(7);
  });
});

describe("one-release Claude compatibility seam", () => {
  it("keeps the legacy request and result aliases exact", () => {
    expectTypeOf<SendOptions>().toEqualTypeOf<LegacySendOptions>();
    expectTypeOf<Provider>().toEqualTypeOf<LegacyProvider>();
    expectTypeOf<Provider<"neutral">>().toEqualTypeOf<NeutralProvider>();
    expectTypeOf<ProviderV2>().toEqualTypeOf<NeutralProvider>();

    const legacyResult = {
      sessionId: "session-1",
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      freshFallback: false,
      status: "ok",
    } satisfies LegacyProviderResult;
    const legacySession = {
      type: "session",
      sessionId: "session-1",
    } satisfies LegacyProviderSessionEvent;
    const legacyDone = {
      type: "done",
      sessionId: "session-1",
      usage: legacyResult.usage,
    } satisfies LegacyProviderDoneEvent;

    expect(legacyResult.sessionId).toBe("session-1");
    expect(legacySession.sessionId).toBe(legacyDone.sessionId);
  });
});
