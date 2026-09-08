import { describe, expect, it, vi } from "vitest";

import { classifyFailure } from "../pool.js";
import type { ProviderStreamEvent } from "../types.js";
import {
  ChatGptSseError,
  MAX_SSE_ERROR_BYTES,
  MAX_SSE_EVENT_BYTES,
  MAX_SSE_EVENTS,
  MAX_SSE_LINE_BYTES,
  MAX_SSE_OUTPUT_BYTES,
  MAX_SSE_RESPONSE_BYTES,
  MAX_SSE_TOTAL_TOOL_ARGUMENT_BYTES,
  MAX_SSE_TOOL_ARGUMENT_BYTES,
  MAX_SSE_TOOL_CALLS,
  consumeChatGptSse,
} from "./sse.js";

function eventBlock(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function responseFor(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(eventBlock).join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function responseFromChunks(
  chunks: Uint8Array[],
  onCancel?: () => void,
): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!onCancel) controller.close();
    },
    cancel() {
      onCancel?.();
    },
  }), {
    headers: { "content-type": "text/event-stream" },
  });
}

function capture() {
  const events: ProviderStreamEvent[] = [];
  return {
    events,
    options: { onEvent: (event: ProviderStreamEvent) => events.push(event) },
  };
}

function usage(input = 12, output = 7): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    input_tokens_details: { cached_tokens: 5 },
  };
}

describe("production ChatGPT SSE parsing", () => {
  it("incrementally decodes fragmented Unicode and multiple events per chunk", async () => {
    const wire = [
      eventBlock({ type: "response.created", response: { id: "resp_private_1" } }),
      eventBlock({ type: "response.output_text.delta", delta: "hello 🧠" }),
      eventBlock({ type: "response.output_text.done", text: "hello 🧠" }),
      eventBlock({
        type: "response.completed",
        response: { id: "resp_private_1", usage: usage() },
      }),
    ].join("");
    const bytes = new TextEncoder().encode(wire);
    const emojiStart = bytes.findIndex((value) => value === 0xf0);
    const chunks = [
      bytes.slice(0, 9),
      bytes.slice(9, emojiStart + 1),
      bytes.slice(emojiStart + 1, emojiStart + 3),
      bytes.slice(emojiStart + 3),
    ];
    const sink = capture();
    const result = await consumeChatGptSse(responseFromChunks(chunks), {
      ...sink.options,
      persistContinuation: true,
    });

    expect(result).toEqual({
      continuation: "resp_private_1",
      usage: {
        inputTokens: 12,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 7,
        cachedInputTokens: 5,
      },
      status: "ok",
      stopReason: "completed",
    });
    expect(sink.events).toEqual([
      { type: "delta", text: "hello 🧠" },
      { type: "usage", usage: result.usage },
      { type: "continuation", token: "resp_private_1" },
      { type: "done", continuation: "resp_private_1", usage: result.usage, stopReason: "completed" },
    ]);
  });

  it("omits response identifiers unless continuation was explicitly requested", async () => {
    const sink = capture();
    const result = await consumeChatGptSse(responseFor([
      { type: "response.created", response: { id: "resp_must_not_escape" } },
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { id: "resp_must_not_escape", usage: usage() } },
    ]), sink.options);
    expect(result.continuation).toBeNull();
    expect(JSON.stringify({ result, events: sink.events })).not.toContain("resp_must_not_escape");
  });

  it("maps one allowlisted tool call after bounded incremental JSON assembly", async () => {
    const sink = capture();
    const result = await consumeChatGptSse(responseFor([
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "item_weather_private",
          call_id: "call_weather_1",
          name: "weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_weather_private",
        delta: "{\"city\":",
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "item_weather_private",
        arguments: "{\"city\":\"Pune\"}",
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "item_weather_private",
          call_id: "call_weather_1",
          name: "weather",
          arguments: "{\"city\":\"Pune\"}",
        },
      },
      { type: "response.completed", response: { usage: usage() } },
    ]), { ...sink.options, allowedToolNames: ["weather"] });

    expect(result.status).toBe("ok");
    expect(sink.events.filter((event) => event.type === "tool_use")).toEqual([{
      type: "tool_use",
      callId: "call_weather_1",
      name: "weather",
      input: { city: "Pune" },
    }]);
    expect(JSON.stringify(sink.events)).not.toContain("item_weather_private");
  });

  it("fails closed on an unrequested tool without echoing its name or arguments", async () => {
    const secret = "unrequested_secret_tool";
    const sink = capture();
    let failure: unknown;
    try {
      await consumeChatGptSse(responseFor([{
        type: "response.output_item.done",
        item: { type: "function_call", id: "call_private", name: secret, arguments: "{\"secret\":true}" },
      }]), sink.options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "BACKEND_UNSUPPORTED" });
    expect(JSON.stringify({ failure: String(failure), events: sink.events })).not.toContain(secret);
    expect(JSON.stringify(sink.events)).not.toContain("call_private");
  });

  it("maps refusal to one fixed CLI_ERROR and discards refusal text", async () => {
    const secret = "private refusal explanation";
    const sink = capture();
    const result = await consumeChatGptSse(responseFor([
      { type: "response.refusal.delta", delta: secret.slice(0, 8) },
      { type: "response.refusal.delta", delta: secret.slice(8) },
      { type: "response.refusal.done", refusal: secret },
      { type: "response.completed", response: { usage: usage() } },
    ]), sink.options);
    expect(result).toMatchObject({ status: "error", errorCode: "CLI_ERROR", stopReason: "refusal" });
    const refusalEvent = sink.events.at(-1);
    expect(refusalEvent).toEqual({
      type: "error",
      code: "CLI_ERROR",
      message: "ChatGPT refusal (usage limit or policy)",
    });
    if (refusalEvent?.type !== "error") throw new Error("expected refusal error");
    expect(classifyFailure(refusalEvent, 0)).toMatchObject({
      action: "pause",
      reason: "refusal",
      spendsRetryBudget: false,
    });
    expect(JSON.stringify({ result, events: sink.events })).not.toContain(secret);
  });

  it.each([
    ["rate_limit_exceeded", "RATE_LIMITED"],
    ["insufficient_quota", "QUOTA_EXCEEDED"],
    ["token_expired", "AUTH_EXPIRED"],
    ["invalid_request_error", "BAD_REQUEST"],
    ["server_error", "TRANSPORT_ERROR"],
    ["new_backend_code", "BACKEND_UNSUPPORTED"],
  ] as const)("classifies coded backend failure %s without retaining its body", async (rawCode, code) => {
    const sink = capture();
    const result = await consumeChatGptSse(responseFor([{
      type: "response.failed",
      response: {
        error: { code: rawCode, message: "sensitive provider/account detail" },
        usage: usage(3, 2),
      },
    }]), sink.options);
    expect(result).toMatchObject({ status: "error", errorCode: code, stopReason: "failed" });
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(JSON.stringify({ result, events: sink.events }))
      .not.toContain("sensitive provider/account detail");
  });

  it("maps remote and local cancellation and cancels a pending reader", async () => {
    const remote = capture();
    await expect(consumeChatGptSse(responseFor([{
      type: "response.cancelled",
      error: { message: "private cancellation reason" },
    }]), remote.options)).resolves.toMatchObject({
      status: "error",
      errorCode: "CANCELLED",
    });

    const controller = new AbortController();
    const cancelled = vi.fn();
    const local = capture();
    const pending = consumeChatGptSse(responseFromChunks([
      new TextEncoder().encode(eventBlock({ type: "response.in_progress" })),
    ], cancelled), { ...local.options, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "error", errorCode: "CANCELLED" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(local.events).toEqual([{
      type: "error",
      code: "CANCELLED",
      message: "ChatGPT request cancelled",
    }]);

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    const preAborted = capture();
    await expect(consumeChatGptSse(new Response("private non-SSE body"), {
      ...preAborted.options,
      signal: preAbortedController.signal,
    })).resolves.toMatchObject({ status: "error", errorCode: "CANCELLED" });
  });

  it.each([
    ["malformed JSON", "data: {not-json}\n\n"],
    ["missing type", `data: ${JSON.stringify({ response: { id: "private" } })}\n\n`],
    ["unknown event", eventBlock({ type: "response.new_shape", value: "private" })],
  ])("returns a fixed BACKEND_UNSUPPORTED failure for %s", async (_name, wire) => {
    const sink = capture();
    const response = new Response(wire, { headers: { "content-type": "text/event-stream" } });
    let failure: unknown;
    try {
      await consumeChatGptSse(response, sink.options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ChatGptSseError);
    expect(failure).toMatchObject({ code: "BACKEND_UNSUPPORTED" });
    expect(sink.events).toEqual([{
      type: "error",
      code: "BACKEND_UNSUPPORTED",
      message: "ChatGPT stream format is unsupported",
    }]);
    expect(String(failure)).not.toMatch(/not-json|new_shape|private/);
  });

  it("rejects a truncated stream and invalid UTF-8 as fixed transport errors", async () => {
    const truncated = capture();
    await expect(consumeChatGptSse(responseFor([
      { type: "response.output_text.delta", delta: "partial" },
    ]), truncated.options)).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });

    const invalid = capture();
    const prefix = new TextEncoder().encode("data: ");
    const bytes = new Uint8Array([...prefix, 0xc3, 0x28, 0x0a, 0x0a]);
    await expect(consumeChatGptSse(responseFromChunks([bytes]), invalid.options))
      .rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  });

  it.each([
    [
      "line",
      () => `data: ${"x".repeat(MAX_SSE_LINE_BYTES)}\n\n`,
      /line limit|event limit/,
    ],
    [
      "event",
      () => {
        const half = "x".repeat(Math.floor(MAX_SSE_EVENT_BYTES / 2));
        return `data: ${half}\ndata: ${half}\n\n`;
      },
      /event limit/,
    ],
    [
      "error",
      () => eventBlock({ type: "error", error: { message: "x".repeat(MAX_SSE_ERROR_BYTES) } }),
      /error payload limit/,
    ],
  ] as const)("enforces the %s byte cap", async (_name, makeWire, message) => {
    const sink = capture();
    await expect(consumeChatGptSse(
      new Response(makeWire(), { headers: { "content-type": "text/event-stream" } }),
      sink.options,
    )).rejects.toThrow(message);
  });

  it("enforces independent accumulated output and tool-argument caps", async () => {
    const outputSink = capture();
    const outputChunk = "x".repeat(60 * 1024);
    const outputEvents = Array.from(
      { length: Math.ceil(MAX_SSE_OUTPUT_BYTES / outputChunk.length) + 1 },
      () => ({ type: "response.output_text.delta", delta: outputChunk }),
    );
    await expect(consumeChatGptSse(responseFor(outputEvents), outputSink.options))
      .rejects.toThrow(/output limit/);

    const toolSink = capture();
    const argumentChunk = "x".repeat(60 * 1024);
    const toolEvents: Array<Record<string, unknown>> = [{
      type: "response.output_item.added",
      item: { type: "function_call", id: "call_oversized", name: "weather", arguments: "" },
    }];
    for (let i = 0; i <= Math.ceil(MAX_SSE_TOOL_ARGUMENT_BYTES / argumentChunk.length); i += 1) {
      toolEvents.push({
        type: "response.function_call_arguments.delta",
        item_id: "call_oversized",
        delta: argumentChunk,
      });
    }
    await expect(consumeChatGptSse(responseFor(toolEvents), {
      ...toolSink.options,
      allowedToolNames: ["weather"],
    })).rejects.toThrow(/tool-argument limit/);

    const totalSink = capture();
    const perTool = Math.floor(MAX_SSE_TOTAL_TOOL_ARGUMENT_BYTES / 5) + 1;
    const totalEvents: Array<Record<string, unknown>> = [];
    for (let tool = 0; tool < 5; tool += 1) {
      const itemId = `item_total_${tool}`;
      totalEvents.push({
        type: "response.output_item.added",
        item: { type: "function_call", id: itemId, name: "weather", arguments: "" },
      });
      let remaining = perTool;
      while (remaining > 0) {
        const size = Math.min(60 * 1024, remaining);
        totalEvents.push({
          type: "response.function_call_arguments.delta",
          item_id: itemId,
          delta: "x".repeat(size),
        });
        remaining -= size;
      }
    }
    await expect(consumeChatGptSse(responseFor(totalEvents), {
      ...totalSink.options,
      allowedToolNames: ["weather"],
    })).rejects.toThrow(/tool-argument limit/);
  });

  it("enforces the raw response cap independently of line and event limits", async () => {
    const sink = capture();
    const heartbeat = `: ${"x".repeat(60 * 1024)}\n\n`;
    const wire = heartbeat.repeat(Math.ceil(MAX_SSE_RESPONSE_BYTES / Buffer.byteLength(heartbeat)) + 1);
    await expect(consumeChatGptSse(
      new Response(wire, { headers: { "content-type": "text/event-stream" } }),
      sink.options,
    )).rejects.toThrow(/response limit/);
  });

  it("enforces independent event-count and tool-count caps", async () => {
    const eventSink = capture();
    const eventWire = `${eventBlock({ type: "response.in_progress" })}`.repeat(MAX_SSE_EVENTS + 1);
    await expect(consumeChatGptSse(
      new Response(eventWire, { headers: { "content-type": "text/event-stream" } }),
      eventSink.options,
    )).rejects.toThrow(/event-count limit/);

    const toolSink = capture();
    const toolEvents = Array.from({ length: MAX_SSE_TOOL_CALLS + 1 }, (_, index) => ({
      type: "response.output_item.added",
      item: { type: "function_call", id: `call_${index}`, name: "weather", arguments: "{}" },
    }));
    await expect(consumeChatGptSse(responseFor(toolEvents), {
      ...toolSink.options,
      allowedToolNames: ["weather"],
    })).rejects.toThrow(/tool-call limit/);
  });

  it("rejects non-SSE content without reading or reflecting its body", async () => {
    const sink = capture();
    const secret = "private non-SSE backend body";
    await expect(consumeChatGptSse(new Response(secret, {
      headers: { "content-type": "application/json" },
    }), sink.options)).rejects.toMatchObject({ code: "BACKEND_UNSUPPORTED" });
    expect(JSON.stringify(sink.events)).not.toContain(secret);
  });
});
