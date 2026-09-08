import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_ACCOUNT_MODELS_URL,
  chatGptProviderCatalogue,
  discoverChatGptAccountModels,
  normalizeChatGptModelCatalogue,
} from "./models.js";
import {
  providerCatalogueCacheKey,
  type ProviderCatalogueStore,
} from "../catalogue.js";

const at = (iso = "2026-09-08T10:00:00.000Z") => () => new Date(iso);

function memoryStore(): ProviderCatalogueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
  };
}

describe("ChatGPT account model catalogue", () => {
  it("fetches the fixed account endpoint once with one coherent auth snapshot", async () => {
    const authorization = vi.fn(async () => ({ accessToken: "access-secret", accountId: "account-safe" }));
    const fetchSpy = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({
      default_model: "gpt-safe",
      models: [{ slug: "gpt-safe", input_modalities: ["text"] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const payload = await discoverChatGptAccountModels({
      session: { authorization }, fetch: fetchSpy as unknown as typeof fetch,
      userAgent: "SuperTwinV13/13.12.2",
    });
    expect(payload).toMatchObject({ default_model: "gpt-safe" });
    expect(authorization).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(CHATGPT_ACCOUNT_MODELS_URL);
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init!.headers).toMatchObject({
      Authorization: "Bearer access-secret",
      "ChatGPT-Account-ID": "account-safe",
      originator: "supertwinv13",
    });
  });

  it("bounds discovery and never retries a failed metadata response", async () => {
    const fetchSpy = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response("x".repeat(1024 * 1024 + 1), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(discoverChatGptAccountModels({
      session: { authorization: async () => ({ accessToken: "access", accountId: "account" }) },
      fetch: fetchSpy as unknown as typeof fetch,
      userAgent: "SuperTwinV13/13.12.2",
    })).rejects.toThrow("ChatGPT model discovery failed");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("times out stalled authorization before fetch and ignores its late resolution", async () => {
    let resolveAuthorization!: (value: { accessToken: string; accountId: string }) => void;
    const authorization = new Promise<{ accessToken: string; accountId: string }>((resolve) => {
      resolveAuthorization = resolve;
    });
    const fetchSpy = vi.fn(async () => new Response("{}", {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(discoverChatGptAccountModels({
      session: { authorization: () => authorization },
      fetch: fetchSpy as unknown as typeof fetch,
      userAgent: "SuperTwinV13/13.12.2",
      timeoutMs: 10,
    })).rejects.toBeDefined();
    resolveAuthorization({ accessToken: "late", accountId: "late" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes explicit account-visible capabilities without price data", () => {
    const catalogue = normalizeChatGptModelCatalogue({
      default_model: "gpt-safe",
      models: [{
        slug: "gpt-safe",
        display_name: "Restricted Preview Model",
        description: "must not enter normalized output",
        input_modalities: ["image", "audio", "text", "image"],
        supported_reasoning_efforts: ["high", "invalid", "low", "high"],
        default_reasoning_effort: "high",
        max_output_tokens: 8192,
        context_window: 200_000,
        supports_tools: true,
        supports_parallel_tool_calls: true,
        supports_structured_output: true,
        supports_strict_tools: true,
        supports_verbosity: true,
        supports_prompt_cache_key: true,
        supports_prompt_cache_options: true,
        pricing: { input: 123, output: 456 },
      }],
    }, { now: at() });

    expect(catalogue).toMatchObject({
      providerId: "chatgpt-oauth",
      mode: "discovered",
      source: "ChatGPT account model catalogue",
      discoveredAt: "2026-09-08T10:00:00.000Z",
      error: null,
      models: [{
        id: "gpt-safe",
        displayName: "Restricted Preview Model",
        isDefault: true,
        hidden: false,
        inputModalities: ["text", "image"],
        reasoningValues: ["low", "high"],
        defaultReasoning: "high",
        supportsTools: true,
        supportsHostTools: false,
        supportsParallelToolCalls: true,
        supportsStructuredOutput: true,
        supportsStrictTools: true,
        supportsVerbosity: true,
        supportsPromptCacheKey: true,
        supportsPromptCacheOptions: true,
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        billingLabel: "ChatGPT subscription",
      }],
    });
    expect(catalogue.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(catalogue)).not.toContain("description");
    expect(JSON.stringify(catalogue)).not.toContain("123");
    expect(JSON.stringify(catalogue)).not.toContain("456");
  });

  it("keeps the observed sparse model shape sparse instead of guessing by name", () => {
    const catalogue = normalizeChatGptModelCatalogue({
      data: [{
        id: "gpt-5.6-sol",
        capabilities: {
          inputModalities: ["text", "image"],
          parallelToolCalls: true,
        },
      }],
    }, { now: at() });

    expect(catalogue.models).toEqual([{
      id: "gpt-5.6-sol",
      displayName: "gpt-5.6-sol",
      isDefault: false,
      hidden: false,
      inputModalities: ["text", "image"],
      reasoningValues: [],
      defaultReasoning: null,
      supportsTools: false,
      supportsHostTools: false,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: false,
      supportsStrictTools: false,
      supportsVerbosity: false,
      supportsPromptCacheKey: false,
      supportsPromptCacheOptions: false,
      contextWindow: null,
      maxOutputTokens: null,
      billingLabel: "ChatGPT subscription",
    }]);
  });

  it("filters hidden and unsafe rows, deduplicates IDs, and accepts one explicit default", () => {
    const catalogue = normalizeChatGptModelCatalogue({ models: [
      { id: "hidden-a", hidden: true, is_default: true },
      { id: "hidden-b", visibility: "hidden" },
      { id: "unsafe/model" },
      { id: "safe-a", display_name: "First", is_default: true },
      { id: "safe-a", display_name: "Duplicate", supports_tools: true },
      { id: "safe-b", display_name: "Name\u0000leak" },
    ] }, { now: at() });

    expect(catalogue.models.map(({ id, displayName, isDefault }) => ({ id, displayName, isDefault })))
      .toEqual([
        { id: "safe-a", displayName: "First", isDefault: true },
        { id: "safe-b", displayName: "safe-b", isDefault: false },
      ]);
    expect(catalogue.models[0]!.supportsTools).toBe(false);
  });

  it("does not select an ambiguous row-level default", () => {
    const catalogue = normalizeChatGptModelCatalogue({ models: [
      { id: "safe-a", is_default: true },
      { id: "safe-b", default: true },
    ] }, { now: at() });
    expect(catalogue.models.every((model) => !model.isDefault)).toBe(true);
  });

  it("fails closed on unsupported/empty/oversized catalogue shapes", () => {
    expect(() => normalizeChatGptModelCatalogue({ nope: [] })).toThrow(/unsupported shape/);
    expect(() => normalizeChatGptModelCatalogue({ models: [{ id: "unsafe/model" }] }))
      .toThrow(/no visible supported models/);
    expect(() => normalizeChatGptModelCatalogue({
      models: Array.from({ length: 513 }, (_, index) => ({ id: `model-${index}` })),
    })).toThrow(/supported model count/);
  });

  it("drops invalid numeric and oversized capability claims rather than clamping", () => {
    const catalogue = normalizeChatGptModelCatalogue([{
      id: "bounded",
      input_modalities: Array.from({ length: 33 }, () => "text"),
      reasoning_efforts: Array.from({ length: 33 }, () => "high"),
      context_window: 10_000_001,
      max_output_tokens: 1.5,
    }], { now: at() });
    expect(catalogue.models[0]).toMatchObject({
      inputModalities: [],
      reasoningValues: [],
      contextWindow: null,
      maxOutputTokens: null,
    });
  });

  it("produces a stable revision bound to normalized data, order, and defaults", () => {
    const first = normalizeChatGptModelCatalogue({ models: [
      { id: "safe-a", supports_tools: true },
      { id: "safe-b" },
    ] }, { now: at("2026-01-01T00:00:00.000Z") });
    const later = normalizeChatGptModelCatalogue({ models: [
      { id: "safe-a", supports_tools: true },
      { id: "safe-b" },
    ] }, { now: at("2026-12-31T00:00:00.000Z") });
    const changed = normalizeChatGptModelCatalogue({ models: [
      { id: "safe-a", supports_tools: false },
      { id: "safe-b" },
    ] }, { now: at() });
    const reordered = normalizeChatGptModelCatalogue({ models: [
      { id: "safe-b" },
      { id: "safe-a", supports_tools: true },
    ] }, { now: at() });
    const defaulted = normalizeChatGptModelCatalogue({
      default_model: "safe-a",
      models: [{ id: "safe-a", supports_tools: true }, { id: "safe-b" }],
    }, { now: at() });

    expect(first.revision).toBe(later.revision);
    expect(changed.revision).not.toBe(first.revision);
    expect(reordered.revision).not.toBe(first.revision);
    expect(defaulted.revision).not.toBe(first.revision);
  });

  it("writes and reuses only the ChatGPT provider's last-good catalogue", () => {
    const store = memoryStore();
    const discover = vi.fn(() => ({ models: [{ id: "account-model" }] }));
    const live = chatGptProviderCatalogue({ discover, store, now: at() });
    const cacheKey = providerCatalogueCacheKey("chatgpt-oauth");

    expect(live.mode).toBe("discovered");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(store.values.has(cacheKey)).toBe(true);
    expect(store.values.has(providerCatalogueCacheKey("claude-local"))).toBe(false);

    const cached = chatGptProviderCatalogue({
      discover: () => { throw new Error("secret-token transport detail"); },
      store,
      now: at("2026-09-09T00:00:00.000Z"),
    });
    expect(cached).toMatchObject({
      providerId: "chatgpt-oauth",
      mode: "cached",
      error: "ChatGPT account model discovery failed",
      revision: live.revision,
      models: live.models,
    });
    expect(JSON.stringify(cached)).not.toContain("secret-token");
  });

  it("returns an honest empty fallback when discovery fails without a cache", () => {
    const catalogue = chatGptProviderCatalogue({
      discover: () => ({ models: [] }),
      store: memoryStore(),
      now: at(),
    });
    expect(catalogue).toMatchObject({
      providerId: "chatgpt-oauth",
      mode: "fallback",
      revision: "unavailable",
      models: [],
    });
    expect(catalogue.error).toMatch(/no visible supported models/);
  });
});
