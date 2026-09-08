import { describe, expect, it } from "vitest";

import type { ResolvedModelCall } from "../providers/selection.js";
import type { ProviderV2 } from "../providers/types.js";
import { assertMediaModalityContract } from "./modality-guard.js";

function resolved(
  providerId: "claude-local" | "chatgpt-oauth",
  modalities: Array<"text" | "image">,
  supportsHostTools = providerId === "claude-local",
): ResolvedModelCall {
  const provider = { id: providerId, capabilities: { hostTools: providerId === "claude-local" } } as ProviderV2;
  return {
    providerId, provider, key: "media", model: "fixture", reasoning: null, catalogueRevision: "r1",
    modelSnapshot: {
      id: "fixture", displayName: "fixture", isDefault: true, hidden: false, inputModalities: modalities,
      reasoningValues: [], defaultReasoning: null, supportsTools: false,
      supportsHostTools, supportsParallelToolCalls: false,
      supportsStructuredOutput: false, supportsStrictTools: false, supportsVerbosity: false,
      supportsPromptCacheKey: false, supportsPromptCacheOptions: false,
      contextWindow: 100_000, maxOutputTokens: 4_096, billingLabel: null,
    },
  };
}

describe("P4b-C immutable modality guard", () => {
  it("requires both text and image for ChatGPT media", () => {
    expect(() => assertMediaModalityContract(resolved("chatgpt-oauth", ["text", "image"]), ["image"]))
      .not.toThrow();
    for (const modalities of [[], ["text"], ["image"]] as Array<Array<"text" | "image">>) {
      expect(() => assertMediaModalityContract(resolved("chatgpt-oauth", modalities), ["image"]))
        .toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    }
  });

  it("rejects documents, mixed batches, empties, and over-limit batches", () => {
    const call = resolved("chatgpt-oauth", ["text", "image"]);
    for (const kinds of [
      ["document"], ["image", "document"], [], Array.from({ length: 33 }, () => "image"),
    ] as Array<Array<"image" | "document">>) {
      expect(() => assertMediaModalityContract(call, kinds))
        .toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    }
  });

  it("keeps Claude on its own host-Read capability with no provider fallback", () => {
    expect(() => assertMediaModalityContract(resolved("claude-local", ["text"]), ["document"])).not.toThrow();
    expect(() => assertMediaModalityContract(resolved("claude-local", ["text"], false), ["image"]))
      .toThrow(expect.objectContaining({ providerId: "claude-local", code: "CAPABILITY_UNSUPPORTED" }));
  });
});
