// Provider-neutral model-catalogue service.
//
// Discovery stays provider-owned; this module owns the shared persistence
// rule. Only a freshly discovered catalogue is cached, every key is scoped by
// provider id, and a failed discovery may reuse only that same provider's last
// validated catalogue.

import { appStateGet, appStateSet } from "../db/ingest.js";
import { discoverClaudeProviderCatalogue } from "./claude-local/discovery.js";
import type {
  ProviderId,
  ProviderModel,
  ProviderModelCatalogue,
} from "./types.js";

export const PROVIDER_CATALOGUE_CACHE_PREFIX = "ai.model_catalog";

export interface ProviderCatalogueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface LoadProviderCatalogueOptions {
  providerId: ProviderId;
  discover: () => ProviderModelCatalogue;
  store?: ProviderCatalogueStore;
  now?: () => Date;
}

const appStateCatalogueStore: ProviderCatalogueStore = {
  get: appStateGet,
  set: appStateSet,
};

export function providerCatalogueCacheKey(providerId: ProviderId): string {
  return `${PROVIDER_CATALOGUE_CACHE_PREFIX}.${providerId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isProviderModel(value: unknown): value is ProviderModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Partial<ProviderModel>;
  return (
    typeof model.id === "string" &&
    model.id.length > 0 &&
    typeof model.displayName === "string" &&
    typeof model.isDefault === "boolean" &&
    typeof model.hidden === "boolean" &&
    Array.isArray(model.inputModalities) &&
    model.inputModalities.every((item) => item === "text" || item === "image") &&
    isStringArray(model.reasoningValues) &&
    (model.defaultReasoning === null || typeof model.defaultReasoning === "string") &&
    typeof model.supportsTools === "boolean" &&
    typeof model.supportsHostTools === "boolean" &&
    typeof model.supportsParallelToolCalls === "boolean" &&
    typeof model.supportsStructuredOutput === "boolean" &&
    typeof model.supportsStrictTools === "boolean" &&
    typeof model.supportsVerbosity === "boolean" &&
    typeof model.supportsPromptCacheKey === "boolean" &&
    typeof model.supportsPromptCacheOptions === "boolean" &&
    (model.contextWindow === null ||
      (typeof model.contextWindow === "number" &&
        Number.isFinite(model.contextWindow) &&
        model.contextWindow > 0)) &&
    (model.maxOutputTokens === null ||
      (typeof model.maxOutputTokens === "number" &&
        Number.isFinite(model.maxOutputTokens) &&
        model.maxOutputTokens > 0)) &&
    (model.billingLabel === null || typeof model.billingLabel === "string")
  );
}

/** Strictly decode a persisted catalogue and bind it to the requested provider. */
export function decodeProviderCatalogue(
  raw: string | null,
  providerId: ProviderId,
): ProviderModelCatalogue | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const catalogue = value as Partial<ProviderModelCatalogue>;
    if (
      catalogue.providerId !== providerId ||
      (catalogue.mode !== "discovered" &&
        catalogue.mode !== "cached" &&
        catalogue.mode !== "fallback") ||
      typeof catalogue.source !== "string" ||
      typeof catalogue.discoveredAt !== "string" ||
      typeof catalogue.revision !== "string" ||
      catalogue.revision.length === 0 ||
      (catalogue.error !== null && typeof catalogue.error !== "string") ||
      !Array.isArray(catalogue.models) ||
      !catalogue.models.every(isProviderModel)
    ) {
      return null;
    }
    const ids = catalogue.models.map((model) => model.id);
    if (
      new Set(ids).size !== ids.length ||
      catalogue.models.filter((model) => model.isDefault).length > 1
    ) {
      return null;
    }
    return catalogue as ProviderModelCatalogue;
  } catch {
    return null;
  }
}

function failedCatalogue(
  providerId: ProviderId,
  error: string,
  now: () => Date,
): ProviderModelCatalogue {
  return {
    providerId,
    mode: "fallback",
    source: `${providerId} discovery`,
    discoveredAt: now().toISOString(),
    revision: "unavailable",
    error,
    models: [],
  };
}

/**
 * Discover a provider catalogue and apply the shared last-known-good policy.
 * Store failures never make a usable live catalogue unusable.
 */
export function loadProviderCatalogue(
  options: LoadProviderCatalogueOptions,
): ProviderModelCatalogue {
  const store = options.store ?? appStateCatalogueStore;
  const now = options.now ?? (() => new Date());
  let live: ProviderModelCatalogue;
  try {
    live = options.discover();
    if (live.providerId !== options.providerId) {
      throw new Error(
        `catalogue provider mismatch: expected ${options.providerId}, received ${live.providerId}`,
      );
    }
    if (!decodeProviderCatalogue(JSON.stringify(live), options.providerId)) {
      throw new Error("provider returned an invalid catalogue");
    }
  } catch (error) {
    live = failedCatalogue(
      options.providerId,
      error instanceof Error ? error.message : String(error),
      now,
    );
  }

  const key = providerCatalogueCacheKey(options.providerId);
  if (live.mode === "discovered") {
    try {
      store.set(key, JSON.stringify(live));
    } catch {
      // Persistence is an optimization; the discovered answer remains valid.
    }
    return live;
  }

  try {
    const cached = decodeProviderCatalogue(store.get(key), options.providerId);
    if (cached && cached.mode !== "fallback" && cached.models.length > 0) {
      return {
        ...cached,
        mode: "cached",
        error: live.error,
      };
    }
  } catch {
    // No database yet, or an unavailable store: return the honest live result.
  }
  return live;
}

/** The current Claude catalogue through the shared provider-keyed cache. */
export function claudeProviderCatalogue(
  store?: ProviderCatalogueStore,
): ProviderModelCatalogue {
  return loadProviderCatalogue({
    providerId: "claude-local",
    discover: discoverClaudeProviderCatalogue,
    store,
  });
}

export function findProviderModel(
  catalogue: ProviderModelCatalogue,
  modelId: string,
): ProviderModel | null {
  return catalogue.models.find((model) => model.id === modelId && !model.hidden) ?? null;
}
