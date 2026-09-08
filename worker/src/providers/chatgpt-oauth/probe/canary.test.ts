import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

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

function jwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
}

function env(accountId: string): NodeJS.ProcessEnv {
  return {
    SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    [LIVE_CANARY_PROBE_ENV]: "1",
    SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: accountFingerprint(accountId),
    SUPERTWIN_CHATGPT_PROBE_MODEL: "gpt-probe",
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: join(tmpdir(), `supertwin-canary-${process.pid}-${Date.now()}`),
  };
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
    const { fetchMock, inferenceBodies } = canaryFetch(accountId);
    const finalized = vi.fn();
    const evidence = await runCanaryProbe({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      requestId: () => "00000000-0000-4000-8000-000000000000",
      env: env(accountId),
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
    const output = redactedJson(evidence);
    for (const secret of [accountId, "refresh-secret", "resp-secret", "authorization-secret"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("keeps mismatch acceptance strict and returns only the safe diagnostic in the error", async () => {
    const accountId = "acct-canary-mismatch";
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
        env: env(accountId),
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
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      httpActuals: {
        deviceCode: 1, devicePoll: 1, token: 2, models: 1,
        quota: 1, inference: 1, other: 0, total: 7,
      },
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
    }));
  });

  it("projects only allowlisted non-SSE error categories and suppresses hostile strings", async () => {
    const accountId = "acct-canary-json-error";
    const secret = "secret-message-request-id-must-not-appear";
    const run = async (error: Record<string, unknown>): Promise<string> => {
      const { fetchMock } = canaryFetch(accountId, true, () => jsonResponse(400, {
        error,
        request_id: secret,
        detail: { identifier: secret },
      }));
      try {
        await runCanaryProbe({
          fetch: fetchMock,
          sleep: vi.fn(async () => undefined),
          now: vi.fn(() => 0),
          onUserCode: vi.fn(),
          env: env(accountId),
        });
      } catch (failure) {
        return failure instanceof Error ? failure.message : String(failure);
      }
      throw new Error("Expected mocked non-SSE canary to fail");
    };

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
  });

  it("hard-refuses a second inference request", async () => {
    expect(LIVE_CANARY_HTTP_LIMITS).toEqual({
      deviceCode: 1, devicePoll: 300, token: 2, models: 1,
      quota: 2, inference: 1, other: 0,
    });
    expect(Object.values(LIVE_CANARY_HTTP_LIMITS).reduce((sum, count) => sum + count, 0)).toBe(307);
    const upstream = vi.fn<typeof fetch>(async () => sseResponse());
    const counted = new ProbeHttpAccounting(LIVE_CANARY_HTTP_LIMITS).wrap(upstream);
    await counted(CODEX_RESPONSES_URL);
    await expect(counted(CODEX_RESPONSES_URL)).rejects.toThrow(/budget exhausted for inference/);
    expect(upstream).toHaveBeenCalledOnce();
  });
});
