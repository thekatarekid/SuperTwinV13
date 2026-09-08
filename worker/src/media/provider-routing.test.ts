import { describe, expect, it } from "vitest";

import type { ResolvedModelCall } from "../providers/selection.js";
import { ProviderSelectionError } from "../providers/selection.js";
import type { ProviderV2 } from "../providers/types.js";
import { routeMediaProvider } from "./provider-routing.js";

function resolved(
  providerId: "claude-local" | "chatgpt-oauth",
  overrides: Partial<ResolvedModelCall["modelSnapshot"]> = {},
): ResolvedModelCall {
  const provider = {
    id: providerId,
    displayName: providerId,
    capabilities: {
      functionTools: true,
      hostTools: providerId === "claude-local",
      continuation: true,
      requiresAuthentication: providerId === "chatgpt-oauth",
    },
  } as ProviderV2;
  return {
    providerId,
    provider,
    key: "media",
    model: providerId === "claude-local" ? "claude-sonnet" : "gpt-5.6-sol",
    reasoning: null,
    catalogueRevision: "immutable-r1",
    modelSnapshot: {
      id: providerId === "claude-local" ? "claude-sonnet" : "gpt-5.6-sol",
      displayName: "fixture",
      isDefault: true,
      hidden: false,
      inputModalities: providerId === "claude-local" ? ["text"] : ["text", "image"],
      reasoningValues: [],
      defaultReasoning: null,
      supportsTools: true,
      supportsHostTools: providerId === "claude-local",
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsStrictTools: false,
      supportsVerbosity: false,
      supportsPromptCacheKey: false,
      supportsPromptCacheOptions: false,
      contextWindow: 200_000,
      maxOutputTokens: 4_096,
      billingLabel: null,
      ...overrides,
    },
  };
}

describe("P4b-A media provider routing", () => {
  it("routes Claude only through the host Read capability", () => {
    expect(routeMediaProvider(resolved("claude-local"), "image").kind)
      .toBe("claude-host-read");
    expect(() => routeMediaProvider(
      resolved("claude-local", { supportsHostTools: false }),
      "image",
    )).toThrowError(ProviderSelectionError);
  });

  it("routes an account-visible ChatGPT image model to data URLs", () => {
    const call = resolved("chatgpt-oauth");
    const route = routeMediaProvider(call, "image");
    expect(route).toEqual({ kind: "chatgpt-data-url", resolved: call });
  });

  it("fails sparse/unsupported ChatGPT modalities closed", () => {
    for (const inputModalities of [[], ["text"]] as const) {
      try {
        routeMediaProvider(resolved("chatgpt-oauth", { inputModalities }), "image");
        throw new Error("expected capability refusal");
      } catch (error) {
        expect(error).toMatchObject({
          code: "CAPABILITY_UNSUPPORTED",
          providerId: "chatgpt-oauth",
          model: "gpt-5.6-sol",
        });
      }
    }
  });

  it("never routes ChatGPT documents to Claude as a fallback", () => {
    expect(() => routeMediaProvider(resolved("chatgpt-oauth"), "document"))
      .toThrowError(/does not advertise document input/);
  });

  it("uses the captured model snapshot, not later mutable provider metadata", () => {
    const call = resolved("chatgpt-oauth", { inputModalities: ["text"] });
    // Even if a provider method would now claim image support, routing reads
    // only the catalogue revision captured in `modelSnapshot`.
    call.provider.catalogue = () => ({
      providerId: "chatgpt-oauth",
      mode: "discovered",
      source: "later",
      discoveredAt: "later",
      revision: "later-r2",
      error: null,
      models: [{
        ...call.modelSnapshot,
        inputModalities: ["text", "image"],
        reasoningValues: [...call.modelSnapshot.reasoningValues],
      }],
    });
    expect(() => routeMediaProvider(call, "image"))
      .toThrowError(/does not advertise image input/);
  });
});
