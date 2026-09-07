import { describe, expect, it } from "vitest";

import {
  consumeBoundedSse,
  MAX_SSE_EVENT_BYTES,
  MAX_SSE_LINE_BYTES,
} from "./sse.js";

function responseFor(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

describe("bounded Codex SSE evidence", () => {
  it("cancels only after the first substantive text delta, not lifecycle events", async () => {
    const evidence = await consumeBoundedSse(
      responseFor([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.added", item: { type: "message" } },
        { type: "response.output_text.delta", delta: "hello" },
        { type: "response.completed", response: { id: "resp_1" } },
      ]),
      { stopAfterFirstSubstantiveDelta: true },
    );
    expect(evidence.stoppedEarly).toBe(true);
    expect(evidence.eventTypes).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
    ]);
    expect(evidence).toMatchObject({ terminal: false, completed: false, incomplete: false, failed: false, error: false });
  });

  it("treats a function argument delta as substantive and preserves duplicate event types in order", async () => {
    const evidence = await consumeBoundedSse(
      responseFor([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: "a" },
        { type: "response.output_text.delta", delta: "b" },
        { type: "response.function_call_arguments.delta", delta: "{\"x\":" },
        { type: "response.completed" },
      ]),
    );
    expect(evidence.eventTypes).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.function_call_arguments.delta",
      "response.completed",
    ]);
  });

  it("rejects an oversized line even when its delimiter arrives in the same chunk", async () => {
    const oversized = `data: ${"x".repeat(MAX_SSE_LINE_BYTES)}\n\n`;
    await expect(consumeBoundedSse(new Response(oversized))).rejects.toThrow(/line limit|event limit/);
  });

  it("rejects an oversized multi-line event whose individual lines remain bounded", async () => {
    const half = "x".repeat(Math.floor(MAX_SSE_EVENT_BYTES / 2));
    const oversizedEvent = `data: ${half}\ndata: ${half}\n\n`;
    await expect(consumeBoundedSse(new Response(oversizedEvent))).rejects.toThrow(/event limit/);
  });

  it("projects only allowlisted top-level and nested usage counters", async () => {
    const evidence = await consumeBoundedSse(responseFor([{
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3, secret: 99 },
          output_tokens_details: { reasoning_tokens: 4, hidden: 88 },
          arbitrary_tokens: 1_000,
        },
      },
    }]));
    expect(evidence.usage).toEqual({
      inputTokens: 10,
      outputTokens: 6,
      totalTokens: 16,
      cachedInputTokens: 7,
      reasoningTokens: 4,
      cacheWriteInputTokens: 3,
    });
    expect(JSON.stringify(evidence.usage)).not.toContain("secret");
    expect(JSON.stringify(evidence.usage)).not.toContain("arbitrary");
  });

  it("sets explicit incomplete, failed, and error flags", async () => {
    const evidence = await consumeBoundedSse(responseFor([
      { type: "response.incomplete" },
      { type: "response.failed" },
      { type: "error", error: { message: "not retained" } },
    ]));
    expect(evidence).toMatchObject({
      terminal: true,
      completed: false,
      incomplete: true,
      failed: true,
      error: true,
    });
  });
});
