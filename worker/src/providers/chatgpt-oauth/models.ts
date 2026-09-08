import { createHash } from "node:crypto";

import {
  loadProviderCatalogue,
  type ProviderCatalogueStore,
} from "../catalogue.js";
import type { ProviderModel, ProviderModelCatalogue } from "../types.js";

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CATALOGUE_MODELS = 512;
const MAX_CAPABILITY_VALUES = 32;
const MAX_NUMERIC_CAPABILITY = 10_000_000;
const MAX_DISPLAY_NAME_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const INPUT_MODALITIES = ["text", "image"] as const;
const REASONING_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const CATALOGUE_SOURCE = "ChatGPT account model catalogue";
const REVISION_DOMAIN = "supertwin.chatgpt-account-catalogue.v1";

type JsonRecord = Record<string, unknown>;

interface NormalizedCandidate {
  model: ProviderModel;
  claimsDefault: boolean;
}

export interface NormalizeChatGptCatalogueOptions {
  now?: () => Date;
}

export interface LoadChatGptCatalogueOptions extends NormalizeChatGptCatalogueOptions {
  /**
   * Returns the account-visible model payload acquired by the provider's
   * authenticated transport. This module deliberately performs no I/O.
   */
  discover: () => unknown;
  store?: ProviderCatalogueStore;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function first(source: JsonRecord, nested: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
    if (nested[key] !== undefined) return nested[key];
  }
  return undefined;
}

function explicitTrue(value: unknown): boolean {
  return value === true;
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_NUMERIC_CAPABILITY
    ? value
    : null;
}

function boundedStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITY_VALUES) return [];
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 64 || CONTROL_CHARACTER.test(item)) continue;
    strings.push(item);
  }
  return strings;
}

function normalizedInputModalities(value: unknown): Array<"text" | "image"> {
  const supplied = new Set(boundedStrings(value));
  return INPUT_MODALITIES.filter((item) => supplied.has(item));
}

function normalizedReasoningValues(value: unknown): string[] {
  const supplied = new Set(boundedStrings(value));
  return REASONING_VALUES.filter((item) => supplied.has(item));
}

function displayName(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > MAX_DISPLAY_NAME_LENGTH) return fallback;
  const trimmed = value.trim();
  return trimmed && !CONTROL_CHARACTER.test(trimmed) ? trimmed : fallback;
}

function normalizeCandidate(value: unknown): NormalizedCandidate | null {
  const source = record(value);
  if (!source) return null;
  if (
    source.hidden === true ||
    source.is_hidden === true ||
    source.visibility === "hidden"
  ) {
    return null;
  }

  const rawId = first(source, {}, ["slug", "id", "model"]);
  if (typeof rawId !== "string") return null;
  const id = rawId.trim();
  if (!SAFE_MODEL_ID.test(id)) return null;

  const nested = record(source.capabilities) ?? record(source.supported_features) ?? {};
  const reasoningValues = normalizedReasoningValues(first(source, nested, [
    "supported_reasoning_efforts",
    "reasoning_efforts",
    "reasoningEfforts",
  ]));
  const rawDefaultReasoning = first(source, nested, [
    "default_reasoning_effort",
    "defaultReasoningEffort",
    "default_reasoning",
    "defaultReasoning",
  ]);
  const normalizedDefaultReasoning =
    typeof rawDefaultReasoning === "string" && reasoningValues.includes(rawDefaultReasoning)
      ? rawDefaultReasoning
      : null;

  const model: ProviderModel = {
    id,
    displayName: displayName(
      first(source, nested, ["display_name", "displayName", "name"]),
      id,
    ),
    isDefault: false,
    hidden: false,
    inputModalities: normalizedInputModalities(first(source, nested, [
      "input_modalities",
      "inputModalities",
      "supported_input_modalities",
    ])),
    reasoningValues,
    defaultReasoning: normalizedDefaultReasoning,
    supportsTools: explicitTrue(first(source, nested, ["supports_tools", "supportsTools", "tools"])),
    // ChatGPT OAuth exposes function tools, not Claude-style local host tools.
    supportsHostTools: false,
    supportsParallelToolCalls: explicitTrue(first(source, nested, [
      "supports_parallel_tool_calls",
      "supportsParallelToolCalls",
      "parallelToolCalls",
      "parallel_tool_calls",
    ])),
    supportsStructuredOutput: explicitTrue(first(source, nested, [
      "supports_structured_output",
      "supportsStructuredOutput",
      "structuredOutput",
      "structured_output",
    ])),
    supportsStrictTools: explicitTrue(first(source, nested, [
      "supports_strict_tools",
      "supportsStrictTools",
      "strict_tools",
    ])),
    supportsVerbosity: explicitTrue(first(source, nested, [
      "supports_verbosity",
      "supportsVerbosity",
      "verbosity",
    ])),
    supportsPromptCacheKey: explicitTrue(first(source, nested, [
      "supports_prompt_cache_key",
      "supportsPromptCacheKey",
      "promptCacheKey",
      "prompt_cache_key",
    ])),
    supportsPromptCacheOptions: explicitTrue(first(source, nested, [
      "supports_prompt_cache_options",
      "supportsPromptCacheOptions",
      "promptCacheOptions",
      "prompt_cache_options",
    ])),
    contextWindow: safePositiveInteger(first(source, nested, ["context_window", "contextWindow"])),
    maxOutputTokens: safePositiveInteger(first(source, nested, ["max_output_tokens", "maxOutputTokens"])),
    billingLabel: "ChatGPT subscription",
  };

  return {
    model,
    claimsDefault: explicitTrue(first(source, nested, ["is_default", "isDefault", "default"])),
  };
}

function candidateRows(payload: unknown): { source: JsonRecord; rows: unknown[] } {
  if (Array.isArray(payload)) return { source: {}, rows: payload };
  const source = record(payload);
  const rows = Array.isArray(source?.models)
    ? source.models
    : Array.isArray(source?.data)
      ? source.data
      : null;
  if (!source || !rows) throw new Error("ChatGPT model catalogue has an unsupported shape");
  return { source, rows };
}

function catalogueRevision(models: readonly ProviderModel[]): string {
  return createHash("sha256")
    .update(REVISION_DOMAIN)
    .update("\0")
    .update(JSON.stringify(models))
    .digest("hex");
}

/** Normalize an already-fetched, account-visible ChatGPT model catalogue. */
export function normalizeChatGptModelCatalogue(
  payload: unknown,
  options: NormalizeChatGptCatalogueOptions = {},
): ProviderModelCatalogue {
  const { source, rows } = candidateRows(payload);
  if (rows.length > MAX_CATALOGUE_MODELS) {
    throw new Error("ChatGPT model catalogue exceeds the supported model count");
  }

  const candidates: NormalizedCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const candidate = normalizeCandidate(row);
    if (candidate && !seen.has(candidate.model.id)) {
      seen.add(candidate.model.id);
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) {
    throw new Error("ChatGPT model catalogue contains no visible supported models");
  }

  const topLevelDefault = first(source, {}, ["default_model", "defaultModel"]);
  const explicitDefault = typeof topLevelDefault === "string" && SAFE_MODEL_ID.test(topLevelDefault)
    ? topLevelDefault
    : null;
  const claimedDefaults = candidates.filter((candidate) => candidate.claimsDefault);
  const defaultId = explicitDefault && seen.has(explicitDefault)
    ? explicitDefault
    : claimedDefaults.length === 1
      ? claimedDefaults[0]!.model.id
      : null;
  const models = candidates.map(({ model }) => ({
    ...model,
    isDefault: model.id === defaultId,
  }));

  return {
    providerId: "chatgpt-oauth",
    mode: "discovered",
    source: CATALOGUE_SOURCE,
    discoveredAt: (options.now ?? (() => new Date()))().toISOString(),
    revision: catalogueRevision(models),
    error: null,
    models,
  };
}

/** Apply the shared, provider-keyed last-known-good cache to ChatGPT discovery. */
export function chatGptProviderCatalogue(
  options: LoadChatGptCatalogueOptions,
): ProviderModelCatalogue {
  return loadProviderCatalogue({
    providerId: "chatgpt-oauth",
    discover: () => {
      let payload: unknown;
      try {
        payload = options.discover();
      } catch {
        // Discovery transports can put URLs, response bodies, or headers in an
        // exception. The persisted/public catalogue error must stay redacted.
        throw new Error("ChatGPT account model discovery failed");
      }
      return normalizeChatGptModelCatalogue(payload, { now: options.now });
    },
    store: options.store,
    now: options.now,
  });
}
