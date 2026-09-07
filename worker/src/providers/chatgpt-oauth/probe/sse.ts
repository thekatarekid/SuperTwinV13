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
  responseId?: string;
  usage?: SseUsageProjection;
  stoppedEarly: boolean;
}

export interface SseProbeOptions {
  /** Compatibility name; now stops only after a substantive text/tool delta. */
  stopAfterFirstEvent?: boolean;
  stopAfterFirstSubstantiveDelta?: boolean;
}

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

function eventResponseId(event: Record<string, unknown>): string | undefined {
  if (typeof event.response_id === "string") return event.response_id;
  const response = event.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const id = (response as Record<string, unknown>).id;
    if (typeof id === "string" && id.length <= 256) return id;
  }
  return undefined;
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
  let stoppedEarly = false;
  let responseId: string | undefined;
  let usage: SseUsageProjection | undefined;
  const eventTypes: string[] = [];

  const processBlock = (block: string): boolean => {
    const event = parseEventBlock(block);
    if (!event) return true;
    eventCount += 1;
    if (eventCount > MAX_SSE_EVENTS) throw new Error("Codex SSE event limit exceeded");
    const type = typeof event.type === "string" ? event.type : "<missing>";
    eventTypes.push(type);
    if (isSubstantiveDelta(event, type)) substantiveDeltaCount += 1;
    completed ||= type === "response.completed";
    incomplete ||= type === "response.incomplete";
    failed ||= type === "response.failed";
    error ||= type === "error";
    terminal ||= completed || incomplete || failed || error;
    responseId = eventResponseId(event) ?? responseId;
    usage = eventUsage(event) ?? usage;
    if ((options.stopAfterFirstEvent || options.stopAfterFirstSubstantiveDelta) &&
        isSubstantiveDelta(event, type)) {
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
          await reader.cancel();
          return { bytes, eventCount, substantiveDeltaCount, eventTypes, terminal, completed, incomplete, failed, error, responseId, usage, stoppedEarly };
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
  } finally {
    reader.releaseLock();
  }

  return { bytes, eventCount, substantiveDeltaCount, eventTypes, terminal, completed, incomplete, failed, error, responseId, usage, stoppedEarly };
}
