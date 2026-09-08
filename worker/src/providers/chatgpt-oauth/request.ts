import type {
  ProviderInputItem,
  ProviderJson,
  ProviderJsonObject,
  ProviderModel,
  ProviderRequest,
  ProviderTextOutput,
  ProviderTool,
  ThinkingBudget,
} from "../types.js";

export const CHATGPT_MAX_REQUEST_BYTES = 1024 * 1024;
export const CHATGPT_MAX_INPUT_ITEMS = 256;
export const CHATGPT_MAX_CONTENT_ITEMS = 64;
export const CHATGPT_MAX_JSON_DEPTH = 32;
export const CHATGPT_MAX_JSON_NODES = 10_000;

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_DESCRIPTION_BYTES = 8 * 1024;
const MAX_CONTINUATION_BYTES = 2 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SAFE_CACHE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const OUTBOUND_REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

const PROVIDER_REQUEST_FIELDS = new Set([
  "runId",
  "model",
  "instructions",
  "input",
  "tools",
  "hostTools",
  "toolChoice",
  "parallelToolCalls",
  "reasoning",
  "text",
  "cache",
  "continuation",
  "persistContinuation",
  "plainCompletion",
  "skipHostSettings",
  "cwd",
  "maxOutputTokens",
  "maxAgentTurns",
  "maxBudgetUsd",
  "timeoutMs",
  "signal",
  "onEvent",
]);

export type ChatGptRequestErrorCode =
  | "BAD_REQUEST"
  | "MODEL_UNAVAILABLE"
  | "CAPABILITY_UNSUPPORTED";

export class ChatGptRequestError extends Error {
  readonly code: ChatGptRequestErrorCode;

  constructor(code: ChatGptRequestErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ChatGptRequestError";
    this.code = code;
  }
}

export interface ChatGptResponsesRequest {
  model: string;
  instructions: string;
  input: ProviderJson[];
  tools?: ProviderJson[];
  tool_choice?: "none" | "auto" | "required";
  parallel_tool_calls?: boolean;
  reasoning?: { effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" };
  text?: ProviderJsonObject;
  max_output_tokens?: number;
  previous_response_id?: string;
  prompt_cache_key?: string;
  prompt_cache_options?: { mode: "implicit" | "explicit"; ttl: "30m" };
  store: false;
  stream: true;
}

function fail(code: ChatGptRequestErrorCode, field: string): never {
  throw new ChatGptRequestError(code, `invalid or unsupported ${field}`);
}

function dataRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("BAD_REQUEST", field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("BAD_REQUEST", field);
  if (Object.getOwnPropertySymbols(value).length > 0) fail("BAD_REQUEST", field);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) fail("BAD_REQUEST", field);
    clone[key] = descriptor.value;
  }
  return clone;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): void {
  const names = Object.getOwnPropertyNames(value);
  if (names.some((name) => !allowed.includes(name))) fail("BAD_REQUEST", field);
  if (required.some((name) => !Object.hasOwn(value, name))) fail("BAD_REQUEST", field);
}

function dataArray(value: unknown, maxLength: number, field: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value)) fail("BAD_REQUEST", field);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("BAD_REQUEST", field);
  if (Object.getOwnPropertySymbols(value).length > 0) fail("BAD_REQUEST", field);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"];
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    fail("BAD_REQUEST", field);
  }
  const length = lengthDescriptor.value as number;
  if ((!allowEmpty && length === 0) || length > maxLength) fail("BAD_REQUEST", field);
  for (const name of Object.keys(descriptors)) {
    if (name === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length) fail("BAD_REQUEST", field);
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor)) fail("BAD_REQUEST", field);
  }
  const cloned: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) fail("BAD_REQUEST", field);
    cloned.push(descriptor.value);
  }
  return cloned;
}

function boundedString(value: unknown, maxBytes: number, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail("BAD_REQUEST", field);
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail("BAD_REQUEST", field);
  return value;
}

interface JsonBudget {
  nodes: number;
}

function cloneJson(value: unknown, budget: JsonBudget, depth = 0): ProviderJson {
  budget.nodes += 1;
  if (budget.nodes > CHATGPT_MAX_JSON_NODES || depth > CHATGPT_MAX_JSON_DEPTH) {
    fail("BAD_REQUEST", "JSON value");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
      fail("BAD_REQUEST", "JSON string");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("BAD_REQUEST", "JSON number");
    return value;
  }
  if (Array.isArray(value)) {
    const items = dataArray(value, CHATGPT_MAX_JSON_NODES, "JSON array", true);
    return items.map((item) => cloneJson(item, budget, depth + 1));
  }
  const source = dataRecord(value, "JSON object");
  const target: Record<string, ProviderJson> = Object.create(null) as Record<string, ProviderJson>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (!("value" in descriptor) || Buffer.byteLength(key, "utf8") > 256) {
      fail("BAD_REQUEST", "JSON object");
    }
    target[key] = cloneJson(descriptor.value, budget, depth + 1);
  }
  return target;
}

function cloneJsonObject(value: unknown, field: string): ProviderJsonObject {
  const source = dataRecord(value, field);
  return cloneJson(source, { nodes: 0 }) as ProviderJsonObject;
}

const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const JSON_SCHEMA_KEYS = new Set([
  "$defs", "$ref", "type", "properties", "required", "additionalProperties", "items",
  "enum", "const", "description", "anyOf", "oneOf", "allOf", "not",
  "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems",
]);

function validateJsonSchemaNode(value: ProviderJson, depth = 0): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > CHATGPT_MAX_JSON_DEPTH) {
    fail("BAD_REQUEST", "JSON schema");
  }
  const schema = value as ProviderJsonObject;
  if (Object.keys(schema).some((key) => !JSON_SCHEMA_KEYS.has(key))) fail("BAD_REQUEST", "JSON schema keyword");
  if (schema.type !== undefined) {
    if (typeof schema.type === "string") {
      if (!JSON_SCHEMA_TYPES.has(schema.type)) fail("BAD_REQUEST", "JSON schema type");
    } else if (Array.isArray(schema.type)) {
      const types = schema.type;
      if (types.length === 0 || types.some((item) => typeof item !== "string" || !JSON_SCHEMA_TYPES.has(item)) ||
          new Set(types).size !== types.length) fail("BAD_REQUEST", "JSON schema type");
    } else {
      fail("BAD_REQUEST", "JSON schema type");
    }
  }
  if (schema.$ref !== undefined &&
      (typeof schema.$ref !== "string" || !/^#\/(?:\$defs\/)?[A-Za-z0-9._~/-]+$/.test(schema.$ref))) {
    fail("BAD_REQUEST", "JSON schema reference");
  }
  if (schema.description !== undefined && typeof schema.description !== "string") fail("BAD_REQUEST", "JSON schema description");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    fail("BAD_REQUEST", "JSON schema additionalProperties");
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      fail("BAD_REQUEST", "JSON schema properties");
    }
    for (const child of Object.values(schema.properties)) validateJsonSchemaNode(child, depth + 1);
  }
  if (schema.$defs !== undefined) {
    if (!schema.$defs || typeof schema.$defs !== "object" || Array.isArray(schema.$defs)) fail("BAD_REQUEST", "JSON schema definitions");
    for (const child of Object.values(schema.$defs)) validateJsonSchemaNode(child, depth + 1);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) ||
        schema.required.some((item) => typeof item !== "string") ||
        new Set(schema.required).size !== schema.required.length) fail("BAD_REQUEST", "JSON schema required");
    if (schema.properties && schema.required.some((item) =>
      !Object.hasOwn(schema.properties as ProviderJsonObject, item as string))) fail("BAD_REQUEST", "JSON schema required");
  }
  if (schema.items !== undefined) validateJsonSchemaNode(schema.items, depth + 1);
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const candidates = schema[keyword];
    if (candidates !== undefined) {
      if (!Array.isArray(candidates) || candidates.length === 0) fail("BAD_REQUEST", "JSON schema composition");
      for (const candidate of candidates) validateJsonSchemaNode(candidate, depth + 1);
    }
  }
  if (schema.not !== undefined) validateJsonSchemaNode(schema.not, depth + 1);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) fail("BAD_REQUEST", "JSON schema enum");
  for (const keyword of ["minimum", "maximum"] as const) {
    const candidate = schema[keyword];
    if (candidate !== undefined && (typeof candidate !== "number" || !Number.isFinite(candidate))) {
      fail("BAD_REQUEST", "JSON schema numeric bound");
    }
  }
  for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    const candidate = schema[keyword];
    if (candidate !== undefined &&
        (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)) {
      fail("BAD_REQUEST", "JSON schema numeric bound");
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") fail("BAD_REQUEST", "JSON schema pattern");
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      fail("BAD_REQUEST", "JSON schema pattern");
    }
  }
}

function cloneAndValidateJsonSchema(
  value: unknown,
  options: { requireObjectRoot: boolean },
): ProviderJsonObject {
  const schema = cloneJsonObject(value, "JSON schema");
  validateJsonSchemaNode(schema);
  if (options.requireObjectRoot && schema.type !== "object") fail("BAD_REQUEST", "tool parameter schema");
  if (schema.type === "object" && schema.additionalProperties === undefined) {
    // ProviderTool/ProviderTextOutput promise strict output but their neutral
    // JSON Schema type permits this keyword to be omitted. Close the root here
    // instead of rejecting an otherwise valid neutral contract.
    schema.additionalProperties = false;
  } else if (schema.type === "object" && schema.additionalProperties !== false) {
    fail("BAD_REQUEST", "strict object schema");
  }
  return schema;
}

function mapInputItem(item: ProviderInputItem): ProviderJson {
  const source = dataRecord(item, "input item");
  if (source.type === "message") {
    exactKeys(source, ["type", "role", "content"], ["type", "role", "content"], "message input");
    if (source.role !== "user" && source.role !== "assistant") fail("BAD_REQUEST", "message role");
    const rawContent = dataArray(source.content, CHATGPT_MAX_CONTENT_ITEMS, "message content");
    const content: ProviderJson[] = rawContent.map((raw): ProviderJson => {
      const part = dataRecord(raw, "message content");
      if (part.type === "input_text") {
        exactKeys(part, ["type", "text"], ["type", "text"], "input_text");
        return { type: "input_text", text: boundedString(part.text, MAX_TEXT_BYTES, "input text", true) };
      }
      if (part.type === "input_image") {
        exactKeys(part, ["type", "image_url", "detail"], ["type", "image_url"], "input_image");
        const imageUrl = boundedString(part.image_url, CHATGPT_MAX_REQUEST_BYTES, "image URL");
        const match = SAFE_DATA_IMAGE.exec(imageUrl);
        if (!match || match[1]!.length % 4 !== 0 || Buffer.from(match[1]!, "base64").byteLength === 0) {
          fail("CAPABILITY_UNSUPPORTED", "image URL");
        }
        if (part.detail !== undefined &&
            (typeof part.detail !== "string" || !["auto", "low", "high"].includes(part.detail))) {
          fail("BAD_REQUEST", "image detail");
        }
        return {
          type: "input_image",
          image_url: imageUrl,
          ...(part.detail === undefined ? {} : { detail: part.detail as "auto" | "low" | "high" }),
        };
      }
      return fail("BAD_REQUEST", "message content type");
    });
    return { type: "message", role: source.role, content };
  }
  if (source.type === "function_call_output") {
    exactKeys(source, ["type", "call_id", "output"], ["type", "call_id", "output"], "function result");
    const callId = boundedString(source.call_id, 128, "function call id");
    if (!SAFE_ID.test(callId)) fail("BAD_REQUEST", "function call id");
    return {
      type: "function_call_output",
      call_id: callId,
      output: boundedString(source.output, MAX_TEXT_BYTES, "function output", true),
    };
  }
  return fail("BAD_REQUEST", "input item type");
}

function mapTool(tool: ProviderTool): ProviderJson {
  const source = dataRecord(tool, "tool");
  exactKeys(
    source,
    ["type", "name", "description", "parameters", "strict"],
    ["type", "name", "description", "parameters", "strict"],
    "tool",
  );
  if (source.type !== "function" || source.strict !== true) fail("BAD_REQUEST", "tool contract");
  const name = boundedString(source.name, 64, "tool name");
  if (!SAFE_TOOL_NAME.test(name)) fail("BAD_REQUEST", "tool name");
  return {
    type: "function",
    name,
    description: boundedString(source.description, MAX_DESCRIPTION_BYTES, "tool description", true),
    parameters: cloneAndValidateJsonSchema(source.parameters, { requireObjectRoot: true }),
    strict: true,
  };
}

function mapText(text: ProviderTextOutput, model: ProviderModel): ProviderJsonObject {
  const source = dataRecord(text, "text output");
  exactKeys(source, ["format", "verbosity"], ["format"], "text output");
  if (source.verbosity !== undefined) {
    if (!model.supportsVerbosity) fail("CAPABILITY_UNSUPPORTED", "text verbosity");
    if (typeof source.verbosity !== "string" ||
        !["low", "medium", "high"].includes(source.verbosity)) fail("BAD_REQUEST", "text verbosity");
  }
  const format = dataRecord(source.format, "text format");
  if (format.type === "text") {
    exactKeys(format, ["type"], ["type"], "plain text format");
    return {
      format: { type: "text" },
      ...(source.verbosity === undefined ? {} : { verbosity: source.verbosity as "low" | "medium" | "high" }),
    };
  }
  if (format.type !== "json_schema") fail("BAD_REQUEST", "text format");
  exactKeys(format, ["type", "name", "strict", "schema"], ["type", "name", "strict", "schema"], "JSON schema format");
  if (!model.supportsStructuredOutput) fail("CAPABILITY_UNSUPPORTED", "structured output");
  if (format.strict !== true) fail("BAD_REQUEST", "JSON schema strictness");
  const name = boundedString(format.name, 64, "JSON schema name");
  if (!SAFE_TOOL_NAME.test(name)) fail("BAD_REQUEST", "JSON schema name");
  return {
    format: {
      type: "json_schema",
      name,
      strict: true,
      schema: cloneAndValidateJsonSchema(format.schema, { requireObjectRoot: false }),
    },
    ...(source.verbosity === undefined ? {} : { verbosity: source.verbosity as "low" | "medium" | "high" }),
  };
}

function mapReasoning(
  reasoning: NonNullable<ProviderRequest["reasoning"]>,
  model: ProviderModel,
): ChatGptResponsesRequest["reasoning"] | undefined {
  const source = dataRecord(reasoning, "reasoning");
  exactKeys(source, ["budget", "effort"], ["budget"], "reasoning");
  if (typeof source.budget !== "string" ||
      !["off", "low", "medium", "high", "xhigh", "max"].includes(source.budget)) {
    fail("BAD_REQUEST", "reasoning budget");
  }
  const budget = source.budget as ThinkingBudget;
  if (budget === "off") {
    if (source.effort !== undefined) fail("BAD_REQUEST", "reasoning effort");
    return model.reasoningValues.includes("none") ? { effort: "none" } : undefined;
  }
  const orderedEfforts = ["xhigh", "high", "medium", "low", "minimal"] as const;
  const effort = source.effort ?? (budget === "max"
    ? orderedEfforts.find((candidate) => model.reasoningValues.includes(candidate))
    : budget);
  if (typeof effort !== "string" || !OUTBOUND_REASONING.has(effort) || effort === "none") {
    fail("BAD_REQUEST", "reasoning effort");
  }
  if (!model.reasoningValues.includes(effort)) fail("CAPABILITY_UNSUPPORTED", "reasoning effort");
  return { effort: effort as Exclude<ChatGptResponsesRequest["reasoning"], undefined>["effort"] };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function validateModel(value: unknown): ProviderModel {
  const source = dataRecord(value, "model capability row");
  const fields = [
    "id", "displayName", "isDefault", "hidden", "inputModalities", "reasoningValues",
    "defaultReasoning", "supportsTools", "supportsHostTools", "supportsParallelToolCalls",
    "supportsStructuredOutput", "supportsStrictTools", "supportsVerbosity",
    "supportsPromptCacheKey", "supportsPromptCacheOptions", "contextWindow",
    "maxOutputTokens", "billingLabel",
  ];
  exactKeys(source, fields, fields, "model capability row");
  const id = boundedString(source.id, 128, "model id");
  if (!SAFE_ID.test(id)) fail("MODEL_UNAVAILABLE", "model id");
  const displayName = boundedString(source.displayName, 256, "model display name");
  const inputModalities = dataArray(source.inputModalities, 2, "model input modalities", true)
    .map((item) => {
      if (item !== "text" && item !== "image") fail("BAD_REQUEST", "model input modality");
      return item;
    });
  if (new Set(inputModalities).size !== inputModalities.length) fail("BAD_REQUEST", "model input modalities");
  const reasoningValues = dataArray(source.reasoningValues, 7, "model reasoning values", true)
    .map((item) => {
      if (typeof item !== "string" || !OUTBOUND_REASONING.has(item) && item !== "off") {
        fail("BAD_REQUEST", "model reasoning value");
      }
      return item;
    });
  if (new Set(reasoningValues).size !== reasoningValues.length) fail("BAD_REQUEST", "model reasoning values");
  if (source.defaultReasoning !== null &&
      (typeof source.defaultReasoning !== "string" || !reasoningValues.includes(source.defaultReasoning))) {
    fail("BAD_REQUEST", "model default reasoning");
  }
  for (const field of [
    "isDefault", "hidden", "supportsTools", "supportsHostTools", "supportsParallelToolCalls",
    "supportsStructuredOutput", "supportsStrictTools", "supportsVerbosity",
    "supportsPromptCacheKey", "supportsPromptCacheOptions",
  ] as const) {
    if (typeof source[field] !== "boolean") fail("BAD_REQUEST", "model capability flag");
  }
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const candidate = source[field];
    if (candidate !== null &&
        (!Number.isSafeInteger(candidate) || Number(candidate) <= 0 || Number(candidate) > 10_000_000)) {
      fail("BAD_REQUEST", "model numeric capability");
    }
  }
  if (source.billingLabel !== "ChatGPT subscription") fail("BAD_REQUEST", "model billing label");
  return {
    id,
    displayName,
    isDefault: source.isDefault as boolean,
    hidden: source.hidden as boolean,
    inputModalities: inputModalities as Array<"text" | "image">,
    reasoningValues,
    defaultReasoning: source.defaultReasoning as string | null,
    supportsTools: source.supportsTools as boolean,
    supportsHostTools: source.supportsHostTools as boolean,
    supportsParallelToolCalls: source.supportsParallelToolCalls as boolean,
    supportsStructuredOutput: source.supportsStructuredOutput as boolean,
    supportsStrictTools: source.supportsStrictTools as boolean,
    supportsVerbosity: source.supportsVerbosity as boolean,
    supportsPromptCacheKey: source.supportsPromptCacheKey as boolean,
    supportsPromptCacheOptions: source.supportsPromptCacheOptions as boolean,
    contextWindow: source.contextWindow as number | null,
    maxOutputTokens: source.maxOutputTokens as number | null,
    billingLabel: "ChatGPT subscription",
  };
}

/**
 * Convert one neutral request into the complete, closed ChatGPT wire body.
 * The caller supplies the exact account-visible model row used by resolution;
 * nothing is inferred from the model name and unknown fields are rejected.
 */
function buildChatGptRequestUnchecked(
  request: ProviderRequest,
  modelInput: ProviderModel,
): Readonly<ChatGptResponsesRequest> {
  const source = dataRecord(request, "provider request");
  const model = validateModel(modelInput);
  const requestKeys = Object.getOwnPropertyNames(source);
  if (requestKeys.some((key) => !PROVIDER_REQUEST_FIELDS.has(key))) fail("BAD_REQUEST", "provider request field");
  for (const required of ["runId", "model", "instructions", "input", "maxOutputTokens", "maxAgentTurns", "onEvent"]) {
    if (!Object.hasOwn(source, required)) fail("BAD_REQUEST", required);
  }

  const runId = boundedString(source.runId, 128, "run id");
  if (!SAFE_ID.test(runId)) fail("BAD_REQUEST", "run id");
  const selectedModel = boundedString(source.model, 128, "model");
  if (!SAFE_ID.test(selectedModel)) fail("BAD_REQUEST", "model");
  if (model.hidden || selectedModel !== model.id) fail("MODEL_UNAVAILABLE", "model");
  const rawInput = dataArray(source.input, CHATGPT_MAX_INPUT_ITEMS, "input");
  if (!Number.isSafeInteger(source.maxOutputTokens) || Number(source.maxOutputTokens) <= 0 ||
      Number(source.maxOutputTokens) > 10_000_000) {
    fail("BAD_REQUEST", "max output tokens");
  }
  if (!Number.isSafeInteger(source.maxAgentTurns) || Number(source.maxAgentTurns) <= 0 || Number(source.maxAgentTurns) > 64) {
    fail("BAD_REQUEST", "max agent turns");
  }
  if (typeof source.onEvent !== "function") fail("BAD_REQUEST", "event callback");
  if (source.maxBudgetUsd !== undefined &&
      (typeof source.maxBudgetUsd !== "number" || !Number.isFinite(source.maxBudgetUsd) || source.maxBudgetUsd <= 0)) {
    fail("BAD_REQUEST", "max budget");
  }
  if (source.timeoutMs !== undefined &&
      (!Number.isSafeInteger(source.timeoutMs) || Number(source.timeoutMs) <= 0)) fail("BAD_REQUEST", "timeout");
  if (source.signal !== undefined && !(source.signal instanceof AbortSignal)) fail("BAD_REQUEST", "abort signal");
  if (source.hostTools !== undefined) {
    const hostTools = dataArray(source.hostTools, 128, "host tools", true);
    if (hostTools.some((name) => typeof name !== "string")) fail("BAD_REQUEST", "host tools");
    if (hostTools.length > 0) fail("CAPABILITY_UNSUPPORTED", "host tools");
  }
  for (const field of ["persistContinuation", "plainCompletion", "skipHostSettings"] as const) {
    if (source[field] !== undefined && typeof source[field] !== "boolean") fail("BAD_REQUEST", field);
  }
  if (source.cwd !== undefined) boundedString(source.cwd, 4_096, "working directory");

  const mappedInput = rawInput.map((item) => mapInputItem(item as ProviderInputItem));
  const usesText = mappedInput.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const content = item.content;
    return Array.isArray(content) && content.some((part) =>
      part !== null && typeof part === "object" && !Array.isArray(part) && part.type === "input_text");
  });
  const usesImage = mappedInput.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const content = item.content;
    return Array.isArray(content) && content.some((part) =>
      part !== null && typeof part === "object" && !Array.isArray(part) && part.type === "input_image");
  });
  if (usesImage && !model.inputModalities.includes("image")) {
    fail("CAPABILITY_UNSUPPORTED", "image input");
  }
  if (usesText && !model.inputModalities.includes("text")) {
    fail("CAPABILITY_UNSUPPORTED", "text input");
  }
  const body: ChatGptResponsesRequest = {
    model: selectedModel,
    instructions: boundedString(source.instructions, MAX_TEXT_BYTES, "instructions", true),
    input: mappedInput,
    store: false,
    stream: true,
  };

  const rawTools = source.tools === undefined
    ? []
    : dataArray(source.tools, 128, "tools", true);
  if (rawTools.length > 0) {
    if (!model.supportsTools || !model.supportsStrictTools) fail("CAPABILITY_UNSUPPORTED", "tools");
    const tools = rawTools.map((tool) => mapTool(tool as ProviderTool));
    const names = tools.map((tool) => (tool as { name: string }).name);
    if (new Set(names).size !== names.length) fail("BAD_REQUEST", "duplicate tool name");
    body.tools = tools;
    if (source.toolChoice !== undefined &&
        (typeof source.toolChoice !== "string" || !["none", "auto", "required"].includes(source.toolChoice))) {
      fail("BAD_REQUEST", "tool choice");
    }
    body.tool_choice = (source.toolChoice ?? "auto") as "none" | "auto" | "required";
    if (source.parallelToolCalls !== undefined && typeof source.parallelToolCalls !== "boolean") {
      fail("BAD_REQUEST", "parallel tool calls");
    }
    if (source.parallelToolCalls === true && !model.supportsParallelToolCalls) {
      fail("CAPABILITY_UNSUPPORTED", "parallel tool calls");
    }
    body.parallel_tool_calls = source.parallelToolCalls ?? false;
  } else {
    if (source.toolChoice !== undefined && source.toolChoice !== "none") {
      fail("BAD_REQUEST", "tool controls without tools");
    }
    if (source.parallelToolCalls !== undefined && source.parallelToolCalls !== false) {
      fail("BAD_REQUEST", "tool controls without tools");
    }
  }

  const hasFunctionResult = mappedInput.some((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item) &&
    item.type === "function_call_output");
  if (hasFunctionResult && !body.tools) fail("BAD_REQUEST", "function result without tool loop");

  if (source.reasoning !== undefined) {
    const reasoning = mapReasoning(source.reasoning as NonNullable<ProviderRequest["reasoning"]>, model);
    if (reasoning) body.reasoning = reasoning;
  }
  if (source.plainCompletion === true) {
    if (body.tools || Number(source.maxAgentTurns) !== 1) {
      fail("CAPABILITY_UNSUPPORTED", "plain completion controls");
    }
  }
  if (source.text !== undefined) body.text = mapText(source.text as ProviderTextOutput, model);

  const maxOutputTokens = Number(source.maxOutputTokens);
  if (model.maxOutputTokens !== null) {
    if (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0 ||
        maxOutputTokens > model.maxOutputTokens) fail("CAPABILITY_UNSUPPORTED", "max output tokens");
    body.max_output_tokens = maxOutputTokens;
  }

  if (source.continuation !== undefined) {
    const continuation = dataRecord(source.continuation, "continuation");
    exactKeys(continuation, ["token"], ["token"], "continuation");
    const token = boundedString(continuation.token, MAX_CONTINUATION_BYTES, "continuation token");
    if (/\p{Cc}/u.test(token)) fail("BAD_REQUEST", "continuation token");
    body.previous_response_id = token;
  }

  if (source.cache !== undefined) {
    const cache = dataRecord(source.cache, "cache");
    exactKeys(cache, ["mode", "key", "ttl"], ["mode"], "cache");
    if (typeof cache.mode !== "string" ||
        !["none", "implicit", "explicit"].includes(cache.mode)) fail("BAD_REQUEST", "cache mode");
    const cacheMode = cache.mode as "none" | "implicit" | "explicit";
    if (cacheMode === "none") {
      if (cache.key !== undefined || cache.ttl !== undefined) fail("BAD_REQUEST", "disabled cache fields");
    } else {
      if (!model.supportsPromptCacheKey) fail("CAPABILITY_UNSUPPORTED", "prompt cache key");
      const key = boundedString(cache.key, 64, "prompt cache key");
      if (!SAFE_CACHE_KEY.test(key)) fail("BAD_REQUEST", "prompt cache key");
      body.prompt_cache_key = key;
      if (cache.ttl !== undefined && cache.ttl !== "30m") fail("BAD_REQUEST", "prompt cache TTL");
      if (cacheMode === "explicit" && !model.supportsPromptCacheOptions) {
        fail("CAPABILITY_UNSUPPORTED", "prompt cache options");
      }
      if (model.supportsPromptCacheOptions) {
        body.prompt_cache_options = { mode: cacheMode, ttl: "30m" };
      }
    }
  }

  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > CHATGPT_MAX_REQUEST_BYTES) fail("BAD_REQUEST", "request size");
  return deepFreeze(body);
}

export function buildChatGptRequest(
  request: ProviderRequest,
  model: ProviderModel,
): Readonly<ChatGptResponsesRequest> {
  try {
    return buildChatGptRequestUnchecked(request, model);
  } catch (error) {
    if (error instanceof ChatGptRequestError) throw error;
    throw new ChatGptRequestError("BAD_REQUEST", "invalid request structure");
  }
}
