import { describe, expect, it } from "vitest";

import {
  decodeProviderCatalogue,
  findProviderModel,
  loadProviderCatalogue,
  providerCatalogueCacheKey,
  type ProviderCatalogueStore,
} from "./catalogue.js";
import type {
  ProviderId,
  ProviderModelCatalogue,
} from "./types.js";

function catalogue(
  providerId: ProviderId,
  mode: ProviderModelCatalogue["mode"] = "discovered",
  error: string | null = null,
): ProviderModelCatalogue {
  return {
    providerId,
    mode,
    source: `${providerId}-fixture`,
    discoveredAt: "2026-09-08T00:00:00.000Z",
    revision: `${providerId}-revision`,
    error,
    models: [
      {
        id: `${providerId}-model`,
        displayName: "Fixture model",
        isDefault: true,
        hidden: false,
        inputModalities: ["text"],
        reasoningValues: ["off", "low", "high"],
        defaultReasoning: "off",
        supportsTools: true,
        supportsHostTools: providerId === "claude-local",
        supportsParallelToolCalls: true,
        supportsStructuredOutput: true,
        supportsStrictTools: true,
        supportsVerbosity: true,
        supportsPromptCacheKey: providerId === "chatgpt-oauth",
        supportsPromptCacheOptions: providerId === "chatgpt-oauth",
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        billingLabel: providerId === "chatgpt-oauth" ? "ChatGPT subscription" : "$3/$15",
      },
    ],
  };
}

function memoryStore(): ProviderCatalogueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
  };
}

describe("provider catalogue cache", () => {
  it("uses exact provider-scoped app-state keys", () => {
    expect(providerCatalogueCacheKey("claude-local")).toBe(
      "ai.model_catalog.claude-local",
    );
    expect(providerCatalogueCacheKey("chatgpt-oauth")).toBe(
      "ai.model_catalog.chatgpt-oauth",
    );
  });

  it("persists discovered catalogues and reuses only the same provider's last good value", () => {
    const store = memoryStore();
    const discovered = catalogue("claude-local");
    expect(
      loadProviderCatalogue({
        providerId: "claude-local",
        discover: () => discovered,
        store,
      }),
    ).toBe(discovered);

    const cached = loadProviderCatalogue({
      providerId: "claude-local",
      discover: () => catalogue("claude-local", "fallback", "CLI missing"),
      store,
    });
    expect(cached).toMatchObject({
      providerId: "claude-local",
      mode: "cached",
      revision: discovered.revision,
      error: "CLI missing",
    });

    const other = loadProviderCatalogue({
      providerId: "chatgpt-oauth",
      discover: () => catalogue("chatgpt-oauth", "fallback", "signed out"),
      store,
    });
    expect(other.mode).toBe("fallback");
    expect(other.models).toHaveLength(1);
  });

  it("rejects corrupt and cross-provider persisted values", () => {
    const valid = catalogue("claude-local");
    expect(
      decodeProviderCatalogue(JSON.stringify(valid), "claude-local"),
    ).toEqual(valid);
    expect(
      decodeProviderCatalogue(JSON.stringify(valid), "chatgpt-oauth"),
    ).toBeNull();
    expect(decodeProviderCatalogue("{broken", "claude-local")).toBeNull();
    expect(
      decodeProviderCatalogue(
        JSON.stringify({ ...valid, models: [{ id: "partial" }] }),
        "claude-local",
      ),
    ).toBeNull();
  });

  it("does not resolve hidden models as runnable choices", () => {
    const visible = catalogue("claude-local");
    const hidden = {
      ...visible,
      models: visible.models.map((model) => ({ ...model, hidden: true })),
    };
    expect(findProviderModel(hidden, hidden.models[0]!.id)).toBeNull();
  });

  it("keeps discovery usable when persistence is unavailable", () => {
    const discovered = catalogue("claude-local");
    const throwingStore: ProviderCatalogueStore = {
      get: () => {
        throw new Error("no db");
      },
      set: () => {
        throw new Error("no db");
      },
    };
    expect(
      loadProviderCatalogue({
        providerId: "claude-local",
        discover: () => discovered,
        store: throwingStore,
      }),
    ).toBe(discovered);
  });

  it("turns throws and provider mismatches into honest empty fallback catalogues", () => {
    const now = () => new Date("2026-09-08T12:00:00.000Z");
    const thrown = loadProviderCatalogue({
      providerId: "chatgpt-oauth",
      discover: () => {
        throw new Error("not signed in");
      },
      store: memoryStore(),
      now,
    });
    expect(thrown).toEqual({
      providerId: "chatgpt-oauth",
      mode: "fallback",
      source: "chatgpt-oauth discovery",
      discoveredAt: "2026-09-08T12:00:00.000Z",
      revision: "unavailable",
      error: "not signed in",
      models: [],
    });

    const mismatch = loadProviderCatalogue({
      providerId: "chatgpt-oauth",
      discover: () => catalogue("claude-local"),
      store: memoryStore(),
      now,
    });
    expect(mismatch.mode).toBe("fallback");
    expect(mismatch.error).toMatch(/provider mismatch/);
  });
});
