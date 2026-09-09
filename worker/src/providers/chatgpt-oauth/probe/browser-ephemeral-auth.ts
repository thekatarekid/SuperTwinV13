import type { EphemeralOAuthTokens } from "./device-flow.js";
import {
  BROWSER_AUTH_ATTEMPT_TTL_MS,
  BROWSER_OAUTH_CALLBACK_HOST,
  BROWSER_OAUTH_CALLBACK_PATH,
  BROWSER_OAUTH_CALLBACK_PORT,
  createBrowserAuthorizationAttempt,
  type BrowserPkceHooks,
} from "./browser-pkce.js";
import type { BrowserLoopbackOptions, BrowserLoopbackListener } from "./browser-loopback.js";
import { exchangeBrowserAuthorizationCode } from "./browser-auth-smoke.js";

export interface BrowserEphemeralAuthHooks extends BrowserPkceHooks {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  openAuthorizationUrl(url: string, signal: AbortSignal): Promise<void>;
  listenerFactory(options: BrowserLoopbackOptions): Promise<BrowserLoopbackListener>;
}

/** Browser Authorization Code + PKCE for ephemeral Phase 0b diagnostics. */
export async function runBrowserEphemeralAuth(
  hooks: BrowserEphemeralAuthHooks,
): Promise<EphemeralOAuthTokens> {
  const localAbort = new AbortController();
  const deadline = AbortSignal.timeout(BROWSER_AUTH_ATTEMPT_TTL_MS);
  const signal = AbortSignal.any(
    [hooks.signal, localAbort.signal, deadline].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
  const attempt = createBrowserAuthorizationAttempt(hooks);
  let listener: BrowserLoopbackListener | undefined;
  let callbackCode: string | undefined;
  try {
    listener = await hooks.listenerFactory({
      expectedState: attempt.material.state,
      timeoutMs: Math.max(1, attempt.expiresAtMs - hooks.now()),
      signal,
    });
    const address = listener.addressEvidence;
    if (address.host !== BROWSER_OAUTH_CALLBACK_HOST ||
        address.port !== BROWSER_OAUTH_CALLBACK_PORT ||
        address.path !== BROWSER_OAUTH_CALLBACK_PATH) {
      throw new Error("REFUSED: browser OAuth listener used an unregistered callback address");
    }
    await hooks.openAuthorizationUrl(attempt.authUrl, signal);
    const callback = await listener.wait();
    if (!callback.stateValidated) {
      throw new Error("REFUSED: browser OAuth callback state was not validated");
    }
    callbackCode = callback.code;
    return await exchangeBrowserAuthorizationCode(
      callbackCode,
      attempt.material.codeVerifier,
      { fetch: hooks.fetch, now: hooks.now, env: hooks.env, signal },
    );
  } finally {
    callbackCode = undefined;
    localAbort.abort(new Error("Phase 0b browser OAuth ceremony finished"));
    await listener?.close();
  }
}
