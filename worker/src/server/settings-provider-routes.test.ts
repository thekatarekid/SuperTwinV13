import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, runMigrations } from "../db/connection.js";
import { appStateSet } from "../db/ingest.js";
import { getProviderModelSelection } from "../db/settings.js";
import { registerV2, resetProviderRegistryForTests } from "../providers/registry.js";
import type { ProviderModelCatalogue, ProviderV2 } from "../providers/types.js";
import {
  installChatGptOAuthRouteRuntime,
  type ChatGptOAuthRouteRuntime,
} from "./chatgpt-oauth-routes.js";
import { handleSettingsRoute } from "./settings-routes.js";

let home: string;

const catalogue = (providerId: "claude-local" | "chatgpt-oauth", id: string): ProviderModelCatalogue => ({
  providerId,
  mode: "discovered",
  source: "offline fixture",
  discoveredAt: "2026-09-08T00:00:00.000Z",
  revision: `${providerId}-r1`,
  error: null,
  models: [{
    id,
    displayName: id,
    isDefault: true,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues: ["off", "high"],
    defaultReasoning: "off",
    supportsTools: true,
    supportsHostTools: providerId === "claude-local",
    supportsParallelToolCalls: false,
    supportsStructuredOutput: true,
    supportsStrictTools: true,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: 100_000,
    maxOutputTokens: 4_096,
    billingLabel: providerId === "chatgpt-oauth" ? "ChatGPT subscription" : null,
  }],
});

function provider(providerId: "claude-local" | "chatgpt-oauth", id: string): ProviderV2 {
  return {
    id: providerId,
    displayName: providerId,
    capabilities: {
      functionTools: true,
      hostTools: providerId === "claude-local",
      continuation: true,
      requiresAuthentication: providerId === "chatgpt-oauth",
    },
    authState: () => ({ status: "ready", error: null }),
    catalogue: () => catalogue(providerId, id),
    send: async () => { throw new Error("offline route test must not send"); },
    cancel: () => false,
    killAll: () => undefined,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "st-p3b-"));
  process.env.SUPERTWIN_HOME = home;
  process.env.SUPERTWIN_DB_PATH = join(home, "st.db");
  closeDb();
  runMigrations();
  resetProviderRegistryForTests();
  registerV2(provider("claude-local", "haiku"));
});

afterEach(() => {
  installChatGptOAuthRouteRuntime(null);
  resetProviderRegistryForTests();
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(home, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = path;
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ""; },
  } as unknown as ServerResponse;
  const handled = await handleSettingsRoute(req, res);
  return { handled, status, body: payload ? JSON.parse(payload) : null };
}

describe("P3-B provider-aware settings routes", () => {
  it("keeps ordinary reads passive and awaits one explicit model retry", async () => {
    appStateSet("ai.chatgpt.enabled", "1");
    registerV2(provider("chatgpt-oauth", "gpt-5.6-sol"));
    await call("POST", "/api/settings/provider", { provider: "chatgpt-oauth" });
    let finishRetry!: () => void;
    const retryDone = new Promise<void>((resolve) => { finishRetry = resolve; });
    const retryCatalogue = vi.fn(() => retryDone);
    installChatGptOAuthRouteRuntime({
      retryCatalogue,
      status: () => ({ authState: { status: "ready", error: null }, plan: null,
        quota: { state: "unknown", resetAt: null }, tokenExpiresAt: null,
        canary: { status: "unknown", checkedAt: null, error: null } }),
      start: async () => { throw new Error("not used"); },
      snapshot: () => ({ loginId: null, status: "idle", expiresAt: null, error: null }),
      cancel: async () => false, logout: async () => undefined,
    });
    expect((await call("GET", "/api/settings/intelligence")).status).toBe(200);
    expect((await call("GET", "/api/providers/chatgpt-oauth/status")).status).toBe(200);
    expect(retryCatalogue).not.toHaveBeenCalled();
    let completed = false;
    const refreshCall = call("GET", "/api/settings/intelligence?refresh=models").then((value) => {
      completed = true;
      return value;
    });
    await vi.waitFor(() => expect(retryCatalogue).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    finishRetry();
    const refreshed = await refreshCall;
    expect(refreshed.status).toBe(200);
    expect(retryCatalogue).toHaveBeenCalledOnce();
  });

  it("serves the selected catalogue and keeps provider choices isolated", async () => {
    let result = await call("GET", "/api/settings/intelligence");
    expect(result.body.provider.selected).toBe("claude-local");
    expect(result.body.catalogue.providerId).toBe("claude-local");

    appStateSet("ai.chatgpt.enabled", "1");
    registerV2(provider("chatgpt-oauth", "gpt-5.6-sol"));
    result = await call("POST", "/api/settings/provider", { provider: "chatgpt-oauth" });
    expect(result.status).toBe(200);
    expect(result.body.catalogue.providerId).toBe("chatgpt-oauth");
    expect(result.body.steps).toHaveLength(11);
    expect(result.body.provider.options.map((option: { label: string }) => option.label)).toEqual([
      "Claude — Claude subscription", "ChatGPT — ChatGPT subscription",
    ]);

    const thinkingOnly = await call("POST", "/api/settings/intelligence", {
      step: "orient", thinking: "high",
    });
    expect(thinkingOnly.status).toBe(200);
    const fresh = await call("GET", "/api/settings/intelligence");
    expect(fresh.body.steps.find((step: { key: string }) => step.key === "orient"))
      .toMatchObject({ selected_model: "gpt-5.6-sol", reasoning: "high" });

    const saved = await call("POST", "/api/settings/intelligence", {
      step: "decide", model: "gpt-5.6-sol", thinking: "high",
    });
    expect(saved.status).toBe(200);
    expect(getProviderModelSelection("chatgpt-oauth", "decide")).toBe("gpt-5.6-sol");
    expect(getProviderModelSelection("claude-local", "decide")).not.toBe("gpt-5.6-sol");

    result = await call("GET", "/api/settings/models");
    expect(result.body).toMatchObject({ providerId: "chatgpt-oauth", revision: "chatgpt-oauth-r1" });

    const { startServer } = await import("./index.js");
    const server = await startServer({ port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/settings/models`);
      const legacy = await response.json() as { models: Array<{ id: string }>; catalogue: ProviderModelCatalogue };
      expect(legacy.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
      expect(legacy.catalogue.providerId).toBe("chatgpt-oauth");
      const savedRole = await fetch(`http://127.0.0.1:${server.port}/api/settings/models`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "chat", model: "gpt-5.6-sol" }),
      });
      expect(savedRole.status).toBe(200);
      expect(getProviderModelSelection("chatgpt-oauth", "chat")).toBe("gpt-5.6-sol");
      const oversized = await fetch(`http://127.0.0.1:${server.port}/api/settings/models`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "chat", model: "gpt-5.6-sol", padding: "x".repeat(17_000) }),
      });
      expect(oversized.status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${server.port}/api/settings/models?extra=1`)).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("reports a selected feature-disabled provider as unavailable without fallback", async () => {
    await call("POST", "/api/settings/provider", { provider: "chatgpt-oauth" });
    const result = await call("GET", "/api/settings/intelligence");
    expect(result.body.provider.selected).toBe("chatgpt-oauth");
    expect(result.body.provider.options.find((item: { id: string }) => item.id === "chatgpt-oauth").auth_state)
      .toBe("unavailable");
    expect(result.body.catalogue).toMatchObject({
      providerId: "chatgpt-oauth", mode: "fallback", error: "PROVIDER_UNAVAILABLE", models: [],
    });
  });

  it("rejects unknown fields, malformed provider ids and models outside the active catalogue", async () => {
    expect((await call("POST", "/api/settings/provider", { provider: "claude-local", extra: true })).status).toBe(400);
    expect((await call("POST", "/api/settings/provider?extra=1", { provider: "claude-local" })).status).toBe(400);
    expect((await call("GET", "/api/settings/intelligence?extra=1")).status).toBe(400);
    expect((await call("POST", "/api/settings/provider", { provider: "openai" })).status).toBe(400);
    expect((await call("POST", "/api/settings/provider", { provider: "x".repeat(17_000) })).status).toBe(400);
    expect((await call("POST", "/api/settings/intelligence", { step: "decide", model: "gpt", surprise: 1 })).status).toBe(400);
    expect((await call("POST", "/api/settings/intelligence", { step: "decide" })).status).toBe(400);
    const rollback = await call("POST", "/api/settings/intelligence", {
      step: "decide", enabled: false, model: "gpt",
    });
    expect(rollback.status).toBe(400);
    const unchanged = await call("GET", "/api/settings/intelligence");
    expect(unchanged.body.steps.find((step: { key: string }) => step.key === "decide").enabled).toBe(true);
    expect((await call("POST", "/api/settings/intelligence", { step: "decide", model: "gpt" })).status).toBe(400);
  });
});

describe("P3-B browser-PKCE auth routes", () => {
  it("mounts the provider status route through the real worker dispatcher", async () => {
    installChatGptOAuthRouteRuntime({
      status: () => ({ authState: { status: "signed_out", error: null }, plan: null,
        quota: { state: "unknown", resetAt: null }, tokenExpiresAt: null,
        canary: { status: "unknown", checkedAt: null, error: null } }),
      start: async () => { throw new Error("not used"); },
      snapshot: () => ({ loginId: null, status: "idle", expiresAt: null, error: null }),
      cancel: async () => false,
      logout: async () => undefined,
    });
    const { startServer } = await import("./index.js");
    const server = await startServer({ port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/providers/chatgpt-oauth/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ signed_in: false, auth_state: "signed_out" });
    } finally {
      await server.close();
    }
  });

  it("serves redacted status and bounded start/status/cancel/logout shapes", async () => {
    let snapshot: ReturnType<ChatGptOAuthRouteRuntime["snapshot"]> = {
      loginId: "login_123", status: "awaiting_browser" as const,
      expiresAt: Date.parse("2026-09-08T00:15:00.000Z"), error: null,
    };
    let logoutCalls = 0;
    const auth: ChatGptOAuthRouteRuntime = {
      status: () => ({
        authState: { status: "ready", accountLabel: "Account", error: null },
        plan: "Plus",
        quota: { state: "available", resetAt: null },
        tokenExpiresAt: "2026-09-08T01:00:00.000Z",
        canary: { status: "passed", checkedAt: "2026-09-08T00:00:00.000Z", error: null },
      }),
      start: async () => ({
        loginId: "login_123", authUrl: "https://auth.openai.com/oauth/authorize?safe=1",
        expiresAt: snapshot.expiresAt!,
      }),
      snapshot: () => snapshot,
      cancel: async (loginId) => {
        if (loginId !== snapshot.loginId) return false;
        snapshot = { ...snapshot, status: "cancelled" };
        return true;
      },
      logout: async () => { logoutCalls += 1; },
    };
    installChatGptOAuthRouteRuntime(auth);

    const status = await call("GET", "/api/providers/chatgpt-oauth/status");
    expect(status.body).toMatchObject({ signed_in: true, auth_state: "ready", plan: "Plus" });
    expect(JSON.stringify(status.body)).not.toMatch(/access_token|refresh_token|accountLabel|Account/);
    const start = await call("POST", "/api/providers/chatgpt-oauth/login/start", {});
    expect(Object.keys(start.body).sort()).toEqual(["auth_url", "expires_at", "login_id"]);
    const waiting = await call("GET", "/api/providers/chatgpt-oauth/login/status?login_id=login_123");
    expect(waiting.body).toMatchObject({ login_id: "login_123", status: "awaiting_browser", error: null });
    expect((await call("POST", "/api/providers/chatgpt-oauth/login/cancel", { login_id: "login_123" })).body)
      .toEqual({ cancelled: true });
    expect((await call("POST", "/api/providers/chatgpt-oauth/logout", {})).body).toEqual({ signed_out: true });
    expect(logoutCalls).toBe(1);
  });

  it("rejects code-entry fields, duplicate query values, stale ids and unavailable runtime", async () => {
    const auth: ChatGptOAuthRouteRuntime = {
      status: () => ({ authState: { status: "signed_out", error: null }, plan: null,
        quota: { state: "unknown", resetAt: null }, tokenExpiresAt: null,
        canary: { status: "unknown", checkedAt: null, error: null } }),
      start: async () => ({ loginId: "active", authUrl: "https://auth.openai.com/oauth/authorize", expiresAt: 1 }),
      snapshot: () => ({ loginId: "active", status: "awaiting_browser", expiresAt: 1, error: null }),
      cancel: async () => false,
      logout: async () => undefined,
    };
    installChatGptOAuthRouteRuntime(auth);
    expect((await call("POST", "/api/providers/chatgpt-oauth/login/start", { code: "secret" })).status).toBe(400);
    expect((await call("GET", "/api/providers/chatgpt-oauth/status?token=secret")).status).toBe(400);
    expect((await call("POST", "/api/providers/chatgpt-oauth/login/cancel?extra=1", { login_id: "active" })).status).toBe(400);
    expect((await call("POST", "/api/providers/chatgpt-oauth/logout?extra=1", {})).status).toBe(400);
    expect((await call("GET", "/api/providers/chatgpt-oauth/login/status?login_id=active&login_id=again")).status).toBe(400);
    expect((await call("GET", "/api/providers/chatgpt-oauth/login/status?login_id=stale")).status).toBe(400);
    installChatGptOAuthRouteRuntime(null);
    const unavailable = await call("GET", "/api/providers/chatgpt-oauth/status");
    expect(unavailable).toMatchObject({ status: 503, body: { error: { code: "PROVIDER_UNAVAILABLE" } } });
  });

  it("never reflects runtime status exceptions or canary error detail", async () => {
    installChatGptOAuthRouteRuntime({
      status: () => { throw new Error("access_token=secret upstream body"); },
      start: async () => { throw new Error("not used"); },
      snapshot: () => ({ loginId: null, status: "idle", expiresAt: null, error: null }),
      cancel: async () => false,
      logout: async () => undefined,
    });
    let result = await call("GET", "/api/providers/chatgpt-oauth/status");
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain("secret");
    const settings = await call("GET", "/api/settings/intelligence");
    expect(settings.status).toBe(200);
    expect(settings.body.provider.options.find((option: { id: string }) => option.id === "chatgpt-oauth").auth_state)
      .toBe("unavailable");
    expect(JSON.stringify(settings.body)).not.toContain("secret");

    installChatGptOAuthRouteRuntime({
      status: () => ({ authState: { status: "degraded", error: "secret" }, plan: null,
        quota: { state: "unknown", resetAt: null }, tokenExpiresAt: null,
        canary: { status: "failed", checkedAt: null,
          error: { code: "BACKEND_UNSUPPORTED", message: "refresh_token=secret" } } }),
      start: async () => { throw new Error("not used"); },
      snapshot: () => ({ loginId: null, status: "idle", expiresAt: null, error: null }),
      cancel: async () => false,
      logout: async () => undefined,
    });
    result = await call("GET", "/api/providers/chatgpt-oauth/status");
    expect(result.body.canary.error).toEqual({
      code: "BACKEND_UNSUPPORTED", message: "ChatGPT compatibility check failed",
    });
    expect(JSON.stringify(result.body)).not.toContain("secret");
  });
});
