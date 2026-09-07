import { describe, expect, it, vi } from "vitest";

import { accountFingerprint, accountIdFromAccessToken } from "./account.js";
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
import { runContractProbeScaffold } from "./contract-runner.js";
import {
  buildContractProbeMatrix,
  PROBED_ALLOWLIST_FIELDS,
} from "./matrix.js";
import { redactedJson } from "./redact.js";
import { consumeBoundedSse } from "./sse.js";

function jwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(type = "response.completed"): Response {
  const events = type === "response.completed"
    ? [
      { type: "response.output_text.delta", delta: "probe" },
      { type, response: { id: "resp_probe", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    : [
      { type: "response.created", response: { id: "resp_probe" } },
      { type, response: { id: "resp_probe" }, delta: "probe" },
      { type: "response.completed", response: { id: "resp_probe", usage: { input_tokens: 1, output_tokens: 1 } } },
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
  it("performs auth, model/quota reads, and each of the 55 inference POSTs exactly once", async () => {
    const accountId = "acct-never-log-this";
    let inferencePosts = 0;
    let continuationBody: Record<string, unknown> | undefined;
    let canaryHeaders: Record<string, string> | undefined;
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
      if (url === CODEX_MODELS_URL) return jsonResponse(200, { models: [{ slug: "gpt-probe" }] });
      if (url === CODEX_USAGE_URL) return jsonResponse(200, { plan_type: "plus", rate_limit: {} });
      if (url === CODEX_RESPONSES_URL) {
        inferencePosts += 1;
        const headers = init?.headers as Record<string, string>;
        const sequence = Number(headers.session_id.split("-").at(-1));
        if (sequence === 1) canaryHeaders = headers;
        if (sequence === 21) continuationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (sequence >= 4 && sequence <= 32 && sequence % 2 === 0) {
          return jsonResponse(400, { error: { code: "invalid_request" } });
        }
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
      env: { SUPERTWIN_APP_VERSION: "13.12.2" },
    });

    expect(inferencePosts).toBe(FULL_PROBE_INFERENCE_POST_BUDGET);
    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(evidence).toMatchObject({
      persistedCredentials: false,
      inferenceRetries: 0,
      plannedInferencePosts: FULL_PROBE_INFERENCE_POST_BUDGET,
      actualInferencePosts: FULL_PROBE_INFERENCE_POST_BUDGET,
      modelCatalogue: { ids: ["gpt-probe"] },
    });
    expect(evidence.cases[1]?.stream?.stoppedEarly).toBe(true);
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
      if (url === CODEX_MODELS_URL) return jsonResponse(200, { models: [{ slug: "gpt-probe" }] });
      if (url === CODEX_USAGE_URL) return jsonResponse(200, { plan_type: "plus" });
      if (url === CODEX_RESPONSES_URL) return sseResponse("response.created");
      throw new Error(`Unexpected mocked URL: ${url}`);
    });

    await expect(runContractProbeScaffold({
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      now: vi.fn(() => 0),
      onUserCode: vi.fn(),
      env: { SUPERTWIN_APP_VERSION: "13.12.2" },
    })).rejects.toThrow(/canary\.blank-context did not match/);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === CODEX_RESPONSES_URL)).toHaveLength(1);
  });
});
