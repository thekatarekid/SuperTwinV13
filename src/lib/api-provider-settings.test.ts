import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelChatGptLogin,
  fetchChatGptLoginStatus,
  fetchChatGptProviderStatus,
  logoutChatGpt,
  saveIntelligenceProvider,
  startChatGptLogin,
  type ChatGptLoginStart,
  type ChatGptProviderStatus,
} from "./api";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return { ok: true, status: 200, json: async () => body };
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("provider-aware Settings API client (V2 P3-A)", () => {
  it("posts only the closed provider selector body", async () => {
    const calls = installFetch({});
    await saveIntelligenceProvider("chatgpt-oauth");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { provider: "chatgpt-oauth" },
    });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/settings/provider");

    if (false) {
      // @ts-expect-error P3-A deliberately has no API-key or arbitrary-provider escape hatch.
      void saveIntelligenceProvider("openai-api-key");
    }
  });

  it("uses the browser-PKCE start route without a code-entry payload", async () => {
    const response: ChatGptLoginStart = {
      login_id: "login-1",
      auth_url: "https://auth.openai.com/oauth/authorize?safe=1",
      expires_at: "2026-09-08T12:00:00.000Z",
    };
    const calls = installFetch(response);

    await expect(startChatGptLogin()).resolves.toEqual(response);
    expect(calls[0]).toMatchObject({ method: "POST", body: undefined });
    expect(new URL(calls[0]!.url).pathname)
      .toBe("/api/providers/chatgpt-oauth/login/start");
  });

  it("encodes the opaque login id for status and sends it explicitly for cancellation", async () => {
    const calls = installFetch({
      login_id: "attempt /?&",
      status: "awaiting_browser",
      expires_at: "2026-09-08T12:00:00.000Z",
      error: null,
    });

    await fetchChatGptLoginStatus("attempt /?&");
    await cancelChatGptLogin("attempt /?&");

    const statusUrl = new URL(calls[0]!.url);
    expect(statusUrl.pathname).toBe("/api/providers/chatgpt-oauth/login/status");
    expect(statusUrl.searchParams.get("login_id")).toBe("attempt /?&");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: { login_id: "attempt /?&" },
    });
    expect(new URL(calls[1]!.url).pathname)
      .toBe("/api/providers/chatgpt-oauth/login/cancel");
  });

  it("keeps provider status and logout on redacted dedicated routes", async () => {
    const response: ChatGptProviderStatus = {
      signed_in: false,
      auth_state: "signed_out",
      plan: null,
      quota: { state: "unknown", reset_at: null },
      token_expires_at: null,
      canary: { status: "unknown", checked_at: null, error: null },
    };
    const statusCalls = installFetch(response);

    await expect(fetchChatGptProviderStatus()).resolves.toEqual(response);
    expect(statusCalls.map((call) => [new URL(call.url).pathname, call.method, call.body]))
      .toEqual([["/api/providers/chatgpt-oauth/status", "GET", undefined]]);

    vi.unstubAllGlobals();
    const logoutCalls = installFetch({ signed_out: true });
    await expect(logoutChatGpt()).resolves.toEqual({ signed_out: true });
    expect(logoutCalls.map((call) => [new URL(call.url).pathname, call.method, call.body]))
      .toEqual([["/api/providers/chatgpt-oauth/logout", "POST", undefined]]);
  });

  it("does not admit credential or user-entered authorization-code fields", () => {
    type PublicKeys = keyof ChatGptProviderStatus | keyof ChatGptLoginStart;
    type Forbidden = Extract<
      PublicKeys,
      "access_token" | "refresh_token" | "authorization_code" | "user_code" | "account_id"
    >;
    const noForbiddenPublicKeys: Forbidden extends never ? true : false = true;
    expect(noForbiddenPublicKeys).toBe(true);
  });
});
