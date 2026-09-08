import { describe, expect, it } from "vitest";

import {
  reasoningRequestForResolvedCall,
  resolveReasoningCapability,
} from "./reasoning.js";
import type {
  ProviderId,
  ProviderModel,
  ProviderModelCatalogue,
} from "../providers/types.js";

function model(reasoningValues: string[]): ProviderModel {
  return {
    id: "fixture-model",
    displayName: "Fixture model",
    isDefault: true,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues,
    defaultReasoning: reasoningValues[0] ?? null,
    supportsTools: false,
    supportsHostTools: false,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: null,
    maxOutputTokens: null,
    billingLabel: null,
  };
}

function catalogue(
  providerId: ProviderId,
  entry: ProviderModel,
): ProviderModelCatalogue {
  return {
    providerId,
    mode: "discovered",
    source: "fixture",
    discoveredAt: "2026-09-08T00:00:00.000Z",
    revision: "fixture-revision",
    error: null,
    models: [entry],
  };
}

describe("provider-aware reasoning capability mapping", () => {
  it("admits an exact advertised level", () => {
    const entry = model(["off", "low", "high"]);
    expect(
      resolveReasoningCapability("high", entry, catalogue("claude-local", entry)),
    ).toEqual({ requested: "high", effective: "high", clamped: false });
  });

  it("drops unsupported Claude levels instead of guessing from the model name", () => {
    const entry = { ...model(["off", "low"]), id: "claude-opus-max-sounding" };
    expect(
      resolveReasoningCapability("max", entry, catalogue("claude-local", entry)),
    ).toBeNull();
  });

  it("clamps ChatGPT max to the highest advertised named effort", () => {
    const entry = model(["none", "low", "medium", "high", "xhigh"]);
    expect(
      resolveReasoningCapability("max", entry, catalogue("chatgpt-oauth", entry)),
    ).toEqual({ requested: "max", effective: "xhigh", clamped: true });
  });

  it("does not invent a ChatGPT effort when none is advertised", () => {
    const entry = model(["none"]);
    expect(
      resolveReasoningCapability("max", entry, catalogue("chatgpt-oauth", entry)),
    ).toBeNull();
  });
});

describe("provider-neutral reasoning request projection", () => {
  it("omits reasoning only when the resolved catalogue has no reasoning state", () => {
    expect(reasoningRequestForResolvedCall({ reasoning: null })).toEqual({});
  });

  it("preserves the resolver's exact effective level without Claude flags", () => {
    expect(reasoningRequestForResolvedCall({ reasoning: "high" })).toEqual({
      reasoning: { budget: "high" },
    });
    expect(reasoningRequestForResolvedCall({ reasoning: "off" })).toEqual({
      reasoning: { budget: "off" },
    });
  });
});
