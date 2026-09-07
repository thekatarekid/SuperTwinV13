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

  it("records cancellation when abort makes reader cancellation reject", async () => {
    const request = new AbortController();
    let readerCancellationAttempted = false;
    const encoded = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "first" })}\n\n`,
    );
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        readerCancellationAttempted = true;
        throw new DOMException("request aborted", "AbortError");
      },
    }));
    const evidence = await consumeBoundedSse(response, {
      stopAfterFirstSubstantiveDelta: true,
      onFirstSubstantiveDelta: () => request.abort(),
      isRequestAborted: () => request.signal.aborted,
    });
    expect(request.signal.aborted).toBe(true);
    expect(readerCancellationAttempted).toBe(true);
    expect(evidence).toMatchObject({ stoppedEarly: true, substantiveOutput: true });
  });

  it("does not hide a non-abort reader cancellation failure", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "first" })}\n\n`,
        ));
      },
      cancel() {
        throw new Error("unrelated reader failure");
      },
    }));
    await expect(consumeBoundedSse(response, {
      stopAfterFirstSubstantiveDelta: true,
      onFirstSubstantiveDelta: () => undefined,
      isRequestAborted: () => false,
    })).rejects.toThrow(/reader cancellation failed/);
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
      restrictionSignal: false,
    });
  });

  it("flags account and rate-limit stop signals without retaining their text", async () => {
    const evidence = await consumeBoundedSse(responseFor([{
      type: "error",
      error: { code: "rate_limit_exceeded", message: "sensitive account detail" },
    }]));
    expect(evidence.restrictionSignal).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("sensitive account detail");
  });

  it("returns text and exact-schema validation facts without retaining output content", async () => {
    const rawText = '{"ok":true}';
    const evidence = await consumeBoundedSse(responseFor([
      { type: "response.output_text.delta", delta: rawText.slice(0, 6) },
      { type: "response.output_text.delta", delta: rawText.slice(6) },
      { type: "response.completed", response: { usage: {} } },
    ]));
    expect(evidence).toMatchObject({
      outputTextBytes: Buffer.byteLength(rawText, "utf8"),
      substantiveOutput: true,
      outputJsonValid: true,
      outputJsonObject: true,
      outputMatchesExactOkBooleanSchema: true,
      usagePresent: true,
    });
    expect(JSON.stringify(evidence)).not.toContain(rawText);
    expect(JSON.stringify(evidence)).not.toContain('"ok":true');
  });

  it("distinguishes valid JSON and object shape from the exact ok:boolean schema", async () => {
    const arrayEvidence = await consumeBoundedSse(responseFor([
      { type: "response.output_text.done", text: "[true]" },
    ]));
    expect(arrayEvidence).toMatchObject({
      outputJsonValid: true,
      outputJsonObject: false,
      outputMatchesExactOkBooleanSchema: false,
    });
    const extraEvidence = await consumeBoundedSse(responseFor([
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: '{"ok":false,"extra":1}' }] } },
    ]));
    expect(extraEvidence).toMatchObject({
      outputJsonValid: true,
      outputJsonObject: true,
      outputMatchesExactOkBooleanSchema: false,
    });
  });

  it("projects safe function-call validation from item, delta, and done shapes without IDs or arguments", async () => {
    const secretId = "call_secret_identifier";
    const secretArguments = '{"value":"sensitive argument"}';
    const evidence = await consumeBoundedSse(responseFor([
      { type: "response.output_item.added", item: { type: "function_call", id: secretId, name: "probe_echo", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: secretId, delta: secretArguments.slice(0, 10) },
      { type: "response.function_call_arguments.done", item_id: secretId, arguments: secretArguments },
      { type: "response.output_item.done", item: { type: "function_call", id: "bad_id", name: "unsafe name!", arguments: "not-json" } },
      { type: "response.output_item.done", item: { type: "function_call", id: "secret_id", name: "acct_secret_123", arguments: "{}" } },
    ]));
    expect(evidence.functionCalls).toEqual([
      { name: "probe_echo", argumentBytes: Buffer.byteLength(secretArguments, "utf8"), argumentsJsonValid: true, argumentsMatchProbeEchoSchema: true },
      { argumentBytes: Buffer.byteLength("not-json", "utf8"), argumentsJsonValid: false, argumentsMatchProbeEchoSchema: false },
      { argumentBytes: 2, argumentsJsonValid: true, argumentsMatchProbeEchoSchema: false },
    ]);
    expect(evidence.invalidFunctionNameCount).toBe(2);
    expect(evidence.substantiveOutput).toBe(true);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(secretId);
    expect(serialized).not.toContain("sensitive argument");
    expect(serialized).not.toContain("unsafe name!");
    expect(serialized).not.toContain("bad_id");
    expect(serialized).not.toContain("acct_secret_123");
  });

  it("reports usage absence explicitly", async () => {
    const evidence = await consumeBoundedSse(responseFor([{ type: "response.completed" }]));
    expect(evidence.usagePresent).toBe(false);
    expect(evidence.usage).toBeUndefined();
  });
});
