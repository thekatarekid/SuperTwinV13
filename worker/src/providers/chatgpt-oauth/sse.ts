import type {
  ProviderErrorCode,
  ProviderJson,
  ProviderStreamEvent,
  Usage,
} from "../types.js";
import { ChatGptUsageError, parseChatGptUsage } from "./usage.js";

export const MAX_SSE_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SSE_LINE_BYTES = 64 * 1024;
export const MAX_SSE_EVENT_BYTES = 64 * 1024;
export const MAX_SSE_EVENTS = 10_000;
export const MAX_SSE_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SSE_TOOL_CALLS = 128;
export const MAX_SSE_TOOL_ARGUMENT_BYTES = 256 * 1024;
export const MAX_SSE_TOTAL_TOOL_ARGUMENT_BYTES = 1024 * 1024;
export const MAX_SSE_ERROR_BYTES = 8 * 1024;
export const MAX_SSE_IDENTIFIER_BYTES = 256;

const RESPONSE_ID_RE = /^[A-Za-z0-9_-]+$/;
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;

const IGNORED_EVENT_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
]);

export interface ChatGptSseOptions {
  onEvent(event: ProviderStreamEvent): void;
  signal?: AbortSignal;
  /** Only explicit interactive callers may retain a response continuation. */
  persistContinuation?: boolean;
  /** Exact request tool names; an unrequested tool call fails closed. */
  allowedToolNames?: readonly string[];
}

export interface ChatGptSseResult {
  continuation: string | null;
  usage: Usage;
  status: "ok" | "error";
  errorCode?: ProviderErrorCode;
  stopReason?: string;
}

/** Fixed-message parser failure. Raw backend values are never attached. */
export class ChatGptSseError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ChatGptSseError";
    this.code = code;
  }
}

interface ToolState {
  /** Stable item identifier used only to correlate stream fragments. */
  itemId: string;
  /** Function-call protocol identifier returned to the caller when present. */
  callId: string | null;
  name: string | null;
  arguments: string;
  argumentBytes: number;
  emitted: boolean;
}

function emptyChatGptUsage(): Usage {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || !RESPONSE_ID_RE.test(value)) return null;
  return Buffer.byteLength(value, "utf8") <= MAX_SSE_IDENTIFIER_BYTES ? value : null;
}

function parseUsage(value: unknown): Usage | null {
  const raw = object(value);
  if (!raw) return null;
  if (!Object.hasOwn(raw, "input_tokens") && !Object.hasOwn(raw, "output_tokens")) return null;
  try {
    return parseChatGptUsage(raw).usage;
  } catch (error) {
    if (!(error instanceof ChatGptUsageError)) throw error;
    throw new ChatGptSseError(
      "BACKEND_UNSUPPORTED",
      "ChatGPT stream contained invalid usage counters",
    );
  }
}

function errorPayload(event: Record<string, unknown>): unknown {
  if (event.type === "response.failed") return object(event.response)?.error;
  if (event.type === "response.incomplete") {
    return object(event.response)?.incomplete_details ?? event.incomplete_details;
  }
  return event.error ?? event;
}

function enforceErrorBound(event: Record<string, unknown>): void {
  const serialized = JSON.stringify(errorPayload(event) ?? null);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SSE_ERROR_BYTES) {
    throw new ChatGptSseError(
      "BACKEND_UNSUPPORTED",
      "ChatGPT stream exceeded the error payload limit",
    );
  }
}

function remoteErrorCode(event: Record<string, unknown>): ProviderErrorCode {
  const payload = object(errorPayload(event));
  const raw = payload?.code ?? payload?.type ?? object(event.response)?.status;
  if (typeof raw !== "string") return "BACKEND_UNSUPPORTED";
  switch (raw) {
    case "rate_limit_exceeded":
    case "rate_limit_error":
    case "too_many_requests":
      return "RATE_LIMITED";
    case "insufficient_quota":
    case "quota_exceeded":
      return "QUOTA_EXCEEDED";
    case "authentication_error":
    case "invalid_token":
    case "token_expired":
    case "unauthorized":
      return "AUTH_EXPIRED";
    case "cancelled":
    case "canceled":
      return "CANCELLED";
    case "invalid_request":
    case "invalid_request_error":
    case "invalid_value":
    case "invalid_type":
    case "missing_required_parameter":
    case "unknown_parameter":
    case "unsupported_value":
    case "context_length_exceeded":
      return "BAD_REQUEST";
    case "server_error":
    case "api_error":
    case "internal_server_error":
      return "TRANSPORT_ERROR";
    default:
      return "BACKEND_UNSUPPORTED";
  }
}

function publicErrorMessage(code: ProviderErrorCode): string {
  switch (code) {
    case "RATE_LIMITED": return "ChatGPT rate limit reached";
    case "QUOTA_EXCEEDED": return "ChatGPT quota exceeded";
    case "AUTH_REQUIRED": return "ChatGPT sign-in required";
    case "AUTH_EXPIRED": return "ChatGPT sign-in expired";
    case "CANCELLED": return "ChatGPT request cancelled";
    case "BAD_REQUEST": return "ChatGPT rejected the request";
    case "TRANSPORT_ERROR": return "ChatGPT transport failed";
    case "BACKEND_UNSUPPORTED": return "ChatGPT stream format is unsupported";
    default: return `ChatGPT request failed (${code})`;
  }
}

const PUBLIC_REFUSAL_MESSAGE = "ChatGPT refusal (usage limit or policy)";

function parseEventBlock(block: string): Record<string, unknown> | null {
  if (Buffer.byteLength(block, "utf8") > MAX_SSE_EVENT_BYTES) {
    throw new ChatGptSseError(
      "BACKEND_UNSUPPORTED",
      "ChatGPT stream exceeded the event limit",
    );
  }
  const lines = block.split("\n");
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_SSE_LINE_BYTES) {
      throw new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT stream exceeded the line limit",
      );
    }
  }
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line[5] === " " ? line.slice(6) : line.slice(5))
    .join("\n");
  if (!data || data === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ChatGptSseError(
      "BACKEND_UNSUPPORTED",
      "ChatGPT stream contained malformed JSON",
    );
  }
  const event = object(parsed);
  if (!event || typeof event.type !== "string") {
    throw new ChatGptSseError(
      "BACKEND_UNSUPPORTED",
      "ChatGPT stream contained a malformed event",
    );
  }
  return event;
}

function outputTextFromItem(value: unknown): string | null {
  const item = object(value);
  if (item?.type !== "message" || !Array.isArray(item.content)) return null;
  const parts: string[] = [];
  for (const rawPart of item.content) {
    const part = object(rawPart);
    if (part?.type === "output_text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.length ? parts.join("") : null;
}

function isProviderJson(
  value: unknown,
  budget: { nodes: number },
  depth = 0,
): value is ProviderJson {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isProviderJson(item, budget, depth + 1));
  }
  if (!object(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((item) => isProviderJson(item, budget, depth + 1));
}

/**
 * Incrementally consume one ChatGPT Responses SSE body. Backend failures are
 * normalized into a returned result; malformed/truncated streams throw a
 * fixed-message ChatGptSseError after emitting one normalized error event.
 */
export async function consumeChatGptSse(
  response: Response,
  options: ChatGptSseOptions,
): Promise<ChatGptSseResult> {
  const fallbackUsage = emptyChatGptUsage();
  let emittedError = false;
  const emit = (event: ProviderStreamEvent): void => {
    try {
      options.onEvent(event);
    } catch {
      throw new ChatGptSseError(
        "TRANSPORT_ERROR",
        "ChatGPT stream consumer failed",
      );
    }
  };
  const emitError = (
    code: ProviderErrorCode,
    message = publicErrorMessage(code),
  ): void => {
    if (emittedError) return;
    emittedError = true;
    emit({ type: "error", code, message });
  };
  const fail = (error: ChatGptSseError): never => {
    try {
      emitError(error.code);
    } catch {
      // Preserve the parser's fixed, already-redacted primary failure.
    }
    throw error;
  };
  if (options.signal?.aborted) {
    const code: ProviderErrorCode = "CANCELLED";
    emitError(code);
    return {
      continuation: null,
      usage: fallbackUsage,
      status: "error",
      errorCode: code,
      stopReason: "cancelled",
    };
  }

  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/event-stream") {
    fail(new ChatGptSseError(
      "BACKEND_UNSUPPORTED",
      "ChatGPT response was not an event stream",
    ));
  }
  const body = response.body;
  if (!body) return fail(
    new ChatGptSseError("TRANSPORT_ERROR", "ChatGPT response had no body"),
  );

  const allowedToolNames = new Set(options.allowedToolNames ?? []);
  if (allowedToolNames.size !== (options.allowedToolNames?.length ?? 0) ||
      [...allowedToolNames].some((name) => !TOOL_NAME_RE.test(name))) {
    fail(new ChatGptSseError("BAD_REQUEST", "ChatGPT tool allowlist is invalid"));
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const tools = new Map<string, ToolState>();
  const toolAliases = new Map<string, ToolState>();
  let buffer = "";
  let responseBytes = 0;
  let eventCount = 0;
  let outputText = "";
  let outputBytes = 0;
  let refusalText = "";
  let refused = false;
  let usage = fallbackUsage;
  let usagePresent = false;
  let createdResponseId: string | null = null;
  let terminal = false;
  let signalAborted = options.signal?.aborted === true;

  const abortReader = (): void => {
    signalAborted = true;
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abortReader, { once: true });

  const checkedOutput = (text: string, authoritative = false): void => {
    if (authoritative && outputText.length > 0) {
      if (text !== outputText) {
        fail(new ChatGptSseError(
          "BACKEND_UNSUPPORTED",
          "ChatGPT stream output did not match its terminal item",
        ));
      }
      return;
    }
    const addedBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes + addedBytes > MAX_SSE_OUTPUT_BYTES) {
      fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT stream exceeded the output limit",
      ));
    }
    if (text.length > 0) {
      outputText += text;
      outputBytes += addedBytes;
      emit({ type: "delta", text });
    }
  };

  const checkedRefusal = (text: string, authoritative = false): void => {
    if (authoritative && refusalText.length > 0) {
      if (text !== refusalText) {
        fail(new ChatGptSseError(
          "BACKEND_UNSUPPORTED",
          "ChatGPT refusal did not match its terminal item",
        ));
      }
    } else {
      refusalText += text;
    }
    if (Buffer.byteLength(refusalText, "utf8") > MAX_SSE_ERROR_BYTES) {
      fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream exceeded the refusal limit"));
    }
    refused = true;
  };

  const checkedToolState = (identifier: string): ToolState => {
    const existing = toolAliases.get(identifier);
    if (existing) return existing;
    if (tools.size >= MAX_SSE_TOOL_CALLS) {
      fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT stream exceeded the tool-call limit",
      ));
    }
    const state: ToolState = {
      itemId: identifier,
      callId: null,
      name: null,
      arguments: "",
      argumentBytes: 0,
      emitted: false,
    };
    tools.set(identifier, state);
    toolAliases.set(identifier, state);
    return state;
  };

  const bindToolAlias = (state: ToolState, identifier: string): void => {
    const existing = toolAliases.get(identifier);
    if (existing && existing !== state) {
      return fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT stream reused a tool identifier",
      ));
    }
    toolAliases.set(identifier, state);
  };

  let totalToolArgumentBytes = 0;
  const setToolArguments = (state: ToolState, value: string): void => {
    const nextBytes = Buffer.byteLength(value, "utf8");
    const nextTotal = totalToolArgumentBytes - state.argumentBytes + nextBytes;
    if (nextBytes > MAX_SSE_TOOL_ARGUMENT_BYTES ||
        nextTotal > MAX_SSE_TOTAL_TOOL_ARGUMENT_BYTES) {
      fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT stream exceeded the tool-argument limit",
      ));
    }
    state.arguments = value;
    state.argumentBytes = nextBytes;
    totalToolArgumentBytes = nextTotal;
  };

  const setToolName = (state: ToolState, value: unknown): void => {
    if (value === undefined) return;
    if (typeof value !== "string" || !TOOL_NAME_RE.test(value) ||
        !allowedToolNames.has(value) || (state.name !== null && state.name !== value)) {
      return fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT emitted an invalid or unrequested tool call",
      ));
    }
    state.name = value;
  };

  const emitTool = (state: ToolState): void => {
    if (state.emitted) return;
    const name = state.name;
    if (!name) {
      return fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT emitted an incomplete tool call",
      ));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(state.arguments);
    } catch {
      fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT emitted malformed tool arguments",
      ));
    }
    if (!isProviderJson(parsed, { nodes: 0 })) {
      return fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT emitted unsupported tool arguments",
      ));
    }
    state.emitted = true;
    const callId = state.callId ?? state.itemId;
    emit({
      type: "tool_use",
      callId,
      name,
      input: parsed as ProviderJson,
    });
  };

  const terminalError = (
    code: ProviderErrorCode,
    stopReason: string,
    message?: string,
  ): ChatGptSseResult => {
    emitError(code, message);
    terminal = true;
    return { continuation: null, usage, status: "error", errorCode: code, stopReason };
  };

  const processEvent = (event: Record<string, unknown>): ChatGptSseResult | null => {
    eventCount += 1;
    if (eventCount > MAX_SSE_EVENTS) {
      fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT stream exceeded the event-count limit",
      ));
    }
    const type = event.type as string;
    if (terminal) {
      fail(new ChatGptSseError(
        "BACKEND_UNSUPPORTED",
        "ChatGPT stream emitted data after completion",
      ));
    }
    if (IGNORED_EVENT_TYPES.has(type)) {
      if (type === "response.created") {
        const rawId = object(event.response)?.id;
        if (rawId !== undefined) {
          createdResponseId = boundedIdentifier(rawId);
          if (!createdResponseId) {
            fail(new ChatGptSseError(
              "BACKEND_UNSUPPORTED",
              "ChatGPT stream contained an invalid response identifier",
            ));
          }
        }
      }
      return null;
    }
    if (type === "response.output_text.delta" || type === "response.text.delta") {
      if (typeof event.delta !== "string") {
        fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained an invalid text delta"));
      }
      checkedOutput(event.delta as string);
      return null;
    }
    if (type === "response.output_text.done") {
      if (typeof event.text !== "string") {
        fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained invalid output text"));
      }
      checkedOutput(event.text as string, true);
      return null;
    }
    if (type === "response.refusal.delta" || type === "response.refusal.done") {
      const value = type.endsWith(".delta") ? event.delta : event.refusal;
      if (typeof value !== "string") {
        fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained an invalid refusal"));
      }
      checkedRefusal(value as string, type.endsWith(".done"));
      return null;
    }
    if (type === "response.content_part.added" || type === "response.content_part.done") {
      const part = object(event.part);
      if (!part || typeof part.type !== "string") return fail(
        new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained a malformed content part"),
      );
      if (part.type === "refusal") {
        const value = part.refusal;
        if (value !== undefined && typeof value !== "string") return fail(
          new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained an invalid refusal"),
        );
        if (typeof value === "string" && value.length > 0) {
          checkedRefusal(value, type.endsWith(".done"));
        } else {
          refused = true;
        }
      }
      return null;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = object(event.item);
      if (!item || typeof item.type !== "string") return fail(
        new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained a malformed output item"),
      );
      if (item.type === "function_call" || item.type === "tool_call") {
        const itemId = boundedIdentifier(item.id ?? item.call_id);
        if (!itemId) return fail(
          new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained an invalid tool identifier"),
        );
        const state = checkedToolState(itemId);
        const explicitCallId = item.call_id === undefined
          ? null
          : boundedIdentifier(item.call_id);
        if (item.call_id !== undefined && !explicitCallId) return fail(
          new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained an invalid tool identifier"),
        );
        if (explicitCallId) {
          if (state.callId !== null && state.callId !== explicitCallId) return fail(
            new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream changed a tool identifier"),
          );
          state.callId = explicitCallId;
          bindToolAlias(state, explicitCallId);
        }
        bindToolAlias(state, itemId);
        setToolName(state, item.name);
        if (typeof item.arguments === "string") {
          if (state.arguments.length > 0 &&
              state.arguments !== item.arguments &&
              !item.arguments.startsWith(state.arguments)) {
            fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT tool arguments were inconsistent"));
          }
          setToolArguments(state, item.arguments);
        }
        if (type.endsWith(".done")) emitTool(state);
        return null;
      }
      if (item.type === "message" && type.endsWith(".done")) {
        const text = outputTextFromItem(item);
        if (text !== null) checkedOutput(text, true);
        if (Array.isArray(item.content)) {
          for (const rawPart of item.content) {
            const part = object(rawPart);
            if (part?.type === "refusal" && typeof part.refusal === "string") {
              checkedRefusal(part.refusal, true);
            }
          }
        }
      }
      return null;
    }
    if (type === "response.function_call_arguments.delta" ||
        type === "response.function_call_arguments.done") {
      const callId = boundedIdentifier(event.call_id ?? event.item_id);
      if (!callId) return fail(
        new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained an invalid tool identifier"),
      );
      const state = checkedToolState(callId);
      if (event.call_id !== undefined) {
        const explicitCallId = boundedIdentifier(event.call_id);
        if (!explicitCallId || (state.callId !== null && state.callId !== explicitCallId)) {
          return fail(new ChatGptSseError(
            "BACKEND_UNSUPPORTED",
            "ChatGPT stream changed a tool identifier",
          ));
        }
        state.callId = explicitCallId;
        bindToolAlias(state, explicitCallId);
      }
      setToolName(state, event.name);
      if (type.endsWith(".delta")) {
        if (typeof event.delta !== "string") {
          fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained invalid tool arguments"));
        }
        setToolArguments(state, state.arguments + (event.delta as string));
      } else {
        if (typeof event.arguments !== "string") {
          fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained invalid tool arguments"));
        }
        if (state.arguments.length > 0 &&
            state.arguments !== event.arguments &&
            !(event.arguments as string).startsWith(state.arguments)) {
          fail(new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT tool arguments were inconsistent"));
        }
        setToolArguments(state, event.arguments as string);
      }
      if (type.endsWith(".done") && state.name) emitTool(state);
      return null;
    }
    if (type === "response.usage") {
      const parsed = parseUsage(event.usage);
      if (!parsed) return fail(
        new ChatGptSseError("BACKEND_UNSUPPORTED", "ChatGPT stream contained invalid usage"),
      );
      usage = parsed;
      usagePresent = true;
      emit({ type: "usage", usage });
      return null;
    }
    if (type === "response.completed") {
      const responseRecord = object(event.response);
      const parsedUsage = parseUsage(responseRecord?.usage ?? event.usage);
      if (parsedUsage) {
        usage = parsedUsage;
        usagePresent = true;
        emit({ type: "usage", usage });
      }
      if (!usagePresent) {
        return fail(new ChatGptSseError(
          "BACKEND_UNSUPPORTED",
          "ChatGPT completion omitted usage counters",
        ));
      }
      if (refused) {
        return terminalError("CLI_ERROR", "refusal", PUBLIC_REFUSAL_MESSAGE);
      }
      for (const state of tools.values()) emitTool(state);
      let continuation: string | null = null;
      if (options.persistContinuation) {
        continuation = boundedIdentifier(responseRecord?.id) ?? createdResponseId;
        if (!continuation) {
          return fail(new ChatGptSseError(
            "BACKEND_UNSUPPORTED",
            "ChatGPT completion omitted its continuation identifier",
          ));
        }
        emit({ type: "continuation", token: continuation });
      }
      emit({ type: "done", continuation, usage, stopReason: "completed" });
      terminal = true;
      return { continuation, usage, status: "ok", stopReason: "completed" };
    }
    if (type === "response.cancelled" || type === "response.canceled") {
      enforceErrorBound(event);
      return terminalError("CANCELLED", "cancelled");
    }
    if (type === "response.incomplete") {
      enforceErrorBound(event);
      const parsedUsage = parseUsage(object(event.response)?.usage ?? event.usage);
      if (parsedUsage) {
        usage = parsedUsage;
        usagePresent = true;
        emit({ type: "usage", usage });
      }
      return terminalError("CLI_ERROR", "incomplete");
    }
    if (type === "response.failed" || type === "error") {
      enforceErrorBound(event);
      const parsedUsage = parseUsage(object(event.response)?.usage ?? event.usage);
      if (parsedUsage) {
        usage = parsedUsage;
        usagePresent = true;
        emit({ type: "usage", usage });
      }
      return terminalError(remoteErrorCode(event), type === "error" ? "error" : "failed");
    }
    return fail(new ChatGptSseError(
      "BACKEND_UNSUPPORTED",
      "ChatGPT stream contained an unknown event type",
    ));
  };

  const cancelled = (): ChatGptSseResult => {
    const code: ProviderErrorCode = "CANCELLED";
    emitError(code);
    terminal = true;
    return {
      continuation: null,
      usage,
      status: "error",
      errorCode: code,
      stopReason: "cancelled",
    };
  };

  const readNext = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    try {
      return await reader.read();
    } catch {
      if (signalAborted || options.signal?.aborted) {
        return { done: true, value: undefined };
      }
      return fail(new ChatGptSseError("TRANSPORT_ERROR", "ChatGPT stream read failed"));
    }
  };

  try {
    if (signalAborted) return cancelled();
    while (true) {
      const read = await readNext();
      if (signalAborted || options.signal?.aborted) return cancelled();
      if (read.done) break;
      responseBytes += read.value.byteLength;
      if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
        fail(new ChatGptSseError(
          "BACKEND_UNSUPPORTED",
          "ChatGPT stream exceeded the response limit",
        ));
      }
      try {
        buffer += decoder.decode(read.value, { stream: true });
      } catch {
        fail(new ChatGptSseError("TRANSPORT_ERROR", "ChatGPT stream contained invalid UTF-8"));
      }
      if (buffer.startsWith("\uFEFF")) buffer = buffer.slice(1);
      buffer = buffer.replace(/\r\n/g, "\n");
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_LINE_BYTES &&
          !buffer.includes("\n\n")) {
        fail(new ChatGptSseError(
          "BACKEND_UNSUPPORTED",
          "ChatGPT stream exceeded the line limit",
        ));
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(block);
        if (event) {
          const result = processEvent(event);
          if (result) {
            await reader.cancel().catch(() => undefined);
            return result;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      fail(new ChatGptSseError("TRANSPORT_ERROR", "ChatGPT stream contained invalid UTF-8"));
    }
    if (buffer.trim()) {
      const event = parseEventBlock(buffer);
      if (event) {
        const result = processEvent(event);
        if (result) return result;
      }
    }
    if (signalAborted || options.signal?.aborted) return cancelled();
    return fail(new ChatGptSseError(
      "TRANSPORT_ERROR",
      "ChatGPT stream ended before a terminal event",
    ));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ChatGptSseError) return fail(error);
    return fail(new ChatGptSseError("TRANSPORT_ERROR", "ChatGPT stream processing failed"));
  } finally {
    options.signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

/** Exact alias for callers that prefer parser terminology. */
export const parseChatGptSse = consumeChatGptSse;
