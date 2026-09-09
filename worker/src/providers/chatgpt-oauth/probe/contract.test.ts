import { afterAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accountFingerprint, accountIdFromAccessToken } from "./account.js";
import { LIVE_CANARY_PROBE_ENV, LIVE_CONTRACT_PROBE_ENV } from "./safety.js";
import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
  FULL_PROBE_CASE_BUDGET,
} from "./constants.js";
import {
  buildContractCaseMismatchDiagnostic,
  contractHttpLimitsForRun,
  executeContractProbeCase,
  runContractProbeScaffold,
} from "./contract-runner.js";
import { ProbeHttpAccounting } from "./accounting.js";
import { buildPhase0bAuthorizationPlan } from "./authorization-plan.js";
import {
  buildContractProbeMatrix,
  PHASE0B_V4_PREFIX_RESERVATIONS,
  PROBED_ALLOWLIST_FIELDS,
} from "./matrix.js";
import { redactedJson } from "./redact.js";
import { consumeBoundedSse, type SseProbeEvidence } from "./sse.js";
import { REQUESTED_PROBE_MODEL_ENV } from "./models.js";
import type { ProbeModelCatalogue } from "./models.js";
import {
  addTestInferenceAuthorization,
  cleanupTestInferenceAuthorizations,
  testConsumedInferencePosts,
  testMatchedCanaryReservationPost,
} from "./authorization-test-support.js";
import {
  bindLiveInferenceAuthorizationPlan,
  markLiveCanaryInferenceMatched,
  prepareLiveInferenceAuthorization,
  reserveLiveCanaryInferencePost,
} from "./live-authorization.js";

afterAll(cleanupTestInferenceAuthorizations);

function jwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
}

const CAPABLE_CATALOGUE: ProbeModelCatalogue = { models: [{
  id: "gpt-probe",
  capabilities: {
    inputModalities: ["text", "image"],
    reasoningEfforts: ["low"],
    maxOutputTokens: 4096,
    tools: true,
    parallelToolCalls: true,
    verbosity: true,
    promptCacheKey: true,
    promptCacheOptions: true,
    structuredOutput: true,
  },
}] };

const DISCOVERED_GPT_5_6_SOL_CATALOGUE: ProbeModelCatalogue = { models: [{
  id: "gpt-5.6-sol",
  capabilities: {
    inputModalities: ["text", "image"],
    parallelToolCalls: true,
  },
}] };

async function contractEnv(
  accountId: string,
  expectedFingerprint = accountFingerprint(accountId),
  catalogue: ProbeModelCatalogue = CAPABLE_CATALOGUE,
  options: { authorizedPosts?: number; consumedPosts?: number } = {},
): Promise<NodeJS.ProcessEnv> {
  return addTestInferenceAuthorization({
    SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    [LIVE_CONTRACT_PROBE_ENV]: "1",
    SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: expectedFingerprint,
    SUPERTWIN_CHATGPT_PROBE_MODEL: "gpt-probe",
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-contract-test"),
  }, catalogue, options);
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(type = "response.completed", output = "OK", toolCall = false): Response {
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
    headers: { "content-type": "TeXt/EvEnT-StReAm; Charset=UTF-8" },
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

  it("freezes the observed prefix and exposes only the 37 untouched live-shape posts", () => {
    const cases = buildContractProbeMatrix(
      DISCOVERED_GPT_5_6_SOL_CATALOGUE,
      "gpt-5.6-sol",
      { SUPERTWIN_APP_VERSION: "13.12.2" },
      true,
    );
    expect(cases.slice(0, 21).every(({ disposition }) => disposition === "prefix-checkpoint")).toBe(true);
    expect(cases.filter(({ disposition }) => disposition === "post")).toHaveLength(37);
    expect(cases.filter(({ disposition }) => disposition === "post")
      .every(({ sequence }) => sequence > 21)).toBe(true);
    expect(cases[20]).toMatchObject({
      sequence: 21,
      name: "allowlist.previous_response_id.accepted",
      disposition: "prefix-checkpoint",
      checkpointOutcome: "backend-incompatible",
    });
  });
});

describe("ephemeral account and SSE evidence", () => {
  it("uses independent fresh IDs for every physical call despite repeated sequence and hook collisions", async () => {
    const seen: Array<Record<string, string>> = [];
    const probe = buildContractProbeMatrix("gpt-probe")[0]!;
    const hooks = { fetch: (async (_url, init) => {
      seen.push(init?.headers as Record<string, string>); return sseResponse();
    }) as typeof fetch, sleep: async () => undefined, onUserCode: () => undefined,
    requestId: () => "forced-collision", reserveInferencePosts: async () => undefined,
    now: () => Date.now() };
    await executeContractProbeCase(probe, { Authorization: "Bearer token", "ChatGPT-Account-ID": "account",
      "User-Agent": "SuperTwinV13/test", originator: "supertwinv13" }, hooks, new Set());
    await executeContractProbeCase(probe, { Authorization: "Bearer token", "ChatGPT-Account-ID": "account",
      "User-Agent": "SuperTwinV13/test", originator: "supertwinv13" }, hooks, new Set());
    expect(new Set(seen.map((headers) => headers.session_id)).size).toBe(2);
    expect(new Set(seen.map((headers) => headers["x-client-request-id"])).size).toBe(2);
    expect(seen.every((headers) => headers.session_id !== headers["x-client-request-id"])).toBe(true);
    expect(seen.every((headers) => headers.session_id.length <= 128 &&
      headers["x-client-request-id"]!.length <= 128)).toBe(true);
  });

  it("accepts absent Content-Type only for strict SSE from the exact response endpoint", async () => {
    const probe = buildContractProbeMatrix("gpt-probe")[0]!;
    const absent = (url: string, body = sseResponse().body!) => {
      const response = new Response(body); Object.defineProperty(response, "url", { value: url }); return response;
    };
    const hooks = { fetch: (async () => absent(CODEX_RESPONSES_URL)) as typeof fetch, now: () => 0,
      sleep: async () => undefined, onUserCode: () => undefined, reserveInferencePosts: async () => undefined };
    await expect(executeContractProbeCase(probe, { Authorization: "Bearer token", "ChatGPT-Account-ID": "account",
      "User-Agent": "SuperTwinV13/test", originator: "supertwinv13" }, hooks, new Set())).resolves.toMatchObject({
      matchedExpectation: true, responseContentTypeCategory: "absent" });
    hooks.fetch = (async () => absent("https://wrong.invalid/response")) as typeof fetch;
    await expect(executeContractProbeCase(probe, { Authorization: "Bearer token", "ChatGPT-Account-ID": "account",
      "User-Agent": "SuperTwinV13/test", originator: "supertwinv13" }, hooks, new Set())).rejects.toThrow(/unexpected response URL/);
  });

  it("retains only bounded safe evidence for an absent-type HTML response", async () => {
    const marker = "private-html-marker";
    const html = `<!doctype html><html>${marker}</html>`;
    const response = new Response(new TextEncoder().encode(html), { headers: { "content-encoding": "gzip" } });
    Object.defineProperty(response, "url", { value: CODEX_RESPONSES_URL });
    const probe = buildContractProbeMatrix("gpt-probe")[0]!;
    let failure = "";
    try {
      await executeContractProbeCase(probe, { Authorization: "Bearer token", "ChatGPT-Account-ID": "account",
        "User-Agent": "SuperTwinV13/test", originator: "supertwinv13" }, {
        fetch: async () => response, now: () => 0, sleep: async () => undefined, onUserCode: () => undefined,
        reserveInferencePosts: async () => undefined,
      }, new Set());
    } catch (error) { failure = String(error); }
    expect(failure).toContain('"bodyShapeCategory":"html-like"');
    expect(failure).toContain('"contentEncodingCategory":"gzip"');
    expect(failure).toContain(`"nonSseResponseBytes":${Buffer.byteLength(html)}`);
    expect(failure).toContain('"expectedUrlMatch":true');
    expect(failure).not.toContain(marker);
  });

  it("decodes the routing claim but exposes only a stable fingerprint in evidence", () => {
    const accountId = "acct-sensitive-value";
    expect(accountIdFromAccessToken(jwt(accountId))).toBe(accountId);
    expect(accountFingerprint(accountId)).toMatch(/^[a-f0-9]{12}$/);
    expect(accountFingerprint(accountId)).not.toContain(accountId);
  });

  it("bounds mismatch diagnostics and excludes raw SSE content and identifiers", () => {
    const diagnostic = buildContractCaseMismatchDiagnostic(
      new Response("ignored", { status: 200 }),
      "text/event-stream",
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

  it("classifies intermediary-shaped responses without retaining raw body, header, or URL values", () => {
    const marker = "raw-marker-must-never-appear";
    const html = `<!doctype html><html><body>${marker}</body></html>`;
    const diagnostic = buildContractCaseMismatchDiagnostic(
      new Response("ignored", { status: 200 }), null, undefined,
      { text: html, bytes: Buffer.byteLength(html) },
      { redirected: true, url: `https://wrong.example/${marker}`, expectedUrl: CODEX_RESPONSES_URL,
        contentEncoding: `x-${marker}` },
    );
    expect(diagnostic).toMatchObject({ contentTypeCategory: "absent", contentEncodingCategory: "other",
      bodyShapeCategory: "html-like", redirected: true, expectedUrlMatch: false });
    expect(JSON.stringify(diagnostic)).not.toContain(marker);
    for (const [header, category] of [[undefined, "absent"], ["gzip", "gzip"], ["br", "br"],
      ["deflate", "deflate"]] as const) {
      expect(buildContractCaseMismatchDiagnostic(new Response("x"), null, undefined,
        { text: "data: {}\n\n", bytes: 10 }, { url: CODEX_RESPONSES_URL, expectedUrl: CODEX_RESPONSES_URL,
          contentEncoding: header })).toMatchObject({ contentEncodingCategory: category,
        bodyShapeCategory: "sse-like", redirected: false, expectedUrlMatch: true });
    }
  });

  it("classifies bounded non-SSE bodies and re-sanitizes hostile builder input", () => {
    const response = new Response("ignored", {
      status: 400,
      headers: { "content-type": "Application/Problem+JSON; Charset=UTF-8" },
    });
    const secret = "secret-arbitrary-diagnostic-value";
    const hostileText = JSON.stringify({
      error: {
        param: `input[0].${secret}`,
        type: secret,
        code: secret,
        message: `The input and max_output_tokens fields conflict. ${secret}`,
      },
    });
    const diagnostic = buildContractCaseMismatchDiagnostic(
      response,
      response.headers.get("content-type"),
      undefined,
      {
        text: hostileText,
        bytes: Buffer.byteLength(hostileText),
      },
    );
    expect(diagnostic).toMatchObject({
      contentTypeCategory: "json",
      nonSseBodyCategory: "json-error-envelope",
      nonSseResponseBytes: Buffer.byteLength(hostileText),
      nonSseError: {
        paramRoot: "input",
        typeCategory: "<unknown>",
        codeCategory: "<unknown>",
        mentionedRequestFields: ["input", "max_output_tokens"],
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);

    const invalidRaw = buildContractCaseMismatchDiagnostic(response, "application/json", undefined, {
      text: hostileText,
      bytes: 999_999_999,
      nonSseError: { paramRoot: secret },
    });
    expect(invalidRaw).not.toHaveProperty("nonSseError");
    expect(invalidRaw).not.toHaveProperty("nonSseResponseBytes");
    expect(JSON.stringify(invalidRaw)).not.toContain(secret);

    const accessorRaw = Object.defineProperty({ bytes: 2 }, "text", {
      enumerable: true,
      get() { throw new Error(secret); },
    });
    expect(() => buildContractCaseMismatchDiagnostic(
      response,
      "application/json",
      undefined,
      accessorRaw,
    )).not.toThrow();

    expect(buildContractCaseMismatchDiagnostic(response, "", undefined, { text: "", bytes: 0 }))
      .toMatchObject({ contentTypeCategory: "absent", nonSseBodyCategory: "empty" });
    expect(buildContractCaseMismatchDiagnostic(response, "text/plain", undefined, { text: "not-json", bytes: 8 }))
      .toMatchObject({ contentTypeCategory: "other", nonSseBodyCategory: "non-json" });
    expect(buildContractCaseMismatchDiagnostic(response, "application/json", undefined, { text: "{}", bytes: 2 }))
      .toMatchObject({ contentTypeCategory: "json", nonSseBodyCategory: "json-other" });

    for (const [payload, expected] of [
      [
        { detail: `Unsupported max_output_tokens ${secret}` },
        { nonSseBodyCategory: "json-detail-error", nonSseError: { mentionedRequestFields: ["max_output_tokens"] } },
      ],
      [
        { message: `Invalid input ${secret}`, param: "input[0].content" },
        {
          nonSseBodyCategory: "json-message-error",
          nonSseError: { paramRoot: "input", mentionedRequestFields: ["input"] },
        },
      ],
      [
        { error: "invalid_request", error_description: `Unsupported reasoning ${secret}` },
        {
          nonSseBodyCategory: "json-error-description",
          nonSseError: { typeCategory: "invalid-request", mentionedRequestFields: ["reasoning"] },
        },
      ],
      [
        { detail: { message: `Invalid instructions ${secret}`, param: "instructions.value" } },
        {
          nonSseBodyCategory: "json-detail-error",
          nonSseError: { paramRoot: "instructions", mentionedRequestFields: ["instructions"] },
        },
      ],
    ] as const) {
      const text = JSON.stringify(payload);
      const projected = buildContractCaseMismatchDiagnostic(response, "application/json", undefined, {
        text,
        bytes: Buffer.byteLength(text),
      });
      expect(projected).toMatchObject(expected);
      expect(JSON.stringify(projected)).not.toContain(secret);
    }

    const knownError = JSON.stringify({ error: { param: "reasoning.effort", type: "invalid_request_error" } });
    expect(buildContractCaseMismatchDiagnostic(response, "APPLICATION/JSON; charset=utf-8", undefined, {
      text: knownError,
      bytes: Buffer.byteLength(knownError),
    })).toMatchObject({
      contentTypeCategory: "json",
      nonSseError: { paramRoot: "reasoning", typeCategory: "invalid-request" },
    });
    expect(buildContractCaseMismatchDiagnostic(
      new Response("ignored", { status: 401 }),
      "application/json",
      undefined,
      { text: knownError, bytes: Buffer.byteLength(knownError) },
    )).not.toHaveProperty("nonSseError");
    expect(buildContractCaseMismatchDiagnostic(response, "text/plain", undefined, {
      text: knownError,
      bytes: Buffer.byteLength(knownError),
    })).not.toHaveProperty("nonSseError");
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
    const env = await contractEnv(accountId);
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
    const env = await contractEnv(accountId, "000000000000");
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
    const liveEnv = await contractEnv(accountId);
    let inferencePosts = 0;
    const consumedAtStageStart = new Map<number, number>();
    let continuationBody: Record<string, unknown> | undefined;
    let canaryHeaders: Record<string, string> | undefined;
    let cancellationSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === CODEX_DEVICE_CODE_URL) {
        // The runner must remain bound to its immutable entry snapshot.
        liveEnv.SUPERTWIN_APP_VERSION = "99.99.99";
        liveEnv.SUPERTWIN_CHATGPT_PROBE_MODEL = "mutated-after-entry";
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
        expect(testConsumedInferencePosts(liveEnv)).toBeGreaterThanOrEqual(inferencePosts);
        if ([42, 43, 47, 55].includes(sequence)) {
          consumedAtStageStart.set(sequence, testConsumedInferencePosts(liveEnv));
        }
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
      env: liveEnv,
    });

    expect(inferencePosts).toBe(43);
    expect(testConsumedInferencePosts(liveEnv)).toBe(43);
    expect(consumedAtStageStart).toEqual(new Map([
      [42, 15], [43, 19], [47, 27], [55, 43],
    ]));
    expect(fetchMock).toHaveBeenCalledTimes(50);
    expect(evidence).toMatchObject({
      persistedCredentials: false,
      inferenceRetries: 0,
      plannedInferencePosts: 43,
      actualInferencePosts: 43,
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
        inference: 43,
        other: 0,
        total: 50,
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
    expect(evidence.cases[1]?.status).toBe("prefix-checkpoint");
    expect(cancellationSignal).toBeUndefined();
    expect(evidence.cases.find(({ name }) => name === "focused.strict-json")?.stream)
      .toMatchObject({ outputMatchesExactOkBooleanSchema: true });
    expect(evidence.cases.find(({ name }) => name === "focused.tool-call")?.stream?.functionCalls)
      .toEqual([{ name: "probe_echo", argumentBytes: 17, argumentsJsonValid: true, argumentsMatchProbeEchoSchema: true }]);
    expect(continuationBody).toBeUndefined();
    expect(canaryHeaders).toBeUndefined();
    const output = redactedJson(evidence);
    expect(output).not.toContain(accountId);
    expect(output).not.toContain("refresh-secret");
    expect(output).not.toContain("Bearer ey");
    expect(output).not.toContain("resp_probe");
  });

  it("runs only the exact untouched gpt-5.6-sol 37-POST suffix", async () => {
    const accountId = "acct-discovered-gpt-5-6-sol";
    const plan = buildPhase0bAuthorizationPlan(
      DISCOVERED_GPT_5_6_SOL_CATALOGUE,
      "gpt-5.6-sol",
      { SUPERTWIN_APP_VERSION: "13.12.2" },
    );
    expect(plan).toEqual({
      matrixVersion: "phase0b-contract-matrix-v4",
      matrixHash: "5d0620739e82a1c8ea4bc610ed2afd91247c67554b4552a6d26a145172ccaa6b",
      caseCount: 70,
      inferencePostCount: 37,
      inferenceRetries: 0,
      prefixCheckpoint: { consumedPosts: 13, lastSequence: 21, predecessorRevision: 3,
        predecessorConsumedPosts: 5, reservations: PHASE0B_V4_PREFIX_RESERVATIONS },
    });
    const liveEnv = await addTestInferenceAuthorization({
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: accountFingerprint(accountId),
      SUPERTWIN_CHATGPT_PROBE_MODEL: "gpt-5.6-sol",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-discovered-plan-test"),
    }, DISCOVERED_GPT_5_6_SOL_CATALOGUE, { consumedPosts: 13 });

    let inferencePosts = 0;
    const sequences: number[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
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
        return jsonResponse(200, { access_token: jwt(accountId), refresh_token: "refresh-secret" });
      }
      if (url === CODEX_MODELS_URL) return jsonResponse(200, { models: [{
        slug: "gpt-5.6-sol",
        input_modalities: ["text", "image"],
        supports_parallel_tool_calls: true,
      }] });
      if (url === CODEX_USAGE_URL) return jsonResponse(200, {
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 10, reset_at: 2_000_000_000 } },
      });
      if (url !== CODEX_RESPONSES_URL) throw new Error(`Unexpected mocked URL: ${url}`);
      inferencePosts += 1;
      expect(testConsumedInferencePosts(liveEnv)).toBeGreaterThanOrEqual(inferencePosts);
      const sequence = Number((init?.headers as Record<string, string>).session_id.split("-").at(-1));
      sequences.push(sequence);
      if (sequence >= 4 && sequence <= 32 && sequence % 2 === 0) {
        return jsonResponse(400, { error: { code: "invalid_request" } });
      }
      return sseResponse(sequence === 2 ? "response.output_text.delta" : "response.completed");
    });

    const evidence = await runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: liveEnv,
    });

    expect(sequences).toHaveLength(37);
    expect(sequences.every((sequence) => sequence > 21)).toBe(true);
    expect(new Set(sequences).size).toBe(37);
    expect(inferencePosts).toBe(37);
    expect(testConsumedInferencePosts(liveEnv)).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(44);
    expect(evidence).toMatchObject({
      plannedInferencePosts: 37,
      actualInferencePosts: 37,
      checkpoint: { canary: "not-reused" },
      modelCatalogue: { ids: ["gpt-5.6-sol"], selectedId: "gpt-5.6-sol" },
      httpActuals: { inference: 37, total: 44 },
    });
    expect(evidence.cases).toHaveLength(70);
    expect(evidence.cases.slice(0, 21).every(({ status }) => status === "prefix-checkpoint")).toBe(true);
    expect(evidence.cases[20]).toMatchObject({
      name: "allowlist.previous_response_id.accepted",
      status: "prefix-checkpoint",
      matchedExpectation: true,
    });
  });

  it("never lets a historical canary checkpoint rerun the immutable v4 prefix", async () => {
    const accountId = "acct-checkpoint-resume";
    const liveEnv = await contractEnv(
      accountId,
      accountFingerprint(accountId),
      CAPABLE_CATALOGUE,
      { authorizedPosts: 57, consumedPosts: 2 },
    );
    liveEnv[LIVE_CANARY_PROBE_ENV] = "1";
    const prepared = await prepareLiveInferenceAuthorization("canary", liveEnv);
    const bound = await bindLiveInferenceAuthorizationPlan(prepared, CAPABLE_CATALOGUE, "gpt-probe", liveEnv);
    const reservation = await reserveLiveCanaryInferencePost(bound);
    await markLiveCanaryInferenceMatched(bound, reservation);
    delete liveEnv[LIVE_CANARY_PROBE_ENV];

    const sequences: number[] = [];
    const consumedAtStageStart = new Map<number, number>();
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
      sequences.push(sequence);
      if ([42, 43, 47, 55].includes(sequence) && !consumedAtStageStart.has(sequence)) {
        consumedAtStageStart.set(sequence, testConsumedInferencePosts(liveEnv));
      }
      if (sequence >= 4 && sequence <= 32 && sequence % 2 === 0) {
        return jsonResponse(400, { error: { code: "invalid_request" } });
      }
      if (sequence === 38) return sseResponse("response.completed", "{\"ok\":true}");
      if (sequence === 40) return sseResponse("response.completed", "", true);
      return sseResponse(sequence === 2 ? "response.output_text.delta" : "response.completed");
    });

    const evidence = await runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: liveEnv,
    });

    expect(sequences).toHaveLength(43);
    expect(sequences.every((sequence) => sequence > 21)).toBe(true);
    expect(Object.fromEntries(consumedAtStageStart)).toEqual({ 42: 18, 43: 22, 47: 30, 55: 46 });
    expect(testConsumedInferencePosts(liveEnv)).toBe(46);
    expect(testMatchedCanaryReservationPost(liveEnv)).toBe(3);
    expect(evidence).toMatchObject({
      plannedInferencePosts: 43,
      actualInferencePosts: 43,
      checkpoint: { canary: "not-reused" },
      httpActuals: { inference: 43, total: 50 },
    });
    expect(evidence.cases).toHaveLength(70);
    expect(evidence.cases[0]).toMatchObject({
      sequence: 1,
      status: "prefix-checkpoint",
      matchedExpectation: true,
    });
    expect(evidence.cases[0]?.stream).toBeUndefined();
  });

  it("hard-caps a checkpoint-resumed run at 54 before an erroneous 55th fetch", async () => {
    const upstream = vi.fn<typeof fetch>(async () => sseResponse());
    const counted = new ProbeHttpAccounting(contractHttpLimitsForRun(55, true)).wrap(upstream);
    for (let index = 0; index < 54; index += 1) await counted(CODEX_RESPONSES_URL);
    await expect(counted(CODEX_RESPONSES_URL)).rejects.toThrow(/budget exhausted for inference/);
    expect(upstream).toHaveBeenCalledTimes(54);
  });

  it.each([
    { planned: 45, reused: false, expectedFetches: 45 },
    { planned: 45, reused: true, expectedFetches: 44 },
  ])("hard-caps a $planned-post current plan at $expectedFetches fetches when reused=$reused", async ({
    planned,
    reused,
    expectedFetches,
  }) => {
    const upstream = vi.fn<typeof fetch>(async () => sseResponse());
    const counted = new ProbeHttpAccounting(contractHttpLimitsForRun(planned, reused)).wrap(upstream);
    for (let index = 0; index < expectedFetches; index += 1) await counted(CODEX_RESPONSES_URL);
    await expect(counted(CODEX_RESPONSES_URL)).rejects.toThrow(/budget exhausted for inference/);
    expect(upstream).toHaveBeenCalledTimes(expectedFetches);
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
      env: await contractEnv(accountId),
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
        env: await contractEnv(accountId, accountFingerprint(accountId), {
          models: [{ id: "gpt-probe", capabilities: {
            inputModalities: ["text", "image"], reasoningEfforts: ["low"], tools: true,
            parallelToolCalls: true, verbosity: true, promptCacheKey: true,
            promptCacheOptions: true, structuredOutput: true,
          } }],
        }),
      });
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("allowlist.prompt_cache_key.accepted did not match");
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
    const liveEnv = await contractEnv(accountId);
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
      env: liveEnv,
    })).rejects.toThrow(/ladder\.4\.1 did not match/);

    expect(abortedPeers).toEqual(new Set([44, 45, 46]));
    expect(settledPeers).toEqual(new Set([44, 45, 46]));
    expect(startedSequences).toEqual(expect.arrayContaining([42, 43, 44, 45, 46]));
    expect(startedSequences.some((sequence) => sequence >= 47)).toBe(false);
    expect(testConsumedInferencePosts(liveEnv)).toBe(19);
  });
});
