import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { findProviderModel } from "../catalogue.js";
import type {
  LegacyProviderResult,
  LegacySendOptions,
  NeutralProviderResult,
  ProviderErrorCode,
  ProviderAuthState,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderV2,
} from "../types.js";
import { emptyUsage } from "../usage.js";
import { claudeProviderCatalogue } from "../catalogue.js";
import {
  buildChildEnv,
  isValidSessionId,
  PLAIN_COMPLETION_MAX_TURNS,
  resolveClaudeBin,
  safeCwd,
} from "./cli.js";
import { discoverClaudeModels } from "./discovery.js";
import { claudeLocalProvider } from "./index.js";

interface DirectClaudeLegacyTransport {
  sendWithDirectInstructions(
    options: Omit<LegacySendOptions, "systemPromptFile">,
    instructions: string,
    authState?: () => ProviderAuthState,
  ): Promise<LegacyProviderResult>;
  cancel(runId: string): boolean;
  killAll(): void;
}

export interface NeutralClaudeDependencies {
  legacy?: DirectClaudeLegacyTransport;
  catalogue?: () => ProviderModelCatalogue;
  supportsEffort?: (modelId: string) => boolean;
  authState?: () => ProviderAuthState;
}

const CONTINUATION_PREFIX = "claude-local:v1:";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const AUTH_STATUS_TIMEOUT_MS = 5_000;

function continuationBindingHash(model: string, instructions: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ providerId: "claude-local", model, instructions }), "utf8")
    .digest("hex");
}

function bindContinuation(sessionId: string, digest: string): string | null {
  return isValidSessionId(sessionId)
    ? `${CONTINUATION_PREFIX}${sessionId}:${digest}`
    : null;
}

function readContinuation(
  token: string,
  digest: string,
): { sessionId: string } | { error: string } {
  if (!token.startsWith(CONTINUATION_PREFIX)) {
    return { error: "Claude continuation is not bound to its original instructions" };
  }
  const suffix = token.slice(CONTINUATION_PREFIX.length);
  const split = suffix.lastIndexOf(":");
  if (split < 0) return { error: "Claude continuation has an invalid format" };
  const sessionId = suffix.slice(0, split);
  const boundDigest = suffix.slice(split + 1);
  if (!isValidSessionId(sessionId) || !SHA256_HEX_RE.test(boundDigest)) {
    return { error: "Claude continuation has an invalid format" };
  }
  if (boundDigest !== digest) {
    return { error: "Claude continuation does not match the session model and instructions" };
  }
  return { sessionId };
}

/**
 * Cheap local-only readiness probe. `claude auth status` reads the CLI's local
 * credential state; it does not run a model. Output is parsed only for state
 * and is never copied into the returned error, so account/token material
 * cannot cross the provider boundary.
 */
export function claudeLocalAuthState(
  run: typeof spawnSync = spawnSync,
): ProviderAuthState {
  const bin = resolveClaudeBin();
  const cwd = safeCwd();
  const result = run(bin, ["auth", "status"], {
    cwd,
    env: buildChildEnv(bin, false, cwd),
    encoding: "utf8",
    timeout: AUTH_STATUS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT" || errorCode === "EACCES") {
    return { status: "unavailable", error: "Claude CLI is unavailable" };
  }
  if (result.error) {
    return { status: "degraded", error: "Claude auth status could not be read" };
  }
  const output = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
  let loggedIn: boolean | undefined;
  try {
    const parsed = JSON.parse(String(result.stdout ?? "")) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === "boolean") loggedIn = parsed.loggedIn;
  } catch {
    // Older CLI builds report the same state as text rather than JSON.
  }
  if (loggedIn === false || /not\s+(?:logged|signed)\s+in|signed\s+out/i.test(output)) {
    return { status: "signed_out", error: null };
  }
  if (result.status === 0) {
    return { status: "ready", error: null };
  }
  return { status: "degraded", error: "Claude auth status is unavailable" };
}

function neutralCatalogue(catalogue: ProviderModelCatalogue): ProviderModelCatalogue {
  if (catalogue.providerId !== "claude-local") {
    throw new Error("Claude neutral adapter received another provider's catalogue");
  }
  const models = catalogue.models.map((model) => ({
    ...model,
    // The current transport consumes text and named host tools. Direct image
    // inputs and caller-supplied function schemas are not yet mapped.
    inputModalities: model.inputModalities.includes("text")
      ? ["text" as const]
      : [],
    supportsTools: false,
    supportsParallelToolCalls: false,
  }));
  return {
    ...catalogue,
    revision: createHash("sha256")
      .update(`${catalogue.revision}\0claude-neutral-v1`)
      .digest("hex"),
    models,
  };
}

function failed(
  request: ProviderRequest,
  code: ProviderErrorCode,
  message: string,
): NeutralProviderResult {
  request.onEvent({ type: "error", code, message });
  return {
    continuation: null,
    usage: emptyUsage(),
    freshFallback: false,
    status: "error",
    errorCode: code,
  };
}

function requestMessage(request: ProviderRequest): string | null {
  if (request.input.length !== 1) return null;
  const item = request.input[0];
  if (item?.type !== "message" || item.role !== "user" || item.content.length !== 1) {
    return null;
  }
  const content = item.content[0];
  return content?.type === "input_text" ? content.text : null;
}

function unsupportedFeature(request: ProviderRequest): string | null {
  if (request.input.some((item) =>
    item.type === "function_call_output" ||
    (item.type === "message" && item.content.some((part) => part.type === "input_image")))) {
    return "Claude's neutral adapter currently accepts one text input message";
  }
  if ((request.tools?.length ?? 0) > 0) {
    return "Claude's neutral adapter does not accept function-tool schemas";
  }
  if (request.toolChoice === "none" && (request.hostTools?.length ?? 0) > 0) {
    return "toolChoice none cannot be combined with Claude host tools";
  }
  if (request.toolChoice === "required") {
    return "Claude's neutral adapter cannot require a tool call";
  }
  if (request.parallelToolCalls !== undefined) {
    return "Claude's neutral adapter cannot enforce caller-selected tool parallelism";
  }
  if (request.text?.format.type === "json_schema" || request.text?.verbosity !== undefined) {
    return "Claude's neutral adapter does not implement structured output or verbosity";
  }
  if (request.cache !== undefined && (
    request.cache.mode !== "implicit" ||
    request.cache.key !== undefined ||
    request.cache.ttl !== undefined
  )) {
    return "Claude's neutral adapter only supports its implicit prompt cache";
  }
  return null;
}

function modernEvent(
  event: ProviderStreamEvent,
  digest: string,
): ProviderStreamEvent | null {
  if (event.type === "session") {
    const token = bindContinuation(event.sessionId, digest);
    return token ? { type: "continuation", token } : null;
  }
  if (event.type === "done") {
    const legacyContinuation = "continuation" in event
      ? event.continuation ?? null
      : event.sessionId || null;
    const continuation = legacyContinuation
      ? bindContinuation(legacyContinuation, digest)
      : null;
    return {
      type: "done",
      continuation,
      usage: event.usage,
      ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
    };
  }
  if (event.type === "error") {
    const legacyContinuation = event.continuation ?? event.sessionId;
    const continuation = legacyContinuation
      ? bindContinuation(legacyContinuation, digest) ?? undefined
      : undefined;
    return {
      type: "error",
      code: event.code,
      message: event.message,
      ...(continuation ? { continuation } : {}),
    };
  }
  if (event.type === "tool_use") {
    return typeof event.callId === "string" && event.callId.length > 0
      ? {
          type: "tool_use",
          callId: event.callId,
          name: event.name,
          input: event.input,
        }
      : null;
  }
  return event;
}

function classifyLegacyFailure(
  code: ProviderErrorCode | undefined,
  message: string | undefined,
): ProviderErrorCode | undefined {
  if (code === "SPAWN_FAILED") return "PROVIDER_UNAVAILABLE";
  if (code !== "CLI_ERROR") return code;
  const detail = message ?? "";
  if (/token[^\n]{0,32}expired|expired[^\n]{0,32}(?:token|credential)/i.test(detail)) {
    return "AUTH_EXPIRED";
  }
  if (
    /not\s+(?:logged|signed)\s+in|signed\s+out|authentication\s+required|please\s+(?:run\s+)?(?:claude\s+)?login/i
      .test(detail)
  ) {
    return "AUTH_REQUIRED";
  }
  return code;
}

export function createNeutralClaudeProvider(
  dependencies: NeutralClaudeDependencies = {},
): ProviderV2 {
  const legacy = dependencies.legacy ?? claudeLocalProvider;
  const readRawCatalogue = dependencies.catalogue ?? claudeProviderCatalogue;
  const readCatalogue = (): ProviderModelCatalogue => neutralCatalogue(readRawCatalogue());
  const supportsEffort = dependencies.supportsEffort ?? ((modelId: string) =>
    discoverClaudeModels().models.some((candidate) =>
      candidate.id === modelId && candidate.effort));
  const readAuthState = dependencies.authState ?? claudeLocalAuthState;
  return {
    id: "claude-local",
    displayName: "Claude (local subscription)",
    capabilities: Object.freeze({
      functionTools: false,
      hostTools: true,
      continuation: true,
      requiresAuthentication: true,
    }),
    authState: readAuthState,
    catalogue: readCatalogue,
    cancel: (runId) => legacy.cancel(runId),
    killAll: () => legacy.killAll(),
    async send(request): Promise<NeutralProviderResult> {
      if (request.input.length === 0) {
        return failed(request, "BAD_REQUEST", "input must contain at least one item");
      }
      const unsupported = unsupportedFeature(request);
      if (unsupported) return failed(request, "CAPABILITY_UNSUPPORTED", unsupported);
      const message = requestMessage(request);
      if (message === null) {
        return failed(
          request,
          "CAPABILITY_UNSUPPORTED",
          "Claude's neutral adapter supports exactly one user input_text item",
        );
      }
      if (!Number.isInteger(request.maxAgentTurns) || request.maxAgentTurns < 1) {
        return failed(request, "BAD_REQUEST", "maxAgentTurns must be a positive integer");
      }
      if (
        request.plainCompletion === true &&
        request.maxAgentTurns !== PLAIN_COMPLETION_MAX_TURNS
      ) {
        return failed(
          request,
          "BAD_REQUEST",
          `plainCompletion requires maxAgentTurns=${PLAIN_COMPLETION_MAX_TURNS} for Claude`,
        );
      }
      if (
        request.plainCompletion === true &&
        ((request.hostTools?.length ?? 0) > 0 ||
          (request.reasoning !== undefined && request.reasoning.budget !== "off"))
      ) {
        return failed(
          request,
          "BAD_REQUEST",
          "plainCompletion cannot enable host tools or reasoning for Claude",
        );
      }
      if (request.hostTools?.some((name) => !name.trim())) {
        return failed(request, "BAD_REQUEST", "hostTools must contain non-empty names");
      }
      if (request.hostTools?.some((name) =>
        name !== name.trim() || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name))) {
        return failed(request, "BAD_REQUEST", "hostTools contains an invalid tool name");
      }
      if (request.hostTools && new Set(request.hostTools).size !== request.hostTools.length) {
        return failed(request, "BAD_REQUEST", "hostTools contains duplicate names");
      }
      if (
        request.maxBudgetUsd !== undefined &&
        (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0)
      ) {
        return failed(request, "BAD_REQUEST", "maxBudgetUsd must be finite and positive");
      }
      if (
        request.timeoutMs !== undefined &&
        (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
      ) {
        return failed(request, "BAD_REQUEST", "timeoutMs must be finite and positive");
      }
      // Claude resumes carry the original system prompt and selected model.
      // Bind both into the opaque V2 token so neither can be silently changed
      // or ignored by the CLI on a later request.
      const digest = continuationBindingHash(request.model, request.instructions);
      const continuationToken = request.continuation?.token;
      let continuation: string | undefined;
      if (continuationToken !== undefined) {
        const parsed = readContinuation(continuationToken, digest);
        if ("error" in parsed) return failed(request, "BAD_REQUEST", parsed.error);
        continuation = parsed.sessionId;
      }
      if (continuation !== undefined && request.persistContinuation === false) {
        return failed(
          request,
          "CAPABILITY_UNSUPPORTED",
          "Claude CLI cannot disable persistence while resuming a continuation",
        );
      }

      let catalogue: ProviderModelCatalogue;
      try {
        catalogue = readCatalogue();
      } catch {
        return failed(request, "MODEL_UNAVAILABLE", "Claude model catalogue is unavailable");
      }
      const model = findProviderModel(catalogue, request.model);
      if (!model) {
        return failed(request, "MODEL_UNAVAILABLE", `Claude model ${request.model} is unavailable`);
      }
      if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
        return failed(request, "BAD_REQUEST", "maxOutputTokens must be a positive integer");
      }
      if (
        model.maxOutputTokens !== null &&
        request.maxOutputTokens > model.maxOutputTokens
      ) {
        return failed(request, "BAD_REQUEST", "maxOutputTokens exceeds the Claude model ceiling");
      }
      // The local Claude CLI exposes no per-call output-token flag. Its model
      // maximum is still a real backend ceiling; accept only that exact bound.
      // A tighter requested cap cannot be silently discarded.
      if (
        model.maxOutputTokens === null ||
        request.maxOutputTokens !== model.maxOutputTokens
      ) {
        return failed(
          request,
          "CAPABILITY_UNSUPPORTED",
          "Claude CLI cannot enforce the requested per-call maxOutputTokens",
        );
      }
      let mappedEffort = request.reasoning?.effort;
      if (request.reasoning !== undefined) {
        const { budget, effort } = request.reasoning;
        const supported = model.reasoningValues.includes(budget) ||
          (budget === "off" && model.reasoningValues.includes("none"));
        if (!supported) {
          return failed(
            request,
            "CAPABILITY_UNSUPPORTED",
            `Claude model ${request.model} does not support reasoning ${budget}`,
          );
        }
        const effortModel = supportsEffort(model.id);
        if (effort !== undefined && (effort !== budget || !effortModel)) {
          return failed(
            request,
            "CAPABILITY_UNSUPPORTED",
            `Claude model ${request.model} does not support the requested effort flag`,
          );
        }
        // The neutral caller selects a reasoning level; the adapter selects
        // the Claude CLI mechanism advertised by that model.
        if (effortModel && budget !== "off") mappedEffort = budget;
      }

      let eventFailure = false;
      let observedError: { code: ProviderErrorCode; message: string } | undefined;
      const allowedHostTools = new Set(request.hostTools ?? []);
      const seenToolCalls = new Set<string>();
      const result = await legacy.sendWithDirectInstructions({
        runId: request.runId,
        message,
        sessionId: continuation ?? null,
        cwd: request.cwd,
        allowedTools: request.hostTools ? [...request.hostTools] : [],
        maxTurns: request.maxAgentTurns,
        plainCompletion: request.plainCompletion,
        skipUserSettings: request.skipHostSettings,
        thinkingBudget: request.reasoning?.budget,
        effort: mappedEffort,
        persistSession: request.persistContinuation,
        maxBudgetUsd: request.maxBudgetUsd,
        timeoutMs: request.timeoutMs,
        model: request.model,
        signal: request.signal,
        onEvent: (event) => {
          if (eventFailure) return;
          const normalized = modernEvent(event, digest);
          if (normalized) {
            if (normalized.type === "error") {
              const code = classifyLegacyFailure(normalized.code, normalized.message) ?? normalized.code;
              observedError = { code, message: normalized.message };
              request.onEvent({ ...normalized, code });
              return;
            }
            if (normalized.type === "tool_use") {
              const callId = normalized.callId;
              if (typeof callId !== "string" || callId.length === 0) {
                eventFailure = true;
                legacy.cancel(request.runId);
                request.onEvent({
                  type: "error",
                  code: "BACKEND_UNSUPPORTED",
                  message: "Claude emitted a tool call without a call identifier",
                });
                return;
              }
              if (!allowedHostTools.has(normalized.name) || seenToolCalls.has(callId)) {
                eventFailure = true;
                legacy.cancel(request.runId);
                request.onEvent({
                  type: "error",
                  code: "BACKEND_UNSUPPORTED",
                  message: !allowedHostTools.has(normalized.name)
                    ? "Claude emitted an unrequested host-tool call"
                    : "Claude emitted a duplicate tool-call identifier",
                });
                return;
              }
              seenToolCalls.add(callId);
              request.onEvent({
                type: "tool_use",
                callId,
                name: normalized.name,
                input: normalized.input,
              });
              return;
            }
            request.onEvent(normalized);
          } else {
            eventFailure = true;
            legacy.cancel(request.runId);
            request.onEvent({
              type: "error",
              code: "BACKEND_UNSUPPORTED",
              message: "Claude emitted a tool call without a call identifier",
            });
          }
        },
      }, request.instructions, readAuthState);
      if (eventFailure) {
        return {
          continuation: result.sessionId
            ? bindContinuation(result.sessionId, digest)
            : null,
          usage: result.usage,
          freshFallback: result.freshFallback,
          status: "error",
          errorCode: "BACKEND_UNSUPPORTED",
        };
      }
      const errorCode = classifyLegacyFailure(result.errorCode, observedError?.message);
      return {
        continuation: result.sessionId
          ? bindContinuation(result.sessionId, digest)
          : null,
        usage: result.usage,
        freshFallback: result.freshFallback,
        status: result.status,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    },
  };
}

export const claudeLocalProviderV2 = createNeutralClaudeProvider();
