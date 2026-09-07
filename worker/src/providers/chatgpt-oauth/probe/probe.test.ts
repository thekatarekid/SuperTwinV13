import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  FULL_PROBE_INFERENCE_CALL_BUDGET,
  LIVE_AUTH_HTTP_REQUEST_BUDGET,
  LIVE_AUTH_INFERENCE_CALL_BUDGET,
} from "./constants.js";
import { runProbeCli } from "./cli.js";
import {
  exchangeAuthorizationCode,
  pollDeviceAuthorization,
  requestDeviceCode,
  type DeviceFlowHooks,
} from "./device-flow.js";
import { buildDryRunRequests, dryRunSnapshot } from "./requests.js";
import { redactedJson } from "./redact.js";
import { assertLiveProbeOptIn, formatLiveDeclaration } from "./safety.js";

afterEach(() => vi.restoreAllMocks());

const jsonResponse = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers });

function hooks(fetchImpl: typeof fetch): DeviceFlowHooks {
  return {
    fetch: fetchImpl,
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => 0),
    onUserCode: vi.fn(),
    env: { SUPERTWIN_APP_VERSION: "13.12.2" },
  };
}

describe("Phase 0b offline safety", () => {
  it("produces redacted request fixtures without calling fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const snapshot = dryRunSnapshot({ SUPERTWIN_APP_VERSION: "13.12.2" });
    const output = redactedJson(snapshot);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(output).toContain('"networkCalls": 0');
    expect(output).toContain('"User-Agent": "SuperTwinV13/13.12.2"');
    expect(output).toContain('"originator": "supertwinv13"');
    expect(output).toContain('"Authorization": "<redacted>"');
    expect(output).not.toContain("probe-access-token");
    expect(output).not.toContain("probe-account-id");
    expect(output).not.toContain("probe-code-verifier");
  });

  it("pins the Hermes endpoints, public client ID, and empty-context wire body", () => {
    const requests = buildDryRunRequests({ SUPERTWIN_APP_VERSION: "13.12.2" });
    expect(requests.find((request) => request.name === "device-code")).toMatchObject({
      url: CODEX_DEVICE_CODE_URL,
      body: { client_id: CODEX_OAUTH_CLIENT_ID },
    });
    expect(requests.find((request) => request.name === "device-poll")?.url).toBe(CODEX_DEVICE_TOKEN_URL);
    expect(requests.find((request) => request.name === "models")?.url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    );
    expect(CODEX_MODELS_URL).toContain("?client_version=1.0.0");
    expect(requests.find((request) => request.name === "token-exchange")).toMatchObject({
      url: CODEX_OAUTH_TOKEN_URL,
      body: { redirect_uri: CODEX_DEVICE_REDIRECT_URI },
    });
    expect(requests.find((request) => request.name === "blank-context-canary")?.body).toMatchObject({
      instructions: "",
      max_output_tokens: 16,
      store: false,
      stream: true,
    });
  });

  it("refuses live work without opt-in, concrete version, and a temp scratch home", () => {
    const base = { SUPERTWIN_APP_VERSION: "13.12.2" };
    expect(() => assertLiveProbeOptIn(base)).toThrow(/requires SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE=1/);
    expect(() => assertLiveProbeOptIn({ ...base, SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1" })).toThrow(
      /SUPERTWIN_HOME/,
    );
    expect(() =>
      assertLiveProbeOptIn({
        ...base,
        SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
        SUPERTWIN_HOME: join(homedir(), "SuperTwinV13"),
      }),
    ).toThrow(/production home/);
    expect(
      assertLiveProbeOptIn({
        ...base,
        SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
        SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-test"),
      }),
    ).toBe(join(tmpdir(), "supertwin-phase0b-test"));
  });

  it("separates the zero-inference live-auth budget from the planned 70-call full probe", () => {
    expect(LIVE_AUTH_INFERENCE_CALL_BUDGET).toBe(0);
    expect(LIVE_AUTH_HTTP_REQUEST_BUDGET).toBe(305);
    expect(FULL_PROBE_INFERENCE_CALL_BUDGET).toBe(70);
    expect(formatLiveDeclaration()).toContain("MAX_LIVE_AUTH_INFERENCE_POSTS=0");
    expect(formatLiveDeclaration()).toContain("MAX_LIVE_AUTH_HTTP_REQUESTS=305");
    expect(formatLiveDeclaration()).toContain("PLANNED_FULL_PHASE_0B_INFERENCE_POSTS=70");
    expect(formatLiveDeclaration()).toContain("INFERENCE_RETRIES=0");
  });

  it("prints the declaration, refuses missing opt-in, and never fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runProbeCli(["--live-auth"], {
        SUPERTWIN_APP_VERSION: "13.12.2",
        SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-refusal"),
      }),
    ).rejects.toThrow(/requires SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE=1/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("MAX_LIVE_AUTH_INFERENCE_POSTS=0");
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("PLANNED_FULL_PHASE_0B_INFERENCE_POSTS=70");
  });
});

describe("Hermes-compatible device-code protocol (mocked HTTP only)", () => {
  it("requests a device code and clamps polling to at least three seconds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret", interval: 1 }),
    );
    const h = hooks(fetchMock);
    const result = await requestDeviceCode(h);

    expect(result).toMatchObject({ userCode: "ABCD-EFGH", intervalSeconds: 3 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CODEX_DEVICE_CODE_URL);
    expect(h.onUserCode).toHaveBeenCalledOnce();
  });

  it("matches Hermes's bounded 2s/4s/8s device-code backoff", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(
        jsonResponse(200, { user_code: "ABCD-EFGH", device_auth_id: "device-secret" }),
      );
    const h = hooks(fetchMock);
    await requestDeviceCode(h);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(h.sleep).toHaveBeenNthCalledWith(1, 2_000);
    expect(h.sleep).toHaveBeenNthCalledWith(2, 4_000);
    expect(h.sleep).toHaveBeenNthCalledWith(3, 8_000);
  });

  it("treats 403/404 as pending and stops at the first authorized response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(403, {}))
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_code: "auth-secret", code_verifier: "verifier-secret" }));
    const h = hooks(fetchMock);
    let now = 0;
    h.now = () => now++ * 3_000;

    const result = await pollDeviceAuthorization(
      { userCode: "ABCD", deviceAuthId: "device-secret", intervalSeconds: 3, verificationUrl: "https://example.test" },
      h,
    );
    expect(result).toEqual({ authorization_code: "auth-secret", code_verifier: "verifier-secret" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("exchanges the server-returned code and verifier without logging or persisting them", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { access_token: "access-secret", refresh_token: "refresh-secret" }),
    );
    const result = await exchangeAuthorizationCode(
      { authorization_code: "auth-secret", code_verifier: "verifier-secret" },
      hooks(fetchMock),
    );
    expect(result).toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain("code_verifier=verifier-secret");
    expect(redactedJson(result)).not.toContain("access-secret");
    expect(redactedJson(result)).not.toContain("refresh-secret");
  });
});
