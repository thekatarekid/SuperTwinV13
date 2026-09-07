export const MAX_SSE_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SSE_LINE_BYTES = 64 * 1024;
export const MAX_SSE_EVENT_BYTES = 64 * 1024;
export const MAX_SSE_EVENTS = 10_000;

export interface SseUsageProjection {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface SseFunctionCallEvidence {
  /** Present only when the name matches the bounded tool-name allowlist. */
  name?: string;
  argumentBytes: number;
  argumentsJsonValid: boolean;
  argumentsMatchProbeEchoSchema: boolean;
}

export interface SseProbeEvidence {
  bytes: number;
  eventCount: number;
  substantiveDeltaCount: number;
  eventTypes: string[];
  terminal: boolean;
  completed: boolean;
  incomplete: boolean;
  failed: boolean;
  error: boolean;
  restrictionSignal: boolean;
  outputTextBytes: number;
  substantiveOutput: boolean;
  outputJsonValid: boolean;
  outputJsonObject: boolean;
  outputMatchesExactOkBooleanSchema: boolean;
  functionCalls: SseFunctionCallEvidence[];
  invalidFunctionNameCount: number;
  usagePresent: boolean;
  responseId?: string;
  usage?: SseUsageProjection;
  stoppedEarly: boolean;
}

const SAFE_FUNCTION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FUNCTION_CALLS = 128;

export interface SseProbeOptions {
  /** Compatibility name; now stops only after a substantive text/tool delta. */
  stopAfterFirstEvent?: boolean;
  stopAfterFirstSubstantiveDelta?: boolean;
  onFirstSubstantiveDelta?(): void;
  isRequestAborted?(): boolean;
}

const RESTRICTION_SIGNAL_RE = /(?:rate[_ -]?limit(?:ed|.{0,30}(?:exceed|restrict|error))|quota.{0,24}(?:exceed|exhaust|restrict|error)|captcha|cloudflare|account.{0,24}(?:flag|restrict|warn|suspend)|subscription.{0,24}(?:restrict|cancel|suspend|disrupt)|token.{0,24}revok|suspicious activity|verify.{0,20}(?:human|identity))/i;

function record(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function projectUsage(value: unknown): SseUsageProjection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const inputDetails = raw.input_tokens_details && typeof raw.input_tokens_details === "object" &&
    !Array.isArray(raw.input_tokens_details)
    ? raw.input_tokens_details as Record<string, unknown>
    : {};
  const outputDetails = raw.output_tokens_details && typeof raw.output_tokens_details === "object" &&
    !Array.isArray(raw.output_tokens_details)
    ? raw.output_tokens_details as Record<string, unknown>
    : {};
  const projected: SseUsageProjection = {
    inputTokens: record(raw, "input_tokens"),
    outputTokens: record(raw, "output_tokens"),
    totalTokens: record(raw, "total_tokens"),
    cachedInputTokens: record(inputDetails, "cached_tokens") ?? record(raw, "cached_input_tokens"),
    reasoningTokens: record(outputDetails, "reasoning_tokens") ?? record(raw, "reasoning_tokens"),
    cacheWriteInputTokens:
      record(inputDetails, "cache_write_tokens") ??
      record(inputDetails, "cache_creation_tokens") ??
      record(raw, "cache_write_input_tokens") ??
      record(raw, "cache_creation_input_tokens"),
  };
  return Object.values(projected).some((candidate) => candidate !== undefined)
    ? Object.fromEntries(
      Object.entries(projected).filter(([, candidate]) => candidate !== undefined),
    ) as SseUsageProjection
    : undefined;
}

function eventUsage(event: Record<string, unknown>): SseUsageProjection | undefined {
  const direct = projectUsage(event.usage);
  if (direct) return direct;
  const response = event.response;
  return response && typeof response === "object" && !Array.isArray(response)
    ? projectUsage((response as Record<string, unknown>).usage)
    : undefined;
}

function eventHasUsage(event: Record<string, unknown>): boolean {
  if (event.usage !== undefined) return true;
  const response = event.response;
  return Boolean(response && typeof response === "object" && !Array.isArray(response) &&
    (response as Record<string, unknown>).usage !== undefined);
}

function eventResponseId(event: Record<string, unknown>): string | undefined {
  if (typeof event.response_id === "string") return event.response_id;
  const response = event.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const id = (response as Record<string, unknown>).id;
    if (typeof id === "string" && id.length <= 256) return id;
  }
  return undefined;
}

function hasRestrictionSignal(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === "string") return value.length <= 4_096 && RESTRICTION_SIGNAL_RE.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.slice(0, 32).some((item) => hasRestrictionSignal(item, depth + 1));
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 64)
    .some(([key, item]) => RESTRICTION_SIGNAL_RE.test(key) || hasRestrictionSignal(item, depth + 1));
}

function parseEventBlock(block: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(block, "utf8") > MAX_SSE_EVENT_BYTES) {
    throw new Error("Codex SSE event limit exceeded");
  }
  for (const line of block.split("\n")) {
    if (Buffer.byteLength(line, "utf8") > MAX_SSE_LINE_BYTES) {
      throw new Error("Codex SSE line limit exceeded");
    }
  }
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    throw new Error("Malformed JSON in Codex SSE event");
  }
}

function isSubstantiveDelta(event: Record<string, unknown>, type: string): boolean {
  const delta = event.delta;
  if (typeof delta !== "string" || delta.length === 0) return false;
  return type === "response.output_text.delta" ||
    type === "response.function_call_arguments.delta" ||
    type.includes("tool_call") && type.endsWith(".delta");
}

function outputTextFromItem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.type !== "message" || !Array.isArray(item.content)) return undefined;
  const parts = item.content.flatMap((content) => {
    if (!content || typeof content !== "object" || Array.isArray(content)) return [];
    const part = content as Record<string, unknown>;
    return part.type === "output_text" && typeof part.text === "string" ? [part.text] : [];
  });
  return parts.length ? parts.join("") : undefined;
}

function jsonFlags(text: string): Pick<
  SseProbeEvidence,
  "outputJsonValid" | "outputJsonObject" | "outputMatchesExactOkBooleanSchema"
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { outputJsonValid: false, outputJsonObject: false, outputMatchesExactOkBooleanSchema: false };
  }
  const object = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const exact = object && Object.keys(parsed as Record<string, unknown>).length === 1 &&
    typeof (parsed as Record<string, unknown>).ok === "boolean";
  return { outputJsonValid: true, outputJsonObject: object, outputMatchesExactOkBooleanSchema: exact };
}

export async function consumeBoundedSse(
  response: Response,
  options: SseProbeOptions = {},
): Promise<SseProbeEvidence> {
  if (!response.body) throw new Error("Codex SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let eventCount = 0;
  let substantiveDeltaCount = 0;
  let terminal = false;
  let completed = false;
  let incomplete = false;
  let failed = false;
  let error = false;
  let restrictionSignal = false;
  let stoppedEarly = false;
  let responseId: string | undefined;
  let usage: SseUsageProjection | undefined;
  let usagePresent = false;
  let outputTextDeltas = "";
  let authoritativeOutputText: string | undefined;
  let substantiveOutput = false;
  let invalidFunctionNameCount = 0;
  let anonymousFunctionSequence = 0;
  let currentFunctionKey: string | undefined;
  const functionCalls = new Map<string, { name?: string; arguments: string; invalidName: boolean }>();
  const eventTypes: string[] = [];

  const functionKey = (event: Record<string, unknown>, item?: Record<string, unknown>): string => {
    const raw = event.item_id ?? event.call_id ?? item?.id ?? item?.call_id;
    if (typeof raw === "string" && raw) return raw;
    if (currentFunctionKey) return currentFunctionKey;
    anonymousFunctionSequence += 1;
    return `anonymous-${anonymousFunctionSequence}`;
  };

  const recordFunction = (event: Record<string, unknown>, type: string): void => {
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ? event.item as Record<string, unknown>
      : undefined;
    const isItem = item?.type === "function_call" || item?.type === "tool_call";
    const isArgumentsEvent = type.includes("function_call_arguments") || type.includes("tool_call");
    if (!isItem && !isArgumentsEvent) return;
    const key = functionKey(event, item);
    currentFunctionKey = key;
    let state = functionCalls.get(key);
    if (!state) {
      if (functionCalls.size >= MAX_FUNCTION_CALLS) throw new Error("Codex SSE function-call limit exceeded");
      state = { arguments: "", invalidName: false };
      functionCalls.set(key, state);
    }
    const rawName = item?.name ?? event.name;
    if (typeof rawName === "string") {
      if (SAFE_FUNCTION_NAME_RE.test(rawName)) state.name = rawName;
      else if (!state.invalidName) {
        state.invalidName = true;
        invalidFunctionNameCount += 1;
      }
    }
    const authoritativeArguments = item?.arguments ??
      (type.endsWith(".done") ? event.arguments : undefined);
    if (typeof authoritativeArguments === "string") {
      state.arguments = authoritativeArguments;
    } else if (type.endsWith(".delta") && typeof event.delta === "string") {
      state.arguments += event.delta;
    }
    substantiveOutput ||= state.arguments.length > 0 || state.name !== undefined || state.invalidName;
  };

  const evidence = (): SseProbeEvidence => {
    const outputText = authoritativeOutputText ?? outputTextDeltas;
    const functions = [...functionCalls.values()].map(({ name, arguments: args }) => {
      let argumentsJsonValid = false;
      let argumentsMatchProbeEchoSchema = false;
      try {
        const parsed = JSON.parse(args) as unknown;
        argumentsJsonValid = true;
        argumentsMatchProbeEchoSchema = Boolean(
          parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          Object.keys(parsed as Record<string, unknown>).length === 1 &&
          typeof (parsed as Record<string, unknown>).value === "string",
        );
      } catch {
        // Validation evidence only; argument content is intentionally discarded.
      }
      return {
        ...(name ? { name } : {}),
        argumentBytes: Buffer.byteLength(args, "utf8"),
        argumentsJsonValid,
        argumentsMatchProbeEchoSchema,
      };
    });
    return {
      bytes,
      eventCount,
      substantiveDeltaCount,
      eventTypes,
      terminal,
      completed,
      incomplete,
      failed,
      error,
      restrictionSignal,
      outputTextBytes: Buffer.byteLength(outputText, "utf8"),
      substantiveOutput: substantiveOutput || outputText.length > 0 || functions.length > 0,
      ...jsonFlags(outputText),
      functionCalls: functions,
      invalidFunctionNameCount,
      usagePresent,
      responseId,
      usage,
      stoppedEarly,
    };
  };

  const processBlock = (block: string): boolean => {
    const event = parseEventBlock(block);
    if (!event) return true;
    eventCount += 1;
    if (eventCount > MAX_SSE_EVENTS) throw new Error("Codex SSE event limit exceeded");
    const type = typeof event.type === "string" ? event.type : "<missing>";
    eventTypes.push(type);
    const substantiveDelta = isSubstantiveDelta(event, type);
    if (substantiveDelta) substantiveDeltaCount += 1;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      outputTextDeltas += event.delta;
      substantiveOutput ||= event.delta.length > 0;
    }
    if (type === "response.output_text.done" && typeof event.text === "string") {
      authoritativeOutputText = event.text;
      substantiveOutput ||= event.text.length > 0;
    }
    const itemText = type === "response.output_item.done" ? outputTextFromItem(event.item) : undefined;
    if (itemText !== undefined) {
      authoritativeOutputText = itemText;
      substantiveOutput ||= itemText.length > 0;
    }
    recordFunction(event, type);
    completed ||= type === "response.completed";
    incomplete ||= type === "response.incomplete";
    failed ||= type === "response.failed";
    error ||= type === "error";
    restrictionSignal ||= hasRestrictionSignal(event);
    terminal ||= completed || incomplete || failed || error;
    responseId = eventResponseId(event) ?? responseId;
    usagePresent ||= eventHasUsage(event);
    usage = eventUsage(event) ?? usage;
    if ((options.stopAfterFirstEvent || options.stopAfterFirstSubstantiveDelta) &&
        isSubstantiveDelta(event, type)) {
      options.onFirstSubstantiveDelta?.();
      stoppedEarly = true;
      return false;
    }
    return true;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SSE_RESPONSE_BYTES) throw new Error("Codex SSE response limit exceeded");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_LINE_BYTES && !buffer.includes("\n\n")) {
        throw new Error("Codex SSE line limit exceeded");
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!processBlock(block)) {
          try {
            await reader.cancel();
          } catch (error) {
            // Aborting the request first may make cancel reject; that is expected
            // only after the substantive cancellation boundary was recorded.
            if (!stoppedEarly || options.isRequestAborted?.() !== true ||
                !(error instanceof DOMException) || error.name !== "AbortError") {
              throw new Error("Codex SSE reader cancellation failed", { cause: error });
            }
          }
          return evidence();
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
  } finally {
    reader.releaseLock();
  }

  return evidence();
}
