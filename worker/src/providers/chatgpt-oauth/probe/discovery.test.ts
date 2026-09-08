import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accountFingerprint } from "./account.js";
import { LIVE_DISCOVERY_HTTP_LIMITS } from "./accounting.js";
import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_USAGE_URL,
} from "./constants.js";
import { runDiscoveryProbe } from "./discovery-runner.js";
import { LIVE_DISCOVERY_PROBE_ENV } from "./safety.js";

afterEach(() => vi.restoreAllMocks());

function jwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
}

function discoveryEnv(accountId: string, home = join(
  tmpdir(),
  `supertwin-phase0b-discovery-${process.pid}-${Date.now()}`,
)): NodeJS.ProcessEnv {
  return {
    SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    [LIVE_DISCOVERY_PROBE_ENV]: "1",
    SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: accountFingerprint(accountId),
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: home,
  };
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface DiscoveryResponses {
  models?: () => Response;
  quota?: () => Response;
}

function mockedDiscoveryFetch(
  accountId: string,
  responses: DiscoveryResponses = {},
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === CODEX_DEVICE_CODE_URL) {
      return jsonResponse(200, {
        user_code: "ABCD-EFGH",
        device_auth_id: "device-secret",
        interval: 3,
      });
    }
    if (url === CODEX_DEVICE_TOKEN_URL) {
      return jsonResponse(200, {
        authorization_code: "authorization-secret",
        code_verifier: "verifier-secret",
      });
    }
    if (url === CODEX_OAUTH_TOKEN_URL) {
      return jsonResponse(200, {
        access_token: jwt(accountId),
        refresh_token: "refresh-secret",
      });
    }
    if (url === CODEX_MODELS_URL) {
      return responses.models?.() ?? jsonResponse(200, { models: [
        {
          slug: "gpt-safe",
          display_name: "Restricted Preview Model",
          description: "Output is restricted to supported text and image modalities.",
          input_modalities: ["text", "image"],
          supported_reasoning_efforts: ["low", "high"],
          max_output_tokens: 8192,
          supports_tools: true,
        },
        { slug: "unsafe\nmodel", supports_tools: true },
        { slug: "gpt-hidden", hidden: true },
      ] });
    }
    if (url === CODEX_USAGE_URL) {
      return responses.quota?.() ?? jsonResponse(200, {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: "2026-09-09T00:00:00Z" },
        },
        credits: { remaining: 5, secret: "drop" },
      });
    }
    throw new Error(`Unexpected mocked URL: ${url}`);
  });
}

describe("Phase 0b metadata-only discovery runner", () => {
  it.each([
    ["base opt-in", {}],
    ["discovery opt-in", {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-discovery-missing-opt-in"),
    }],
    ["account fingerprint", {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_DISCOVERY_PROBE_ENV]: "1",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-discovery-missing-account"),
    }],
    ["valid account fingerprint", {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_DISCOVERY_PROBE_ENV]: "1",
      SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: "not-12-hex",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-discovery-bad-account"),
    }],
  ])("refuses a missing %s gate with zero fetch", async (_label, env) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env,
    })).rejects.toThrow(/REFUSED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discovers safe metadata in order with exact accounting, no model selection, and ephemeral logout", async () => {
    const accountId = "acct-discovery-secret";
    const scratchHome = join(tmpdir(), `supertwin-discovery-unused-${process.pid}-${Date.now()}`);
    expect(existsSync(scratchHome)).toBe(false);
    const fetchMock = mockedDiscoveryFetch(accountId);
    const finalized = vi.fn();
    const listenersBefore = process.listeners("SIGINT");

    const evidence = await runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env: discoveryEnv(accountId, scratchHome),
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      CODEX_DEVICE_CODE_URL,
      CODEX_DEVICE_TOKEN_URL,
      CODEX_OAUTH_TOKEN_URL,
      CODEX_MODELS_URL,
      CODEX_USAGE_URL,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST", "POST", "POST", "GET", "GET",
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    for (const index of [3, 4]) {
      expect(fetchMock.mock.calls[index]?.[1]?.headers).toMatchObject({
        Accept: "application/json",
        Authorization: expect.stringMatching(/^Bearer /),
        "ChatGPT-Account-ID": accountId,
        "User-Agent": "SuperTwinV13/13.12.2",
        originator: "supertwinv13",
      });
    }
    expect(evidence).toEqual({
      mode: "discovery",
      evidenceCompleteness: "partial-metadata-only",
      persistedCredentials: false,
      inferenceCalls: 0,
      accountFingerprint: accountFingerprint(accountId),
      models: {
        status: 200,
        responseBytes: expect.any(Number),
        visible: [{
          id: "gpt-safe",
          capabilities: {
            inputModalities: ["text", "image"],
            reasoningEfforts: ["low", "high"],
            maxOutputTokens: 8192,
            tools: true,
          },
        }],
      },
      quota: {
        status: 200,
        responseBytes: expect.any(Number),
        planType: "plus",
        primary: { usedPercent: 12, resetAt: "2026-09-09T00:00:00Z" },
        healthy: true,
        restrictionSignal: false,
        creditsRemaining: 5,
      },
      httpActuals: {
        deviceCode: 1, devicePoll: 1, token: 1, models: 1,
        quota: 1, inference: 0, other: 0, total: 5,
      },
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
      localListeningSocketsCreated: false,
    });
    const serialized = JSON.stringify(evidence);
    for (const secret of [accountId, "refresh-secret", "device-secret", "authorization-secret", "Restricted Preview Model", "restricted to supported", "unsafe\nmodel"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith({
      httpActuals: {
        deviceCode: 1, devicePoll: 1, token: 1, models: 1,
        quota: 1, inference: 0, other: 0, total: 5,
      },
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
      aborted: true,
    });
    expect(existsSync(scratchHome)).toBe(false);
    expect(process.listeners("SIGINT")).toEqual(listenersBefore);
  });

  it("rejects an authenticated account mismatch before all metadata calls and logs out", async () => {
    const accountId = "acct-actual-discovery";
    const env = discoveryEnv("acct-expected-discovery");
    const fetchMock = mockedDiscoveryFetch(accountId);
    const finalized = vi.fn();

    await expect(runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env,
    })).rejects.toThrow(/not the dedicated Phase 0b test account/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: expect.objectContaining({ token: 1, models: 0, quota: 0, inference: 0 }),
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
    }));
  });

  it("fails a catalogue with no safe visible model IDs before requesting quota", async () => {
    const accountId = "acct-discovery-empty-models";
    const fetchMock = mockedDiscoveryFetch(accountId, {
      models: () => jsonResponse(200, { models: [
        { slug: "unsafe/model" },
        { slug: "hidden", hidden: true },
      ] }),
    });
    const finalized = vi.fn();
    await expect(runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env: discoveryEnv(accountId),
    })).rejects.toThrow(/no safe visible model IDs/);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === CODEX_USAGE_URL)).toBe(false);
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: expect.objectContaining({ models: 1, quota: 0, inference: 0 }),
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
    }));
  });

  it.each([
    ["top-level captcha", { captcha_required: true, models: [{ slug: "gpt-safe" }] }],
    ["nested account flag", { metadata: { account: { flagged: true } }, models: [{ slug: "gpt-safe" }] }],
    ["nested error restriction", { metadata: { error: { message: "account restricted" } }, models: [{ slug: "gpt-safe" }] }],
    ["top-level suspended status", { status: "suspended", data: [{ slug: "gpt-safe" }] }],
  ])("stops on a structural model-response restriction: %s", async (_label, payload) => {
    const accountId = "acct-discovery-structural-restriction";
    const fetchMock = mockedDiscoveryFetch(accountId, {
      models: () => jsonResponse(200, payload),
    });
    const finalized = vi.fn();

    await expect(runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env: discoveryEnv(accountId),
    })).rejects.toThrow(/structural account or restriction signal/);

    expect(fetchMock.mock.calls.some(([input]) => String(input) === CODEX_USAGE_URL)).toBe(false);
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: expect.objectContaining({ models: 1, quota: 0, inference: 0 }),
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
    }));
  });

  it.each([
    ["HTTP 429", () => jsonResponse(429, { error: "rate_limited" })],
    ["HTTP 401", () => jsonResponse(401, { error: "unauthorized" })],
    ["quota restriction", () => jsonResponse(200, {
      plan_type: "plus",
      warning: "account restricted",
      rate_limit: { primary_window: { used_percent: 1, reset_at: 1 } },
    })],
  ])("fails closed on %s after quota is requested last without inference", async (_label, quota) => {
    const accountId = "acct-discovery-quota-failure";
    const fetchMock = mockedDiscoveryFetch(accountId, { quota });
    const finalized = vi.fn();
    await expect(runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env: discoveryEnv(accountId),
    })).rejects.toThrow();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(CODEX_USAGE_URL);
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: expect.objectContaining({ models: 1, quota: 1, inference: 0, token: 1 }),
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
    }));
  });

  it.each([
    ["invalid JSON", () => new Response("not-json", { status: 200 })],
    ["oversized body", () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 })],
  ])("bounds metadata and rejects an %s response without continuing to quota", async (_label, models) => {
    const accountId = "acct-discovery-model-failure";
    const fetchMock = mockedDiscoveryFetch(accountId, { models });
    const finalized = vi.fn();
    await expect(runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env: discoveryEnv(accountId),
    })).rejects.toThrow();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === CODEX_USAGE_URL)).toBe(false);
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: expect.objectContaining({ models: 1, quota: 0, inference: 0 }),
    }));
  });

  it("honors an already-aborted signal before fetch and finalizes zero actuals", async () => {
    const accountId = "acct-discovery-abort";
    const fetchMock = vi.fn<typeof fetch>();
    const finalized = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("mocked discovery abort"));
    await expect(runDiscoveryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      signal: controller.signal,
      env: discoveryEnv(accountId),
    })).rejects.toThrow(/mocked discovery abort/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: expect.objectContaining({ total: 0, inference: 0 }),
    }));
  });

  it("declares the exact metadata-only endpoint ceilings", () => {
    expect(LIVE_DISCOVERY_HTTP_LIMITS).toEqual({
      deviceCode: 1, devicePoll: 300, token: 1, models: 1,
      quota: 1, inference: 0, other: 0,
    });
    expect(Object.values(LIVE_DISCOVERY_HTTP_LIMITS).reduce((sum, value) => sum + value, 0)).toBe(304);
  });
});
