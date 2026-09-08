import {
  assertExpectedProbeAccount,
  expectedProbeAccountFingerprint,
} from "./account.js";
import {
  BROWSER_AUTH_ATTEMPT_TTL_MS,
  BROWSER_OAUTH_CALLBACK_HOST,
  BROWSER_OAUTH_CALLBACK_PATH,
  BROWSER_OAUTH_CALLBACK_PORT,
  createBrowserAuthorizationAttempt,
  pkceChallengeForVerifier,
  type BrowserPkceHooks,
} from "./browser-pkce.js";
import type {
  BrowserLoopbackListener,
  BrowserLoopbackOptions,
} from "./browser-loopback.js";
import {
  BrowserSmokeNetworkBudget,
  type BrowserSmokeNetworkCounts,
} from "./browser-smoke-budget.js";
import {
  buildBrowserSmokeEvidence,
  type BrowserSmokeEvidence,
} from "./browser-smoke-evidence.js";
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  LIVE_PROBE_ENV,
  superTwinUserAgent,
} from "./constants.js";
import { EphemeralProbeTokenSession, ProbeAuthError } from "./refresh.js";
import { enforceScratchHomeInvariant } from "./scratch.js";
import { BROWSER_OAUTH_REDIRECT_URI } from "./browser-pkce.js";

export const LIVE_BROWSER_AUTH_SMOKE_ENV =
  "SUPERTWIN_RUN_LIVE_CHATGPT_BROWSER_AUTH_SMOKE";
export const BROWSER_TOKEN_RESPONSE_MAX_BYTES = 128 * 1024;
export const BROWSER_TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface BrowserAuthSmokeHooks extends BrowserPkceHooks {
  fetch: typeof fetch;
  openAuthorizationUrl(url: string, signal: AbortSignal): Promise<void>;
  listenerFactory(options: BrowserLoopbackOptions): Promise<BrowserLoopbackListener>;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onNetworkActuals?(counts: BrowserSmokeNetworkCounts): void;
}

interface BrowserTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAtMs?: number;
}

function requirePreflight(env: NodeJS.ProcessEnv): string {
  if (env[LIVE_PROBE_ENV] !== "1" || env[LIVE_BROWSER_AUTH_SMOKE_ENV] !== "1") {
    throw new Error(
      `REFUSED: browser-auth smoke requires ${LIVE_PROBE_ENV}=1 and ${LIVE_BROWSER_AUTH_SMOKE_ENV}=1`,
    );
  }
  const version = env.SUPERTWIN_APP_VERSION?.trim() || env.npm_package_version?.trim();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("REFUSED: browser-auth smoke requires a concrete semver SUPERTWIN_APP_VERSION");
  }
  return expectedProbeAccountFingerprint(env);
}

async function boundedTokenJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ProbeAuthError("TOKEN_ERROR", "OAuth token response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BROWSER_TOKEN_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new ProbeAuthError("TOKEN_ERROR", "OAuth token response exceeded its byte limit");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ProbeAuthError(
      "TOKEN_ERROR",
      `OAuth token exchange returned invalid JSON (HTTP ${response.status})`,
    );
  }
}

function requiredToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProbeAuthError("TOKEN_ERROR", `OAuth token exchange is missing ${label}`);
  }
  return value;
}

export async function exchangeBrowserAuthorizationCode(
  code: string,
  codeVerifier: string,
  hooks: Pick<BrowserAuthSmokeHooks, "fetch" | "now" | "env" | "signal">,
): Promise<BrowserTokenPair> {
  const timeout = AbortSignal.timeout(BROWSER_TOKEN_REQUEST_TIMEOUT_MS);
  const signal = hooks.signal ? AbortSignal.any([hooks.signal, timeout]) : timeout;
  const response = await hooks.fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": superTwinUserAgent(hooks.env),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH_CLIENT_ID,
      code,
      redirect_uri: BROWSER_OAUTH_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  if (response.status === 429) {
    await response.body?.cancel();
    throw new ProbeAuthError("RATE_LIMITED", "OAuth token exchange was rate-limited");
  }
  const payload = await boundedTokenJson(response);
  if (!response.ok) {
    throw new ProbeAuthError("TOKEN_ERROR", `OAuth token exchange failed (HTTP ${response.status})`);
  }
  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : undefined;
  return {
    accessToken: requiredToken(payload.access_token, "access_token"),
    refreshToken: requiredToken(payload.refresh_token, "refresh_token"),
    ...(expiresIn === undefined ? {} : { expiresAtMs: hooks.now() + expiresIn * 1_000 }),
  };
}

export async function runBrowserAuthSmoke(
  hooks: BrowserAuthSmokeHooks,
): Promise<BrowserSmokeEvidence> {
  const expectedFingerprint = requirePreflight(hooks.env);
  return enforceScratchHomeInvariant(hooks.env, async () => {
    const abortController = new AbortController();
    const deadline = AbortSignal.timeout(BROWSER_AUTH_ATTEMPT_TTL_MS);
    const signal = AbortSignal.any(
      [hooks.signal, abortController.signal, deadline].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined,
      ),
    );
    const budget = new BrowserSmokeNetworkBudget();
    const countedFetch = budget.wrapFetch(hooks.fetch, signal);
    const attempt = createBrowserAuthorizationAttempt(hooks);
    let listener: BrowserLoopbackListener | undefined;
    let session: EphemeralProbeTokenSession | undefined;
    let callbackCode: string | undefined;
    try {
      listener = await hooks.listenerFactory({
        expectedState: attempt.material.state,
        timeoutMs: Math.max(1, attempt.expiresAtMs - hooks.now()),
        signal,
      });
      if (
        listener.addressEvidence.host !== BROWSER_OAUTH_CALLBACK_HOST ||
        listener.addressEvidence.port !== BROWSER_OAUTH_CALLBACK_PORT ||
        listener.addressEvidence.path !== BROWSER_OAUTH_CALLBACK_PATH
      ) {
        throw new Error("REFUSED: browser-auth smoke listener used an unregistered callback address");
      }
      budget.recordAuthorizationNavigation(attempt.authUrl);
      try {
        await hooks.openAuthorizationUrl(attempt.authUrl, signal);
      } catch {
        throw new Error("Browser authorization page could not be opened");
      }
      const callback = await listener.wait();
      callbackCode = callback.code;
      const initial = await exchangeBrowserAuthorizationCode(
        callbackCode,
        attempt.material.codeVerifier,
        { fetch: countedFetch, now: hooks.now, env: hooks.env, signal },
      );
      assertExpectedProbeAccount(initial.accessToken, hooks.env);
      session = new EphemeralProbeTokenSession(initial);
      const refreshed = await session.refresh({
        fetch: countedFetch,
        now: hooks.now,
        env: hooks.env,
        signal,
      });
      assertExpectedProbeAccount(refreshed.accessToken, hooks.env);
      const refreshRotatedBeforeUse =
        refreshed.accessToken !== initial.accessToken &&
        refreshed.refreshToken !== initial.refreshToken &&
        session.current().accessToken === refreshed.accessToken &&
        session.current().refreshToken === refreshed.refreshToken &&
        session.evidence().previousRecoveryPairAvailable;
      session.logout();
      let logoutCleared = false;
      try {
        session.current();
      } catch (error) {
        logoutCleared = error instanceof ProbeAuthError && error.code === "AUTH_REQUIRED";
      }
      await listener.close();
      const counts = budget.snapshot();
      return buildBrowserSmokeEvidence({
        accountFingerprint: expectedFingerprint,
        pkceCorrelation:
          pkceChallengeForVerifier(attempt.material.codeVerifier) ===
          attempt.material.codeChallenge,
        stateValidated: callback.stateValidated,
        callbackAccepted: 1,
        listenerCleanedUp: true,
        refreshRotatedBeforeUse,
        logoutCleared,
        counts,
      });
    } finally {
      callbackCode = undefined;
      session?.logout();
      abortController.abort(new Error("browser-auth smoke finished"));
      await listener?.close();
      hooks.onNetworkActuals?.(budget.snapshot());
    }
  });
}
