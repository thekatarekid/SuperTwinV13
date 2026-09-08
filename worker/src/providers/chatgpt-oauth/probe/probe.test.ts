import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountFingerprint,
  EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV,
} from "./account.js";

import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  FULL_PROBE_CASE_BUDGET,
  FULL_PROBE_INFERENCE_POST_BUDGET,
  LIVE_AUTH_HTTP_REQUEST_BUDGET,
  LIVE_AUTH_INFERENCE_CALL_BUDGET,
} from "./constants.js";
import { runProbeCli } from "./cli.js";
import { runContractProbeScaffold } from "./contract-runner.js";
import {
  formatHttpAccounting,
  LIVE_AUTH_HTTP_LIMITS,
  LIVE_CONTRACT_HTTP_LIMITS,
  LIVE_CONTRACT_HTTP_REQUEST_BUDGET,
  ProbeHttpAccounting,
} from "./accounting.js";
import {
  exchangeAuthorizationCode,
  pollDeviceAuthorization,
  requestDeviceCode,
  type DeviceFlowHooks,
} from "./device-flow.js";
import { buildDryRunRequests, dryRunSnapshot } from "./requests.js";
import { redactedJson } from "./redact.js";
import { REQUESTED_PROBE_MODEL_ENV } from "./models.js";
import {
  assertLiveContractProbeAccount,
  assertLiveContractProbeOptIn,
  assertLiveContractProbePreflight,
  assertLiveProbeOptIn,
  formatLiveDeclaration,
  LIVE_CONTRACT_PROBE_ENV,
} from "./safety.js";

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

function accountJwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
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

  it("requires a separate live-contract opt-in without fetching", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-contract-opt-in"),
    };
    expect(() => assertLiveContractProbeOptIn(env)).toThrow(
      /SUPERTWIN_RUN_LIVE_CHATGPT_CONTRACT_PROBE=1/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing or mismatched dedicated-account fingerprint without fetching", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const accountId = "acct-dedicated-phase0b";
    const env = {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      [REQUESTED_PROBE_MODEL_ENV]: "gpt-probe",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-account-gate"),
    };
    expect(() => assertLiveContractProbeAccount(accountJwt(accountId), env)).toThrow(
      new RegExp(EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV),
    );
    expect(() => assertLiveContractProbeAccount(accountJwt(accountId), {
      ...env,
      [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: "000000000000",
    })).toThrow(/not the dedicated Phase 0b test account/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts only the predeclared 12-hex fingerprint of the decoded JWT account", () => {
    const accountId = "acct-dedicated-phase0b";
    const result = assertLiveContractProbeAccount(accountJwt(accountId), {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: accountFingerprint(accountId),
      [REQUESTED_PROBE_MODEL_ENV]: "gpt-probe",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-account-match"),
    });
    expect(result).toEqual({ accountId, fingerprint: accountFingerprint(accountId) });
  });

  it("separates live-auth from the 70-case, 55-POST full probe", () => {
    expect(LIVE_AUTH_INFERENCE_CALL_BUDGET).toBe(0);
    expect(LIVE_AUTH_HTTP_REQUEST_BUDGET).toBe(302);
    expect(FULL_PROBE_CASE_BUDGET).toBe(70);
    expect(FULL_PROBE_INFERENCE_POST_BUDGET).toBe(55);
    expect(LIVE_CONTRACT_HTTP_REQUEST_BUDGET).toBe(361);
    expect(formatLiveDeclaration()).toContain("MAX_LIVE_AUTH_INFERENCE_POSTS=0");
    expect(formatLiveDeclaration()).toContain("MAX_LIVE_AUTH_HTTP_REQUESTS=302");
    expect(formatLiveDeclaration()).toContain("PLANNED_FULL_PHASE_0B_CASES=70");
    expect(formatLiveDeclaration()).toContain("PLANNED_FULL_PHASE_0B_INFERENCE_POSTS=55");
    expect(formatLiveDeclaration()).toContain("MAX_LIVE_CONTRACT_HTTP_REQUESTS=361");
    expect(formatLiveDeclaration()).toContain("INFERENCE_RETRIES=0");
    expect(formatLiveDeclaration("contract")).toContain("1 token exchange + 1 refresh");
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
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("PLANNED_FULL_PHASE_0B_CASES=70");
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("PLANNED_FULL_PHASE_0B_INFERENCE_POSTS=55");
  });

  it("requires the additional live-contract flag pairing before any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runProbeCli(["--live-contract"], {})).rejects.toThrow(
      /--live-contract additionally requires --live-auth/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("MAX_SELECTED_MODE_INFERENCE_POSTS=55");
  });

  it("refuses contract execution before fetch unless both opt-ins, fingerprint, and model are present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const contractRunner = vi.fn<typeof runContractProbeScaffold>();
    const base = {
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-cli-contract-gates"),
    };

    await expect(runProbeCli(["--live-auth", "--live-contract"], base, {
      runContractProbe: contractRunner,
    })).rejects.toThrow(/live OAuth\/network access requires/);
    await expect(runProbeCli(["--live-auth", "--live-contract"], {
      ...base,
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    }, { runContractProbe: contractRunner })).rejects.toThrow(new RegExp(LIVE_CONTRACT_PROBE_ENV));
    await expect(runProbeCli(["--live-auth", "--live-contract"], {
      ...base,
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
    }, { runContractProbe: contractRunner })).rejects.toThrow(
      new RegExp(EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV),
    );
    await expect(runProbeCli(["--live-auth", "--live-contract"], {
      ...base,
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: "not-12-hex",
    }, { runContractProbe: contractRunner })).rejects.toThrow(
      new RegExp(EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV),
    );
    const validAccountEnv = {
      ...base,
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: "7d41db9e5a28",
    };
    await expect(runProbeCli(["--live-auth", "--live-contract"], validAccountEnv, {
      runContractProbe: contractRunner,
    })).rejects.toThrow(new RegExp(REQUESTED_PROBE_MODEL_ENV));
    await expect(runProbeCli(["--live-auth", "--live-contract"], {
      ...validAccountEnv,
      [REQUESTED_PROBE_MODEL_ENV]: "bad model/with whitespace",
    }, { runContractProbe: contractRunner })).rejects.toThrow(new RegExp(REQUESTED_PROBE_MODEL_ENV));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(contractRunner).not.toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("PHASE_0B_LIVE_CONTRACT_DECLARATION");
  });

  it("delegates an explicitly gated contract run once and prints redacted evidence plus exact actuals", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const actuals = {
      deviceCode: 1,
      devicePoll: 7,
      token: 2,
      models: 1,
      quota: 2,
      inference: 55,
      other: 0,
      total: 68,
    };
    const contractRunner = vi.fn<typeof runContractProbeScaffold>(async (contractHooks) => {
      contractHooks.onFinalized?.({
        httpActuals: actuals,
        logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
        aborted: true,
      });
      return {
        mode: "contract-scaffold",
        accountFingerprint: "7d41db9e5a28",
        accessToken: "must-not-print",
      } as unknown as Awaited<ReturnType<typeof runContractProbeScaffold>>;
    });
    const env = {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: "7d41db9e5a28",
      [REQUESTED_PROBE_MODEL_ENV]: "gpt-probe",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-cli-contract-run"),
    };

    expect(assertLiveContractProbePreflight(env)).toBe(env.SUPERTWIN_HOME);
    await expect(runProbeCli(["--live-auth", "--live-contract"], env, {
      runContractProbe: contractRunner,
    })).resolves.toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(contractRunner).toHaveBeenCalledOnce();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("PHASE_0B_LIVE_CONTRACT_DECLARATION");
    expect(stderrSpy.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      `PHASE_0B_HTTP_ACTUALS=${JSON.stringify(actuals)}`,
    );
    const output = stdoutSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('"accountFingerprint": "7d41db9e5a28"');
    expect(output).not.toContain("must-not-print");
  });

  it("prints finalized nonzero HTTP actuals exactly once on contract failure without stdout", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const secret = "must-not-print-failed-token";
    const actuals = {
      deviceCode: 1, devicePoll: 3, token: 1, models: 0,
      quota: 0, inference: 0, other: 0, total: 5,
    };
    const contractRunner = vi.fn<typeof runContractProbeScaffold>(async (hooks) => {
      hooks.onFinalized?.({
        httpActuals: actuals,
        logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
        aborted: true,
      });
      void secret;
      throw new Error("forced mocked contract failure");
    });
    const env = {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: "7d41db9e5a28",
      [REQUESTED_PROBE_MODEL_ENV]: "gpt-probe",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-cli-contract-failure"),
    };

    await expect(runProbeCli(["--live-auth", "--live-contract"], env, {
      runContractProbe: contractRunner,
    })).rejects.toThrow(/forced mocked contract failure/);

    const stderr = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(stderr.match(/PHASE_0B_HTTP_ACTUALS=/g)).toHaveLength(1);
    expect(stderr).toContain(`PHASE_0B_HTTP_ACTUALS=${JSON.stringify(actuals)}`);
    expect(stderr).not.toContain(secret);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("aborts the passed contract signal on SIGINT, removes its listener, and prints final actuals once", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const listenersBefore = process.listeners("SIGINT");
    const actuals = {
      deviceCode: 1, devicePoll: 2, token: 0, models: 0,
      quota: 0, inference: 0, other: 0, total: 3,
    };
    const contractRunner = vi.fn<typeof runContractProbeScaffold>(async (hooks) => {
      expect(hooks.signal?.aborted).toBe(false);
      const prior = new Set(listenersBefore);
      const added = process.listeners("SIGINT").filter((listener) => !prior.has(listener));
      expect(added).toHaveLength(1);
      added[0]!("SIGINT");
      expect(hooks.signal?.aborted).toBe(true);
      hooks.onFinalized?.({
        httpActuals: actuals,
        logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
        aborted: true,
      });
      throw hooks.signal?.reason ?? new Error("expected SIGINT abort");
    });
    const env = {
      SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: "7d41db9e5a28",
      [REQUESTED_PROBE_MODEL_ENV]: "gpt-probe",
      SUPERTWIN_APP_VERSION: "13.12.2",
      SUPERTWIN_HOME: join(tmpdir(), "supertwin-phase0b-cli-contract-sigint"),
    };

    await expect(runProbeCli(["--live-auth", "--live-contract"], env, {
      runContractProbe: contractRunner,
    })).rejects.toThrow(/cancelled by SIGINT/);

    expect(process.listeners("SIGINT")).toEqual(listenersBefore);
    const stderr = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(stderr.match(/PHASE_0B_HTTP_ACTUALS=/g)).toHaveLength(1);
    expect(stderr).toContain(`PHASE_0B_HTTP_ACTUALS=${JSON.stringify(actuals)}`);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("records exact per-endpoint HTTP attempts without retaining request data", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, {}));
    const accounting = new ProbeHttpAccounting({
      ...LIVE_AUTH_HTTP_LIMITS,
      models: 1,
    });
    const countedFetch = accounting.wrap(fetchMock);

    await countedFetch(CODEX_DEVICE_CODE_URL);
    await countedFetch(CODEX_DEVICE_TOKEN_URL);
    await countedFetch(CODEX_MODELS_URL);

    expect(accounting.snapshot()).toEqual({
      deviceCode: 1,
      devicePoll: 1,
      token: 0,
      models: 1,
      quota: 0,
      inference: 0,
      other: 0,
      total: 3,
    });
    expect(formatHttpAccounting(accounting.snapshot())).toContain('"total":3');
    expect(JSON.stringify(accounting.snapshot())).not.toContain("ABCD-EFGH");
    await expect(countedFetch("https://example.test/undeclared")).rejects.toThrow(
      /HTTP budget exhausted for other/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("hard-limits the complete contract endpoint budget", () => {
    expect(LIVE_CONTRACT_HTTP_LIMITS).toEqual({
      deviceCode: 1,
      devicePoll: 300,
      token: 2,
      models: 1,
      quota: 2,
      inference: 55,
      other: 0,
    });
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

  it("stops on the first device-code rate limit without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(429, {}));
    const h = hooks(fetchMock);
    await expect(requestDeviceCode(h)).rejects.toThrow(/rate-limited/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(h.sleep).not.toHaveBeenCalled();
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
