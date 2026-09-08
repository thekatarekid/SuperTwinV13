import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  BrowserOAuthError,
  BrowserOAuthManager,
  CHATGPT_OAUTH_AUTHORIZE_URL,
  CHATGPT_OAUTH_CALLBACK_HOST,
  CHATGPT_OAUTH_CALLBACK_PATH,
  CHATGPT_OAUTH_CALLBACK_PORT,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_SCOPE,
  CHATGPT_OAUTH_TOKEN_URL,
  browserOAuthAuthorizationUrl,
  browserOAuthCompletionPage,
  createBrowserOAuthCredentialStore,
  createBrowserOAuthPkce,
  createBrowserOAuthTokenSession,
  validateBrowserOAuthCallback,
  type BrowserOAuthCallback,
  type BrowserOAuthCallbackListenerOptions,
  type BrowserOAuthCredentialStore,
  type BrowserOAuthExchangeTokens,
  type BrowserOAuthManagerDependencies,
  type BrowserOAuthTokenPair,
} from "./auth.js";
import type { ChatGptTokenSession } from "./keychain.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deterministicRandom(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => {
    call += 1;
    return new Uint8Array(size).fill(call);
  };
}

function tokenResponse(payload: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    id_token: "identity-secret",
    expires_in: 3_600,
    ...payload,
  }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.${Buffer.from("signature").toString("base64url")}`;
}

function makeFixture(overrides: Partial<BrowserOAuthManagerDependencies> = {}) {
  const callback = deferred<BrowserOAuthCallback>();
  const finish = vi.fn<(success: boolean) => void>();
  const close = vi.fn(async () => undefined);
  let listenerOptions: BrowserOAuthCallbackListenerOptions | undefined;
  const createCallbackListener = vi.fn(async (options: BrowserOAuthCallbackListenerOptions) => {
    listenerOptions = options;
    return { callback: callback.promise, close };
  });
  const openBrowser = vi.fn(async (_url: string) => undefined);
  const fetchSpy = vi.fn(async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) => tokenResponse());
  const prepared: BrowserOAuthTokenPair = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAtMs: 1_700_003_600_000,
    accountId: "account-safe",
  };
  const prepare = vi.fn(async (_tokens: BrowserOAuthExchangeTokens, _signal: AbortSignal) => prepared);
  const save = vi.fn(async (_pair: BrowserOAuthTokenPair, _signal: AbortSignal) => undefined);
  let timeoutCallback: (() => void) | undefined;
  const timerHandle = Object.freeze({ timer: "oauth" });
  const scheduleTimeout = vi.fn((next: () => void, _delayMs: number) => {
    timeoutCallback = next;
    return timerHandle;
  });
  const clearScheduledTimeout = vi.fn((_handle: unknown) => undefined);
  const dependencies: BrowserOAuthManagerDependencies = {
    openBrowser,
    credentialStore: { save },
    tokenSession: { prepare },
    fetch: fetchSpy as unknown as typeof fetch,
    createCallbackListener,
    randomBytes: deterministicRandom(),
    now: () => 1_700_000_000_000,
    scheduleTimeout,
    clearScheduledTimeout,
    timeoutMs: 60_000,
    ...overrides,
  };
  const manager = new BrowserOAuthManager(dependencies);
  return {
    manager,
    callback,
    finish,
    close,
    createCallbackListener,
    openBrowser,
    fetchSpy,
    prepare,
    save,
    scheduleTimeout,
    clearScheduledTimeout,
    timerHandle,
    listenerOptions: () => listenerOptions,
    fireTimeout: () => {
      if (!timeoutCallback) throw new Error("timeout was not scheduled");
      timeoutCallback();
    },
    resolveCallback(code = "authorization-secret") {
      callback.resolve({ code, response: { finish } });
    },
  };
}

function validCallback(target = `${CHATGPT_OAUTH_CALLBACK_PATH}?code=code-safe&state=state-safe`) {
  return {
    method: "GET",
    target,
    host: "localhost:1455",
    rawHeaders: ["Host", "localhost:1455"],
  } as const;
}

describe("browser OAuth PKCE contract", () => {
  it("adapts the account-locked production token session at the persistence seam", () => {
    expectTypeOf<ChatGptTokenSession>().toMatchTypeOf<import("./auth.js").BrowserOAuthSessionInstaller>();
    expectTypeOf(createBrowserOAuthCredentialStore).returns.toMatchTypeOf<BrowserOAuthCredentialStore>();
  });

  it("projects bounded matching JWT identity and account claims without persisting the id token", async () => {
    const session = createBrowserOAuthTokenSession();
    const signal = new AbortController().signal;
    const accessToken = jwt({
      sub: "user-safe",
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-safe" },
    });
    const pair = await session.prepare({
      accessToken,
      refreshToken: "refresh-safe",
      idToken: jwt({ sub: "user-safe" }),
      expiresAtMs: 1_700_003_600_000,
    }, signal);
    expect(pair).toEqual({
      accessToken,
      refreshToken: "refresh-safe",
      expiresAtMs: 1_700_003_600_000,
      accountId: "workspace-safe",
    });
    expect(pair).not.toHaveProperty("idToken");
  });

  it.each([
    ["non-JWT access", "opaque", jwt({ sub: "user-safe" })],
    ["missing account", jwt({ sub: "user-safe" }), jwt({ sub: "user-safe" })],
    ["mismatched subject", jwt({ sub: "other", "https://api.openai.com/auth": { chatgpt_account_id: "workspace-safe" } }), jwt({ sub: "user-safe" })],
    ["missing identity subject", jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "workspace-safe" } }), jwt({ aud: CHATGPT_OAUTH_CLIENT_ID })],
  ])("rejects %s identity before persistence", async (_name, accessToken, idToken) => {
    await expect(createBrowserOAuthTokenSession().prepare({
      accessToken,
      refreshToken: "refresh-safe",
      idToken,
      expiresAtMs: 1_700_003_600_000,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("persists through the account-locked installer and forwards cancellation", async () => {
    const install = vi.fn(async (_pair: BrowserOAuthTokenPair, _signal?: AbortSignal) => undefined);
    const store = createBrowserOAuthCredentialStore({ install });
    const controller = new AbortController();
    const pair: BrowserOAuthTokenPair = {
      accessToken: "access-safe",
      refreshToken: "refresh-safe",
      expiresAtMs: 1_700_003_600_000,
      accountId: "workspace-safe",
    };
    await store.save(pair, controller.signal);
    expect(install).toHaveBeenCalledExactlyOnceWith(pair, controller.signal);

    controller.abort();
    await expect(store.save(pair, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(install).toHaveBeenCalledOnce();
  });

  it("creates independent high-entropy PKCE/state material and the exact authorization URL", () => {
    const material = createBrowserOAuthPkce(deterministicRandom());
    expect(material.verifier).toHaveLength(86);
    expect(material.state).toHaveLength(43);
    expect(material.loginId).toHaveLength(22);
    expect(material.verifier).not.toBe(material.state);
    expect(material.challenge).toBe(
      createHash("sha256").update(material.verifier, "ascii").digest("base64url"),
    );

    const authUrl = new URL(browserOAuthAuthorizationUrl(material));
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(CHATGPT_OAUTH_AUTHORIZE_URL);
    expect([...authUrl.searchParams.keys()]).toEqual([
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "id_token_add_organizations",
      "codex_cli_simplified_flow",
      "originator",
    ]);
    expect(Object.fromEntries(authUrl.searchParams)).toEqual({
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
      response_type: "code",
      scope: CHATGPT_OAUTH_SCOPE,
      state: material.state,
      code_challenge: material.challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "supertwinv13",
    });
    expect(authUrl.search).not.toContain(material.verifier);
  });

  it("uses real cryptographic entropy by default", () => {
    const first = createBrowserOAuthPkce();
    const second = createBrowserOAuthPkce();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
    expect(randomBytes(1)).toHaveLength(1);
  });

  it("accepts only the exact callback host, path, method, state, and one bounded code", () => {
    expect(validateBrowserOAuthCallback(validCallback(), "state-safe")).toBe("code-safe");
  });

  it.each([
    ["wrong method", { ...validCallback(), method: "POST" }],
    ["wrong host", { ...validCallback(), host: "127.0.0.1:1455" }],
    ["wrong path", validCallback("/other?code=code-safe&state=state-safe")],
    ["absolute target", validCallback("http://localhost:1455/auth/callback?code=x&state=state-safe")],
    ["fragment", validCallback("/auth/callback?code=x&state=state-safe#fragment")],
    ["bad state", validCallback("/auth/callback?code=x&state=wrong")],
    ["duplicate state", validCallback("/auth/callback?code=x&state=state-safe&state=state-safe")],
    ["duplicate code", validCallback("/auth/callback?code=x&code=y&state=state-safe")],
    ["empty code", validCallback("/auth/callback?code=&state=state-safe")],
    ["malformed encoding", validCallback("/auth/callback?code=%ZZ&state=state-safe")],
    ["duplicate Host", { ...validCallback(), rawHeaders: ["Host", "localhost:1455", "host", "localhost:1455"] }],
    ["oversized target", validCallback(`/auth/callback?code=${"a".repeat(4_100)}&state=state-safe`)],
    ["OAuth denial", validCallback("/auth/callback?error=access_denied&state=state-safe")],
  ])("rejects %s without reflecting callback data", (_name, request) => {
    expect(() => validateBrowserOAuthCallback(request, "state-safe")).toThrow(BrowserOAuthError);
    try {
      validateBrowserOAuthCallback(request, "state-safe");
    } catch (error) {
      expect(String(error)).not.toContain("access_denied");
      expect(String(error)).not.toContain("code-safe");
    }
  });

  it("uses fixed completion pages with no reflected material", () => {
    expect(browserOAuthCompletionPage(true)).toContain("Signed in to SuperTwin");
    expect(browserOAuthCompletionPage(false)).toContain("Sign-in failed");
    for (const page of [browserOAuthCompletionPage(true), browserOAuthCompletionPage(false)]) {
      expect(page).not.toContain("authorization-secret");
      expect(page).not.toContain("account-safe");
      expect(page).not.toContain(CHATGPT_OAUTH_CALLBACK_PATH);
    }
  });
});

describe("BrowserOAuthManager", () => {
  it("returns the URL without opening a second browser when the shell owns navigation", async () => {
    const fixture = makeFixture({ browserOwner: "caller" });
    const started = await fixture.manager.start();
    expect(started.authUrl).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    expect(fixture.openBrowser).not.toHaveBeenCalled();
    await fixture.manager.cancel(started.loginId);
  });

  it("holds the callback until validation and durable persistence, then exchanges exact fields", async () => {
    const persist = deferred<void>();
    const fixture = makeFixture({
      credentialStore: {
        save: vi.fn(async () => persist.promise),
      },
    });
    const started = await fixture.manager.start();
    expect(fixture.listenerOptions()).toMatchObject({
      host: CHATGPT_OAUTH_CALLBACK_HOST,
      port: CHATGPT_OAUTH_CALLBACK_PORT,
    });
    expect(fixture.openBrowser).toHaveBeenCalledOnce();
    expect(fixture.openBrowser).toHaveBeenCalledWith(started.authUrl, fixture.listenerOptions()!.signal);
    expect(fixture.scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(fixture.manager.snapshot()).toEqual({
      loginId: started.loginId,
      status: "awaiting_browser",
      expiresAt: 1_700_000_060_000,
      error: null,
    });

    fixture.resolveCallback();
    await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce());
    const exchange = fixture.prepare.mock.calls[0]![0];
    expect(exchange).toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "identity-secret",
      expiresAtMs: 1_700_003_600_000,
    });
    expect(fixture.finish).not.toHaveBeenCalled();
    expect(fixture.manager.snapshot().status).toBe("exchanging");

    persist.resolve();
    await fixture.manager.wait(started.loginId);
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.manager.snapshot()).toMatchObject({ status: "signed_in", error: null });
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.clearScheduledTimeout).toHaveBeenCalledWith(fixture.timerHandle);

    expect(fixture.fetchSpy).toHaveBeenCalledOnce();
    const [endpoint, init] = fixture.fetchSpy.mock.calls[0]!;
    expect(endpoint).toBe(CHATGPT_OAUTH_TOKEN_URL);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    });
    expect(Object.fromEntries((init as RequestInit).body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      code: "authorization-secret",
      redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
      code_verifier: expect.any(String),
    });
    expect(JSON.stringify(fixture.manager.snapshot())).not.toMatch(/access-secret|refresh-secret|identity-secret|authorization-secret/);
  });

  it("requires account validation and never persists or reports success when it fails", async () => {
    const fixture = makeFixture({
      tokenSession: { prepare: vi.fn(async () => { throw new Error("raw identity-secret"); }) },
    });
    const started = await fixture.manager.start();
    fixture.resolveCallback();
    await expect(fixture.manager.wait(started.loginId)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.manager.snapshot()).toMatchObject({ status: "failed", error: "AUTH_REQUIRED" });
  });

  it("rejects malformed validated credentials before the Keychain seam", async () => {
    const fixture = makeFixture({
      tokenSession: {
        prepare: vi.fn(async () => ({
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresAtMs: 1_700_003_600_000,
          accountId: "account-safe",
          idToken: "must-not-persist",
        } as BrowserOAuthTokenPair)),
      },
    });
    const started = await fixture.manager.start();
    fixture.resolveCallback();
    await expect(fixture.manager.wait(started.loginId)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("serves failure only after a durable-store failure and exposes no secret", async () => {
    const fixture = makeFixture({
      credentialStore: { save: vi.fn(async () => { throw new Error("refresh-secret"); }) },
    });
    const started = await fixture.manager.start();
    fixture.resolveCallback();
    let failure: unknown;
    try {
      await fixture.manager.wait(started.loginId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(String(failure)).not.toContain("refresh-secret");
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.manager.snapshot()).toMatchObject({ status: "failed", error: "PROVIDER_UNAVAILABLE" });
  });

  it("accepts an optional id token while still requiring the access-token account binding", async () => {
    const accessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-safe" },
    });
    const fetchSpy = vi.fn(async () => tokenResponse({
      access_token: accessToken,
      id_token: undefined,
    }));
    const fixture = makeFixture({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenSession: createBrowserOAuthTokenSession(),
    });
    const started = await fixture.manager.start();
    fixture.resolveCallback();
    await expect(fixture.manager.wait(started.loginId)).resolves.toBeUndefined();
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.manager.snapshot().status).toBe("signed_in");
  });

  it.each([
    ["cancel", (manager: BrowserOAuthManager, id: string) => manager.cancel(id)],
    ["window close", (manager: BrowserOAuthManager, id: string) => manager.windowClosed(id)],
    ["shutdown", (manager: BrowserOAuthManager, _id: string) => manager.shutdown().then(() => true)],
  ])("cleans up on %s without exchanging", async (_name, stop) => {
    const fixture = makeFixture();
    const started = await fixture.manager.start();
    await expect(stop(fixture.manager, started.loginId)).resolves.toBe(true);
    await expect(fixture.manager.wait(started.loginId)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fixture.manager.snapshot()).toMatchObject({ status: "cancelled", error: "CANCELLED" });
    expect(fixture.fetchSpy).not.toHaveBeenCalled();
    expect(fixture.finish).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("expires while waiting for callback and closes without exchange", async () => {
    const fixture = makeFixture();
    const started = await fixture.manager.start();
    fixture.fireTimeout();
    await expect(fixture.manager.wait(started.loginId)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fixture.manager.snapshot()).toMatchObject({ status: "expired", error: "AUTH_REQUIRED" });
    expect(fixture.fetchSpy).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("expires during persistence, sends failure, and never sends late success", async () => {
    let storeSignal: AbortSignal | undefined;
    const fixture = makeFixture({
      credentialStore: {
        save: vi.fn((_pair, signal) => {
          storeSignal = signal;
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          });
        }),
      },
    });
    const started = await fixture.manager.start();
    fixture.resolveCallback();
    await vi.waitFor(() => expect(storeSignal).toBeDefined());
    fixture.fireTimeout();
    await expect(fixture.manager.wait(started.loginId)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(storeSignal?.aborted).toBe(true);
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(false);
    await Promise.resolve();
    expect(fixture.finish).not.toHaveBeenCalledWith(true);
  });

  it("keeps durable signed-in state when the browser disconnects before its success page", async () => {
    const fixture = makeFixture();
    const started = await fixture.manager.start();
    const finish = vi.fn((_success: boolean) => { throw new Error("socket closed"); });
    fixture.callback.resolve({ code: "authorization-secret", response: { finish } });
    await expect(fixture.manager.wait(started.loginId)).resolves.toBeUndefined();
    expect(fixture.save).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.manager.snapshot()).toMatchObject({ status: "signed_in", error: null });
  });

  it("returns false when a raced cancel loses to the durable credential commit", async () => {
    let enteredStore = false;
    const fixture = makeFixture({
      credentialStore: {
        save: vi.fn((_pair, signal) => new Promise<void>((resolve) => {
          enteredStore = true;
          signal.addEventListener("abort", () => resolve(), { once: true });
        })),
      },
    });
    const started = await fixture.manager.start();
    fixture.resolveCallback();
    await vi.waitFor(() => expect(enteredStore).toBe(true));
    await expect(fixture.manager.cancel(started.loginId)).resolves.toBe(false);
    expect(fixture.manager.snapshot()).toMatchObject({ status: "signed_in", error: null });
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("bounds listener setup with the same timeout and never opens a browser", async () => {
    const listenerSetup = deferred<never>();
    let fire: (() => void) | undefined;
    const manager = new BrowserOAuthManager({
      openBrowser: vi.fn(async () => undefined),
      credentialStore: { save: vi.fn(async () => undefined) },
      tokenSession: { prepare: vi.fn(async () => { throw new Error("unreachable"); }) },
      createCallbackListener: vi.fn(async () => listenerSetup.promise),
      randomBytes: deterministicRandom(),
      now: () => 1_700_000_000_000,
      timeoutMs: 60_000,
      scheduleTimeout: (callback) => { fire = callback; return 1; },
      clearScheduledTimeout: vi.fn(),
    });
    const starting = manager.start();
    await vi.waitFor(() => expect(fire).toBeDefined());
    fire!();
    await expect(starting).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("fails closed on port conflict and browser-open failure with no exchange", async () => {
    const portConflict = makeFixture({
      createCallbackListener: vi.fn(async () => {
        throw new BrowserOAuthError("PROVIDER_UNAVAILABLE", "OAuth callback port is already in use");
      }),
    });
    await expect(portConflict.manager.start()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(portConflict.openBrowser).not.toHaveBeenCalled();
    expect(portConflict.fetchSpy).not.toHaveBeenCalled();

    const browserFailure = makeFixture({
      openBrowser: vi.fn(async () => { throw new Error("browser command detail"); }),
    });
    await expect(browserFailure.manager.start()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(browserFailure.fetchSpy).not.toHaveBeenCalled();
    expect(browserFailure.manager.snapshot()).toMatchObject({ status: "failed", error: "PROVIDER_UNAVAILABLE" });
    expect(browserFailure.close).toHaveBeenCalledOnce();
  });

  it("cannot exchange an early callback until browser opening succeeds", async () => {
    const opening = deferred<void>();
    const fixture = makeFixture({ openBrowser: vi.fn(async () => opening.promise) });
    const starting = fixture.manager.start();
    await vi.waitFor(() => expect(fixture.listenerOptions()).toBeDefined());
    fixture.resolveCallback();
    opening.reject(new Error("browser command failed after launch"));
    await expect(starting).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(fixture.fetchSpy).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.finish).not.toHaveBeenCalledWith(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("allows only one active attempt and does not create a second listener", async () => {
    const fixture = makeFixture();
    await fixture.manager.start();
    await expect(fixture.manager.start()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.createCallbackListener).toHaveBeenCalledOnce();
    expect(fixture.openBrowser).toHaveBeenCalledOnce();
    await fixture.manager.shutdown();
  });

  it("contains no production import or fallback to probe, device flow, API keys, or Codex CLI", async () => {
    const source = await readFile(new URL("./auth.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*probe/);
    expect(source).not.toMatch(/deviceauth|device[-_ ]code|api[_-]?key|codex\/auth\.json|spawn\s*\(/i);
  });
});
