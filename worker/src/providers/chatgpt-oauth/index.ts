import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";

import { findProviderModel } from "../catalogue.js";
import { runGatedProviderAttempt } from "../gate.js";
import type {
  NeutralProviderResult,
  ProviderAuthState,
  ProviderErrorCode,
  ProviderId,
  ProviderModel,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderV2,
  Usage,
} from "../types.js";
import { emptyUsage } from "../usage.js";
import type { ChatGptTokenSession } from "./keychain.js";
import { buildChatGptRequest } from "./request.js";
import { consumeChatGptSse, ChatGptSseError } from "./sse.js";

export const CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_RESPONSES_URL = `${CHATGPT_BACKEND_BASE_URL}/responses`;
export const CHATGPT_CANARY_RECHECK_MS = 6 * 60 * 60 * 1_000;
export const CHATGPT_DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
export const CHATGPT_MAX_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;

const SAFE_HEADER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,4095}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODES = new Set<ProviderErrorCode>([
  "TIMEOUT", "SPAWN_FAILED", "CLI_ERROR", "POISONED_SESSION", "CANCELLED",
  "QUOTA_EXCEEDED", "BUDGET_EXCEEDED", "MODEL_ACTIVITY_PAUSED", "MAX_TURNS",
  "BAD_REQUEST", "AUTH_REQUIRED", "AUTH_EXPIRED", "PROVIDER_UNAVAILABLE",
  "MODEL_UNAVAILABLE", "CAPABILITY_UNSUPPORTED", "BACKEND_UNSUPPORTED",
  "RATE_LIMITED", "TRANSPORT_ERROR",
]);

export interface ChatGptAuthorizationSnapshot {
  accessToken: string;
  accountId: string;
}

/** Atomic token/account snapshots required by the backend header contract. */
export interface ChatGptProviderSession {
  authState(): ProviderAuthState;
  /** Opaque, non-secret revision for the current credential pair. */
  credentialRevision(): string;
  authorization(signal: AbortSignal): Promise<ChatGptAuthorizationSnapshot>;
  refreshAuthorization(signal: AbortSignal): Promise<ChatGptAuthorizationSnapshot>;
}

function authorizationRevision(value: ChatGptAuthorizationSnapshot): string {
  const authorization = normalizeAuthorization(value);
  return createHash("sha256")
    .update(authorization.accountId)
    .update("\0")
    .update(authorization.accessToken)
    .digest("hex");
}

/** Adapt the account-locked Keychain token session without exposing credentials. */
export function createChatGptProviderSession(
  session: Pick<ChatGptTokenSession, "authState" | "accessToken" | "current" | "refresh">,
): ChatGptProviderSession {
  const snapshot = (pair: ReturnType<ChatGptTokenSession["current"]>): ChatGptAuthorizationSnapshot => {
    if (!pair.accountId) throw new ChatGptProviderError("AUTH_EXPIRED", "ChatGPT sign-in is not account-bound");
    return normalizeAuthorization({ accessToken: pair.accessToken, accountId: pair.accountId });
  };
  return {
    authState: () => session.authState(),
    credentialRevision: () => authorizationRevision(snapshot(session.current())),
    async authorization(signal) {
      if (signal.aborted) throw new ChatGptProviderError("CANCELLED", "ChatGPT request cancelled");
      // accessToken() performs a due refresh under the Keychain session lock.
      // current() then takes one coherent post-refresh token/account snapshot.
      await session.accessToken();
      if (signal.aborted) throw new ChatGptProviderError("CANCELLED", "ChatGPT request cancelled");
      return snapshot(session.current());
    },
    async refreshAuthorization(signal) {
      if (signal.aborted) throw new ChatGptProviderError("CANCELLED", "ChatGPT request cancelled");
      const refreshed = await session.refresh();
      if (signal.aborted) throw new ChatGptProviderError("CANCELLED", "ChatGPT request cancelled");
      return snapshot(refreshed);
    },
  };
}

export class ChatGptProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ChatGptProviderError";
  }
}

type ProviderAttemptRunner = typeof runGatedProviderAttempt;

export interface ChatGptOAuthProviderDependencies {
  session: ChatGptProviderSession;
  catalogue: () => ProviderModelCatalogue;
  /** Shared provider quota ceiling; required and invoked by every admission. */
  checkQuota: () => void;
  fetch: typeof fetch;
  appVersion: string;
  randomUUID?: () => string;
  now?: () => number;
  runAttempt?: ProviderAttemptRunner;
  canaryIntervalMs?: number;
}

export interface ChatGptOAuthProvider extends ProviderV2 {
  /** Boot/activation hook. Sends no user data and is shared across callers. */
  checkCanary(modelId: string, force?: boolean): Promise<boolean>;
}

interface InflightEntry {
  readonly identity: symbol;
  readonly controller: AbortController;
}

interface PhysicalAttempt {
  usage: Usage;
  status: "ok" | "error";
  errorCode?: ProviderErrorCode;
  httpStatus: number;
  result: NeutralProviderResult;
}

interface CanaryOutcome {
  ok: boolean;
  code: ProviderErrorCode | null;
}

function normalizeAuthorization(value: ChatGptAuthorizationSnapshot): ChatGptAuthorizationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ChatGptProviderError("AUTH_EXPIRED", "ChatGPT authorization is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== 2 || keys.some((key) =>
    !["accessToken", "accountId"].includes(key) ||
    descriptors[key]!.get !== undefined || descriptors[key]!.set !== undefined)) {
    throw new ChatGptProviderError("AUTH_EXPIRED", "ChatGPT authorization is invalid");
  }
  const accessToken = descriptors.accessToken!.value as unknown;
  const accountId = descriptors.accountId!.value as unknown;
  if (typeof accessToken !== "string" || accessToken.length === 0 ||
      Buffer.byteLength(accessToken, "utf8") > 64 * 1_024 || /\p{Cc}/u.test(accessToken) ||
      typeof accountId !== "string" || !SAFE_HEADER_ID.test(accountId)) {
    throw new ChatGptProviderError("AUTH_EXPIRED", "ChatGPT authorization is invalid");
  }
  return { accessToken, accountId };
}

function safeCode(error: unknown, fallback: ProviderErrorCode): ProviderErrorCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && ERROR_CODES.has(code as ProviderErrorCode)) {
      return code as ProviderErrorCode;
    }
  }
  return fallback;
}

function snapshotRequest(value: ProviderRequest): ProviderRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length > 0) {
    throw new ChatGptProviderError("BAD_REQUEST", "ChatGPT request was invalid");
  }
  const clone: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new ChatGptProviderError("BAD_REQUEST", "ChatGPT request was invalid");
    }
    clone[key] = descriptor.value;
  }
  return clone as unknown as ProviderRequest;
}

function publicMessage(code: ProviderErrorCode): string {
  switch (code) {
    case "AUTH_REQUIRED": return "ChatGPT sign-in required";
    case "AUTH_EXPIRED": return "ChatGPT sign-in expired";
    case "RATE_LIMITED": return "ChatGPT rate limit reached";
    case "QUOTA_EXCEEDED": return "ChatGPT quota exceeded";
    case "CANCELLED": return "ChatGPT request cancelled";
    case "BAD_REQUEST": return "ChatGPT request was invalid";
    case "MODEL_UNAVAILABLE": return "ChatGPT model is unavailable";
    case "CAPABILITY_UNSUPPORTED": return "ChatGPT capability is unsupported";
    case "BACKEND_UNSUPPORTED": return "ChatGPT backend compatibility check failed";
    case "PROVIDER_UNAVAILABLE": return "ChatGPT provider is unavailable";
    case "TIMEOUT": return "ChatGPT request timed out";
    default: return "ChatGPT transport failed";
  }
}

function failureResult(
  code: ProviderErrorCode,
  onEvent: (event: ProviderStreamEvent) => void,
  emit = true,
): NeutralProviderResult {
  if (emit) {
    try {
      onEvent({ type: "error", code, message: publicMessage(code) });
    } catch {
      // Preserve the fixed provider failure when a consumer callback fails.
    }
  }
  return {
    continuation: null,
    usage: emptyUsage(),
    freshFallback: false,
    status: "error",
    errorCode: code,
  };
}

function validateCatalogue(value: ProviderModelCatalogue): ProviderModelCatalogue {
  if (!value || value.providerId !== "chatgpt-oauth" || !Array.isArray(value.models)) {
    throw new ChatGptProviderError("PROVIDER_UNAVAILABLE", "ChatGPT catalogue is unavailable");
  }
  return value;
}

function httpErrorCode(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTH_EXPIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 425 || status >= 500) return "TRANSPORT_ERROR";
  // A locally validated request rejected by the private backend is contract
  // drift, not a user-shaped BAD_REQUEST that callers should mutate/retry.
  return "BACKEND_UNSUPPORTED";
}

function combineSignals(controller: AbortController, request: ProviderRequest): AbortSignal {
  const timeoutMs = request.timeoutMs ?? CHATGPT_DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CHATGPT_MAX_REQUEST_TIMEOUT_MS) {
    throw new ChatGptProviderError("BAD_REQUEST", "ChatGPT request timeout is invalid");
  }
  return AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(timeoutMs),
    ...(request.signal ? [request.signal] : []),
  ]);
}

function abortedCode(signal: AbortSignal): ProviderErrorCode {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED";
}

function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(
    new ChatGptProviderError(abortedCode(signal), publicMessage(abortedCode(signal))),
  );
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(
      new ChatGptProviderError(abortedCode(signal), publicMessage(abortedCode(signal))),
    );
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function allowedToolNames(body: Readonly<ReturnType<typeof buildChatGptRequest>>): string[] {
  return (body.tools ?? []).map((tool) =>
    (tool as { name: string }).name,
  );
}

class ChatGptOAuthProviderImpl implements ChatGptOAuthProvider {
  readonly id = "chatgpt-oauth" as const;
  readonly displayName = "ChatGPT subscription";
  readonly capabilities = Object.freeze({
    functionTools: true,
    hostTools: false,
    continuation: true,
    requiresAuthentication: true,
  });

  private readonly inflight = new Map<string, InflightEntry>();
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly runAttempt: ProviderAttemptRunner;
  private readonly canaryIntervalMs: number;
  private canaryState: "unknown" | "checking" | "ready" | "degraded" = "unknown";
  private canaryCheckedAt = 0;
  private canaryPromise: Promise<CanaryOutcome> | null = null;
  private forcedAuthExpiredRevision: string | null | undefined;

  constructor(private readonly dependencies: ChatGptOAuthProviderDependencies) {
    if (!dependencies || typeof dependencies !== "object" ||
        !dependencies.session || typeof dependencies.session !== "object" ||
        typeof dependencies.session.authState !== "function" ||
        typeof dependencies.session.credentialRevision !== "function" ||
        typeof dependencies.session.authorization !== "function" ||
        typeof dependencies.session.refreshAuthorization !== "function" ||
        typeof dependencies.catalogue !== "function" ||
        typeof dependencies.checkQuota !== "function" ||
        typeof dependencies.fetch !== "function" ||
        (dependencies.runAttempt !== undefined && typeof dependencies.runAttempt !== "function") ||
        (dependencies.randomUUID !== undefined && typeof dependencies.randomUUID !== "function") ||
        (dependencies.now !== undefined && typeof dependencies.now !== "function")) {
      throw new ChatGptProviderError("PROVIDER_UNAVAILABLE", "ChatGPT provider configuration is invalid");
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(dependencies.appVersion) ||
        Buffer.byteLength(dependencies.appVersion, "utf8") > 128) {
      throw new ChatGptProviderError("PROVIDER_UNAVAILABLE", "ChatGPT app version is invalid");
    }
    const canaryIntervalMs = dependencies.canaryIntervalMs ?? CHATGPT_CANARY_RECHECK_MS;
    if (!Number.isSafeInteger(canaryIntervalMs) || canaryIntervalMs <= 0 ||
        canaryIntervalMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new ChatGptProviderError("PROVIDER_UNAVAILABLE", "ChatGPT canary interval is invalid");
    }
    this.userAgent = `SuperTwinV13/${dependencies.appVersion}`;
    this.now = dependencies.now ?? Date.now;
    this.randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
    this.runAttempt = dependencies.runAttempt ?? runGatedProviderAttempt;
    this.canaryIntervalMs = canaryIntervalMs;
  }

  authState(): ProviderAuthState {
    const auth = this.dependencies.session.authState();
    if (auth.status !== "ready") return auth;
    if (this.authExpiryIsCurrent()) return { status: "expired", error: "ChatGPT sign-in expired" };
    if (this.canaryState !== "ready") {
      return {
        status: "degraded",
        error: this.canaryState === "checking"
          ? "ChatGPT backend compatibility check is running"
          : "ChatGPT backend compatibility check required",
      };
    }
    return auth;
  }

  catalogue(): ProviderModelCatalogue {
    try {
      return validateCatalogue(this.dependencies.catalogue());
    } catch (error) {
      if (error instanceof ChatGptProviderError) throw error;
      throw new ChatGptProviderError("PROVIDER_UNAVAILABLE", "ChatGPT catalogue is unavailable");
    }
  }

  async send(request: ProviderRequest): Promise<NeutralProviderResult> {
    let stableRequest: ProviderRequest | undefined;
    let onEvent: ProviderRequest["onEvent"] = () => undefined;
    let model: ProviderModel;
    let body: Readonly<ReturnType<typeof buildChatGptRequest>>;
    try {
      stableRequest = snapshotRequest(request);
      if (typeof stableRequest.onEvent === "function") onEvent = stableRequest.onEvent;
      model = this.model(stableRequest.model);
      // Build once before canary/network so hostile request shapes fail locally.
      body = buildChatGptRequest(stableRequest, model);
    } catch (error) {
      return failureResult(safeCode(error, "BAD_REQUEST"), onEvent);
    }
    // A failed refresh plus retry is terminal for this provider instance. Do
    // not let a later request bypass the public expired state and spend again.
    if (this.authExpiryIsCurrent()) return failureResult("AUTH_EXPIRED", onEvent);
    if (stableRequest.signal?.aborted) return failureResult("CANCELLED", onEvent);
    if (this.inflight.has(stableRequest.runId)) return failureResult("BAD_REQUEST", onEvent);
    const entry: InflightEntry = {
      identity: Symbol(stableRequest.runId),
      controller: new AbortController(),
    };
    this.inflight.set(stableRequest.runId, entry);
    try {
      const signal = combineSignals(entry.controller, stableRequest);
      const now = this.now();
      const canaryDue = this.canaryState !== "ready" ||
        !Number.isSafeInteger(now) || now < this.canaryCheckedAt ||
        now - this.canaryCheckedAt >= this.canaryIntervalMs;
      if (canaryDue) {
        let outcome: CanaryOutcome;
        try {
          outcome = await waitWithSignal(this.ensureCanary(model, false), signal);
        } catch (error) {
          return failureResult(safeCode(error, abortedCode(signal)), onEvent);
        }
        if (!outcome.ok) {
          return failureResult(outcome.code ?? "BACKEND_UNSUPPORTED", onEvent);
        }
      }

      const result = await this.sendWithRetry(stableRequest, model, body, signal);
      if (result.errorCode === "BACKEND_UNSUPPORTED" && !signal.aborted) {
        // Exactly one shared diagnostic canary on the first unexplained parser or
        // private-backend contract failure. Its events never reach the caller.
        this.canaryState = "unknown";
        this.canaryCheckedAt = 0;
        await waitWithSignal(this.ensureCanary(model, true), signal).catch(() => undefined);
      }
      return result;
    } catch (error) {
      return failureResult(safeCode(error, "TRANSPORT_ERROR"), onEvent);
    } finally {
      if (this.inflight.get(stableRequest.runId)?.identity === entry.identity) {
        this.inflight.delete(stableRequest.runId);
      }
    }
  }

  cancel(runId: string): boolean {
    const entry = this.inflight.get(runId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  killAll(): void {
    for (const entry of this.inflight.values()) entry.controller.abort();
  }

  async checkCanary(modelId: string, force = false): Promise<boolean> {
    if (this.authExpiryIsCurrent()) return false;
    const model = this.model(modelId);
    return (await this.ensureCanary(model, force)).ok;
  }

  private model(modelId: string): ProviderModel {
    const selected = findProviderModel(this.catalogue(), modelId);
    if (!selected) throw new ChatGptProviderError("MODEL_UNAVAILABLE", "ChatGPT model is unavailable");
    return Object.freeze({
      ...selected,
      inputModalities: Object.freeze([...selected.inputModalities]) as unknown as ProviderModel["inputModalities"],
      reasoningValues: Object.freeze([...selected.reasoningValues]) as unknown as string[],
    });
  }

  private async ensureCanary(model: ProviderModel, force: boolean): Promise<CanaryOutcome> {
    const now = this.now();
    if (!force && this.canaryState === "ready" && Number.isSafeInteger(now) &&
        now >= this.canaryCheckedAt && now - this.canaryCheckedAt < this.canaryIntervalMs) {
      return { ok: true, code: null };
    }
    if (this.canaryPromise) return this.canaryPromise;
    this.canaryState = "checking";
    const promise = this.performCanary(model).then((outcome) => {
      if (outcome.ok) {
        this.canaryState = "ready";
        this.canaryCheckedAt = this.now();
      } else {
        this.canaryState = "degraded";
        this.canaryCheckedAt = 0;
      }
      return outcome;
    }, (error: unknown) => {
      const code = safeCode(error, "BACKEND_UNSUPPORTED");
      this.canaryState = "degraded";
      this.canaryCheckedAt = 0;
      return { ok: false, code };
    }).finally(() => {
      if (this.canaryPromise === promise) this.canaryPromise = null;
    });
    this.canaryPromise = promise;
    return promise;
  }

  private async performCanary(model: ProviderModel): Promise<CanaryOutcome> {
    let output = "";
    const runId = `canary-${this.identifier()}`;
    const request: ProviderRequest = {
      runId,
      model: model.id,
      instructions: "",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with OK." }],
      }],
      plainCompletion: true,
      maxOutputTokens: model.maxOutputTokens === null ? 16 : Math.min(16, model.maxOutputTokens),
      maxAgentTurns: 1,
      persistContinuation: false,
      onEvent: (event) => {
        if (event.type === "delta") output += event.text;
      },
    };
    const result = await this.sendManaged(
      request,
      model,
      buildChatGptRequest(request, model),
    );
    return result.status === "ok" && output.trim() === "OK"
      ? { ok: true, code: null }
      : { ok: false, code: result.errorCode ?? "BACKEND_UNSUPPORTED" };
  }

  private async sendManaged(
    request: ProviderRequest,
    model: ProviderModel,
    body: Readonly<ReturnType<typeof buildChatGptRequest>>,
  ): Promise<NeutralProviderResult> {
    if (this.inflight.has(request.runId)) return failureResult("BAD_REQUEST", request.onEvent);
    const entry: InflightEntry = { identity: Symbol(request.runId), controller: new AbortController() };
    this.inflight.set(request.runId, entry);
    try {
      const signal = combineSignals(entry.controller, request);
      return this.sendWithRetry(request, model, body, signal);
    } catch (error) {
      return failureResult(safeCode(error, "TRANSPORT_ERROR"), request.onEvent);
    } finally {
      if (this.inflight.get(request.runId)?.identity === entry.identity) {
        this.inflight.delete(request.runId);
      }
    }
  }

  private async sendWithRetry(
    request: ProviderRequest,
    model: ProviderModel,
    body: Readonly<ReturnType<typeof buildChatGptRequest>>,
    signal: AbortSignal,
  ): Promise<NeutralProviderResult> {
    const sessionId = this.identifier();
    const firstRequestId = this.identifier(sessionId);
    const first = await this.physicalAttempt(
      request,
      model,
      body,
      signal,
      sessionId,
      firstRequestId,
      1,
      undefined,
      true,
    );
    if (first.httpStatus !== 401) return first.result;

    let refreshed: ChatGptAuthorizationSnapshot;
    try {
      refreshed = normalizeAuthorization(
        await waitWithSignal(this.dependencies.session.refreshAuthorization(signal), signal),
      );
    } catch (error) {
      const code = safeCode(error, signal.aborted ? abortedCode(signal) : "AUTH_EXPIRED");
      if (code === "AUTH_EXPIRED") this.markAuthExpired();
      return failureResult(code, request.onEvent);
    }
    const second = await this.physicalAttempt(
      request,
      model,
      body,
      signal,
      sessionId,
      this.identifier(sessionId, firstRequestId),
      2,
      refreshed,
      false,
    );
    return second.result;
  }

  private async physicalAttempt(
    request: ProviderRequest,
    model: ProviderModel,
    body: Readonly<ReturnType<typeof buildChatGptRequest>>,
    signal: AbortSignal,
    sessionId: string,
    requestId: string,
    attempt: number,
    fixedAuthorization: ChatGptAuthorizationSnapshot | undefined,
    suppressUnauthorizedEvent: boolean,
  ): Promise<PhysicalAttempt> {
    return this.runAttempt({
      providerId: "chatgpt-oauth",
      runId: request.runId,
      attempt,
      model: model.id,
      systemPrompt: request.instructions,
      packedContext: JSON.stringify(body.input),
      onEvent: request.onEvent,
      checkQuota: this.dependencies.checkQuota,
      authState: () => this.dependencies.session.authState(),
      execute: async (onEvent): Promise<PhysicalAttempt> => {
        if (signal.aborted) return this.physicalFailure(0, abortedCode(signal), onEvent);
        let authorization: ChatGptAuthorizationSnapshot;
        try {
          authorization = normalizeAuthorization(
            fixedAuthorization ?? await waitWithSignal(
              this.dependencies.session.authorization(signal),
              signal,
            ),
          );
        } catch (error) {
          return this.physicalFailure(
            0,
            safeCode(error, signal.aborted ? abortedCode(signal) : "AUTH_EXPIRED"),
            onEvent,
          );
        }
        let response: Response;
        try {
          response = await this.dependencies.fetch(CHATGPT_RESPONSES_URL, {
            method: "POST",
            redirect: "error",
            signal,
            headers: {
              Authorization: `Bearer ${authorization.accessToken}`,
              "ChatGPT-Account-ID": authorization.accountId,
              "User-Agent": this.userAgent,
              originator: "supertwinv13",
              Accept: "text/event-stream",
              "Content-Type": "application/json",
              session_id: sessionId,
              "x-client-request-id": requestId,
            },
            body: JSON.stringify(body),
          });
        } catch {
          return this.physicalFailure(0, signal.aborted ? abortedCode(signal) : "TRANSPORT_ERROR", onEvent);
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const code = httpErrorCode(response.status);
          return this.physicalFailure(
            response.status,
            code,
            onEvent,
            suppressUnauthorizedEvent && response.status === 401,
            authorization,
          );
        }
        try {
          const parsed = await consumeChatGptSse(response, {
            signal,
            onEvent: (event) => {
              if (signal.aborted && event.type === "error" && event.code === "CANCELLED") {
                const code = abortedCode(signal);
                onEvent({ type: "error", code, message: publicMessage(code) });
                return;
              }
              onEvent(event);
            },
            persistContinuation: request.persistContinuation === true,
            allowedToolNames: allowedToolNames(body),
          });
          const parsedErrorCode = signal.aborted && parsed.errorCode === "CANCELLED"
            ? abortedCode(signal)
            : parsed.errorCode;
          const result: NeutralProviderResult = {
            continuation: parsed.continuation,
            usage: parsed.usage,
            freshFallback: false,
            status: parsed.status,
            ...(parsedErrorCode === undefined ? {} : { errorCode: parsedErrorCode }),
          };
          if (result.errorCode === "AUTH_EXPIRED") this.markAuthExpired(authorization);
          return {
            usage: result.usage,
            status: result.status,
            ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
            httpStatus: response.status,
            result,
          };
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          const parsedCode = error instanceof ChatGptSseError
            ? error.code
            : safeCode(error, signal.aborted ? abortedCode(signal) : "TRANSPORT_ERROR");
          const code = signal.aborted && parsedCode === "CANCELLED"
            ? abortedCode(signal)
            : parsedCode;
          const result = failureResult(code, onEvent, !(error instanceof ChatGptSseError));
          return {
            usage: result.usage,
            status: "error",
            errorCode: code,
            httpStatus: response.status,
            result,
          };
        }
      },
      now: this.now,
    });
  }

  private physicalFailure(
    httpStatus: number,
    code: ProviderErrorCode,
    onEvent: (event: ProviderStreamEvent) => void,
    suppressEvent = false,
    authorization?: ChatGptAuthorizationSnapshot,
  ): PhysicalAttempt {
    if (code === "AUTH_EXPIRED" && !suppressEvent) this.markAuthExpired(authorization);
    const result = failureResult(code, onEvent, !suppressEvent);
    return {
      usage: result.usage,
      status: "error",
      errorCode: code,
      httpStatus,
      result,
    };
  }

  private markAuthExpired(authorization?: ChatGptAuthorizationSnapshot): void {
    try {
      this.forcedAuthExpiredRevision = authorization
        ? authorizationRevision(authorization)
        : this.dependencies.session.credentialRevision();
    } catch {
      this.forcedAuthExpiredRevision = null;
    }
  }

  /**
   * A successful P2-A credential install changes the opaque revision. That is
   * the only event allowed to clear a terminal backend-auth latch; ordinary
   * concurrent successes cannot clear it.
   */
  private authExpiryIsCurrent(): boolean {
    if (this.forcedAuthExpiredRevision === undefined) return false;
    try {
      const revision = this.dependencies.session.credentialRevision();
      if (revision !== this.forcedAuthExpiredRevision) {
        this.forcedAuthExpiredRevision = undefined;
        this.canaryState = "unknown";
        this.canaryCheckedAt = 0;
        return false;
      }
    } catch {
      // Fail closed until the credential session becomes readable again.
    }
    return true;
  }

  private identifier(...excluded: string[]): string {
    const identifier = this.randomUUID();
    if (typeof identifier !== "string" || !SAFE_REQUEST_ID.test(identifier) || excluded.includes(identifier)) {
      throw new ChatGptProviderError("PROVIDER_UNAVAILABLE", "ChatGPT request identifier is unavailable");
    }
    return identifier;
  }
}

export function createChatGptOAuthProvider(
  dependencies: ChatGptOAuthProviderDependencies,
): ChatGptOAuthProvider {
  return new ChatGptOAuthProviderImpl(dependencies);
}

/**
 * Truthful activation seam. Disabled means no registry mutation or canary.
 * Enabled providers are visible while their mandatory boot canary runs and
 * remain degraded when that zero-user-data compatibility check fails.
 */
export interface ChatGptOAuthActivationResult {
  registered: boolean;
  canary: "skipped" | "ready" | "degraded";
}

export async function registerChatGptOAuthProviderIfEnabled(options: {
  enabled: boolean;
  activeProviderId: ProviderId;
  provider: ChatGptOAuthProvider;
  canaryModelId: string;
  register: (provider: ProviderV2) => void;
}): Promise<ChatGptOAuthActivationResult> {
  if (options.enabled !== true) {
    return { registered: false, canary: "skipped" };
  }
  options.register(options.provider);
  if (options.activeProviderId !== "chatgpt-oauth") {
    return { registered: true, canary: "skipped" };
  }
  try {
    const ready = await options.provider.checkCanary(options.canaryModelId);
    return { registered: true, canary: ready ? "ready" : "degraded" };
  } catch {
    return { registered: true, canary: "degraded" };
  }
}
