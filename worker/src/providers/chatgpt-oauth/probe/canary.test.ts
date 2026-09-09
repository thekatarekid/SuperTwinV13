import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";

import { accountFingerprint } from "./account.js";
import { LIVE_CANARY_HTTP_LIMITS, ProbeHttpAccounting } from "./accounting.js";
import { runCanaryProbe } from "./canary-runner.js";
import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
} from "./constants.js";
import { buildContractProbeMatrix } from "./matrix.js";
import { redactedJson } from "./redact.js";
import { LIVE_CANARY_PROBE_ENV } from "./safety.js";
import {
  addTestInferenceAuthorization,
  cleanupTestInferenceAuthorizations,
  testConsumedInferencePosts,
  testMatchedCanaryReservationPost,
} from "./authorization-test-support.js";

afterAll(cleanupTestInferenceAuthorizations);

function jwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
}

async function env(accountId: string): Promise<NodeJS.ProcessEnv> {
  return addTestInferenceAuthorization({
    SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    [LIVE_CANARY_PROBE_ENV]: "1",
    SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: accountFingerprint(accountId),
    SUPERTWIN_CHATGPT_PROBE_MODEL: "gpt-probe",
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: join(tmpdir(), `supertwin-canary-${process.pid}-${Date.now()}`),
  });
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(substantive = true): Response {
  const events = [
    ...(substantive ? [{ type: "response.output_text.delta", delta: "OK" }] : []),
    {
      type: "response.completed",
      response: { id: "resp-secret", usage: { input_tokens: 3, output_tokens: 1 } },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function canaryFetch(accountId: string, substantive = true, inferenceResponse?: () => Response): {
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  inferenceBodies: string[];
} {
  let tokenCalls = 0;
  const inferenceBodies: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === CODEX_DEVICE_CODE_URL) {
      return jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret", interval: 3 });
    }
    if (url === CODEX_DEVICE_TOKEN_URL) {
      return jsonResponse(200, { authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
    }
    if (url === CODEX_OAUTH_TOKEN_URL) {
      tokenCalls += 1;
      return jsonResponse(200, {
        access_token: jwt(accountId),
        refresh_token: tokenCalls === 1 ? "refresh-secret-one" : "refresh-secret-two",
      });
    }
    if (url === CODEX_MODELS_URL) return jsonResponse(200, { models: [{ slug: "gpt-probe" }] });
    if (url === CODEX_USAGE_URL) return jsonResponse(200, {
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 1, reset_at: 2_000_000_000 } },
    });
    if (url === CODEX_RESPONSES_URL) {
      inferenceBodies.push(String(init?.body));
      return inferenceResponse?.() ?? sseResponse(substantive);
    }
    throw new Error(`Unexpected mocked URL: ${url}`);
  });
  return { fetchMock, inferenceBodies };
}

describe("Phase 0b canary-only runner", () => {
  it("runs the exact first matrix case once with pre/post quota and explicit refresh", async () => {
    const accountId = "acct-canary-secret";
    const liveEnv = await env(accountId);
    const { fetchMock, inferenceBodies } = canaryFetch(accountId, true, () => {
      expect(testConsumedInferencePosts(liveEnv)).toBe(1);
      return sseResponse();
    });
    const finalized = vi.fn();
    const evidence = await runCanaryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      requestId: () => "00000000-0000-4000-8000-000000000000",
      env: liveEnv,
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      CODEX_DEVICE_CODE_URL,
      CODEX_DEVICE_TOKEN_URL,
      CODEX_OAUTH_TOKEN_URL,
      CODEX_MODELS_URL,
      CODEX_USAGE_URL,
      CODEX_OAUTH_TOKEN_URL,
      CODEX_RESPONSES_URL,
      CODEX_USAGE_URL,
    ]);
    expect(inferenceBodies).toEqual([
      JSON.stringify(buildContractProbeMatrix("gpt-probe")[0]!.body),
    ]);
    expect(evidence).toMatchObject({
      mode: "canary-only",
      evidenceCompleteness: "single-canary-only",
      scratchHomeProof: "no-residual-artifacts",
      persistedCredentials: false,
      inferenceRetries: 0,
      actualInferencePosts: 1,
      model: { selectedId: "gpt-probe" },
      quota: { healthy: true },
      finalQuota: { healthy: true },
      refresh: { authenticated: true, previousRecoveryPairAvailable: true },
      canary: {
        status: 200,
        contentTypeCategory: "event-stream",
        eventCount: 2,
        outputTextBytes: 2,
        flags: { completed: true, substantiveOutput: true },
      },
      httpActuals: {
        deviceCode: 1, devicePoll: 1, token: 2, models: 1,
        quota: 2, inference: 1, other: 0, total: 8,
      },
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
    });
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: evidence.httpActuals,
      logout: evidence.logout,
    }));
    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBe(1);
    expect(evidence.checkpoint).toMatchObject({
      state: "matched",
      caseSequence: 1,
      caseName: "canary.blank-context",
      acceptancePolicyVersion: "phase0b-canary-success-v1",
      plannedInferencePosts: 43,
      reservationPost: 1,
    });
    const output = redactedJson(evidence);
    for (const secret of [accountId, "refresh-secret", "resp-secret", "authorization-secret"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("keeps mismatch acceptance strict and returns only the safe diagnostic in the error", async () => {
    const accountId = "acct-canary-mismatch";
    const liveEnv = await env(accountId);
    const { fetchMock } = canaryFetch(accountId, false);
    const finalized = vi.fn();
    let failure: unknown;
    try {
      await runCanaryProbe({
        fetch: fetchMock,
        sleep: vi.fn(async () => undefined),
        now: vi.fn(() => 0),
        onUserCode: vi.fn(),
        onFinalized: finalized,
        env: liveEnv,
      });
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("canary.blank-context did not match");
    expect(message).toContain('"eventTypes":["response.completed"]');
    expect(message).toContain('"substantiveOutput":false');
    expect(message).not.toContain(accountId);
    expect(message).not.toContain("resp-secret");
    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBeUndefined();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: {
        deviceCode: 1, devicePoll: 1, token: 2, models: 1,
        quota: 1, inference: 1, other: 0, total: 7,
      },
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
    }));
  });

  it("rejects a completed substantive NOT OK canary while retaining its charge and no checkpoint", async () => {
    const accountId = "acct-canary-not-ok";
    const liveEnv = await env(accountId);
    const notOk = () => new Response([
      { type: "response.output_text.delta", delta: "NOT OK" },
      { type: "response.completed", response: { id: "resp-secret", usage: { input_tokens: 3, output_tokens: 2 } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
    const { fetchMock } = canaryFetch(accountId, true, notOk);
    await expect(runCanaryProbe({ fetch: fetchMock, sleep: vi.fn(async () => undefined), now: vi.fn(() => 0),
      onUserCode: vi.fn(), env: liveEnv })).rejects.toThrow(/canary\.blank-context did not match/);
    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBeUndefined();
  });

  it("projects only allowlisted non-SSE error categories and suppresses hostile strings", async () => {
    const accountId = "acct-canary-json-error";
    const secret = "secret-message-request-id-must-not-appear";
    const runPayload = async (payload: Record<string, unknown>): Promise<string> => {
      const { fetchMock } = canaryFetch(accountId, true, () => jsonResponse(400, payload));
      try {
        await runCanaryProbe({
          fetch: fetchMock,
          sleep: vi.fn(async () => undefined),
          now: vi.fn(() => 0),
          onUserCode: vi.fn(),
          env: await env(accountId),
        });
      } catch (failure) {
        return failure instanceof Error ? failure.message : String(failure);
      }
      throw new Error("Expected mocked non-SSE canary to fail");
    };
    const run = (error: Record<string, unknown>): Promise<string> => runPayload({
      error,
      request_id: secret,
      detail: { identifier: secret },
    });

    const known = await run({
      message: secret,
      param: "input",
      type: "invalid_request_error",
      code: "unsupported_value",
      detail: { identifier: secret },
    });
    expect(known).toContain('"contentTypeCategory":"json"');
    expect(known).toContain('"nonSseBodyCategory":"json-error-envelope"');
    expect(known).toMatch(/"nonSseResponseBytes":\d+/);
    expect(known).toContain(
      '"nonSseError":{"paramRoot":"input","typeCategory":"invalid-request","codeCategory":"unsupported-value"}',
    );
    expect(known).not.toContain(secret);
    expect(known).not.toContain("message");
    expect(known).not.toContain("detail");

    const mentioned = await run({
      message: `Fields instructions and max_output_tokens are incompatible; ${secret}`,
      param: null,
      type: "invalid_request_error",
      code: "unsupported_value",
    });
    expect(mentioned).toContain(
      '"mentionedRequestFields":["instructions","max_output_tokens"]',
    );
    expect(mentioned).not.toContain(secret);
    expect(mentioned).not.toContain("incompatible");

    const unknownParam = "identifier_shaped_but_untrusted_param";
    const unknownType = "identifier_shaped_but_untrusted_type";
    const unknownCode = "identifier_shaped_but_untrusted_code";
    const unknown = await run({
      message: secret,
      param: unknownParam,
      type: unknownType,
      code: unknownCode,
    });
    expect(unknown).toContain(
      '"nonSseError":{"paramRoot":"<unknown>","typeCategory":"<unknown>","codeCategory":"<unknown>"}',
    );
    for (const unsafe of [secret, unknownParam, unknownType, unknownCode]) {
      expect(unknown).not.toContain(unsafe);
    }

    const nestedParam = await run({
      message: secret,
      param: "input[0].type",
      type: "invalid_request_error",
      code: "invalid_value",
    });
    expect(nestedParam).toContain('"paramRoot":"input"');
    expect(nestedParam).not.toContain("[0].type");

    const observedDetail = { detail: "Unsupported parameter: max_output_tokens" };
    expect(Buffer.byteLength(JSON.stringify(observedDetail))).toBe(53);
    const topLevel = await runPayload(observedDetail);
    expect(topLevel).toContain('"nonSseBodyCategory":"json-detail-error"');
    expect(topLevel).toContain('"nonSseResponseBytes":53');
    expect(topLevel).toContain('"mentionedRequestFields":["max_output_tokens"]');
    expect(topLevel).not.toContain("Unsupported parameter");

    const restricted = await runPayload({ detail: `account restricted instructions ${secret}` });
    expect(restricted).toContain("stopped on account restriction");
    expect(restricted).not.toContain("json-detail-error");
    expect(restricted).not.toContain(secret);
  });

  it("does not refund a durable reservation when the inference fetch throws", async () => {
    const accountId = "acct-canary-fetch-failure";
    const liveEnv = await env(accountId);
    const { fetchMock } = canaryFetch(accountId, true, () => {
      expect(testConsumedInferencePosts(liveEnv)).toBe(1);
      throw new Error("forced transport failure");
    });
    const finalized = vi.fn();

    await expect(runCanaryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env: liveEnv,
    })).rejects.toThrow(/forced transport failure/);

    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBeUndefined();
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: expect.objectContaining({ inference: 1 }),
    }));
  });

  it.each([
    [400, /did not match/],
    [429, /stopped on HTTP 429/],
  ])("keeps an HTTP %i canary charged but non-reusable", async (status, message) => {
    const accountId = `acct-canary-http-${status}`;
    const liveEnv = await env(accountId);
    const { fetchMock } = canaryFetch(accountId, true, () => jsonResponse(status, {
      error: { code: status === 429 ? "rate_limit_exceeded" : "invalid_request" },
    }));
    await expect(runCanaryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: liveEnv,
    })).rejects.toThrow(message);
    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBeUndefined();
  });

  it("does not mark the canary when final quota becomes unhealthy", async () => {
    const accountId = "acct-canary-final-quota";
    const liveEnv = await env(accountId);
    const base = canaryFetch(accountId);
    let quotaCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === CODEX_USAGE_URL && ++quotaCalls === 2) {
        return jsonResponse(200, {
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 100, reset_at: 2_000_000_000 } },
        });
      }
      return base.fetchMock(input, init);
    });
    await expect(runCanaryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: liveEnv,
    })).rejects.toThrow(/quota-limited or restricted/);
    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBeUndefined();
  });

  it("keeps SIGINT after reserve charged and non-reusable", async () => {
    const accountId = "acct-canary-sigint-after-reserve";
    const liveEnv = await env(accountId);
    const controller = new AbortController();
    const { fetchMock } = canaryFetch(accountId, true, () => {
      expect(testConsumedInferencePosts(liveEnv)).toBe(1);
      controller.abort(new Error("SIGINT after canary reserve"));
      throw controller.signal.reason;
    });
    await expect(runCanaryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      signal: controller.signal,
      env: liveEnv,
    })).rejects.toThrow(/SIGINT after canary reserve/);
    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBeUndefined();
  });

  it("does not mark a successful response reusable when scratch proof fails afterward", async () => {
    const accountId = "acct-canary-scratch-failure";
    const liveEnv = await env(accountId);
    const base = canaryFetch(accountId);
    let quotaCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const response = await base.fetchMock(input, init);
      if (String(input) === CODEX_USAGE_URL && ++quotaCalls === 2) {
        await mkdir(liveEnv.SUPERTWIN_HOME!, { recursive: true, mode: 0o700 });
        await writeFile(join(liveEnv.SUPERTWIN_HOME!, "residual"), "must-not-checkpoint");
      }
      return response;
    });

    await expect(runCanaryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: liveEnv,
    })).rejects.toThrow(/no-residual-artifacts/);
    expect(testConsumedInferencePosts(liveEnv)).toBe(1);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBeUndefined();
    await rm(liveEnv.SUPERTWIN_HOME!, { recursive: true, force: true });
  });

  it("hard-refuses a second inference request", async () => {
    expect(LIVE_CANARY_HTTP_LIMITS).toEqual({
      deviceCode: 0, devicePoll: 0, token: 2, models: 1,
      quota: 2, inference: 1, other: 0,
    });
    expect(Object.values(LIVE_CANARY_HTTP_LIMITS).reduce((sum, count) => sum + count, 0)).toBe(6);
    const upstream = vi.fn<typeof fetch>(async () => sseResponse());
    const counted = new ProbeHttpAccounting(LIVE_CANARY_HTTP_LIMITS).wrap(upstream);
    await counted(CODEX_RESPONSES_URL);
    await expect(counted(CODEX_RESPONSES_URL)).rejects.toThrow(/budget exhausted for inference/);
    expect(upstream).toHaveBeenCalledOnce();
  });
});
