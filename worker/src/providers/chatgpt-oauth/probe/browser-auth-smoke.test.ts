import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { accountFingerprint } from "./account.js";
import {
  exchangeBrowserAuthorizationCode,
  LIVE_BROWSER_AUTH_SMOKE_ENV,
  runBrowserAuthSmoke,
  type BrowserAuthSmokeHooks,
} from "./browser-auth-smoke.js";
import type {
  BrowserLoopbackListener,
  BrowserLoopbackOptions,
} from "./browser-loopback.js";
import { pkceChallengeForVerifier } from "./browser-pkce.js";
import { CODEX_OAUTH_TOKEN_URL, LIVE_PROBE_ENV } from "./constants.js";

const ACCOUNT_ID = "acct-browser-smoke";
const scratchHomes: string[] = [];

afterEach(() => {
  for (const path of scratchHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function scratchHome(): string {
  const path = mkdtempSync(join(tmpdir(), "supertwin-browser-smoke-"));
  chmodSync(path, 0o700);
  scratchHomes.push(path);
  return path;
}

function accessToken(signature: string, accountId = ACCOUNT_ID): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.${signature}`;
}

function tokenResponse(access: string, refresh: string): Response {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3_600 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    [LIVE_PROBE_ENV]: "1",
    [LIVE_BROWSER_AUTH_SMOKE_ENV]: "1",
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: scratchHome(),
    SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: accountFingerprint(ACCOUNT_ID),
  };
}

function fakeListenerFactory(
  seen: BrowserLoopbackOptions[],
  close = vi.fn(async () => {}),
): (options: BrowserLoopbackOptions) => Promise<BrowserLoopbackListener> {
  return async (options) => {
    seen.push(options);
    return {
      addressEvidence: { host: "127.0.0.1", port: 1455, path: "/auth/callback" },
      wait: async () => ({ code: "authorization-code-secret", stateValidated: true }),
      cancel: vi.fn(),
      close,
    };
  };
}

function smokeHooks(overrides: Partial<BrowserAuthSmokeHooks> = {}) {
  let randomCall = 0;
  const seenListenerOptions: BrowserLoopbackOptions[] = [];
  const opened: string[] = [];
  const close = vi.fn(async () => {});
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    const grant = new URLSearchParams(String(init?.body)).get("grant_type");
    return grant === "authorization_code"
      ? tokenResponse(accessToken("initial"), "refresh-initial")
      : tokenResponse(accessToken("rotated"), "refresh-rotated");
  });
  const hooks: BrowserAuthSmokeHooks = {
    fetch: fetchMock,
    openAuthorizationUrl: async (url) => {
      opened.push(url);
    },
    listenerFactory: fakeListenerFactory(seenListenerOptions, close),
    randomBytes: (size) => new Uint8Array(size).fill(++randomCall),
    now: () => 1_000,
    env: validEnv(),
    ...overrides,
  };
  return { hooks, fetchMock, opened, seenListenerOptions, close };
}

describe("zero-inference browser auth smoke orchestration", () => {
  it("binds before opening, exchanges once, refreshes once, verifies account and logs out", async () => {
    const { hooks, fetchMock, opened, seenListenerOptions, close } = smokeHooks();
    const evidence = await runBrowserAuthSmoke(hooks);

    expect(seenListenerOptions).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CODEX_OAUTH_TOKEN_URL,
      CODEX_OAUTH_TOKEN_URL,
    ]);
    const authUrl = new URL(opened[0]!);
    expect(seenListenerOptions[0]?.expectedState).toBe(
      authUrl.searchParams.get("state"),
    );
    const exchangeBody = new URLSearchParams(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    );
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect([...exchangeBody.keys()]).toEqual([
      "grant_type",
      "client_id",
      "code",
      "redirect_uri",
      "code_verifier",
    ]);
    expect(exchangeBody.get("code")).toBe("authorization-code-secret");
    expect(exchangeBody.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );
    expect(pkceChallengeForVerifier(exchangeBody.get("code_verifier")!)).toBe(
      authUrl.searchParams.get("code_challenge"),
    );
    const refreshBody = new URLSearchParams(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    );
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect([...refreshBody.keys()]).toEqual([
      "grant_type",
      "refresh_token",
      "client_id",
    ]);
    expect(refreshBody.get("refresh_token")).toBe("refresh-initial");
    expect(close).toHaveBeenCalled();
    expect(evidence).toMatchObject({
      status: "passed",
      accountFingerprint: accountFingerprint(ACCOUNT_ID),
      refreshRotatedBeforeUse: true,
      logoutCleared: true,
      networkActuals: {
        authorizeNavigation: 1,
        tokenExchange: 1,
        tokenRefresh: 1,
        deviceCode: 0,
        devicePoll: 0,
        models: 0,
        quota: 0,
        inference: 0,
        other: 0,
        workerFetchTotal: 2,
        controlledRemoteTotal: 3,
      },
    });
  });

  it("fails closed before listener, opener, and fetch when either opt-in is absent", async () => {
    for (const missing of [LIVE_PROBE_ENV, LIVE_BROWSER_AUTH_SMOKE_ENV]) {
      const listenerFactory = vi.fn();
      const openAuthorizationUrl = vi.fn();
      const fetchMock = vi.fn<typeof fetch>();
      const { hooks } = smokeHooks({ listenerFactory, openAuthorizationUrl, fetch: fetchMock });
      delete hooks.env[missing];
      await expect(runBrowserAuthSmoke(hooks)).rejects.toThrow(/REFUSED/);
      expect(listenerFactory).not.toHaveBeenCalled();
      expect(openAuthorizationUrl).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("does not refresh or retry when account/workspace selection is wrong", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      tokenResponse(accessToken("wrong", "other-account"), "refresh-initial"),
    );
    const { hooks, close } = smokeHooks({ fetch: fetchMock });
    await expect(runBrowserAuthSmoke(hooks)).rejects.toThrow(/dedicated Phase 0b/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
  });

  it("cleans up without fetching when opening the authorization URL fails", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const onNetworkActuals = vi.fn();
    const { hooks, close } = smokeHooks({
      fetch: fetchMock,
      onNetworkActuals,
      openAuthorizationUrl: async () => {
        throw new Error("opener unavailable");
      },
    });
    await expect(runBrowserAuthSmoke(hooks)).rejects.toThrow(/could not be opened/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(onNetworkActuals).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizeNavigation: 1,
        workerFetchTotal: 0,
        inference: 0,
        other: 0,
      }),
    );
  });

  it("rejects an alternate callback address before opening or fetching", async () => {
    const openAuthorizationUrl = vi.fn();
    const fetchMock = vi.fn<typeof fetch>();
    const close = vi.fn(async () => {});
    const { hooks } = smokeHooks({
      fetch: fetchMock,
      openAuthorizationUrl,
      listenerFactory: async () =>
        ({
          addressEvidence: { host: "127.0.0.1", port: 1456, path: "/auth/callback" },
          wait: async () => ({ code: "code", stateValidated: true }),
          cancel: vi.fn(),
          close,
        }) as unknown as BrowserLoopbackListener,
    });
    await expect(runBrowserAuthSmoke(hooks)).rejects.toThrow(/unregistered callback/);
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});

describe("bounded browser authorization-code exchange", () => {
  const baseHooks = {
    now: () => 0,
    env: { SUPERTWIN_APP_VERSION: "13.12.2" },
  };

  it("stops on the first 429 with no retry", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 429 }));
    await expect(
      exchangeBrowserAuthorizationCode("code", "verifier", {
        ...baseHooks,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requires both token values and bounds the response body", async () => {
    const missingRefresh = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ access_token: "access" }), { status: 200 }),
    );
    await expect(
      exchangeBrowserAuthorizationCode("code", "verifier", {
        ...baseHooks,
        fetch: missingRefresh,
      }),
    ).rejects.toMatchObject({ code: "TOKEN_ERROR" });
    expect(missingRefresh).toHaveBeenCalledOnce();

    const oversized = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ payload: "x".repeat(129 * 1024) }), { status: 200 }),
    );
    await expect(
      exchangeBrowserAuthorizationCode("code", "verifier", {
        ...baseHooks,
        fetch: oversized,
      }),
    ).rejects.toThrow(/byte limit/);
    expect(oversized).toHaveBeenCalledOnce();
  });
});
