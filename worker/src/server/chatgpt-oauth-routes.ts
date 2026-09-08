import type { IncomingMessage, ServerResponse } from "node:http";

import {
  BrowserOAuthError,
  type BrowserOAuthLoginSnapshot,
  type BrowserOAuthLoginStart,
} from "../providers/chatgpt-oauth/auth.js";
import type { ProviderAuthState, ProviderErrorCode } from "../providers/types.js";
import { requireTrustedMutationOrigin } from "./app-origin.js";

const ROOT = "/api/providers/chatgpt-oauth";
const MAX_BODY_BYTES = 16 * 1_024;
const LOGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLIC_ERROR_CODES = new Set<ProviderErrorCode>([
  "TIMEOUT", "SPAWN_FAILED", "CLI_ERROR", "POISONED_SESSION", "CANCELLED",
  "QUOTA_EXCEEDED", "BUDGET_EXCEEDED", "MODEL_ACTIVITY_PAUSED", "MAX_TURNS",
  "BAD_REQUEST", "AUTH_REQUIRED", "AUTH_EXPIRED", "PROVIDER_UNAVAILABLE",
  "MODEL_UNAVAILABLE", "CAPABILITY_UNSUPPORTED", "BACKEND_UNSUPPORTED",
  "RATE_LIMITED", "TRANSPORT_ERROR",
]);

export interface ChatGptRouteStatus {
  authState: ProviderAuthState;
  plan: string | null;
  quota: {
    state: "unknown" | "available" | "limited" | "exhausted";
    resetAt: string | null;
  };
  tokenExpiresAt: string | null;
  canary: {
    status: "unknown" | "passed" | "failed";
    checkedAt: string | null;
    error: { code: ProviderErrorCode; message: string } | null;
  };
}

export interface ChatGptOAuthRouteRuntime {
  retryCatalogue?(): Promise<void>;
  status(): ChatGptRouteStatus;
  start(): Promise<BrowserOAuthLoginStart>;
  snapshot(): BrowserOAuthLoginSnapshot;
  cancel(loginId: string): Promise<boolean>;
  logout(): Promise<void>;
}

let runtime: ChatGptOAuthRouteRuntime | null = null;

/** Install the home-bound auth/session coordinator at worker boot. */
export function installChatGptOAuthRouteRuntime(value: ChatGptOAuthRouteRuntime | null): void {
  runtime = value;
}

export function chatGptSettingsAuthState(): ProviderAuthState {
  try {
    return runtime?.status().authState ?? {
      status: "unavailable",
      error: "ChatGPT authentication is unavailable",
    };
  } catch {
    return { status: "unavailable", error: "ChatGPT authentication is unavailable" };
  }
}

/** Explicit user retry rail; ordinary settings/status reads never cause I/O. */
export async function retryChatGptCatalogue(): Promise<void> {
  await runtime?.retryCatalogue?.();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function publicMessage(code: ProviderErrorCode): string {
  switch (code) {
    case "BAD_REQUEST": return "The request was invalid";
    case "CANCELLED": return "ChatGPT sign-in was cancelled";
    case "AUTH_REQUIRED": return "ChatGPT sign-in required";
    case "AUTH_EXPIRED": return "ChatGPT sign-in expired";
    case "TIMEOUT": return "ChatGPT sign-in timed out";
    default: return "ChatGPT authentication is unavailable";
  }
}

function errorCode(error: unknown): ProviderErrorCode {
  if (error instanceof BrowserOAuthError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && [
      "BAD_REQUEST", "CANCELLED", "AUTH_REQUIRED", "AUTH_EXPIRED", "TIMEOUT",
      "PROVIDER_UNAVAILABLE", "TRANSPORT_ERROR",
    ].includes(code)) return code as ProviderErrorCode;
  }
  return "PROVIDER_UNAVAILABLE";
}

function fail(res: ServerResponse, error: unknown, status?: number): void {
  const code = errorCode(error);
  sendJson(res, status ?? (code === "BAD_REQUEST" ? 400 : code === "AUTH_REQUIRED" ? 401 : 503), {
    error: { code, message: publicMessage(code) },
  });
}

async function readClosedBody(
  req: IncomingMessage,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) throw new BrowserOAuthError("BAD_REQUEST", "request body too large");
    chunks.push(value);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BrowserOAuthError("BAD_REQUEST", "invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BrowserOAuthError("BAD_REQUEST", "invalid JSON body");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new BrowserOAuthError("BAD_REQUEST", "unknown request field");
  }
  return value as Record<string, unknown>;
}

function safeLoginId(value: unknown): string {
  if (typeof value !== "string" || !LOGIN_ID.test(value)) {
    throw new BrowserOAuthError("BAD_REQUEST", "invalid login identifier");
  }
  return value;
}

function requireNoQuery(url: URL): void {
  if ([...url.searchParams.keys()].length !== 0) {
    throw new BrowserOAuthError("BAD_REQUEST", "invalid query");
  }
}

function iso(ms: number | null): string | null {
  if (ms === null || !Number.isSafeInteger(ms) || ms < 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function safeOptionalText(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" && value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= maxBytes && !/\p{Cc}/u.test(value)
    ? value
    : null;
}

function safeIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

function loginSnapshot(value: BrowserOAuthLoginSnapshot) {
  const statuses = ["idle", "awaiting_browser", "exchanging", "signed_in", "failed", "cancelled", "expired"];
  return {
    login_id: value.loginId !== null && LOGIN_ID.test(value.loginId) ? value.loginId : null,
    status: statuses.includes(value.status) ? value.status : "failed",
    expires_at: iso(value.expiresAt),
    error: value.error !== null && PUBLIC_ERROR_CODES.has(value.error) ? value.error : null,
  };
}

function safeStart(value: BrowserOAuthLoginStart) {
  const loginId = safeLoginId(value.loginId);
  if (typeof value.authUrl !== "string" || Buffer.byteLength(value.authUrl, "utf8") > 8_192) {
    throw new BrowserOAuthError("PROVIDER_UNAVAILABLE", "invalid authorization URL");
  }
  let url: URL;
  try {
    url = new URL(value.authUrl);
  } catch {
    throw new BrowserOAuthError("PROVIDER_UNAVAILABLE", "invalid authorization URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" ||
      url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash) {
    throw new BrowserOAuthError("PROVIDER_UNAVAILABLE", "invalid authorization URL");
  }
  const expiresAt = iso(value.expiresAt);
  if (!expiresAt) throw new BrowserOAuthError("PROVIDER_UNAVAILABLE", "invalid login expiry");
  return { login_id: loginId, auth_url: url.toString(), expires_at: expiresAt };
}

export async function handleChatGptOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith(ROOT)) return false;
  const active = runtime;
  if (!active) {
    fail(res, { code: "PROVIDER_UNAVAILABLE" });
    return true;
  }

  try {
    if (req.method === "POST") requireTrustedMutationOrigin(req);
    if (req.method === "GET" && url.pathname === `${ROOT}/status`) {
      requireNoQuery(url);
      const status = active.status();
      const authState = ["ready", "signed_out", "expired", "unavailable", "degraded"]
        .includes(status.authState.status) ? status.authState.status : "unavailable";
      const quotaState = ["unknown", "available", "limited", "exhausted"]
        .includes(status.quota.state) ? status.quota.state : "unknown";
      const canaryStatus = ["unknown", "passed", "failed"].includes(status.canary.status)
        ? status.canary.status
        : "unknown";
      const canaryError = status.canary.error && PUBLIC_ERROR_CODES.has(status.canary.error.code)
        ? { code: status.canary.error.code, message: "ChatGPT compatibility check failed" }
        : null;
      sendJson(res, 200, {
        signed_in: authState === "ready" || authState === "degraded",
        auth_state: authState,
        plan: safeOptionalText(status.plan, 128),
        quota: { state: quotaState, reset_at: safeIso(status.quota.resetAt) },
        token_expires_at: safeIso(status.tokenExpiresAt),
        canary: {
          status: canaryStatus,
          checked_at: safeIso(status.canary.checkedAt),
          error: canaryError,
        },
      });
      return true;
    }
    if (req.method === "POST" && url.pathname === `${ROOT}/login/start`) {
      requireNoQuery(url);
      await readClosedBody(req, []);
      const started = await active.start();
      sendJson(res, 200, safeStart(started));
      return true;
    }
    if (req.method === "GET" && url.pathname === `${ROOT}/login/status`) {
      if ([...url.searchParams.keys()].some((key) => key !== "login_id") ||
          url.searchParams.getAll("login_id").length !== 1) {
        throw new BrowserOAuthError("BAD_REQUEST", "invalid query");
      }
      const loginId = safeLoginId(url.searchParams.get("login_id"));
      const snapshot = active.snapshot();
      if (snapshot.loginId !== loginId) throw new BrowserOAuthError("BAD_REQUEST", "login was not found");
      sendJson(res, 200, loginSnapshot(snapshot));
      return true;
    }
    if (req.method === "POST" && url.pathname === `${ROOT}/login/cancel`) {
      requireNoQuery(url);
      const body = await readClosedBody(req, ["login_id"]);
      const cancelled = await active.cancel(safeLoginId(body.login_id));
      sendJson(res, 200, { cancelled });
      return true;
    }
    if (req.method === "POST" && url.pathname === `${ROOT}/logout`) {
      requireNoQuery(url);
      await readClosedBody(req, []);
      await active.logout();
      sendJson(res, 200, { signed_out: true });
      return true;
    }
  } catch (error) {
    fail(res, error);
    return true;
  }

  sendJson(res, 405, { error: { code: "BAD_REQUEST", message: "Method not allowed" } });
  return true;
}
