import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accountFingerprint, accountIdFromAccessToken } from "./account.js";
import { LIVE_CONTRACT_PROBE_ENV } from "./safety.js";
import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
  FULL_PROBE_CASE_BUDGET,
  FULL_PROBE_INFERENCE_POST_BUDGET,
} from "./constants.js";
import {
  buildContractCaseMismatchDiagnostic,
  runContractProbeScaffold,
} from "./contract-runner.js";
import {
  buildContractProbeMatrix,
  PROBED_ALLOWLIST_FIELDS,
} from "./matrix.js";
import { redactedJson } from "./redact.js";
import { consumeBoundedSse, type SseProbeEvidence } from "./sse.js";
import { REQUESTED_PROBE_MODEL_ENV } from "./models.js";

function jwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
}

function contractEnv(accountId: string): NodeJS.ProcessEnv {
  return {
    SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    [LIVE_CONTRACT_PROBE_ENV]: "1",
    SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: accountFingerprint(accountId),
    SUPERTWIN_CHATGPT_PROBE_MODEL: "gpt-probe",
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-contract-test"),
  };
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(type = "response.completed", output = "probe", toolCall = false): Response {
  const usage = {
    input_tokens: 10,
    output_tokens: 1,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
  };
  const events = toolCall
    ? [
      { type: "response.output_item.added", item: { id: "item_probe", type: "function_call", name: "probe_echo" } },
      { type: "response.function_call_arguments.delta", item_id: "item_probe", delta: "{\"value\":\"probe\"}" },
      { type: "response.output_item.done", item: { id: "item_probe", type: "function_call", name: "probe_echo", arguments: "{\"value\":\"probe\"}" } },
      { type: "response.completed", response: { id: "resp_probe", usage } },
    ]
    : type === "response.completed"
    ? [
      { type: "response.output_text.delta", delta: output },
      { type, response: { id: "resp_probe", usage } },
    ]
    : [
      { type: "response.created", response: { id: "resp_probe" } },
      { type, response: { id: "resp_probe" }, delta: output },
      { type: "response.completed", response: { id: "resp_probe", usage } },
    ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Phase 0b declarative contract matrix", () => {
  it("is exactly 70 cases with at most 55 POSTs and only the 1/4/8/16 ladder", () => {
    const matrix = buildContractProbeMatrix("gpt-probe");
    expect(matrix).toHaveLength(FULL_PROBE_CASE_BUDGET);
    expect(matrix.map((probe) => probe.sequence)).toEqual(
      Array.from({ length: 70 }, (_, index) => index + 1),
    );
    const ladder = matrix.filter((probe) => probe.category === "ladder");
    expect([...new Set(ladder.map((probe) => probe.concurrency))]).toEqual([1, 4, 8, 16]);
    expect(ladder).toHaveLength(29);
  });

  it("contains one accepted and one rejected fixture for every strict field guard", () => {
    const matrix = buildContractProbeMatrix("gpt-probe");
    for (const field of PROBED_ALLOWLIST_FIELDS) {
      expect(matrix.filter((probe) => probe.name === `allowlist.${field}.accepted`)).toHaveLength(1);
      expect(matrix.filter((probe) => probe.name === `allowlist.${field}.rejected`)).toHaveLength(1);
    }
    expect(matrix.filter((probe) => probe.expectation === "rejected")).toHaveLength(15);
  });
});

describe("ephemeral account and SSE evidence", () => {
  it("decodes the routing claim but exposes only a stable fingerprint in evidence", () => {
    const accountId = "acct-sensitive-value";
    expect(accountIdFromAccessToken(jwt(accountId))).toBe(accountId);
    expect(accountFingerprint(accountId)).toMatch(/^[a-f0-9]{12}$/);
    expect(accountFingerprint(accountId)).not.toContain(accountId);
  });

  it("bounds mismatch diagnostics and excludes raw SSE content and identifiers", () => {
    const diagnostic = buildContractCaseMismatchDiagnostic(
      new Response("ignored", { status: 200 }),
      true,
      {
        eventTypes: [
          "response.identifier_shaped_unknown",
          "unsafe secret event\nvalue",
          ...Array.from({ length: 63 }, () => "response.created"),
        ],
        terminal: true,
        completed: false,
        responseId: "resp-secret-must-not-appear",
        substantiveOutput: true,
      } as SseProbeEvidence,
    );
    expect(diagnostic.eventTypes).toHaveLength(64);
    expect(diagnostic.eventTypes.slice(0, 2)).toEqual(["<unknown>", "<unknown>"]);
    expect(diagnostic.flags.eventTypesTruncated).toBe(true);
    expect(diagnostic).toMatchObject({
      status: 200,
      contentTypeCategory: "event-stream",
      eventCount: 0,
      outputTextBytes: 0,
    });
    const output = JSON.stringify(diagnostic);
    expect(output).not.toContain("unsafe secret");
    expect(output).not.toContain("identifier_shaped_unknown");
    expect(output).not.toContain("resp-secret");
  });

  it("parses fragmented UTF-8 SSE and captures only event types, response ID, and numeric usage", async () => {
    const encoded = new TextEncoder().encode(
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "hello 🌍",
      })}\n\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_123", usage: { input_tokens: 2, output_tokens: 3, detail: "drop-me" } },
      })}\n\n`,
    );
    const split = encoded.indexOf(0xf0) + 2;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, split));
          controller.enqueue(encoded.slice(split));
          controller.close();
        },
      }),
    );
    const evidence = await consumeBoundedSse(response);
    expect(evidence.eventTypes).toEqual(["response.output_text.delta", "response.completed"]);
    expect(evidence).toMatchObject({ terminal: true, responseId: "resp_123", usage: { inputTokens: 2, outputTokens: 3 } });
    expect(redactedJson(evidence)).not.toContain("hello");
    expect(redactedJson(evidence)).not.toContain("drop-me");
  });
});

describe("mocked contract runner scaffold", () => {
  it("refuses missing live opt-ins before the first OAuth request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: {},
    })).rejects.toThrow(/live OAuth\/network access requires/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["malformed", "bad model/with whitespace"],
  ])("refuses a %s selected model before the first OAuth request", async (_label, model) => {
    const accountId = "acct-model-preflight";
    const env = contractEnv(accountId);
    if (model === undefined) delete env[REQUESTED_PROBE_MODEL_ENV];
    else env[REQUESTED_PROBE_MODEL_ENV] = model;
    const fetchMock = vi.fn<typeof fetch>();

    await expect(runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env,
    })).rejects.toThrow(new RegExp(REQUESTED_PROBE_MODEL_ENV));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the wrong account before model, quota, or inference traffic", async () => {
    const accountId = "acct-wrong-for-this-run";
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === CODEX_DEVICE_CODE_URL) {
        return jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret", interval: 3 });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
      }
      if (url === CODEX_OAUTH_TOKEN_URL) {
        return jsonResponse(200, { access_token: jwt(accountId), refresh_token: "refresh-secret" });
      }
      throw new Error(`Account gate allowed unexpected URL: ${url}`);
    });
    const env = contractEnv(accountId);
    env.SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT = "000000000000";
    const finalized = vi.fn();

    await expect(runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env,
    })).rejects.toThrow(/not the dedicated Phase 0b test account/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      aborted: true,
      logout: expect.objectContaining({ authenticated: false, hasRefreshToken: false }),
      httpActuals: expect.objectContaining({ deviceCode: 1, devicePoll: 1, token: 1, inference: 0 }),
    }));
  });

  it("performs auth, model/quota reads, and each of the 55 inference POSTs exactly once", async () => {
    const accountId = "acct-never-log-this";
    let inferencePosts = 0;
    let continuationBody: Record<string, unknown> | undefined;
    let canaryHeaders: Record<string, string> | undefined;
    let cancellationSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === CODEX_DEVICE_CODE_URL) {
        return jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret", interval: 3 });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
      }
      if (url === CODEX_OAUTH_TOKEN_URL) {
        return jsonResponse(200, { access_token: jwt(accountId), refresh_token: "refresh-secret" });
      }
      if (url === CODEX_MODELS_URL) return jsonResponse(200, { models: [{
        slug: "gpt-probe",
        display_name: "Restricted Preview Model",
        description: "Availability is restricted to supported account tiers.",
        input_modalities: ["text", "image"],
        supported_reasoning_efforts: ["low"],
        max_output_tokens: 4096,
        supports_tools: true,
        supports_parallel_tool_calls: true,
        supports_verbosity: true,
        supports_prompt_cache_key: true,
        supports_prompt_cache_options: true,
        supports_structured_output: true,
      }] });
      if (url === CODEX_USAGE_URL) return jsonResponse(200, {
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 10, reset_at: 2_000_000_000 } },
      });
      if (url === CODEX_RESPONSES_URL) {
        inferencePosts += 1;
        const headers = init?.headers as Record<string, string>;
        const sequence = Number(headers.session_id.split("-").at(-1));
        if (sequence === 1) canaryHeaders = headers;
        if (sequence === 2) cancellationSignal = init?.signal;
        if (sequence === 21) continuationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (sequence >= 4 && sequence <= 32 && sequence % 2 === 0) {
          return jsonResponse(400, { error: { code: "invalid_request" } });
        }
        if (sequence === 38) return sseResponse("response.completed", "{\"ok\":true}");
        if (sequence === 40) return sseResponse("response.completed", "", true);
        return sseResponse(sequence === 2 ? "response.output_text.delta" : "response.completed");
      }
      throw new Error(`Unexpected mocked URL: ${url}`);
    });

    const evidence = await runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      requestId: () => "00000000-0000-4000-8000-000000000000",
      env: contractEnv(accountId),
    });

    expect(inferencePosts).toBe(FULL_PROBE_INFERENCE_POST_BUDGET);
    expect(fetchMock).toHaveBeenCalledTimes(62);
    expect(evidence).toMatchObject({
      persistedCredentials: false,
      inferenceRetries: 0,
      plannedInferencePosts: FULL_PROBE_INFERENCE_POST_BUDGET,
      actualInferencePosts: FULL_PROBE_INFERENCE_POST_BUDGET,
      modelCatalogue: { ids: ["gpt-probe"], selectedId: "gpt-probe" },
      quotaComparison: { healthyAtStart: true, healthyAtEnd: true },
      refresh: { authenticated: true, previousRecoveryPairAvailable: true },
      logout: { authenticated: false, previousRecoveryPairAvailable: false },
      httpActuals: {
        deviceCode: 1,
        devicePoll: 1,
        token: 2,
        models: 1,
        quota: 2,
        inference: 55,
        other: 0,
        total: 62,
      },
      localListeningSocketsCreated: false,
    });
    expect(evidence.concurrency.rungs.map(({ concurrency, attempts }) => [concurrency, attempts])).toEqual([
      [1, 1], [4, 4], [8, 8], [16, 16],
    ]);
    expect(evidence.concurrency.concurrency8CeilingInputs).toMatchObject({
      peakOverlap: expect.any(Number),
      projectedCallsPerHour: expect.any(Number),
      failures: 0,
      rateLimits: 0,
    });
    expect(evidence.cache.supported).toBe(true);
    if (!evidence.cache.supported) throw new Error("Mocked capable model unexpectedly skipped cache evidence");
    expect(evidence.cache.modes.map(({ mode }) => mode)).toEqual(["none", "implicit", "explicit"]);
    expect(evidence.cases[1]?.stream?.stoppedEarly).toBe(true);
    expect(cancellationSignal?.aborted).toBe(true);
    expect(evidence.cases.find(({ name }) => name === "focused.strict-json")?.stream)
      .toMatchObject({ outputMatchesExactOkBooleanSchema: true });
    expect(evidence.cases.find(({ name }) => name === "focused.tool-call")?.stream?.functionCalls)
      .toEqual([{ name: "probe_echo", argumentBytes: 17, argumentsJsonValid: true, argumentsMatchProbeEchoSchema: true }]);
    expect(continuationBody?.previous_response_id).toBe("resp_probe");
    expect(Object.keys(canaryHeaders ?? {}).sort()).toEqual([
      "Accept",
      "Authorization",
      "ChatGPT-Account-ID",
      "Content-Type",
      "User-Agent",
      "originator",
      "session_id",
      "x-client-request-id",
    ].sort());
    expect(canaryHeaders).toMatchObject({
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": "SuperTwinV13/13.12.2",
      originator: "supertwinv13",
    });
    const output = redactedJson(evidence);
    expect(output).not.toContain(accountId);
    expect(output).not.toContain("refresh-secret");
    expect(output).not.toContain("Bearer ey");
    expect(output).not.toContain("resp_probe");
  });

  it("ignores restriction words in model metadata but rejects structural catalogue flags", async () => {
    const accountId = "acct-contract-structural-restriction";
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === CODEX_DEVICE_CODE_URL) {
        return jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret", interval: 3 });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
      }
      if (url === CODEX_OAUTH_TOKEN_URL) {
        return jsonResponse(200, { access_token: jwt(accountId), refresh_token: "refresh-secret" });
      }
      if (url === CODEX_MODELS_URL) {
        return jsonResponse(200, {
          account: { flagged: true },
          models: [{
            slug: "gpt-probe",
            display_name: "Restricted Preview Model",
            description: "Availability is restricted to supported tiers.",
          }],
        });
      }
      throw new Error(`Structural catalogue gate allowed unexpected URL: ${url}`);
    });
    const finalized = vi.fn();

    await expect(runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      onFinalized: finalized,
      env: contractEnv(accountId),
    })).rejects.toThrow(/upstream restriction \(HTTP 200\)/);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === CODEX_USAGE_URL)).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === CODEX_RESPONSES_URL)).toBe(false);
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith({
      httpActuals: {
        deviceCode: 1, devicePoll: 1, token: 1, models: 1,
        quota: 0, inference: 0, other: 0, total: 4,
      },
      logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
      aborted: true,
    });
  });

  it("fails closed on a 200 stream without a completion event", async () => {
    const accountId = "acct-never-log-this";
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === CODEX_DEVICE_CODE_URL) {
        return jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret", interval: 3 });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
      }
      if (url === CODEX_OAUTH_TOKEN_URL) {
        return jsonResponse(200, { access_token: jwt(accountId), refresh_token: "refresh-secret" });
      }
      if (url === CODEX_MODELS_URL) return jsonResponse(200, { models: [{
        slug: "gpt-probe",
        input_modalities: ["text", "image"],
        supported_reasoning_efforts: ["low"],
        supports_tools: true,
        supports_parallel_tool_calls: true,
        supports_verbosity: true,
        supports_prompt_cache_key: true,
        supports_prompt_cache_options: true,
        supports_structured_output: true,
      }] });
      if (url === CODEX_USAGE_URL) return jsonResponse(200, {
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 10, reset_at: 2_000_000_000 } },
      });
      if (url === CODEX_RESPONSES_URL) return sseResponse("response.created");
      throw new Error(`Unexpected mocked URL: ${url}`);
    });

    const finalized = vi.fn();
    let failure: unknown;
    try {
      await runContractProbeScaffold({
        fetch: fetchMock,
        sleep: vi.fn(async () => undefined),
        now: vi.fn(() => 0),
        onUserCode: vi.fn(),
        onFinalized: finalized,
        env: contractEnv(accountId),
      });
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("canary.blank-context did not match");
    expect(message).toContain('"status":200');
    expect(message).toContain('"contentTypeCategory":"event-stream"');
    expect(message).toContain('"eventCount":3');
    expect(message).toContain('"outputTextBytes":0');
    expect(message).toContain('"eventTypes":["response.created","response.created","response.completed"]');
    expect(message).toContain('"completed":true');
    expect(message).toContain('"substantiveOutput":false');
    expect(message).not.toContain("resp_probe");
    expect(message).not.toContain("probe-signature");
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === CODEX_RESPONSES_URL)).toHaveLength(1);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      aborted: true,
      logout: expect.objectContaining({ authenticated: false, hasRefreshToken: false }),
      httpActuals: expect.objectContaining({ inference: 1, models: 1, quota: 1, token: 2 }),
    }));
  });

  it("aborts and settles every concurrency-4 peer before rejecting, without starting concurrency-8", async () => {
    const accountId = "acct-concurrency-abort-test";
    const startedSequences: number[] = [];
    const abortedPeers = new Set<number>();
    const settledPeers = new Set<number>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === CODEX_DEVICE_CODE_URL) {
        return jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret", interval: 3 });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
      }
      if (url === CODEX_OAUTH_TOKEN_URL) {
        return jsonResponse(200, { access_token: jwt(accountId), refresh_token: "refresh-secret" });
      }
      if (url === CODEX_MODELS_URL) return jsonResponse(200, { models: [{
        slug: "gpt-probe",
        input_modalities: ["text", "image"],
        supported_reasoning_efforts: ["low"],
        max_output_tokens: 4096,
        supports_tools: true,
        supports_parallel_tool_calls: true,
        supports_verbosity: true,
        supports_prompt_cache_key: true,
        supports_prompt_cache_options: true,
        supports_structured_output: true,
      }] });
      if (url === CODEX_USAGE_URL) return jsonResponse(200, {
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 10, reset_at: 2_000_000_000 } },
      });
      if (url !== CODEX_RESPONSES_URL) throw new Error(`Unexpected mocked URL: ${url}`);

      const sequence = Number((init?.headers as Record<string, string>).session_id.split("-").at(-1));
      startedSequences.push(sequence);
      if (sequence === 38) return sseResponse("response.completed", "{\"ok\":true}");
      if (sequence === 40) return sseResponse("response.completed", "", true);
      if (sequence === 2) return sseResponse("response.output_text.delta");
      if (sequence === 43) return jsonResponse(500, { error: { code: "forced_concurrency_4_failure" } });
      if (sequence >= 44 && sequence <= 46) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error("peer request did not receive an abort signal"));
          signal.addEventListener("abort", () => {
            abortedPeers.add(sequence);
            setTimeout(() => {
              settledPeers.add(sequence);
              reject(signal.reason ?? new Error("peer aborted"));
            }, 5);
          }, { once: true });
        });
      }
      return sseResponse();
    });

    await expect(runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: contractEnv(accountId),
    })).rejects.toThrow(/ladder\.4\.1 did not match/);

    expect(abortedPeers).toEqual(new Set([44, 45, 46]));
    expect(settledPeers).toEqual(new Set([44, 45, 46]));
    expect(startedSequences).toEqual(expect.arrayContaining([42, 43, 44, 45, 46]));
    expect(startedSequences.some((sequence) => sequence >= 47)).toBe(false);
  });
});
