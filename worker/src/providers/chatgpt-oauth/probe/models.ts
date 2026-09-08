export const REQUESTED_PROBE_MODEL_ENV = "SUPERTWIN_CHATGPT_PROBE_MODEL";
const SAFE_PROBE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PROBE_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ProbeReasoningEffort = (typeof PROBE_REASONING_EFFORTS)[number];

export interface ProbeModelCapabilities {
  inputModalities?: Array<"text" | "image">;
  reasoningEfforts?: ProbeReasoningEffort[];
  maxOutputTokens?: number;
  tools?: boolean;
  parallelToolCalls?: boolean;
  verbosity?: boolean;
  promptCacheKey?: boolean;
  promptCacheOptions?: boolean;
  structuredOutput?: boolean;
}

export interface ProbeModel {
  id: string;
  displayName?: string;
  capabilities: ProbeModelCapabilities;
}

export interface ProbeModelCatalogue {
  models: ProbeModel[];
}

/** Validate the operator-selected model identifier before any OAuth/network request. */
export function requestedProbeModelId(env: NodeJS.ProcessEnv = process.env): string {
  const modelId = env[REQUESTED_PROBE_MODEL_ENV]?.trim();
  if (!modelId || !SAFE_PROBE_MODEL_ID.test(modelId)) {
    throw new Error(
      `REFUSED: ${REQUESTED_PROBE_MODEL_ENV} must be a 1-128 character safe model identifier`,
    );
  }
  return modelId;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function first(source: Record<string, unknown>, nested: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
    if (nested[key] !== undefined) return nested[key];
  }
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return values.length ? [...new Set(values)] : undefined;
}

function inputModalities(value: unknown): Array<"text" | "image"> | undefined {
  const values = stringArray(value)?.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return values?.length ? values : undefined;
}

function reasoningEfforts(value: unknown): ProbeReasoningEffort[] | undefined {
  const allowed = new Set<string>(PROBE_REASONING_EFFORTS);
  const values = stringArray(value)?.filter(
    (item): item is ProbeReasoningEffort => allowed.has(item),
  );
  return values?.length ? values : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000
    ? value
    : undefined;
}

function visibleModel(value: unknown): ProbeModel | undefined {
  const source = record(value);
  if (!source) return undefined;
  if (source.hidden === true || source.is_hidden === true || source.visibility === "hidden") return undefined;
  const id = first(source, {}, ["slug", "id", "model"]);
  if (typeof id !== "string" || !SAFE_PROBE_MODEL_ID.test(id.trim())) return undefined;
  const nested = record(source.capabilities) ?? record(source.supported_features) ?? {};
  const displayName = first(source, nested, ["display_name", "displayName", "name"]);
  const capabilities: ProbeModelCapabilities = {
    inputModalities: inputModalities(first(source, nested, ["input_modalities", "inputModalities", "supported_input_modalities"])),
    reasoningEfforts: reasoningEfforts(first(source, nested, ["supported_reasoning_efforts", "reasoning_efforts", "reasoningEfforts"])),
    maxOutputTokens: positiveInteger(first(source, nested, ["max_output_tokens", "maxOutputTokens"])),
    tools: optionalBoolean(first(source, nested, ["supports_tools", "supportsTools", "tools"])),
    parallelToolCalls: optionalBoolean(first(source, nested, ["supports_parallel_tool_calls", "supportsParallelToolCalls", "parallel_tool_calls"])),
    verbosity: optionalBoolean(first(source, nested, ["supports_verbosity", "supportsVerbosity", "verbosity"])),
    promptCacheKey: optionalBoolean(first(source, nested, ["supports_prompt_cache_key", "supportsPromptCacheKey", "prompt_cache_key"])),
    promptCacheOptions: optionalBoolean(first(source, nested, ["supports_prompt_cache_options", "supportsPromptCacheOptions", "prompt_cache_options"])),
    structuredOutput: optionalBoolean(first(source, nested, ["supports_structured_output", "supportsStructuredOutput", "structured_output"])),
  };
  return {
    id: id.trim(),
    ...(typeof displayName === "string" && displayName.trim() ? { displayName: displayName.trim() } : {}),
    capabilities: Object.fromEntries(
      Object.entries(capabilities).filter(([, capability]) => capability !== undefined),
    ) as ProbeModelCapabilities,
  };
}

export function parseProbeModelCatalogue(payload: unknown): ProbeModelCatalogue {
  const source = record(payload);
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(source?.models)
      ? source.models
      : Array.isArray(source?.data)
        ? source.data
        : [];
  const byId = new Map<string, ProbeModel>();
  for (const candidate of candidates) {
    const model = visibleModel(candidate);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return { models: [...byId.values()] };
}

export function selectRequestedProbeModel(
  catalogue: ProbeModelCatalogue,
  requested?: string,
  env: NodeJS.ProcessEnv = process.env,
): ProbeModel {
  const requestedEnv = requested === undefined
    ? env
    : { ...env, [REQUESTED_PROBE_MODEL_ENV]: requested };
  const modelId = requestedProbeModelId(requestedEnv);
  const model = catalogue.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error("REFUSED: requested Phase 0b model is unavailable or hidden");
  return model;
}
