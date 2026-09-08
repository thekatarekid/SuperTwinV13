import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { ProviderErrorCode } from "../types.js";

export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CHATGPT_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CHATGPT_OAUTH_CALLBACK_HOST = "127.0.0.1";
export const CHATGPT_OAUTH_CALLBACK_PORT = 1455;
export const CHATGPT_OAUTH_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access";

export const CHATGPT_OAUTH_MAX_TARGET_BYTES = 4_096;
export const CHATGPT_OAUTH_MAX_HEADER_BYTES = 8_192;
export const CHATGPT_OAUTH_MAX_TOKEN_RESPONSE_BYTES = 128 * 1_024;
export const CHATGPT_OAUTH_DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

const MAX_CALLBACK_CODE_BYTES = 4_096;
const MAX_TOKEN_BYTES = 64 * 1_024;
const MAX_ACCOUNT_ID_BYTES = 4 * 1_024;
const MAX_JWT_CLAIMS_BYTES = 32 * 1_024;
const MAX_TOKEN_LIFETIME_SECONDS = 31 * 24 * 60 * 60;
const CALLBACK_ORIGIN = "http://localhost:1455";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export type BrowserOAuthStatus =
  | "idle"
  | "awaiting_browser"
  | "exchanging"
  | "signed_in"
  | "failed"
  | "cancelled"
  | "expired";

export type BrowserOAuthProviderErrorCode = Extract<
  ProviderErrorCode,
  | "AUTH_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "TRANSPORT_ERROR"
  | "BAD_REQUEST"
  | "CANCELLED"
>;

export class BrowserOAuthError extends Error {
  readonly code: BrowserOAuthProviderErrorCode;

  constructor(code: BrowserOAuthProviderErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BrowserOAuthError";
    this.code = code;
  }
}

/** Raw exchange result; identity material never crosses into persisted credentials. */
export interface BrowserOAuthExchangeTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  idToken?: string;
}

/** Keychain-compatible account-bound credentials produced by validation. */
export interface BrowserOAuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  accountId: string;
}

/** Keychain integration implements this interface in P2-A's storage slice. */
export interface BrowserOAuthCredentialStore {
  /** Persist durably before resolving and settle promptly when signal aborts. */
  save(credentials: BrowserOAuthTokenPair, signal: AbortSignal): Promise<void>;
}

/** Structural seam implemented by the account-locked ChatGptTokenSession. */
export interface BrowserOAuthSessionInstaller {
  install(credentials: BrowserOAuthTokenPair, signal?: AbortSignal): Promise<void>;
}

/** Required account/session validation and normalization before persistence. */
export interface BrowserOAuthTokenSession {
  /** Validate account/workspace binding and prepare the persistable session. */
  prepare(
    credentials: BrowserOAuthExchangeTokens,
    signal: AbortSignal,
  ): Promise<BrowserOAuthTokenPair>;
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) =>
    !segment || segment.length > MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(segments[1]!, "base64url");
  } catch {
    throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
  }
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_JWT_CLAIMS_BYTES ||
      decoded.toString("base64url") !== segments[1]) {
    throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims) ||
      Object.getPrototypeOf(claims) !== Object.prototype) {
    throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
  }
  return claims as Record<string, unknown>;
}

function boundedIdentity(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      Buffer.byteLength(value, "utf8") > maxBytes || /\p{Cc}/u.test(value)) {
    throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
  }
  return value;
}

/**
 * Production, bounded account/workspace projection for tokens received from the
 * exact OAuth token endpoint. JWT signatures are trusted through that TLS/code
 * exchange; this parser only selects and validates the account-bound claims.
 */
export function createBrowserOAuthTokenSession(): BrowserOAuthTokenSession {
  return {
    async prepare(tokens, signal) {
      if (signal.aborted) throw authError("CANCELLED", "OAuth login was cancelled");
      const accessClaims = decodeJwtClaims(tokens.accessToken);
      const authClaim = accessClaims[OPENAI_AUTH_CLAIM];
      if (!authClaim || typeof authClaim !== "object" || Array.isArray(authClaim) ||
          Object.getPrototypeOf(authClaim) !== Object.prototype) {
        throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
      }
      const accountId = boundedIdentity(
        (authClaim as Record<string, unknown>).chatgpt_account_id,
        MAX_ACCOUNT_ID_BYTES,
      );
      if (tokens.idToken !== undefined) {
        const identityClaims = decodeJwtClaims(tokens.idToken);
        const identitySubject = boundedIdentity(identityClaims.sub, MAX_ACCOUNT_ID_BYTES);
        if (accessClaims.sub !== undefined &&
            boundedIdentity(accessClaims.sub, MAX_ACCOUNT_ID_BYTES) !== identitySubject) {
          throw authError("AUTH_REQUIRED", "OAuth identity was invalid");
        }
      }
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.expiresAtMs,
        accountId,
      };
    },
  };
}

/** Persist login through ChatGptTokenSession.install's account-wide lock/epoch update. */
export function createBrowserOAuthCredentialStore(
  session: BrowserOAuthSessionInstaller,
): BrowserOAuthCredentialStore {
  return {
    async save(credentials, signal) {
      if (signal.aborted) throw authError("CANCELLED", "OAuth login was cancelled");
      await session.install(credentials, signal);
    },
  };
}

export interface BrowserOAuthCallbackRequest {
  method: string | undefined;
  target: string | undefined;
  host: string | undefined;
  rawHeaders: readonly string[];
}

export interface BrowserOAuthCallbackResponse {
  finish(success: boolean): void;
}

export interface BrowserOAuthCallback {
  code: string;
  response: BrowserOAuthCallbackResponse;
}

export interface BrowserOAuthCallbackListener {
  callback: Promise<BrowserOAuthCallback>;
  close(): Promise<void>;
}

export interface BrowserOAuthCallbackListenerOptions {
  host: typeof CHATGPT_OAUTH_CALLBACK_HOST;
  port: typeof CHATGPT_OAUTH_CALLBACK_PORT;
  expectedState: string;
  signal: AbortSignal;
}

export type CreateBrowserOAuthCallbackListener = (
  options: BrowserOAuthCallbackListenerOptions,
) => Promise<BrowserOAuthCallbackListener>;

export interface BrowserOAuthManagerDependencies {
  openBrowser(url: string, signal: AbortSignal): Promise<void>;
  /** `caller` means the Settings shell opens the returned authUrl exactly once. */
  browserOwner?: "manager" | "caller";
  credentialStore: BrowserOAuthCredentialStore;
  tokenSession: BrowserOAuthTokenSession;
  fetch?: typeof fetch;
  createCallbackListener?: CreateBrowserOAuthCallbackListener;
  randomBytes?: (size: number) => Uint8Array;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  timeoutMs?: number;
}

export interface BrowserOAuthLoginStart {
  loginId: string;
  authUrl: string;
  expiresAt: number;
}

export interface BrowserOAuthLoginSnapshot {
  loginId: string | null;
  status: BrowserOAuthStatus;
  expiresAt: number | null;
  error: BrowserOAuthProviderErrorCode | null;
}

interface Attempt {
  loginId: string;
  verifier: string;
  expiresAt: number;
  status: BrowserOAuthStatus;
  error: BrowserOAuthProviderErrorCode | null;
  controller: AbortController;
  listener: BrowserOAuthCallbackListener | null;
  timeoutHandle: unknown;
  stopReason: "cancelled" | "expired" | "failed" | null;
  browserReady: Promise<void>;
  markBrowserReady(): void;
  completion: Promise<void>;
}

function authError(code: BrowserOAuthProviderErrorCode, message: string): BrowserOAuthError {
  return new BrowserOAuthError(code, message);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomMaterial(
  random: (size: number) => Uint8Array,
  size: number,
  label: string,
): string {
  const bytes = random(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    throw authError("PROVIDER_UNAVAILABLE", `could not create ${label}`);
  }
  return base64url(bytes);
}

export function createBrowserOAuthPkce(
  random: (size: number) => Uint8Array = nodeRandomBytes,
): { verifier: string; challenge: string; state: string; loginId: string } {
  const verifier = randomMaterial(random, 64, "PKCE verifier");
  const state = randomMaterial(random, 32, "OAuth state");
  const loginId = randomMaterial(random, 16, "login identifier");
  if (verifier === state) throw authError("PROVIDER_UNAVAILABLE", "OAuth entropy was not independent");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge, state, loginId };
}

function clearPkce(material: { verifier: string; challenge: string; state: string }): void {
  material.verifier = "";
  material.challenge = "";
  material.state = "";
}

export function browserOAuthAuthorizationUrl(input: {
  state: string;
  challenge: string;
}): string {
  const url = new URL(CHATGPT_OAUTH_AUTHORIZE_URL);
  const parameters: Array<[string, string]> = [
    ["client_id", CHATGPT_OAUTH_CLIENT_ID],
    ["redirect_uri", CHATGPT_OAUTH_REDIRECT_URI],
    ["response_type", "code"],
    ["scope", CHATGPT_OAUTH_SCOPE],
    ["state", input.state],
    ["code_challenge", input.challenge],
    ["code_challenge_method", "S256"],
    ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"],
    ["originator", "supertwinv13"],
  ];
  for (const [key, value] of parameters) url.searchParams.append(key, value);
  return url.toString();
}

function sameState(received: string, expected: string): boolean {
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function callbackFailure(code: BrowserOAuthProviderErrorCode, message: string): never {
  throw authError(code, message);
}

/** Validate an already-bounded callback request without retaining its URL. */
export function validateBrowserOAuthCallback(
  request: BrowserOAuthCallbackRequest,
  expectedState: string,
): string {
  if (typeof expectedState !== "string" || expectedState.length === 0 ||
      Buffer.byteLength(expectedState, "utf8") > 1_024) {
    callbackFailure("BAD_REQUEST", "OAuth callback state was invalid");
  }
  if (request.method !== "GET") callbackFailure("BAD_REQUEST", "OAuth callback was invalid");
  if (request.host !== "localhost:1455") callbackFailure("BAD_REQUEST", "OAuth callback was invalid");
  if (typeof request.target !== "string" || !request.target.startsWith("/") ||
      request.target.startsWith("//") ||
      Buffer.byteLength(request.target, "utf8") > CHATGPT_OAUTH_MAX_TARGET_BYTES ||
      /%(?![0-9a-fA-F]{2})/.test(request.target)) {
    callbackFailure("BAD_REQUEST", "OAuth callback was invalid");
  }
  if (request.rawHeaders.length > 128 || request.rawHeaders.length % 2 !== 0 ||
      request.rawHeaders.reduce((total, part) => total + Buffer.byteLength(part, "utf8"), 0) >
        CHATGPT_OAUTH_MAX_HEADER_BYTES) {
    callbackFailure("BAD_REQUEST", "OAuth callback was invalid");
  }
  const hostHeaders: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === "host") {
      hostHeaders.push(request.rawHeaders[index + 1]!);
    }
  }
  if (hostHeaders.length !== 1 || hostHeaders[0] !== "localhost:1455") {
    callbackFailure("BAD_REQUEST", "OAuth callback was invalid");
  }

  let url: URL;
  try {
    url = new URL(request.target, CALLBACK_ORIGIN);
  } catch {
    callbackFailure("BAD_REQUEST", "OAuth callback was invalid");
  }
  if (url.pathname !== CHATGPT_OAUTH_CALLBACK_PATH || url.username || url.password || url.hash ||
      url.host !== "localhost:1455") {
    callbackFailure("BAD_REQUEST", "OAuth callback was invalid");
  }
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (states.length !== 1 || !sameState(states[0]!, expectedState)) {
    callbackFailure("BAD_REQUEST", "OAuth callback state did not match");
  }
  if (errors.length > 0) callbackFailure("AUTH_REQUIRED", "OAuth authorization was not granted");
  if (codes.length !== 1 || !codes[0] ||
      Buffer.byteLength(codes[0], "utf8") > MAX_CALLBACK_CODE_BYTES ||
      /\p{Cc}/u.test(codes[0])) {
    callbackFailure("BAD_REQUEST", "OAuth callback code was invalid");
  }
  return codes[0];
}

const SUCCESS_PAGE = "<!doctype html><meta charset=utf-8><title>Signed in to SuperTwin</title><p>Signed in to SuperTwin. You can close this window.</p>";
const FAILURE_PAGE = "<!doctype html><meta charset=utf-8><title>SuperTwin sign-in failed</title><p>Sign-in failed. You can close this window.</p>";

export function browserOAuthCompletionPage(success: boolean): string {
  return success ? SUCCESS_PAGE : FAILURE_PAGE;
}

function respondFixed(response: ServerResponse, success: boolean): void {
  if (response.writableEnded) return;
  const body = browserOAuthCompletionPage(success);
  response.writeHead(success ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export const createNodeBrowserOAuthCallbackListener: CreateBrowserOAuthCallbackListener =
  async (options) => {
    let consumed = false;
    let resolveCallback!: (callback: BrowserOAuthCallback) => void;
    let rejectCallback!: (error: BrowserOAuthError) => void;
    const callback = new Promise<BrowserOAuthCallback>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    // The manager always awaits callback; suppress a transient unhandled event
    // if a malformed request arrives in the same turn as listener creation.
    void callback.catch(() => undefined);

    const server = createServer({ maxHeaderSize: CHATGPT_OAUTH_MAX_HEADER_BYTES },
      (request: IncomingMessage, response: ServerResponse) => {
        if (consumed) {
          respondFixed(response, false);
          return;
        }
        consumed = true;
        server.close();
        try {
          const code = validateBrowserOAuthCallback({
            method: request.method,
            target: request.url,
            host: request.headers.host,
            rawHeaders: request.rawHeaders,
          }, options.expectedState);
          let answered = false;
          resolveCallback({
            code,
            response: {
              finish(success) {
                if (answered) return;
                answered = true;
                respondFixed(response, success);
              },
            },
          });
        } catch (error) {
          respondFixed(response, false);
          rejectCallback(error instanceof BrowserOAuthError
            ? error
            : authError("BAD_REQUEST", "OAuth callback was invalid"));
        }
      });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1;

    const abort = () => {
      if (!consumed) {
        consumed = true;
        rejectCallback(authError("CANCELLED", "OAuth login was cancelled"));
      }
      void closeServer(server);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    server.on("clientError", (_error, socket) => {
      const body = browserOAuthCompletionPage(false);
      socket.end([
        "HTTP/1.1 400 Bad Request",
        "Content-Type: text/html; charset=utf-8",
        `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
        "Cache-Control: no-store",
        "Content-Security-Policy: default-src 'none'; frame-ancestors 'none'",
        "Referrer-Policy: no-referrer",
        "X-Content-Type-Options: nosniff",
        "Connection: close",
        "",
        body,
      ].join("\r\n"));
      if (!consumed) {
        consumed = true;
        server.close();
        rejectCallback(authError("BAD_REQUEST", "OAuth callback was invalid"));
      }
    });

    if (options.signal.aborted) {
      abort();
      options.signal.removeEventListener("abort", abort);
      throw authError("CANCELLED", "OAuth login was cancelled");
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        const onError = (error: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen({
          host: options.host,
          port: options.port,
          exclusive: true,
        });
      });
    } catch (error) {
      options.signal.removeEventListener("abort", abort);
      await closeServer(server);
      if ((error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") {
        throw authError("PROVIDER_UNAVAILABLE", "OAuth callback port is already in use");
      }
      throw authError("PROVIDER_UNAVAILABLE", "OAuth callback listener could not start");
    }

    return {
      callback,
      async close() {
        options.signal.removeEventListener("abort", abort);
        await closeServer(server);
      },
    };
  };

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw authError("TRANSPORT_ERROR", "OAuth token response was empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > CHATGPT_OAUTH_MAX_TOKEN_RESPONSE_BYTES) {
        throw authError("TRANSPORT_ERROR", "OAuth token response exceeded its limit");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof BrowserOAuthError) throw error;
    throw authError("TRANSPORT_ERROR", "OAuth token response was invalid");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function tokenString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES || /\p{Cc}/u.test(value)) {
    throw authError("AUTH_REQUIRED", `OAuth ${label} was missing`);
  }
  return value;
}

function normalizePreparedCredentials(value: unknown): BrowserOAuthTokenPair {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw authError("AUTH_REQUIRED", "OAuth session validation failed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== 4 || keys.some((key) =>
    !["accessToken", "refreshToken", "expiresAtMs", "accountId"].includes(key) ||
    descriptors[key]!.get !== undefined || descriptors[key]!.set !== undefined)) {
    throw authError("AUTH_REQUIRED", "OAuth session validation failed");
  }
  const row = value as Record<string, unknown>;
  const expiresAtMs = row.expiresAtMs;
  const accountId = row.accountId;
  if (!Number.isSafeInteger(expiresAtMs) || Number(expiresAtMs) <= 0 ||
      typeof accountId !== "string" || accountId.length === 0 ||
      Buffer.byteLength(accountId, "utf8") > MAX_ACCOUNT_ID_BYTES || /\p{Cc}/u.test(accountId)) {
    throw authError("AUTH_REQUIRED", "OAuth session validation failed");
  }
  return {
    accessToken: tokenString(row.accessToken, "access token"),
    refreshToken: tokenString(row.refreshToken, "refresh token"),
    expiresAtMs: Number(expiresAtMs),
    accountId,
  };
}

async function exchangeAuthorizationCode(input: {
  code: string;
  verifier: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  now: () => number;
}): Promise<BrowserOAuthExchangeTokens> {
  const body = new URLSearchParams([
    ["grant_type", "authorization_code"],
    ["client_id", CHATGPT_OAUTH_CLIENT_ID],
    ["code", input.code],
    ["redirect_uri", CHATGPT_OAUTH_REDIRECT_URI],
    ["code_verifier", input.verifier],
  ]);
  let response: Response;
  try {
    response = await input.fetchImpl(CHATGPT_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      redirect: "error",
      signal: input.signal,
    });
  } catch {
    if (input.signal.aborted) throw authError("CANCELLED", "OAuth login was cancelled");
    throw authError("TRANSPORT_ERROR", "OAuth token exchange failed");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw authError("AUTH_REQUIRED", "OAuth token exchange was rejected");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    void response.body?.cancel().catch(() => undefined);
    throw authError("TRANSPORT_ERROR", "OAuth token response was invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await boundedResponseText(response, input.signal));
  } catch (error) {
    if (error instanceof BrowserOAuthError) throw error;
    throw authError("TRANSPORT_ERROR", "OAuth token response was invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.getPrototypeOf(payload) !== Object.prototype) {
    throw authError("TRANSPORT_ERROR", "OAuth token response was invalid");
  }
  const token = payload as Record<string, unknown>;
  const expiresIn = token.expires_in;
  if (!Number.isSafeInteger(expiresIn) || Number(expiresIn) <= 0 ||
      Number(expiresIn) > MAX_TOKEN_LIFETIME_SECONDS) {
    throw authError("AUTH_REQUIRED", "OAuth token lifetime was invalid");
  }
  const now = input.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - Number(expiresIn) * 1_000) {
    throw authError("PROVIDER_UNAVAILABLE", "OAuth clock was invalid");
  }
  return {
    accessToken: tokenString(token.access_token, "access token"),
    refreshToken: tokenString(token.refresh_token, "refresh token"),
    expiresAtMs: now + Number(expiresIn) * 1_000,
    ...(token.id_token === undefined
      ? {}
      : { idToken: tokenString(token.id_token, "identity token") }),
  };
}

function scheduleDefault(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function clearDefault(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(authError("CANCELLED", "OAuth login was cancelled"));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(authError("CANCELLED", "OAuth login was cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

/** One-process, one-active-attempt production browser OAuth coordinator. */
export class BrowserOAuthManager {
  private readonly dependencies: Required<Pick<
    BrowserOAuthManagerDependencies,
    "openBrowser" | "credentialStore" | "tokenSession"
  >> & BrowserOAuthManagerDependencies;
  private attempt: Attempt | null = null;

  constructor(dependencies: BrowserOAuthManagerDependencies) {
    this.dependencies = dependencies;
  }

  snapshot(): BrowserOAuthLoginSnapshot {
    const attempt = this.attempt;
    return attempt
      ? {
          loginId: attempt.loginId,
          status: attempt.status,
          expiresAt: attempt.expiresAt,
          error: attempt.error,
        }
      : { loginId: null, status: "idle", expiresAt: null, error: null };
  }

  async start(): Promise<BrowserOAuthLoginStart> {
    if (this.attempt && ["awaiting_browser", "exchanging"].includes(this.attempt.status)) {
      throw authError("BAD_REQUEST", "OAuth login is already in progress");
    }
    const now = this.dependencies.now ?? Date.now;
    const timeoutMs = this.dependencies.timeoutMs ?? CHATGPT_OAUTH_DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CHATGPT_OAUTH_DEFAULT_TIMEOUT_MS) {
      throw authError("BAD_REQUEST", "OAuth timeout was invalid");
    }
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0 ||
        startedAt > Number.MAX_SAFE_INTEGER - timeoutMs) {
      throw authError("PROVIDER_UNAVAILABLE", "OAuth clock was invalid");
    }
    const material = createBrowserOAuthPkce(this.dependencies.randomBytes ?? nodeRandomBytes);
    const controller = new AbortController();
    const expiresAt = startedAt + timeoutMs;
    const schedule = this.dependencies.scheduleTimeout ?? scheduleDefault;
    const clear = this.dependencies.clearScheduledTimeout ?? clearDefault;
    let expiredBeforeReady = false;
    let timeoutHandle: unknown;
    try {
      timeoutHandle = schedule(() => {
        expiredBeforeReady = true;
        const current = this.attempt;
        if (current?.loginId === material.loginId &&
            ["awaiting_browser", "exchanging"].includes(current.status)) {
          current.stopReason = "expired";
        }
        controller.abort();
      }, timeoutMs);
    } catch {
      controller.abort();
      clearPkce(material);
      throw authError("PROVIDER_UNAVAILABLE", "OAuth timeout could not be scheduled");
    }
    let listener: BrowserOAuthCallbackListener;
    try {
      listener = await abortable(
        (this.dependencies.createCallbackListener ?? createNodeBrowserOAuthCallbackListener)({
          host: CHATGPT_OAUTH_CALLBACK_HOST,
          port: CHATGPT_OAUTH_CALLBACK_PORT,
          expectedState: material.state,
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error) {
      clear(timeoutHandle);
      clearPkce(material);
      if (expiredBeforeReady) throw authError("AUTH_REQUIRED", "OAuth login expired");
      if (error instanceof BrowserOAuthError) throw error;
      throw authError("PROVIDER_UNAVAILABLE", "OAuth callback listener could not start");
    }
    /* The timeout starts before listener setup so port binding is bounded too. */
    if (expiredBeforeReady) {
      await listener.close().catch(() => undefined);
      clear(timeoutHandle);
      clearPkce(material);
      throw authError("AUTH_REQUIRED", "OAuth login expired");
    }
    const placeholder = Promise.resolve();
    let markBrowserReady!: () => void;
    const browserReady = new Promise<void>((resolve) => { markBrowserReady = resolve; });
    const attempt: Attempt = {
      loginId: material.loginId,
      verifier: material.verifier,
      expiresAt,
      status: "awaiting_browser",
      error: null,
      controller,
      listener,
      timeoutHandle,
      stopReason: null,
      browserReady,
      markBrowserReady,
      completion: placeholder,
    };
    this.attempt = attempt;
    attempt.completion = this.complete(attempt);
    void attempt.completion.catch(() => undefined);

    const authUrl = browserOAuthAuthorizationUrl({
      state: material.state,
      challenge: material.challenge,
    });
    clearPkce(material);
    try {
      if (this.dependencies.browserOwner !== "caller") {
        await abortable(this.dependencies.openBrowser(authUrl, controller.signal), controller.signal);
      }
      attempt.markBrowserReady();
    } catch {
      if (attempt.stopReason === "expired") {
        await attempt.completion.catch(() => undefined);
        throw authError("AUTH_REQUIRED", "OAuth login expired");
      }
      attempt.stopReason = "failed";
      attempt.error = "PROVIDER_UNAVAILABLE";
      attempt.controller.abort();
      await attempt.completion.catch(() => undefined);
      throw authError("PROVIDER_UNAVAILABLE", "OAuth browser could not open");
    }
    return { loginId: material.loginId, authUrl, expiresAt };
  }

  async wait(loginId: string): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.loginId !== loginId) throw authError("BAD_REQUEST", "OAuth login was not found");
    return attempt.completion;
  }

  async cancel(loginId: string): Promise<boolean> {
    const attempt = this.attempt;
    if (!attempt || attempt.loginId !== loginId ||
        !["awaiting_browser", "exchanging"].includes(attempt.status)) return false;
    attempt.stopReason = "cancelled";
    attempt.controller.abort();
    await attempt.completion.catch(() => undefined);
    // A Keychain commit may have crossed its durable boundary concurrently.
    // In that case signed-in truth wins and cancellation honestly returns false.
    return attempt.status === "cancelled";
  }

  async windowClosed(loginId: string): Promise<boolean> {
    return this.cancel(loginId);
  }

  async shutdown(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || !["awaiting_browser", "exchanging"].includes(attempt.status)) return;
    attempt.stopReason = "cancelled";
    attempt.controller.abort();
    await attempt.completion.catch(() => undefined);
  }

  private async complete(attempt: Attempt): Promise<void> {
    const listener = attempt.listener;
    if (!listener) throw authError("PROVIDER_UNAVAILABLE", "OAuth callback listener was unavailable");
    let callback: BrowserOAuthCallback | null = null;
    const clear = this.dependencies.clearScheduledTimeout ?? clearDefault;
    try {
      await abortable(attempt.browserReady, attempt.controller.signal);
      callback = await abortable(listener.callback, attempt.controller.signal);
      if (attempt.controller.signal.aborted) throw authError("CANCELLED", "OAuth login was cancelled");
      attempt.status = "exchanging";
      const exchanged = await exchangeAuthorizationCode({
        code: callback.code,
        verifier: attempt.verifier,
        fetchImpl: this.dependencies.fetch ?? fetch,
        signal: attempt.controller.signal,
        now: this.dependencies.now ?? Date.now,
      });
      let credentials: BrowserOAuthTokenPair;
      try {
        credentials = normalizePreparedCredentials(await abortable(
          this.dependencies.tokenSession.prepare(exchanged, attempt.controller.signal),
          attempt.controller.signal,
        ));
      } catch {
        throw authError("AUTH_REQUIRED", "OAuth session validation failed");
      }
      try {
        // Do not race a durable write: returning while an ignored signal later
        // commits would make cancellation lie. The production installer passes
        // the signal into the bounded Keychain subprocess and settles on abort.
        await this.dependencies.credentialStore.save(credentials, attempt.controller.signal);
      } catch {
        throw authError("PROVIDER_UNAVAILABLE", "OAuth credentials could not be stored");
      }
      attempt.status = "signed_in";
      attempt.error = null;
      try {
        callback.response.finish(true);
      } catch {
        // Credentials are already durably installed. A disconnected callback
        // page must not turn a successful login into contradictory auth state.
      }
      return;
    } catch (error) {
      try {
        callback?.response.finish(false);
      } catch {
        // The terminal error below stays fixed even if the browser disconnected.
      }
      const failure = error instanceof BrowserOAuthError
        ? error
        : authError("TRANSPORT_ERROR", "OAuth login failed");
      if (attempt.stopReason === "expired") {
        attempt.status = "expired";
        attempt.error = "AUTH_REQUIRED";
        throw authError("AUTH_REQUIRED", "OAuth login expired");
      }
      if (attempt.stopReason === "failed") {
        attempt.status = "failed";
        attempt.error = attempt.error ?? failure.code;
        throw authError(attempt.error, "OAuth login could not start");
      }
      if (attempt.stopReason === "cancelled" || failure.code === "CANCELLED") {
        attempt.status = "cancelled";
        attempt.error = "CANCELLED";
        throw authError("CANCELLED", "OAuth login was cancelled");
      }
      attempt.status = "failed";
      attempt.error = failure.code;
      throw failure;
    } finally {
      attempt.verifier = "";
      clear(attempt.timeoutHandle);
      await listener.close().catch(() => undefined);
      // The resolved callback promise retains its code/response object. Drop
      // the listener, while the void completion promise retains no token pair.
      attempt.listener = null;
      callback = null;
    }
  }
}
