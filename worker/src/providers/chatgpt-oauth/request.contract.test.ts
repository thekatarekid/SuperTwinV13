import { describe, expect, it, vi } from "vitest";

import type { ProviderModel, ProviderRequest, ThinkingBudget } from "../types.js";
import { buildChatGptRequest, ChatGptRequestError } from "./request.js";

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "gpt-contract",
    displayName: "GPT Contract",
    isDefault: true,
    hidden: false,
    inputModalities: ["text", "image"],
    reasoningValues: ["none", "low", "medium", "high", "xhigh"],
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
    runId: "contract-1",
    model: "gpt-contract",
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

function expectCode(
  operation: () => unknown,
  code: ChatGptRequestError["code"],
): void {
  try {
    operation();
    throw new Error("expected request failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptRequestError);
    expect((error as ChatGptRequestError).code).toBe(code);
  }
}

describe("P4-D core and input contract", () => {
  it("pins the minimum body and prevents caller overrides of wire constants", () => {
    expect(buildChatGptRequest(request(), model())).toEqual({
      model: "gpt-contract",
      instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      max_output_tokens: 512,
      store: false,
      stream: true,
    });
    for (const forbidden of [
      { store: true }, { stream: false }, { api_key: "secret" }, { metadata: {} },
    ]) {
      expectCode(() => buildChatGptRequest({ ...request(), ...forbidden } as ProviderRequest, model()), "BAD_REQUEST");
    }
  });

  it("preserves text, image and explicit assistant-history items in order", () => {
    const input: ProviderRequest["input"] = [
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "prior" }] },
      {
        type: "message", role: "user", content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
          { type: "input_image", image_url: "data:image/jpeg;base64,AA==", detail: "low" },
          { type: "input_image", image_url: "data:image/webp;base64,AA==", detail: "high" },
        ],
      },
    ];
    expect(buildChatGptRequest(request({ input }), model()).input).toEqual(input);
  });

  it("requires every neutral core field and capability-binds output/continuation", () => {
    for (const field of [
      "runId", "model", "instructions", "input", "maxOutputTokens", "maxAgentTurns", "onEvent",
    ] as const) {
      const candidate = { ...request() } as Record<string, unknown>;
      delete candidate[field];
      expectCode(() => buildChatGptRequest(candidate as unknown as ProviderRequest, model()), "BAD_REQUEST");
    }
    expect(buildChatGptRequest(request(), model({ maxOutputTokens: null })))
      .not.toHaveProperty("max_output_tokens");
    expectCode(
      () => buildChatGptRequest(request({ continuation: { token: "resp_valid_1" } }), model()),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ continuation: { token: "resp.invalid" } }), model()),
      "CAPABILITY_UNSUPPORTED",
    );
  });
});

describe("P4-D tools contract", () => {
  const tool = {
    type: "function" as const,
    name: "lookup",
    description: "",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true as const,
  };

  it("maps every tool choice and parallel value only beside strict tools", () => {
    for (const toolChoice of ["none", "auto", "required"] as const) {
      for (const parallelToolCalls of [false, true]) {
        expect(buildChatGptRequest(request({ tools: [tool], toolChoice, parallelToolCalls }), model()))
          .toMatchObject({ tools: [tool], tool_choice: toolChoice, parallel_tool_calls: parallelToolCalls });
      }
    }
    expect(buildChatGptRequest(request({ tools: [] }), model())).not.toHaveProperty("tools");
  });

  it("rejects invalid, duplicate, unavailable and unbound tool shapes", () => {
    expectCode(
      () => buildChatGptRequest(request({ tools: [{ ...tool, strict: false } as never] }), model()),
      "BAD_REQUEST",
    );
    expectCode(() => buildChatGptRequest(request({ tools: [tool, tool] }), model()), "BAD_REQUEST");
    expectCode(
      () => buildChatGptRequest(request({ tools: [tool] }), model({ supportsTools: false })),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ tools: [tool], parallelToolCalls: true }),
        model({ supportsParallelToolCalls: false })),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({
        tools: [tool],
        input: [{ type: "function_call_output", call_id: "call-1", output: "done" }],
      }), model()),
      "BAD_REQUEST",
    );
    expectCode(() => buildChatGptRequest(request({
      tools: [tool],
      input: [{ type: "function_call_output", call_id: "call-1", output: "done" }],
      continuation: { token: "resp_tool_1" },
    }), model()), "CAPABILITY_UNSUPPORTED");
  });
});

describe("P4-D reasoning contract", () => {
  it("maps the total SuperTwin ladder deterministically", () => {
    const expected: Array<[ThinkingBudget, string | undefined]> = [
      ["off", "none"], ["low", "low"], ["medium", "medium"],
      ["high", "high"], ["xhigh", "xhigh"], ["max", "xhigh"],
    ];
    for (const [budget, effort] of expected) {
      expect(buildChatGptRequest(request({ reasoning: { budget } }), model()).reasoning?.effort)
        .toBe(effort);
    }
    expect(buildChatGptRequest(request({ reasoning: { budget: "max" } }), model({
      reasoningValues: ["minimal"], defaultReasoning: "minimal",
    })).reasoning?.effort).toBe("minimal");
    expect(buildChatGptRequest(request({ reasoning: { budget: "off" } }),
      model({ reasoningValues: ["low"], defaultReasoning: "low" }))).not.toHaveProperty("reasoning");
  });

  it("rejects unsupported values and caller attempts to remap effort", () => {
    expectCode(
      () => buildChatGptRequest(request({ reasoning: { budget: "medium" } }),
        model({ reasoningValues: ["none", "low"], defaultReasoning: "low" })),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ reasoning: { budget: "low", effort: "high" } }), model()),
      "BAD_REQUEST",
    );
    expectCode(
      () => buildChatGptRequest(request({ reasoning: { budget: "max", effort: "low" } }), model()),
      "BAD_REQUEST",
    );
  });
});

describe("P4-D text and strict-schema contract", () => {
  it("maps plain text and every supported verbosity value", () => {
    expect(buildChatGptRequest(request({ text: { format: { type: "text" } } }), model()).text)
      .toEqual({ format: { type: "text" } });
    for (const verbosity of ["low", "medium", "high"] as const) {
      expect(buildChatGptRequest(request({ text: { format: { type: "text" }, verbosity } }), model()).text)
        .toEqual({ format: { type: "text" }, verbosity });
    }
    expectCode(
      () => buildChatGptRequest(request({ text: { format: { type: "text" }, verbosity: "low" } }),
        model({ supportsVerbosity: false })),
      "CAPABILITY_UNSUPPORTED",
    );
  });

  it("emits recursively closed strict JSON and rejects incomplete object schemas", () => {
    const text = buildChatGptRequest(request({
      text: { format: {
        type: "json_schema", name: "result", strict: true,
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
    }), model()).text as { format: { schema: Record<string, unknown> } };
    expect(text.format.schema).toMatchObject({
      additionalProperties: false,
      properties: { child: { additionalProperties: false } },
    });
    expectCode(() => buildChatGptRequest(request({
      text: { format: {
        type: "json_schema", name: "result", strict: true,
        schema: { type: "object", properties: { value: { type: "string" } } },
      } },
    }), model()), "BAD_REQUEST");
  });
});

describe("P4-D cache contract", () => {
  it("keeps none absent and maps verified implicit/explicit values", () => {
    expect(buildChatGptRequest(request(), model())).not.toHaveProperty("prompt_cache_key");
    expect(buildChatGptRequest(request({ cache: { mode: "none" } }), model()))
      .not.toHaveProperty("prompt_cache_options");
    expect(buildChatGptRequest(request({ cache: { mode: "implicit", key: "stable-v1" } }), model()))
      .toMatchObject({
        prompt_cache_key: "stable-v1",
        prompt_cache_options: { mode: "implicit", ttl: "30m" },
      });
    expect(buildChatGptRequest(request({
      cache: { mode: "explicit", key: "stable-v1", ttl: "30m" },
    }), model())).toMatchObject({
      prompt_cache_key: "stable-v1",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
    });
  });

  it("rejects unsafe keys, invalid TTLs and unavailable cache capabilities", () => {
    expectCode(
      () => buildChatGptRequest(request({ cache: { mode: "implicit", key: "user@example.com" } }), model()),
      "BAD_REQUEST",
    );
    expectCode(
      () => buildChatGptRequest(request({ cache: { mode: "explicit", key: "stable", ttl: "1h" as never } }), model()),
      "BAD_REQUEST",
    );
    expectCode(
      () => buildChatGptRequest(request({ cache: { mode: "none", key: "stable" } as never }), model()),
      "BAD_REQUEST",
    );
    expectCode(
      () => buildChatGptRequest(request({ cache: { mode: "implicit", key: "stable" } }),
        model({ supportsPromptCacheKey: false })),
      "CAPABILITY_UNSUPPORTED",
    );
    expectCode(
      () => buildChatGptRequest(request({ cache: { mode: "explicit", key: "stable" } }),
        model({ supportsPromptCacheOptions: false })),
      "CAPABILITY_UNSUPPORTED",
    );
  });
});
