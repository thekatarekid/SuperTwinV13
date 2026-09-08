import type {
  NeutralProviderResult,
  ProviderJson,
  ProviderJsonObject,
  ProviderRequest,
  ProviderToolUseEvent,
  ProviderV2,
  Usage,
} from "./types.js";
import { emptyUsage } from "./usage.js";

const SAFE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_CONTINUATION = /^[A-Za-z0-9_-]{1,256}$/;

export type AgentTurnLoopErrorCode = "BAD_REQUEST";

export class AgentTurnLoopError extends Error {
  readonly code: AgentTurnLoopErrorCode;
  constructor(message: string) {
    super(message);
    this.name = "AgentTurnLoopError";
    this.code = "BAD_REQUEST";
  }
}

export interface AgentToolHandler {
  /** The caller owns compilation; the loop always passes the exact supplied schema. */
  validate(input: ProviderJson, suppliedSchema: ProviderJsonObject): boolean;
  execute(input: ProviderJson, context: { callId: string; signal?: AbortSignal }): Promise<string>;
}

export interface RunAgentTurnLoopOptions {
  provider: ProviderV2;
  request: ProviderRequest;
  toolHandlers: Readonly<Record<string, AgentToolHandler>>;
}

/** Production dispatch seam: function-tool requests cannot bypass the owned loop. */
export async function sendProviderRequest(options: RunAgentTurnLoopOptions): Promise<NeutralProviderResult> {
  return (options.request.tools?.length ?? 0) > 0
    ? runAgentTurnLoop(options)
    : options.provider.send(options.request);
}

function addUsage(total: Usage, next: Usage): Usage {
  const sumOptional = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + next.cacheCreationInputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + next.cacheReadInputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cachedInputTokens: sumOptional(total.cachedInputTokens, next.cachedInputTokens),
    cacheCreation5mInputTokens: sumOptional(total.cacheCreation5mInputTokens, next.cacheCreation5mInputTokens),
    cacheCreation1hInputTokens: sumOptional(total.cacheCreation1hInputTokens, next.cacheCreation1hInputTokens),
    costUsd: sumOptional(total.costUsd, next.costUsd),
  };
}

function checkedCalls(
  calls: ProviderToolUseEvent[],
  suppliedTools: ReadonlyMap<string, ProviderJsonObject>,
  handlers: Readonly<Record<string, AgentToolHandler>>,
  seenCallIds: Set<string>,
): Array<{ call: ProviderToolUseEvent; handler: AgentToolHandler }> {
  return calls.map((call) => {
    if (!SAFE_CALL_ID.test(call.callId) || Buffer.byteLength(call.callId, "utf8") > 256 || seenCallIds.has(call.callId)) {
      throw new AgentTurnLoopError("Provider returned a duplicate or missing tool call id");
    }
    seenCallIds.add(call.callId);
    const suppliedSchema = suppliedTools.get(call.name);
    const handler = suppliedSchema ? handlers[call.name] : undefined;
    if (!suppliedSchema || !handler) throw new AgentTurnLoopError("Provider requested a tool that was not supplied");
    let valid = false;
    try { valid = handler.validate(call.input, suppliedSchema); } catch { valid = false; }
    if (!valid) throw new AgentTurnLoopError("Provider tool arguments did not match the supplied schema");
    return { call, handler };
  });
}

/**
 * Execute a bounded SuperTwin-owned model/tool loop. Each provider.send is one
 * model turn. This layer performs no provider selection, fallback, or retry.
 */
export async function runAgentTurnLoop(
  options: RunAgentTurnLoopOptions,
): Promise<NeutralProviderResult> {
  const { provider, request } = options;
  if (!Number.isSafeInteger(request.maxAgentTurns) || request.maxAgentTurns < 1 || request.maxAgentTurns > 64) {
    throw new AgentTurnLoopError("maxAgentTurns must be an integer from 1 to 64");
  }
  const suppliedTools = new Map(request.tools?.map((tool) => [tool.name, tool.parameters]) ?? []);
  if (suppliedTools.size !== (request.tools?.length ?? 0)) {
    throw new AgentTurnLoopError("Tool names must be unique");
  }
  const seenCallIds = new Set<string>();
  let nextRequest = request;
  let totalUsage = emptyUsage();
  let anyFreshFallback = false;

  for (let turn = 1; turn <= request.maxAgentTurns; turn += 1) {
    const calls: ProviderToolUseEvent[] = [];
    let uncorrelatedToolCall = false;
    const result = await provider.send({
      ...nextRequest,
      onEvent: (event) => {
        if (event.type === "tool_use") {
          if (typeof event.callId === "string") calls.push(event as ProviderToolUseEvent);
          else uncorrelatedToolCall = true;
        }
        request.onEvent(event);
      },
    });
    totalUsage = addUsage(totalUsage, result.usage);
    anyFreshFallback ||= result.freshFallback;
    if (uncorrelatedToolCall) {
      throw new AgentTurnLoopError("Provider returned a tool call without a correlation id");
    }
    if (result.status === "error") {
      return { ...result, usage: totalUsage, freshFallback: anyFreshFallback };
    }
    if (request.toolChoice === "none" && calls.length > 0) {
      throw new AgentTurnLoopError("Provider returned a tool call when toolChoice was none");
    }
    if (request.toolChoice === "required" && calls.length === 0) {
      throw new AgentTurnLoopError("Provider returned no tool call when toolChoice was required");
    }
    if (calls.length === 0) return { ...result, usage: totalUsage, freshFallback: anyFreshFallback };

    if (typeof result.continuation !== "string" ||
        Buffer.byteLength(result.continuation, "utf8") > 256 ||
        !SAFE_CONTINUATION.test(result.continuation)) {
      throw new AgentTurnLoopError("Provider returned an invalid continuation token");
    }

    const checked = checkedCalls(calls, suppliedTools, options.toolHandlers, seenCallIds);
    if (turn === request.maxAgentTurns) {
      return {
        continuation: result.continuation,
        usage: totalUsage,
        freshFallback: anyFreshFallback,
        status: "error",
        errorCode: "MAX_TURNS",
      };
    }
    const execute = async ({ call, handler }: typeof checked[number]) => ({
      type: "function_call_output" as const,
      call_id: call.callId,
      output: await handler.execute(call.input, { callId: call.callId, signal: request.signal }),
    });
    const outputs = request.parallelToolCalls
      ? await Promise.all(checked.map(execute))
      : await checked.reduce<Promise<Array<Awaited<ReturnType<typeof execute>>>>>(
          async (prior, item) => [...await prior, await execute(item)],
          Promise.resolve([]),
        );
    nextRequest = {
      ...request,
      input: outputs,
      continuation: { token: result.continuation },
    };
  }
  throw new AgentTurnLoopError("Unreachable agent loop state");
}
