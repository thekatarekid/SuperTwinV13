import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  GatedProviderAttemptOptions,
  GatedProviderAttemptResult,
} from "../gate.js";
import type {
  ProviderAuthState,
  ProviderModel,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderV2,
} from "../types.js";
import {
  CHATGPT_RESPONSES_URL,
  ChatGptProviderError,
  createChatGptOAuthProvider,
  createChatGptProviderSession,
  registerChatGptOAuthProviderIfEnabled,
  type ChatGptAuthorizationSnapshot,
  type ChatGptOAuthProviderDependencies,
} from "./index.js";

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "gpt-test",
    displayName: "GPT Test",
    isDefault: true,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues: [],
    defaultReasoning: null,
    supportsTools: false,
    supportsHostTools: false,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: 100_000,
    maxOutputTokens: null,
    billingLabel: "ChatGPT subscription",
    ...overrides,
  };
}

function catalogue(selected = model()): ProviderModelCatalogue {
  return {
    providerId: "chatgpt-oauth",
    mode: "discovered",
    source: "fixture",
    discoveredAt: "2026-09-08T00:00:00.000Z",
    revision: "a".repeat(64),
    error: null,
    models: [selected],
  };
}

function sse(text = "OK", options: { id?: string; input?: number; output?: number } = {}): Response {
  const completed = {
    type: "response.completed",
    response: {
      id: options.id ?? "resp_safe",
      usage: {
        input_tokens: options.input ?? 3,
        output_tokens: options.output ?? 1,
      },
    },
  };
  const body = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
    `data: ${JSON.stringify(completed)}\n\n`,
  ].join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function userRequest(
  runId = "run-user",
  onEvent = vi.fn<NonNullable<ProviderRequest["onEvent"]>>(),
  overrides: Partial<ProviderRequest> = {},
): ProviderRequest {
  return {
    runId,
    model: "gpt-test",
    instructions: "system-safe",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "user-safe" }],
    }],
    maxOutputTokens: 64,
    maxAgentTurns: 1,
    onEvent,
    ...overrides,
  };
}

interface Fixture {
  provider: ReturnType<typeof createChatGptOAuthProvider>;
  fetchSpy: ReturnType<typeof vi.fn>;
  authorization: ReturnType<typeof vi.fn>;
  refreshAuthorization: ReturnType<typeof vi.fn>;
  quota: ReturnType<typeof vi.fn>;
  attempts: number[];
  setAuth(state: ProviderAuthState): void;
  installCredential(accessToken: string): void;
}

function fixture(overrides: Partial<ChatGptOAuthProviderDependencies> = {}): Fixture {
  let auth: ProviderAuthState = { status: "ready", error: null };
  let currentAccessToken = "access-old";
  const credentialRevision = () => createHash("sha256")
    .update("account-safe")
    .update("\0")
    .update(currentAccessToken)
    .digest("hex");
  let uuid = 0;
  const authorization = vi.fn(async (): Promise<ChatGptAuthorizationSnapshot> => ({
    accessToken: currentAccessToken,
    accountId: "account-safe",
  }));
  const refreshAuthorization = vi.fn(async (): Promise<ChatGptAuthorizationSnapshot> => {
    currentAccessToken = "access-new";
    return { accessToken: currentAccessToken, accountId: "account-safe" };
  });
  const fetchSpy = vi.fn(async () => sse());
  const quota = vi.fn();
  const attempts: number[] = [];
  const runAttempt = async <T extends GatedProviderAttemptResult>(
    options: GatedProviderAttemptOptions<T>,
  ): Promise<T> => {
    attempts.push(options.attempt);
    options.checkQuota?.();
    const state = options.authState?.();
    if (state && state.status !== "ready") {
      throw new ChatGptProviderError(
        state.status === "signed_out" ? "AUTH_REQUIRED" : "AUTH_EXPIRED",
        "provider auth gate",
      );
    }
    return options.execute(options.onEvent);
  };
  const dependencies: ChatGptOAuthProviderDependencies = {
    session: {
      authState: () => auth,
      credentialRevision,
      authorization,
      refreshAuthorization,
    },
    catalogue,
    checkQuota: quota,
    fetch: fetchSpy as unknown as typeof fetch,
    appVersion: "13.12.2",
    randomUUID: () => `request-${++uuid}`,
    now: () => 1_700_000_000_000,
    runAttempt,
    ...overrides,
  };
  return {
    provider: createChatGptOAuthProvider(dependencies),
    fetchSpy,
    authorization,
    refreshAuthorization,
    quota,
    attempts,
    setAuth: (state) => { auth = state; },
    installCredential: (accessToken) => { currentAccessToken = accessToken; },
  };
}

async function ready(f: Fixture): Promise<void> {
  await expect(f.provider.checkCanary("gpt-test")).resolves.toBe(true);
  f.fetchSpy.mockClear();
  f.quota.mockClear();
  f.attempts.length = 0;
}

describe("ChatGPT OAuth ProviderV2", () => {
  it("publishes strict capabilities, account catalogue, and canary-gated auth state", async () => {
    const f = fixture();
    expect(f.provider).toMatchObject({
      id: "chatgpt-oauth",
      displayName: "ChatGPT subscription",
      capabilities: {
        functionTools: true,
        hostTools: false,
        continuation: true,
        requiresAuthentication: true,
      },
    });
    expect(f.provider.catalogue()).toEqual(catalogue());
    expect(f.provider.authState()).toMatchObject({ status: "degraded" });
    await expect(f.provider.checkCanary("gpt-test")).resolves.toBe(true);
    expect(f.provider.authState()).toEqual({ status: "ready", error: null });
    f.setAuth({ status: "signed_out", error: null });
    expect(f.provider.authState()).toEqual({ status: "signed_out", error: null });
  });

  it("runs one side-effect-free canary, enforces cadence, and uses the matrix-v2 body", async () => {
    const f = fixture();
    await expect(f.provider.checkCanary("gpt-test")).resolves.toBe(true);
    await expect(f.provider.checkCanary("gpt-test")).resolves.toBe(true);
    expect(f.fetchSpy).toHaveBeenCalledOnce();
    expect(f.quota).toHaveBeenCalledOnce();
    const [url, init] = f.fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CHATGPT_RESPONSES_URL);
    expect(init.redirect).toBe("error");
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual([
      "Accept", "Authorization", "ChatGPT-Account-ID", "Content-Type", "User-Agent",
      "originator", "session_id", "x-client-request-id",
    ].sort());
    expect(headers).toMatchObject({
      Authorization: "Bearer access-old",
      "ChatGPT-Account-ID": "account-safe",
      "User-Agent": "SuperTwinV13/13.12.2",
      originator: "supertwinv13",
    });
    expect(headers.session_id).not.toBe(headers["x-client-request-id"]);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-test",
      instructions: "",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with OK." }],
      }],
      store: false,
      stream: true,
    });
    expect(String(init.body)).not.toContain("max_output_tokens");

    await expect(f.provider.checkCanary("gpt-test", true)).resolves.toBe(true);
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("streams one strict user request after canary and preserves continuation/usage", async () => {
    const f = fixture();
    await ready(f);
    f.fetchSpy.mockResolvedValueOnce(sse("hello", { id: "resp_continue", input: 10, output: 2 }));
    const events = vi.fn<NonNullable<ProviderRequest["onEvent"]>>();
    const result = await f.provider.send(userRequest("run-stream", events, {
      persistContinuation: true,
    }));
    expect(result).toMatchObject({
      status: "ok",
      continuation: "resp_continue",
      freshFallback: false,
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(events.mock.calls.flatMap((call) => call[0].type)).toEqual([
      "delta", "usage", "continuation", "done",
    ]);
    expect(f.fetchSpy).toHaveBeenCalledOnce();
    expect(f.attempts).toEqual([1]);
    const body = JSON.parse(String((f.fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({ model: "gpt-test", instructions: "system-safe", store: false, stream: true });
    expect(body.input[0].content[0].text).toBe("user-safe");
  });

  it("gates each physical POST and performs exactly one refresh plus one retry on 401", async () => {
    let firstCancelled = false;
    const unauthorized = new Response(new ReadableStream({
      cancel() { firstCancelled = true; },
    }), { status: 401 });
    const f = fixture();
    await ready(f);
    f.fetchSpy.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(sse("done"));
    const result = await f.provider.send(userRequest("run-refresh"));
    expect(result.status).toBe("ok");
    expect(firstCancelled).toBe(true);
    expect(f.refreshAuthorization).toHaveBeenCalledOnce();
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);
    expect(f.quota).toHaveBeenCalledTimes(2);
    expect(f.attempts).toEqual([1, 2]);
    const firstHeaders = f.fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    const secondHeaders = f.fetchSpy.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe("Bearer access-old");
    expect(secondHeaders.Authorization).toBe("Bearer access-new");
    expect(firstHeaders.session_id).toBe(secondHeaders.session_id);
    expect(firstHeaders["x-client-request-id"]).not.toBe(secondHeaders["x-client-request-id"]);
  });

  it("never retries a second 401 and moves auth state to expired", async () => {
    const f = fixture();
    await ready(f);
    f.fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    f.fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const result = await f.provider.send(userRequest("run-double-401"));
    expect(result).toMatchObject({ status: "error", errorCode: "AUTH_EXPIRED" });
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);
    expect(f.refreshAuthorization).toHaveBeenCalledOnce();
    expect(f.provider.authState()).toMatchObject({ status: "expired" });
    f.fetchSpy.mockResolvedValue(sse("must-not-send"));
    await expect(f.provider.send(userRequest("run-after-expiry"))).resolves.toMatchObject({
      status: "error",
      errorCode: "AUTH_EXPIRED",
    });
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);
    expect(f.provider.authState()).toMatchObject({ status: "expired" });
    await expect(f.provider.checkCanary("gpt-test", true)).resolves.toBe(false);
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);

    f.installCredential("access-relogin");
    f.fetchSpy.mockResolvedValueOnce(sse()).mockResolvedValueOnce(sse("recovered"));
    expect(f.provider.authState()).toMatchObject({ status: "degraded" });
    await expect(f.provider.checkCanary("gpt-test")).resolves.toBe(true);
    expect(f.provider.authState()).toEqual({ status: "ready", error: null });
    await expect(f.provider.send(userRequest("run-after-relogin"))).resolves.toMatchObject({ status: "ok" });
    expect(f.fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("does not let an older concurrent success clear terminal auth expiry", async () => {
    const f = fixture();
    await ready(f);
    let resolveOlder!: (response: Response) => void;
    const older = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    let expiringAttempts = 0;
    f.fetchSpy.mockImplementation(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes("expire-this-run")) {
        expiringAttempts += 1;
        return new Response(null, { status: 401 });
      }
      if (body.includes("older-success")) return older;
      return sse("unexpected");
    });
    const expiring = f.provider.send(userRequest("run-expiring", vi.fn(), {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "expire-this-run" }] }],
    }));
    const successful = f.provider.send(userRequest("run-older", vi.fn(), {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "older-success" }] }],
    }));
    await expect(expiring).resolves.toMatchObject({ status: "error", errorCode: "AUTH_EXPIRED" });
    expect(expiringAttempts).toBe(2);
    resolveOlder(sse("done"));
    await expect(successful).resolves.toMatchObject({ status: "ok" });
    expect(f.provider.authState()).toMatchObject({ status: "expired" });
    const fetches = f.fetchSpy.mock.calls.length;
    await expect(f.provider.send(userRequest("run-after-concurrent"))).resolves.toMatchObject({
      status: "error",
      errorCode: "AUTH_EXPIRED",
    });
    expect(f.fetchSpy).toHaveBeenCalledTimes(fetches);
  });

  it("does not let a stale 401 poison credentials installed while the request was in flight", async () => {
    const f = fixture();
    await ready(f);
    let resolveStale!: (response: Response) => void;
    const stale = new Promise<Response>((resolve) => { resolveStale = resolve; });
    f.fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockReturnValueOnce(stale);
    const request = f.provider.send(userRequest("run-stale-401"));
    await vi.waitFor(() => expect(f.fetchSpy).toHaveBeenCalledTimes(2));
    f.installCredential("access-relogin-during-request");
    resolveStale(new Response(null, { status: 401 }));
    await expect(request).resolves.toMatchObject({ status: "error", errorCode: "AUTH_EXPIRED" });
    expect(f.provider.authState()).toMatchObject({ status: "degraded" });

    f.fetchSpy.mockResolvedValueOnce(sse());
    await expect(f.provider.checkCanary("gpt-test")).resolves.toBe(true);
    expect(f.provider.authState()).toEqual({ status: "ready", error: null });
  });

  it("bounds pending authorization and refresh work by request timeout", async () => {
    const pendingAuthorization = fixture();
    await ready(pendingAuthorization);
    pendingAuthorization.authorization.mockImplementationOnce(async () => new Promise(() => undefined));
    await expect(pendingAuthorization.provider.send(userRequest("run-auth-timeout", vi.fn(), {
      timeoutMs: 10,
    }))).resolves.toMatchObject({ status: "error", errorCode: "TIMEOUT" });
    expect(pendingAuthorization.fetchSpy).not.toHaveBeenCalled();

    const pendingRefresh = fixture();
    await ready(pendingRefresh);
    pendingRefresh.fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    pendingRefresh.refreshAuthorization.mockImplementationOnce(async () => new Promise(() => undefined));
    await expect(pendingRefresh.provider.send(userRequest("run-refresh-timeout", vi.fn(), {
      timeoutMs: 10,
    }))).resolves.toMatchObject({ status: "error", errorCode: "TIMEOUT" });
    expect(pendingRefresh.fetchSpy).toHaveBeenCalledOnce();
  });

  it("maps a stalled SSE timeout to TIMEOUT rather than caller cancellation", async () => {
    const f = fixture();
    await ready(f);
    let cancelled = false;
    const events = vi.fn<NonNullable<ProviderRequest["onEvent"]>>();
    f.fetchSpy.mockResolvedValueOnce(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    await expect(f.provider.send(userRequest("run-sse-timeout", events, {
      timeoutMs: 10,
    }))).resolves.toMatchObject({ status: "error", errorCode: "TIMEOUT" });
    expect(cancelled).toBe(true);
    expect(events.mock.calls.map(([event]) => event)).toEqual([{
      type: "error",
      code: "TIMEOUT",
      message: "ChatGPT request timed out",
    }]);
  });

  it("does not refresh or fall back on 403, 429, or transport failure", async () => {
    for (const [response, expected] of [
      [new Response(null, { status: 403 }), "AUTH_EXPIRED"],
      [new Response(null, { status: 429 }), "RATE_LIMITED"],
    ] as const) {
      const f = fixture();
      await ready(f);
      f.fetchSpy.mockResolvedValueOnce(response);
      await expect(f.provider.send(userRequest(`run-${expected}`))).resolves.toMatchObject({
        status: "error",
        errorCode: expected,
      });
      expect(f.fetchSpy).toHaveBeenCalledOnce();
      expect(f.refreshAuthorization).not.toHaveBeenCalled();
    }
    const transport = fixture();
    await ready(transport);
    transport.fetchSpy.mockRejectedValueOnce(new Error("secret host detail"));
    await expect(transport.provider.send(userRequest("run-transport"))).resolves.toMatchObject({
      status: "error",
      errorCode: "TRANSPORT_ERROR",
    });
    expect(transport.fetchSpy).toHaveBeenCalledOnce();
    expect(transport.refreshAuthorization).not.toHaveBeenCalled();
  });

  it("fails a user call on canary without sending user content and recovers on a later pass", async () => {
    const f = fixture();
    f.fetchSpy.mockResolvedValueOnce(new Response("opaque", { status: 400 }));
    const first = await f.provider.send(userRequest("run-never-sent", vi.fn(), {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "private-user-text" }] }],
    }));
    expect(first).toMatchObject({ status: "error", errorCode: "BACKEND_UNSUPPORTED" });
    expect(f.fetchSpy).toHaveBeenCalledOnce();
    expect(String(f.fetchSpy.mock.calls[0]![1]!.body)).not.toContain("private-user-text");
    expect(f.provider.authState()).toMatchObject({ status: "degraded" });

    f.fetchSpy.mockResolvedValueOnce(sse());
    await expect(f.provider.checkCanary("gpt-test", true)).resolves.toBe(true);
    expect(f.provider.authState()).toEqual({ status: "ready", error: null });
  });

  it("runs one diagnostic canary after unexplained stream drift without replaying the user request", async () => {
    const f = fixture();
    await ready(f);
    f.fetchSpy.mockResolvedValueOnce(new Response(
      "data: {not-json}\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));
    f.fetchSpy.mockResolvedValueOnce(sse());
    const result = await f.provider.send(userRequest("run-drift"));
    expect(result).toMatchObject({ status: "error", errorCode: "BACKEND_UNSUPPORTED" });
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = f.fetchSpy.mock.calls.map((call) => String(call[1]!.body));
    expect(bodies.filter((body) => body.includes("user-safe"))).toHaveLength(1);
    expect(bodies.filter((body) => body.includes("Reply with OK."))).toHaveLength(1);
    expect(f.provider.authState()).toEqual({ status: "ready", error: null });
  });

  it("cancels one run, kills all runs, and safely reuses a run id only after cleanup", async () => {
    const f = fixture();
    await ready(f);
    f.fetchSpy.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const first = f.provider.send(userRequest("run-shared"));
    await vi.waitFor(() => expect(f.fetchSpy).toHaveBeenCalledOnce());
    await expect(f.provider.send(userRequest("run-shared"))).resolves.toMatchObject({ errorCode: "BAD_REQUEST" });
    expect(f.provider.cancel("run-shared")).toBe(true);
    await expect(first).resolves.toMatchObject({ errorCode: "CANCELLED" });
    expect(f.provider.cancel("run-shared")).toBe(false);

    f.fetchSpy.mockResolvedValue(sse("again"));
    await expect(f.provider.send(userRequest("run-shared"))).resolves.toMatchObject({ status: "ok" });

    f.fetchSpy.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const left = f.provider.send(userRequest("run-left"));
    const right = f.provider.send(userRequest("run-right"));
    await vi.waitFor(() => expect(f.fetchSpy).toHaveBeenCalledTimes(4));
    f.provider.killAll();
    await expect(left).resolves.toMatchObject({ errorCode: "CANCELLED" });
    await expect(right).resolves.toMatchObject({ errorCode: "CANCELLED" });
  });

  it("cancels a user while the shared boot canary is pending without sending user content", async () => {
    const f = fixture();
    f.fetchSpy.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const send = f.provider.send(userRequest("run-during-canary"));
    await vi.waitFor(() => expect(f.fetchSpy).toHaveBeenCalledOnce());
    expect(String(f.fetchSpy.mock.calls[0]![1]!.body)).not.toContain("user-safe");
    expect(f.provider.cancel("run-during-canary")).toBe(true);
    await expect(send).resolves.toMatchObject({ status: "error", errorCode: "CANCELLED" });
    f.provider.killAll();
    await vi.waitFor(() => expect(f.provider.authState()).toMatchObject({ status: "degraded" }));
    expect(f.fetchSpy).toHaveBeenCalledOnce();
  });

  it("cancels successful response bodies rejected before SSE consumption", async () => {
    const f = fixture();
    await ready(f);
    let cancelled = false;
    f.fetchSpy.mockResolvedValueOnce(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    f.fetchSpy.mockResolvedValueOnce(sse());
    await expect(f.provider.send(userRequest("run-not-sse"))).resolves.toMatchObject({
      status: "error",
      errorCode: "BACKEND_UNSUPPORTED",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects malformed requests, catalogue mismatches, and identifiers before network", async () => {
    const invalid = fixture();
    const request = userRequest("run-invalid", vi.fn(), { hostTools: ["Read"] });
    await expect(invalid.provider.send(request)).resolves.toMatchObject({ errorCode: "CAPABILITY_UNSUPPORTED" });
    expect(invalid.fetchSpy).not.toHaveBeenCalled();

    const mismatch = fixture({ catalogue: () => ({ ...catalogue(), providerId: "claude-local" }) });
    await expect(mismatch.provider.send(userRequest("run-mismatch"))).resolves.toMatchObject({
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    expect(mismatch.fetchSpy).not.toHaveBeenCalled();

    const badId = fixture({ randomUUID: () => "bad id" });
    await expect(badId.provider.checkCanary("gpt-test")).resolves.toBe(false);
    expect(badId.fetchSpy).not.toHaveBeenCalled();
  });

  it("adapts coherent post-refresh token/account snapshots", async () => {
    let pair = { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, accountId: "account-a" };
    const session = {
      authState: () => ({ status: "ready", error: null } as const),
      accessToken: vi.fn(async () => { pair = { ...pair, accessToken: "new" }; return "new"; }),
      current: vi.fn(() => ({ ...pair })),
      refresh: vi.fn(async () => {
        pair = { ...pair, accessToken: "newer" };
        return { ...pair };
      }),
    };
    const adapted = createChatGptProviderSession(session);
    await expect(adapted.authorization(new AbortController().signal)).resolves.toEqual({
      accessToken: "new",
      accountId: "account-a",
    });
    await expect(adapted.refreshAuthorization(new AbortController().signal)).resolves.toEqual({
      accessToken: "newer",
      accountId: "account-a",
    });
  });

  it("registers and runs the boot canary only when enabled and selected active", async () => {
    const f = fixture();
    const register = vi.fn<(provider: ProviderV2) => void>();
    await expect(registerChatGptOAuthProviderIfEnabled({
      enabled: false,
      activeProviderId: "chatgpt-oauth",
      provider: f.provider,
      canaryModelId: "gpt-test",
      register,
    })).resolves.toEqual({ registered: false, canary: "skipped" });
    await expect(registerChatGptOAuthProviderIfEnabled({
      enabled: true,
      activeProviderId: "claude-local",
      provider: f.provider,
      canaryModelId: "gpt-test",
      register,
    })).resolves.toEqual({ registered: true, canary: "skipped" });
    expect(register).toHaveBeenCalledExactlyOnceWith(f.provider);
    expect(f.fetchSpy).not.toHaveBeenCalled();
    register.mockClear();
    await expect(registerChatGptOAuthProviderIfEnabled({
      enabled: true,
      activeProviderId: "chatgpt-oauth",
      provider: f.provider,
      canaryModelId: "gpt-test",
      register,
    })).resolves.toEqual({ registered: true, canary: "ready" });
    expect(register).toHaveBeenCalledExactlyOnceWith(f.provider);
    expect(f.fetchSpy).toHaveBeenCalledOnce();
    expect(f.provider.authState()).toEqual({ status: "ready", error: null });

    const degraded = fixture();
    degraded.fetchSpy.mockResolvedValueOnce(new Response(null, { status: 400 }));
    const degradedRegister = vi.fn<(provider: ProviderV2) => void>();
    await expect(registerChatGptOAuthProviderIfEnabled({
      enabled: true,
      activeProviderId: "chatgpt-oauth",
      provider: degraded.provider,
      canaryModelId: "gpt-test",
      register: degradedRegister,
    })).resolves.toEqual({ registered: true, canary: "degraded" });
    expect(degradedRegister).toHaveBeenCalledExactlyOnceWith(degraded.provider);
  });

  it("contains no probe, device, API-key, Codex CLI, or Claude fallback path", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*probe/);
    expect(source).not.toMatch(/deviceauth|device[-_ ]code|api[_-]?key|codex\/auth\.json|claude-local|spawn\s*\(/i);
  });
});
