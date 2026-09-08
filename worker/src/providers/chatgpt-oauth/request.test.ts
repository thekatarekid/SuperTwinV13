import { describe, expect, it, vi } from "vitest";

import type { ProviderJsonObject, ProviderModel, ProviderRequest } from "../types.js";
import {
  buildChatGptRequest,
  ChatGptRequestError,
  CHATGPT_MAX_INPUT_ITEMS,
} from "./request.js";

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "gpt-test",
    displayName: "GPT Test",
    isDefault: true,
    hidden: false,
    inputModalities: ["text", "image"],
    reasoningValues: ["none", "low", "high", "xhigh"],
    defaultReasoning: "low",
    supportsTools: true,
    supportsHostTools: false,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    supportsStrictTools: true,
    supportsVerbosity: true,
    supportsPromptCacheKey: true,
    supportsPromptCacheOptions: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    billingLabel: "ChatGPT subscription",
    ...overrides,
  };
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: "run-test",
    model: "gpt-test",
    instructions: "",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    }],
    maxOutputTokens: 512,
    maxAgentTurns: 1,
    onEvent: vi.fn(),
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: ChatGptRequestError["code"]): void {
  try {
    operation();
    throw new Error("expected request failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptRequestError);
    expect((error as ChatGptRequestError).code).toBe(code);
  }
}

describe("buildChatGptRequest", () => {
  it("preserves the minimum blank request and pins the wire constants", () => {
    const built = buildChatGptRequest(request(), model({ maxOutputTokens: null }));
    expect(built).toEqual({
      model: "gpt-test",
      instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      store: false,
      stream: true,
    });
    expect(built).not.toHaveProperty("max_output_tokens");
    expect(Object.isFrozen(built)).toBe(true);
  });

  it("preserves exact UTF-8 instruction bytes and input order without wrappers", () => {
    const instructions = "  first line\nनमस्ते 🌱\nlast line  ";
    const input: ProviderRequest["input"] = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
    ];
    const built = buildChatGptRequest(request({ instructions, input }), model());
    expect(built.instructions).toBe(instructions);
    expect(built.input).toEqual(input);
    expect(JSON.parse(JSON.stringify(built)).instructions).toBe(instructions);
  });

  it("maps the complete supported neutral request without forwarding neutral-only fields", () => {
    const parameters = {
      type: "object", properties: { value: { type: "string" } },
      required: ["value"], additionalProperties: false,
    };
    const built = buildChatGptRequest(request({
      input: [
        { type: "message", role: "assistant", content: [{ type: "input_text", text: "prior" }] },
        { type: "message", role: "user", content: [{
          type: "input_image",
          image_url: "data:image/png;base64,iVBORw0KGgo=",
          detail: "low",
        }] },
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
      tools: [{ type: "function", name: "probe_echo", description: "", parameters, strict: true }],
      toolChoice: "required",
      parallelToolCalls: true,
      reasoning: { budget: "high", effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "result_schema",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
        verbosity: "low",
      },
      cache: { mode: "explicit", key: "supertwin.prompt.v1", ttl: "30m" },
      continuation: { token: "resp_previous" },
      persistContinuation: true,
      skipHostSettings: true,
      cwd: "/ignored-by-http",
      maxBudgetUsd: 1,
      timeoutMs: 5_000,
    }), model());
    expect(built).toMatchObject({
      tool_choice: "required",
      parallel_tool_calls: true,
      reasoning: { effort: "high" },
      max_output_tokens: 512,
      previous_response_id: "resp_previous",
      prompt_cache_key: "supertwin.prompt.v1",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      store: false,
      stream: true,
    });
    expect(built).not.toHaveProperty("cwd");
    expect(built).not.toHaveProperty("maxBudgetUsd");
    expect((built.tools![0] as { parameters: unknown }).parameters).not.toBe(parameters);
  });

  it("includes max_output_tokens only when the account catalogue declares a bound", () => {
    expect(buildChatGptRequest(request({ maxOutputTokens: 8_192 }), model()).max_output_tokens).toBe(8_192);
    expectCode(
      () => buildChatGptRequest(request({ maxOutputTokens: 8_193 }), model()),
      "CAPABILITY_UNSUPPORTED",
    );
    expect(buildChatGptRequest(request({ maxOutputTokens: 8_193 }), model({ maxOutputTokens: null })))
      .not.toHaveProperty("max_output_tokens");
  });

  it("rejects unknown neutral fields before constructing a body", () => {
    const hostile = { ...request(), apiKey: "sk-secret", metadata: { secret: true } };
    expectCode(() => buildChatGptRequest(hostile as ProviderRequest, model()), "BAD_REQUEST");
    expect(() => buildChatGptRequest(hostile as ProviderRequest, model())).toThrow("provider request field");
  });

  it.each([
    [{ model: "other" }, "MODEL_UNAVAILABLE"],
    [{ input: [] }, "BAD_REQUEST"],
    [{ input: Array.from({ length: CHATGPT_MAX_INPUT_ITEMS + 1 }, () => request().input[0]!) }, "BAD_REQUEST"],
    [{ maxOutputTokens: 0 }, "BAD_REQUEST"],
    [{ maxAgentTurns: 0 }, "BAD_REQUEST"],
    [{ hostTools: ["Read"] }, "CAPABILITY_UNSUPPORTED"],
  ] as const)("fails closed for invalid core request %#", (overrides, code) => {
    expectCode(() => buildChatGptRequest(request(overrides as Partial<ProviderRequest>), model()), code);
  });

  it("accepts only exact input shapes and data image URLs", () => {
    const localImage = request({ input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "file:///tmp/private.png" }],
    }] });
    expectCode(() => buildChatGptRequest(localImage, model()), "CAPABILITY_UNSUPPORTED");

    const extra = request({ input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello", hidden: "secret" } as never],
    }] });
    expectCode(() => buildChatGptRequest(extra, model()), "BAD_REQUEST");
    expectCode(
      () => buildChatGptRequest(request({ input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }],
      }] }), model({ inputModalities: ["text"] })),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }] }), model({ inputModalities: ["image"] })),
      "CAPABILITY_UNSUPPORTED",
    );

    const sparse = Array(1) as ProviderRequest["input"];
    expectCode(() => buildChatGptRequest(request({ input: sparse }), model()), "BAD_REQUEST");
  });

  it("requires exact strict function tools and declared tool capabilities", () => {
    const withTool = request({ tools: [{
      type: "function",
      name: "lookup",
      description: "",
      parameters: { type: "object", additionalProperties: false },
      strict: true,
    }] });
    expect(buildChatGptRequest(withTool, model())).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expectCode(() => buildChatGptRequest(withTool, model({ supportsStrictTools: false })), "CAPABILITY_UNSUPPORTED");
    expectCode(
      () => buildChatGptRequest(request({ parallelToolCalls: true }), model()),
      "BAD_REQUEST",
    );
  });

  it("gates reasoning, structured output and verbosity on the selected model row", () => {
    expect(buildChatGptRequest(request({ reasoning: { budget: "off" } }), model()).reasoning)
      .toEqual({ effort: "none" });
    expect(buildChatGptRequest(
      request({ reasoning: { budget: "off" } }),
      model({ reasoningValues: ["low"] }),
    )).not.toHaveProperty("reasoning");
    expectCode(
      () => buildChatGptRequest(request({ reasoning: { budget: "medium" } }), model()),
      "CAPABILITY_UNSUPPORTED",
    );
    expect(buildChatGptRequest(request({ reasoning: { budget: "max" } }), model()).reasoning)
      .toEqual({ effort: "xhigh" });
    expectCode(
      () => buildChatGptRequest(request({ reasoning: { budget: "low", effort: "high" } }), model()),
      "BAD_REQUEST",
    );
    expectCode(
      () => buildChatGptRequest(request({ reasoning: { budget: "max", effort: "low" } }), model()),
      "BAD_REQUEST",
    );
    expectCode(
      () => buildChatGptRequest(
        request({ reasoning: { budget: "max" } }),
        model({ reasoningValues: ["none"], defaultReasoning: "none" }),
      ),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ text: { format: { type: "text" }, verbosity: "high" } }), model({ supportsVerbosity: false })),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ text: { format: { type: "json_schema", name: "out", strict: true, schema: {} } } }), model({ supportsStructuredOutput: false })),
      "CAPABILITY_UNSUPPORTED",
    );
  });

  it("keeps plain completion tool-free and single-turn without dropping supported reasoning", () => {
    expect(buildChatGptRequest(request({ plainCompletion: true }), model())).toMatchObject({
      store: false,
      stream: true,
    });
    expect(buildChatGptRequest(
      request({ plainCompletion: true, reasoning: { budget: "low" } }),
      model(),
    )).toMatchObject({ reasoning: { effort: "low" } });
    expectCode(
      () => buildChatGptRequest(request({ plainCompletion: true, maxAgentTurns: 2 }), model()),
      "CAPABILITY_UNSUPPORTED",
    );
  });

  it("accepts the neutral no-tools denial shape and omits it from the wire", () => {
    const built = buildChatGptRequest(request({
      tools: [],
      toolChoice: "none",
      parallelToolCalls: false,
    }), model());
    expect(built).not.toHaveProperty("tools");
    expect(built).not.toHaveProperty("tool_choice");
    expect(built).not.toHaveProperty("parallel_tool_calls");
    expectCode(
      () => buildChatGptRequest(request({ toolChoice: "auto" }), model()),
      "BAD_REQUEST",
    );
  });

  it("does not invoke array subclasses or coerce request controls", () => {
    class HostileArray extends Array<ProviderRequest["input"][number]> {
      override map(): never {
        throw new Error("secret array method");
      }
    }
    const hostileInput = new HostileArray(request().input[0]!);
    expectCode(() => buildChatGptRequest(request({ input: hostileInput }), model()), "BAD_REQUEST");

    const coercion = {
      toString: () => "auto",
      toJSON: () => ({ injected: true }),
    };
    expectCode(
      () => buildChatGptRequest(request({
        tools: [{
          type: "function",
          name: "lookup",
          description: "",
          parameters: { type: "object", additionalProperties: false },
          strict: true,
        }],
        toolChoice: coercion as never,
      }), model()),
      "BAD_REQUEST",
    );
  });

  it("converts reflective structure failures to a fixed typed error", () => {
    const hostile = new Proxy(request(), {
      ownKeys() {
        throw new Error("secret-reflection-value");
      },
    });
    let failure: unknown;
    try {
      buildChatGptRequest(hostile, model());
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "BAD_REQUEST" });
    expect(String(failure)).toBe("ChatGptRequestError: BAD_REQUEST: invalid request structure");
    expect(String(failure)).not.toContain("secret-reflection-value");
  });

  it("validates strict JSON schemas and requires a tool-loop context for results", () => {
    const normalized = buildChatGptRequest(request({
      tools: [{
        type: "function",
        name: "lookup",
        description: "",
        parameters: { type: "object", properties: {} },
        strict: true,
      }],
    }), model());
    expect((normalized.tools![0] as { parameters: unknown }).parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });

    const nested = buildChatGptRequest(request({
      text: { format: {
        type: "json_schema", name: "nested", strict: true,
        schema: {
          type: "object",
          properties: {
            child: {
              type: "object", properties: { value: { type: "string" } }, required: ["value"],
            },
          },
          required: ["child"],
        },
      } },
    }), model());
    const nestedSchema = (nested.text!.format as { schema: {
      additionalProperties: boolean;
      properties: { child: { additionalProperties: boolean } };
    } }).schema;
    expect(nestedSchema.additionalProperties).toBe(false);
    expect(nestedSchema.properties.child.additionalProperties).toBe(false);

    const invalidChildren: ProviderJsonObject[] = [
      { type: "object", properties: { value: { type: "string" } } },
      { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: true },
      { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] },
    ];
    for (const child of invalidChildren) {
      expectCode(() => buildChatGptRequest(request({
        text: { format: {
          type: "json_schema", name: "invalid_nested", strict: true,
          schema: { type: "object", properties: { child }, required: ["child"] },
        } },
      }), model()), "BAD_REQUEST");
    }

    expectCode(() => buildChatGptRequest(request({
      tools: [{
        type: "function",
        name: "lookup",
        description: "",
        parameters: { type: "not-a-json-schema-type" },
        strict: true,
      }],
    }), model()), "BAD_REQUEST");
    expectCode(() => buildChatGptRequest(request({
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    }), model()), "BAD_REQUEST");
    expectCode(() => buildChatGptRequest(request({
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
      tools: [{
        type: "function", name: "lookup", description: "",
        parameters: { type: "object", additionalProperties: false }, strict: true,
      }],
    }), model()), "BAD_REQUEST");
  });

  it("preserves explicit history and admits only parser-compatible continuation identifiers", () => {
    const history: ProviderRequest["input"] = [{
      type: "message", role: "assistant", content: [{ type: "input_text", text: "prior" }],
    }];
    expect(buildChatGptRequest(request({ input: history }), model()).input).toEqual(history);
    expect(buildChatGptRequest(request({
      input: history,
      continuation: { token: "resp_valid_123" },
    }), model()).previous_response_id).toBe("resp_valid_123");
    for (const token of ["resp with spaces", "resp.with.dot", "resp/with/slash", "é", "a".repeat(257)]) {
      expectCode(() => buildChatGptRequest(request({
        continuation: { token },
      }), model()), "BAD_REQUEST");
    }
  });

  it("classifies unknown catalogue modalities as unsupported at the request boundary", () => {
    expectCode(
      () => buildChatGptRequest(request(), model({ inputModalities: [] })),
      "CAPABILITY_UNSUPPORTED",
    );
  });

  it("keeps cache modes closed and capability-bound", () => {
    expect(buildChatGptRequest(request({ cache: { mode: "none" } }), model()))
      .not.toHaveProperty("prompt_cache_key");
    expect(buildChatGptRequest(
      request({ cache: { mode: "implicit", key: "cache-v1" } }),
      model({ supportsPromptCacheOptions: false }),
    )).toMatchObject({ prompt_cache_key: "cache-v1" });
    expectCode(
      () => buildChatGptRequest(request({ cache: { mode: "explicit", key: "cache-v1" } }), model({ supportsPromptCacheOptions: false })),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ cache: { mode: "implicit" } }), model()),
      "BAD_REQUEST",
    );
  });

  it("rejects unsafe JSON values, accessors and oversized bodies without reading secrets", () => {
    const getter = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(getter, "type", { get: () => { throw new Error("secret getter"); }, enumerable: true });
    expectCode(
      () => buildChatGptRequest(request({ tools: [{
        type: "function",
        name: "lookup",
        description: "",
        parameters: getter as never,
        strict: true,
      }] }), model()),
      "BAD_REQUEST",
    );

    expectCode(
      () => buildChatGptRequest(request({ text: {
        format: { type: "json_schema", name: "out", strict: true, schema: { multipleOf: Number.NaN } },
      } }), model()),
      "BAD_REQUEST",
    );
    expectCode(
      () => buildChatGptRequest(request({ instructions: "x".repeat(1024 * 1024) }), model()),
      "BAD_REQUEST",
    );
  });

  it("never emits API-key, fallback, metadata, or provider process fields", () => {
    const serialized = JSON.stringify(buildChatGptRequest(request(), model()));
    for (const forbidden of ["api_key", "authorization", "metadata", "background", "service_tier", "temperature", "top_p", "cwd", "hostTools"] ) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
