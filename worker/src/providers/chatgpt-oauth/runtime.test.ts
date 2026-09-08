import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BrowserOAuthManager } from "./auth.js";
import type { ChatGptTokenSession } from "./keychain.js";
import type { ProviderModelCatalogue } from "../types.js";
import { installChatGptOAuthRouteRuntime, handleChatGptOAuthRoute, retryChatGptCatalogue } from "../../server/chatgpt-oauth-routes.js";
import { initializeProductionChatGptRuntime } from "./runtime.js";
import { CHATGPT_ACCOUNT_MODELS_URL } from "./models.js";
import { CHATGPT_ACCOUNT_QUOTA_URL } from "./quota.js";
import { resetBudgetForTests } from "../budget.js";

const modelCatalogue: ProviderModelCatalogue = {
  providerId: "chatgpt-oauth", mode: "discovered", source: "fixture",
  discoveredAt: "2026-09-08T00:00:00.000Z", revision: "fixture", error: null,
  models: [{
    id: "gpt-fixture", displayName: "GPT Fixture", isDefault: true, hidden: false,
    inputModalities: ["text"], reasoningValues: [], defaultReasoning: null,
    supportsTools: false, supportsHostTools: false, supportsParallelToolCalls: false,
    supportsStructuredOutput: false, supportsStrictTools: false, supportsVerbosity: false,
    supportsPromptCacheKey: false, supportsPromptCacheOptions: false,
    contextWindow: 1000, maxOutputTokens: null, billingLabel: "ChatGPT subscription",
  }],
};

function fakeSession(status: "ready" | "signed_out" = "signed_out") {
  return {
    authState: () => ({ status, error: null }),
    current: () => {
      if (status !== "ready") throw new Error("signed out");
      return { accessToken: "access", refreshToken: "refresh", accountId: "account", expiresAtMs: 2_000_000_000_000 };
    },
    accessToken: vi.fn(async () => "access"),
    refresh: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", accountId: "account", expiresAtMs: 2_000_000_000_000 })),
    install: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
  } as unknown as ChatGptTokenSession;
}

function fakeAuth() {
  return {
    start: vi.fn(async () => ({ loginId: "login", authUrl: "https://auth.openai.com/oauth/authorize", expiresAt: 2_000_000_000_000 })),
    snapshot: vi.fn(() => ({ loginId: null, status: "idle" as const, expiresAt: null, error: null })),
    cancel: vi.fn(async () => false),
    shutdown: vi.fn(async () => undefined),
  } as unknown as BrowserOAuthManager;
}

async function route(method = "GET", path = "/api/providers/chatgpt-oauth/status", body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { method?: string; url?: string }).method = method;
  (req as { method?: string; url?: string }).url = path;
  let status = 0;
  let payload = "";
  const res = { writeHead(code: number) { status = code; return this; }, end(value?: string) { payload = value ?? ""; } } as unknown as ServerResponse;
  await handleChatGptOAuthRoute(req, res);
  return { status, body: JSON.parse(payload) };
}

const statusRoute = () => route();
const modelFetchCount = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter(([url]) => String(url) === CHATGPT_ACCOUNT_MODELS_URL).length;

afterEach(() => { installChatGptOAuthRouteRuntime(null); resetBudgetForTests(); });

describe("production ChatGPT runtime lifecycle", () => {
  it("feeds a bounded authenticated production quota poll into status", async () => {
    resetBudgetForTests();
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === CHATGPT_ACCOUNT_QUOTA_URL) {
        return new Response(JSON.stringify({ plan_type: "plus", rate_limit: {
          primary_window: { used_percent: 60, reset_at: "2026-09-10T00:00:00.000Z" }, secondary_window: null,
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ default_model: "gpt-live", models: [{ slug: "gpt-live", input_modalities: ["text"] }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session: fakeSession("ready"), authManager: fakeAuth(), fetch: fetchSpy,
      catalogueStore: { get: () => null, set: vi.fn() },
    });
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === CHATGPT_ACCOUNT_QUOTA_URL)).toHaveLength(1);
    expect((await statusRoute()).body.quota).toEqual({ state: "available", reset_at: "2026-09-10T00:00:00.000Z" });
    await runtime.shutdown();
  });
  it("keeps login polling in exchanging until discovery reaches a terminal result", async () => {
    let current: ReturnType<ChatGptTokenSession["current"]> | null = null;
    let loginStatus: "awaiting_browser" | "signed_in" = "awaiting_browser";
    let finishLogin!: () => void;
    const loginDone = new Promise<void>((resolve) => { finishLogin = resolve; });
    let finishDiscovery!: (response: Response) => void;
    const discovery = new Promise<Response>((resolve) => { finishDiscovery = resolve; });
    const session = {
      authState: () => ({ status: current ? "ready" as const : "signed_out" as const, error: null }),
      current: () => { if (!current) throw new Error("signed out"); return current; },
      accessToken: vi.fn(async () => current!.accessToken), refresh: vi.fn(), install: vi.fn(),
      logout: vi.fn(async () => { current = null; }), close: vi.fn(),
    } as unknown as ChatGptTokenSession;
    const auth = {
      start: vi.fn(async () => ({ loginId: "login-ready", authUrl: "https://auth.openai.com/oauth/authorize", expiresAt: 2_000_000_000_000 })),
      wait: vi.fn(() => loginDone),
      snapshot: vi.fn(() => ({ loginId: "login-ready", status: loginStatus, expiresAt: 2_000_000_000_000, error: null })),
      cancel: vi.fn(async () => false), shutdown: vi.fn(async () => undefined),
    } as unknown as BrowserOAuthManager;
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session, authManager: auth, fetch: vi.fn(() => discovery) as unknown as typeof fetch,
      catalogueStore: { get: () => null, set: vi.fn() },
    });
    await route("POST", "/api/providers/chatgpt-oauth/login/start", {});
    current = { accessToken: "access", refreshToken: "refresh", accountId: "account", expiresAtMs: 2_000_000_000_000 };
    loginStatus = "signed_in";
    finishLogin();
    await vi.waitFor(() => expect(session.accessToken).toHaveBeenCalledOnce());
    expect((await route("GET", "/api/providers/chatgpt-oauth/login/status?login_id=login-ready")).body.status).toBe("exchanging");
    finishDiscovery(new Response(JSON.stringify({ default_model: "gpt-ready", models: [{ slug: "gpt-ready", input_modalities: ["text"] }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await vi.waitFor(async () => expect((await route("GET", "/api/providers/chatgpt-oauth/login/status?login_id=login-ready")).body.status).toBe("signed_in"));
    await runtime.shutdown();
  });

  it("aborts and awaits discovery on shutdown without a late catalogue write", async () => {
    const values = new Map<string, string>();
    let observedAbort = false;
    const fetchSpy = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { observedAbort = true; reject(new Error("aborted")); }, { once: true });
    }));
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session: fakeSession(), authManager: fakeAuth(),
      fetch: fetchSpy as unknown as typeof fetch,
      catalogueStore: { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) },
    });
    // A later ready credential is discovered only through explicit retry.
    const ready = fakeSession("ready");
    Object.assign(runtime.session, ready);
    void retryChatGptCatalogue();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await runtime.shutdown();
    expect(observedAbort).toBe(true);
    expect([...values.values()].join("\n")).not.toContain("gpt-");
  });

  it("queues the newest credential generation behind an older discovery flight", async () => {
    let current: ReturnType<ChatGptTokenSession["current"]> | null = null;
    let releaseFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    const session = {
      authState: () => ({ status: current ? "ready" as const : "signed_out" as const, error: null }),
      current: () => { if (!current) throw new Error("signed out"); return current; },
      accessToken: vi.fn(async () => current!.accessToken), refresh: vi.fn(), install: vi.fn(),
      logout: vi.fn(async () => { current = null; }), close: vi.fn(),
    } as unknown as ChatGptTokenSession;
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const account = (init?.headers as Record<string, string>)["ChatGPT-Account-ID"];
      if (fetchSpy.mock.calls.length === 1) return firstResponse;
      return new Response(JSON.stringify({ default_model: `gpt-${account}`, models: [{ slug: `gpt-${account}`, input_modalities: ["text"] }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session, authManager: fakeAuth(), fetch: fetchSpy as unknown as typeof fetch,
      catalogueStore: { get: () => null, set: vi.fn() },
    });
    current = { accessToken: "access-a", refreshToken: "refresh-a", accountId: "a", expiresAtMs: 2_000_000_000_000 };
    const retryA = retryChatGptCatalogue();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    current = { accessToken: "access-b", refreshToken: "refresh-b", accountId: "b", expiresAtMs: 2_000_000_000_000 };
    const retryB = retryChatGptCatalogue();
    releaseFirst(new Response(JSON.stringify({ default_model: "gpt-a", models: [{ slug: "gpt-a", input_modalities: ["text"] }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await Promise.all([retryA, retryB]);
    await vi.waitFor(() => expect(modelFetchCount(fetchSpy)).toBe(2));
    await vi.waitFor(() => expect(runtime.provider.catalogue().models[0]?.id).toBe("gpt-b"));
    await runtime.shutdown();
  });

  it("discards a late generation-bound canary result after logout", async () => {
    let active: "claude-local" | "chatgpt-oauth" = "claude-local";
    const auth = fakeAuth();
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => active,
      register: vi.fn(), session: fakeSession("ready"), authManager: auth,
      fetch: vi.fn(async () => new Response(JSON.stringify({ default_model: "gpt-live", models: [{ slug: "gpt-live", input_modalities: ["text"] }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
      catalogueStore: { get: () => null, set: vi.fn() },
    });
    let resolveCanary!: (ready: boolean) => void;
    vi.spyOn(runtime.provider, "checkCanary").mockReturnValue(new Promise<boolean>((resolve) => { resolveCanary = resolve; }));
    active = "chatgpt-oauth";
    void retryChatGptCatalogue();
    await vi.waitFor(() => expect(runtime.provider.checkCanary).toHaveBeenCalledOnce());
    const logout = route("POST", "/api/providers/chatgpt-oauth/logout", {});
    await vi.waitFor(() => expect(auth.shutdown).toHaveBeenCalledOnce());
    resolveCanary(true);
    await logout;
    expect((await statusRoute()).body.canary.status).toBe("unknown");
    expect(runtime.activation).toEqual({ registered: true, canary: "skipped" });
    await runtime.shutdown();
  });

  it("installs auth/status while feature-off without registration or canary", async () => {
    const register = vi.fn();
    const auth = fakeAuth();
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => false,
      activeProvider: () => "chatgpt-oauth", register,
      session: fakeSession(), authManager: auth,
      catalogue: () => modelCatalogue,
      fetch: vi.fn(async () => { throw new Error("network forbidden"); }) as unknown as typeof fetch,
    });
    expect(runtime.activation).toEqual({ registered: false, canary: "skipped" });
    expect(register).not.toHaveBeenCalled();
    expect(await statusRoute()).toMatchObject({ status: 200, body: { auth_state: "signed_out" } });
    await runtime.shutdown();
    expect(auth.shutdown).toHaveBeenCalledOnce();
    expect(runtime.session.close).toHaveBeenCalledOnce();
    expect((await statusRoute()).status).toBe(503);
  });

  it("registers flag-on but runs no canary unless ChatGPT is active", async () => {
    const register = vi.fn();
    const fetchSpy = vi.fn(async () => { throw new Error("network forbidden"); });
    const inactive = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true,
      activeProvider: () => "claude-local", register,
      session: fakeSession(), authManager: fakeAuth(), catalogue: () => modelCatalogue,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(inactive.activation).toEqual({ registered: true, canary: "skipped" });
    expect(register).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    await inactive.shutdown();

    register.mockClear();
    const active = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true,
      activeProvider: () => "chatgpt-oauth", register,
      session: fakeSession(), authManager: fakeAuth(), catalogue: () => modelCatalogue,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(active.activation).toEqual({ registered: true, canary: "degraded" });
    expect(register).toHaveBeenCalledOnce();
    await active.shutdown();
  });

  it("discovers a fresh signed-in account catalogue once and caches only validated rows", async () => {
    const values = new Map<string, string>();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      default_model: "gpt-live",
      models: [{ slug: "gpt-live", display_name: "GPT Live", input_modalities: ["text"] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session: fakeSession("ready"), authManager: fakeAuth(),
      fetch: fetchSpy as unknown as typeof fetch,
      catalogueStore: {
        get: (key) => values.get(key) ?? null,
        set: (key, value) => void values.set(key, value),
      },
    });
    expect(modelFetchCount(fetchSpy)).toBe(1);
    expect(runtime.provider.catalogue().models.map((model) => model.id)).toEqual(["gpt-live"]);
    expect([...values.values()].join("\n")).toContain("gpt-live");
    await runtime.shutdown();
  });

  it("preserves a same-credential last-good cache and retries a failed refresh", async () => {
    const values = new Map<string, string>();
    const catalogueStore = {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => void values.set(key, value),
    };
    const session = fakeSession("ready");
    const good = (id: string) => new Response(JSON.stringify({
      default_model: id, models: [{ slug: id, input_modalities: ["text"] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const first = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session, authManager: fakeAuth(), catalogueStore,
      fetch: vi.fn(async () => good("gpt-last-good")) as unknown as typeof fetch,
    });
    await first.shutdown();

    let shouldFail = true;
    const fetchSpy = vi.fn(async () => {
      if (shouldFail) throw new Error("temporary metadata failure");
      return good("gpt-recovered");
    });
    const retrying = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session, authManager: fakeAuth(), catalogueStore,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(retrying.provider.catalogue().models[0]?.id).toBe("gpt-last-good");
    await statusRoute();
    expect(modelFetchCount(fetchSpy)).toBe(1);
    await retryChatGptCatalogue();
    expect(modelFetchCount(fetchSpy)).toBe(2);
    expect(retrying.provider.catalogue().models[0]?.id).toBe("gpt-last-good");
    shouldFail = false;
    await retryChatGptCatalogue();
    expect(retrying.provider.catalogue().models[0]?.id).toBe("gpt-recovered");
    await retrying.shutdown();
  });

  it("kills provider work before logout clears the session", async () => {
    const order: string[] = [];
    const values = new Map<string, string>([
      ["ai.model_catalog.chatgpt-oauth", "old-catalogue"],
      ["ai.model_catalog.chatgpt-oauth.credential_revision", "old-generation"],
    ]);
    const session = fakeSession();
    vi.mocked(session.logout).mockImplementation(async () => { order.push("logout"); });
    const auth = fakeAuth();
    vi.mocked(auth.shutdown).mockImplementation(async () => { order.push("auth"); });
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session, authManager: auth, catalogue: () => modelCatalogue,
      fetch: vi.fn(async () => { throw new Error("network forbidden"); }) as unknown as typeof fetch,
      catalogueStore: { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) },
    });
    vi.spyOn(runtime.provider, "killAll").mockImplementation(() => { order.push("kill"); });
    expect((await route("POST", "/api/providers/chatgpt-oauth/logout", {})).status).toBe(200);
    expect(order).toEqual(["auth", "kill", "logout"]);
    expect([...values.values()]).toEqual(["", ""]);
    await runtime.shutdown();
  });

  it("single-flights post-login discovery and invalidates it on account change", async () => {
    let current: { accessToken: string; refreshToken: string; accountId: string; expiresAtMs: number } | null = null;
    const session = {
      authState: () => ({ status: current ? "ready" as const : "signed_out" as const, error: null }),
      current: () => {
        if (!current) throw new Error("signed out");
        return { ...current };
      },
      accessToken: vi.fn(async () => current!.accessToken),
      refresh: vi.fn(async () => ({ ...current! })),
      install: vi.fn(async () => undefined), logout: vi.fn(async () => { current = null; }),
      close: vi.fn(),
    } as unknown as ChatGptTokenSession;
    let login = 0;
    const completions = new Map<string, { promise: Promise<void>; resolve(): void }>();
    const auth = {
      start: vi.fn(async () => {
        const id = `login-${++login}`;
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        completions.set(id, { promise, resolve });
        return { loginId: id, authUrl: "https://auth.openai.com/oauth/authorize", expiresAt: 2_000_000_000_000 };
      }),
      wait: vi.fn((id: string) => completions.get(id)!.promise),
      snapshot: vi.fn(() => ({ loginId: null, status: "idle" as const, expiresAt: null, error: null })),
      cancel: vi.fn(async () => false), shutdown: vi.fn(async () => undefined),
    } as unknown as BrowserOAuthManager;
    const values = new Map<string, string>();
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const account = (init?.headers as Record<string, string>)["ChatGPT-Account-ID"];
      return new Response(JSON.stringify({
        default_model: `gpt-${account}`,
        models: [{ slug: `gpt-${account}`, input_modalities: ["text"] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const runtime = await initializeProductionChatGptRuntime({
      appVersion: "13.12.2", enabled: () => true, activeProvider: () => "claude-local",
      register: vi.fn(), session, authManager: auth,
      fetch: fetchSpy as unknown as typeof fetch,
      catalogueStore: { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) },
    });

    const first = await route("POST", "/api/providers/chatgpt-oauth/login/start", {});
    current = { accessToken: "access-a", refreshToken: "refresh-a", accountId: "a", expiresAtMs: 2_000_000_000_000 };
    completions.get(first.body.login_id)!.resolve();
    await vi.waitFor(() => expect(modelFetchCount(fetchSpy)).toBe(1));
    expect(runtime.provider.catalogue().models[0]!.id).toBe("gpt-a");
    // Status polling while the same generation is current joins/no-ops.
    await Promise.all([statusRoute(), statusRoute(), statusRoute()]);
    expect(modelFetchCount(fetchSpy)).toBe(1);

    const second = await route("POST", "/api/providers/chatgpt-oauth/login/start", {});
    current = { accessToken: "access-b", refreshToken: "refresh-b", accountId: "b", expiresAtMs: 2_000_000_000_000 };
    completions.get(second.body.login_id)!.resolve();
    await vi.waitFor(() => expect(modelFetchCount(fetchSpy)).toBe(2));
    expect(runtime.provider.catalogue().models[0]!.id).toBe("gpt-b");
    expect([...values.values()].join("\n")).not.toContain("gpt-a");
    await runtime.shutdown();
  });
});
