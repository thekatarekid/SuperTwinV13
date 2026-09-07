import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  superTwinUserAgent,
} from "./constants.js";

const REFRESH_SKEW_MS = 120_000;
const MAX_TOKEN_RESPONSE_BYTES = 128 * 1024;

export type ProbeAuthErrorCode = "AUTH_REQUIRED" | "AUTH_EXPIRED" | "RATE_LIMITED" | "TOKEN_ERROR";

export class ProbeAuthError extends Error {
  constructor(readonly code: ProbeAuthErrorCode, message: string) {
    super(message);
    this.name = "ProbeAuthError";
  }
}

export interface EphemeralTokenPair {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

export interface RefreshHooks {
  fetch: typeof fetch;
  now(): number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface SafeSessionEvidence {
  authenticated: boolean;
  expiresAtMs?: number;
  hasRefreshToken: boolean;
  previousRecoveryPairAvailable: boolean;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProbeAuthError("TOKEN_ERROR", `OAuth refresh response is missing ${label}`);
  }
  return value;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ProbeAuthError("TOKEN_ERROR", "OAuth refresh response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProbeAuthError("TOKEN_ERROR", "OAuth refresh response exceeded its byte limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new ProbeAuthError("TOKEN_ERROR", `OAuth refresh returned invalid JSON (HTTP ${response.status})`);
  }
}

function tokenSignal(hooks: RefreshHooks): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return hooks.signal ? AbortSignal.any([timeout, hooks.signal]) : timeout;
}

export class EphemeralProbeTokenSession {
  #current?: EphemeralTokenPair;
  #previous?: EphemeralTokenPair;
  #refreshing?: Promise<EphemeralTokenPair>;

  constructor(initial: EphemeralTokenPair) {
    this.#current = { ...initial };
  }

  evidence(): SafeSessionEvidence {
    return {
      authenticated: this.#current !== undefined,
      expiresAtMs: this.#current?.expiresAtMs,
      hasRefreshToken: Boolean(this.#current?.refreshToken),
      previousRecoveryPairAvailable: this.#previous !== undefined,
    };
  }

  current(): EphemeralTokenPair {
    if (!this.#current) throw new ProbeAuthError("AUTH_REQUIRED", "ChatGPT probe is signed out");
    return { ...this.#current };
  }

  shouldRefresh(nowMs: number): boolean {
    return this.#current?.expiresAtMs !== undefined &&
      this.#current.expiresAtMs - nowMs <= REFRESH_SKEW_MS;
  }

  refresh(hooks: RefreshHooks): Promise<EphemeralTokenPair> {
    if (this.#refreshing) return this.#refreshing;
    const pending = this.#performRefresh(hooks);
    this.#refreshing = pending;
    void pending.finally(() => {
      if (this.#refreshing === pending) this.#refreshing = undefined;
    }).catch(() => undefined);
    return pending;
  }

  async #performRefresh(hooks: RefreshHooks): Promise<EphemeralTokenPair> {
    const current = this.current();
    if (!current.refreshToken) {
      throw new ProbeAuthError("AUTH_EXPIRED", "OAuth session has no refresh token; sign in again");
    }
    const response = await hooks.fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: tokenSignal(hooks),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": superTwinUserAgent(hooks.env),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
    });
    if (response.status === 429) {
      await response.body?.cancel();
      throw new ProbeAuthError("RATE_LIMITED", "OpenAI rate-limited OAuth refresh; stop the probe");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ProbeAuthError("AUTH_EXPIRED", "OAuth refresh was rejected; sign in again");
    }
    const payload = await boundedJson(response);
    const errorCode = typeof payload.error === "string" ? payload.error : undefined;
    if (errorCode === "invalid_grant") {
      throw new ProbeAuthError("AUTH_EXPIRED", "OAuth refresh was rejected; sign in again");
    }
    if (!response.ok) {
      throw new ProbeAuthError("TOKEN_ERROR", `OAuth refresh failed (HTTP ${response.status})`);
    }

    const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : undefined;
    const rotated: EphemeralTokenPair = {
      accessToken: requiredString(payload.access_token, "access_token"),
      refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token
        ? payload.refresh_token
        : current.refreshToken,
      expiresAtMs: expiresIn === undefined ? current.expiresAtMs : hooks.now() + expiresIn * 1_000,
    };

    // The new pair becomes current before any waiter can observe the resolved promise.
    this.#previous = current;
    this.#current = rotated;
    return { ...rotated };
  }

  async retryOnceAfter401<T extends { status: number }>(
    send: (accessToken: string) => Promise<T>,
    hooks: RefreshHooks,
  ): Promise<T> {
    const first = await send(this.current().accessToken);
    if (first.status !== 401) return first;
    const refreshed = await this.refresh(hooks);
    return send(refreshed.accessToken);
  }

  logout(): void {
    this.#current = undefined;
    this.#previous = undefined;
  }
}
