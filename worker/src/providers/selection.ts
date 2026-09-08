// Immutable provider/model selection for one logical model call.
//
// Resolution happens once, before a caller enters the resource pool. The
// returned object keeps the exact provider instance and catalogue revision so
// retries and a repair turn cannot observe a mid-call Settings change.

import {
  MODEL_DEFAULT_BY_ROLE,
  getActiveProvider,
  getProviderModelSelection,
  getProviderReasoningSelection,
} from "../db/settings.js";
import {
  isThinkingLevel,
  resolveReasoningCapability,
} from "../brain/reasoning.js";
import { readStepOverrides, type StepOverride } from "../settings/overrides.js";
import { findProviderModel } from "./catalogue.js";
import { getV2 as getRegisteredProviderV2 } from "./registry.js";
import type {
  ProviderErrorCode,
  ProviderId,
  ProviderModel,
  ProviderModelCatalogue,
  ProviderV2,
  ThinkingBudget,
} from "./types.js";

export type ProviderRoleKey = keyof typeof MODEL_DEFAULT_BY_ROLE;

export type ModelCallSelection =
  | {
      source: "step";
      key: string;
      /** A VersionedPrompt's settingsKey, in precedence order. */
      fallbackKeys?: readonly string[];
    }
  | {
      source: "role";
      key: ProviderRoleKey;
      fallbackKeys?: readonly string[];
    };

export interface ResolvedModelCall {
  readonly providerId: ProviderId;
  readonly provider: ProviderV2;
  readonly key: string;
  readonly model: string;
  readonly reasoning: ThinkingBudget | null;
  readonly catalogueRevision: string;
}

export type ProviderSelectionErrorCode = Extract<
  ProviderErrorCode,
  "BAD_REQUEST" | "PROVIDER_UNAVAILABLE" | "MODEL_UNAVAILABLE"
>;

export class ProviderSelectionError extends Error {
  readonly code: ProviderSelectionErrorCode;
  readonly providerId: ProviderId | null;
  readonly key: string;
  readonly model: string | null;

  constructor(
    code: ProviderSelectionErrorCode,
    detail: string,
    fields: {
      providerId?: ProviderId | null;
      key?: string;
      model?: string | null;
    } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = "ProviderSelectionError";
    this.code = code;
    this.providerId = fields.providerId ?? null;
    this.key = fields.key ?? "";
    this.model = fields.model ?? null;
  }
}

export interface ResolveModelCallDependencies {
  /** Exact test seam. When supplied, this provider is the selected provider. */
  provider?: ProviderV2;
  /** Exact test seam for a provider catalogue snapshot. */
  catalogue?: ProviderModelCatalogue;
  getProvider?: (providerId: ProviderId) => ProviderV2 | undefined;
  getActiveProvider?: () => ProviderId;
  getModelSelection?: typeof getProviderModelSelection;
  getReasoningSelection?: typeof getProviderReasoningSelection;
  getStepOverrides?: () => ReturnType<typeof readStepOverrides>;
}

function defaultProviderLookup(providerId: ProviderId): ProviderV2 | undefined {
  return getRegisteredProviderV2(providerId);
}

/** Exact key, explicit settings-key aliases, then each version stem. */
function selectionCandidates(
  key: string,
  fallbackKeys: readonly string[],
): string[] {
  const exact = key.trim();
  if (!exact) {
    throw new ProviderSelectionError("BAD_REQUEST", "model-call key is empty");
  }
  const aliases = fallbackKeys.map((candidate) => candidate.trim());
  if (aliases.some((candidate) => candidate.length === 0)) {
    throw new ProviderSelectionError(
      "BAD_REQUEST",
      "model-call fallback key is empty",
      { key: exact },
    );
  }
  const candidates = [exact, ...aliases];
  for (const candidate of [...candidates]) {
    const stem = candidate.split(".")[0]!;
    if (stem) candidates.push(stem);
  }
  return [...new Set(candidates)];
}

function stepOverrideFor(
  candidates: readonly string[],
  read: () => ReturnType<typeof readStepOverrides>,
): StepOverride | null {
  const overrides = read();
  for (const candidate of candidates) {
    const override = overrides[candidate];
    if (override) return override;
  }
  return null;
}

function providerDefaultModel(
  selection: ModelCallSelection,
  providerId: ProviderId,
  catalogue: ProviderModelCatalogue,
): ProviderModel | null {
  if (selection.source === "role" && providerId === "claude-local") {
    const roleDefault = MODEL_DEFAULT_BY_ROLE[selection.key];
    if (roleDefault) return findProviderModel(catalogue, roleDefault);
  }
  const defaults = catalogue.models.filter(
    (model) => model.isDefault && !model.hidden,
  );
  return defaults.length === 1 ? defaults[0]! : null;
}

function effectiveReasoning(
  configured: string | null,
  model: ProviderModel,
  catalogue: ProviderModelCatalogue,
): ThinkingBudget | null {
  const raw = configured === null || configured.trim() === ""
    ? model.defaultReasoning
    : configured.trim();
  if (raw === null) return null;

  // Provider catalogues may spell disabled reasoning as `none`; SuperTwin's
  // neutral setting and request contract call the same state `off`.
  const requested: ThinkingBudget | null = raw === "none"
    ? "off"
    : isThinkingLevel(raw)
      ? raw
      : null;
  if (!requested) return null;
  if (
    requested === "off" &&
    (model.reasoningValues.includes("off") ||
      model.reasoningValues.includes("none"))
  ) {
    return "off";
  }
  return resolveReasoningCapability(requested, model, catalogue)?.effective ?? null;
}

/** Resolve one immutable provider/model/reasoning snapshot. */
export function resolveModelCall(
  selection: ModelCallSelection,
  dependencies: ResolveModelCallDependencies = {},
): ResolvedModelCall {
  const fallbackKeys = selection.fallbackKeys ?? [];
  const candidates = selectionCandidates(selection.key, fallbackKeys);
  const override = selection.source === "step"
    ? stepOverrideFor(
        candidates,
        dependencies.getStepOverrides ?? (() => readStepOverrides()),
      )
    : null;

  const activeProvider = dependencies.getActiveProvider ?? getActiveProvider;
  // An explicitly injected provider is the whole test provider selection;
  // production has no injection and therefore follows candidate override,
  // then the persisted active provider.
  const providerId = dependencies.provider?.id ?? override?.provider ?? activeProvider();
  const selectedOverride =
    override?.provider && override.provider !== providerId ? null : override;
  const provider = dependencies.provider?.id === providerId
    ? dependencies.provider
    : (dependencies.getProvider ?? defaultProviderLookup)(providerId);
  if (!provider) {
    throw new ProviderSelectionError(
      "PROVIDER_UNAVAILABLE",
      `selected provider ${providerId} is not registered`,
      { providerId, key: candidates[0] },
    );
  }

  let catalogue: ProviderModelCatalogue;
  try {
    catalogue = dependencies.catalogue ?? provider.catalogue();
  } catch {
    throw new ProviderSelectionError(
      "MODEL_UNAVAILABLE",
      `selected provider ${providerId} has no usable model catalogue`,
      { providerId, key: candidates[0] },
    );
  }
  if (catalogue.providerId !== providerId) {
    throw new ProviderSelectionError(
      "PROVIDER_UNAVAILABLE",
      `catalogue does not belong to selected provider ${providerId}`,
      { providerId, key: candidates[0] },
    );
  }

  const readModel = dependencies.getModelSelection ?? getProviderModelSelection;
  const configuredModel = selectedOverride?.model ??
    readModel(providerId, candidates[0]!, fallbackKeys);
  const model = configuredModel !== null && configuredModel.trim() !== ""
    ? findProviderModel(catalogue, configuredModel.trim())
    : providerDefaultModel(selection, providerId, catalogue);
  if (!model) {
    const requested = configuredModel?.trim() || null;
    throw new ProviderSelectionError(
      "MODEL_UNAVAILABLE",
      requested
        ? `saved model ${requested} is unavailable for ${providerId}`
        : `no default model is available for ${providerId}`,
      {
        providerId,
        key: candidates[0],
        model: requested,
      },
    );
  }

  const readReasoning =
    dependencies.getReasoningSelection ?? getProviderReasoningSelection;
  const configuredReasoning = selectedOverride?.thinking ??
    readReasoning(providerId, candidates[0]!, fallbackKeys);

  return Object.freeze({
    providerId,
    provider,
    key: candidates[0]!,
    model: model.id,
    reasoning: effectiveReasoning(configuredReasoning, model, catalogue),
    catalogueRevision: catalogue.revision,
  });
}
