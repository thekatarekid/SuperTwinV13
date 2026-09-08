import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_MAX_CONTENT_ITEMS,
  CHATGPT_MAX_INPUT_ITEMS,
  CHATGPT_MAX_REQUEST_BYTES,
  buildChatGptRequest,
} from "../providers/chatgpt-oauth/request.js";
import type { ProviderModel, ProviderRequest } from "../providers/types.js";

const model = (inputModalities: Array<"text" | "image"> = ["text", "image"]): ProviderModel => ({
  id: "gpt-media", displayName: "GPT Media", isDefault: true, hidden: false,
  inputModalities, reasoningValues: [], defaultReasoning: null,
  supportsTools: false, supportsHostTools: false, supportsParallelToolCalls: false,
  supportsStructuredOutput: false, supportsStrictTools: false, supportsVerbosity: false,
  supportsPromptCacheKey: false, supportsPromptCacheOptions: false,
  contextWindow: 100_000, maxOutputTokens: 4_096, billingLabel: "ChatGPT subscription",
});

const image = { type: "input_image" as const, image_url: "data:image/png;base64,aA==", detail: "low" as const };
const text = { type: "input_text" as const, text: "caption this" };
const request = (content: Array<typeof image | typeof text> = [text, image]): ProviderRequest => ({
  runId: "media-contract", model: "gpt-media", instructions: "", input: [{ type: "message", role: "user", content }],
  toolChoice: "none", maxOutputTokens: 1_024, maxAgentTurns: 1, onEvent: () => undefined,
});

describe("P4b-C media modality contract", () => {
  it("accepts one bounded mixed text/image message and preserves order", () => {
    expect(buildChatGptRequest(request(), model()).input).toEqual([{
      type: "message", role: "user", content: [text, image],
    }]);
  });

  it("fails missing image capability before transport and never falls back", () => {
    const fetchSpy = vi.fn();
    expect(() => {
      const body = buildChatGptRequest(request(), model(["text"]));
      fetchSpy(body);
    }).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["remote URL", "https://example.com/private.png"],
    ["local path", "file:///tmp/private.png"],
    ["empty image", "data:image/png;base64,"],
    ["oversized image", `data:image/png;base64,${"A".repeat(CHATGPT_MAX_REQUEST_BYTES)}`],
  ])("rejects %s at the image boundary", (_label, image_url) => {
    expect(() => buildChatGptRequest(request([{ ...image, image_url }]), model())).toThrow();
  });

  it("closes every request collection bound", () => {
    const content = Array.from({ length: CHATGPT_MAX_CONTENT_ITEMS + 1 }, () => text);
    expect(() => buildChatGptRequest(request(content), model())).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    const tooManyInputs = {
      ...request(),
      input: Array.from({ length: CHATGPT_MAX_INPUT_ITEMS + 1 }, () => request().input[0]!),
    };
    expect(() => buildChatGptRequest(tooManyInputs, model())).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
});
