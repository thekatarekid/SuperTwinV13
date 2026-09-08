import { afterAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addTestInferenceAuthorization,
  cleanupTestInferenceAuthorizations,
  testConsumedInferencePosts,
} from "./authorization-test-support.js";
import { executeContractProbeCase } from "./contract-runner.js";
import { buildContractProbeMatrix } from "./matrix.js";
import {
  AUTHORIZATION_ID_ENV,
  AUTHORIZATION_LEDGER_PATH_ENV,
  AUTHORIZATION_OWNER_ENV,
  AUTHORIZED_INFERENCE_POSTS_ENV,
  AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV,
  bindLiveInferenceAuthorizationPlan,
  prepareLiveInferenceAuthorization,
  reserveLiveInferencePosts,
} from "./live-authorization.js";
import { LIVE_CANARY_PROBE_ENV, LIVE_CONTRACT_PROBE_ENV } from "./safety.js";

afterAll(cleanupTestInferenceAuthorizations);

function baseEnv(mode: "canary" | "contract"): NodeJS.ProcessEnv {
  return {
    SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    [mode === "canary" ? LIVE_CANARY_PROBE_ENV : LIVE_CONTRACT_PROBE_ENV]: "1",
    SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: "7d41db9e5a28",
    SUPERTWIN_CHATGPT_PROBE_MODEL: "gpt-probe",
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: join(tmpdir(), `supertwin-live-authorization-${mode}-${Math.random()}`),
  };
}

describe("Phase 0b live cumulative authorization wiring", () => {
  it("requires every explicit ledger binding and an existing secure ledger before OAuth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const complete = await addTestInferenceAuthorization(baseEnv("canary"));
    for (const key of [
      AUTHORIZATION_LEDGER_PATH_ENV,
      AUTHORIZATION_ID_ENV,
      AUTHORIZATION_OWNER_ENV,
      AUTHORIZED_INFERENCE_POSTS_ENV,
      AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV,
    ]) {
      const candidate = { ...complete };
      delete candidate[key];
      await expect(prepareLiveInferenceAuthorization("canary", candidate)).rejects.toThrow(/REFUSED/);
    }
    await expect(prepareLiveInferenceAuthorization("canary", {
      ...complete,
      [AUTHORIZATION_LEDGER_PATH_ENV]: join(tmpdir(), "missing-phase0b-ledger.sqlite"),
    })).rejects.toThrow(/ledger is missing|ledger location is unavailable/);
    await expect(prepareLiveInferenceAuthorization("canary", {
      ...complete,
      [AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV]: "45",
    })).rejects.toThrow(/preflight binding/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses cumulative remaining capacity for conservative canary and full-run gates", async () => {
    const canaryEnv = await addTestInferenceAuthorization(baseEnv("canary"), undefined, {
      authorizedPosts: 3,
      consumedPosts: 2,
    });
    const prepared = await prepareLiveInferenceAuthorization("canary", canaryEnv);
    const catalogue = { models: [{ id: "gpt-probe", capabilities: {} }] };
    const bound = await bindLiveInferenceAuthorizationPlan(prepared, catalogue, "gpt-probe", canaryEnv);
    await reserveLiveInferencePosts(bound, 1);
    expect(testConsumedInferencePosts(canaryEnv)).toBe(3);
    await expect(prepareLiveInferenceAuthorization("canary", canaryEnv)).rejects.toThrow(/insufficient/);

    const contractEnv = await addTestInferenceAuthorization(baseEnv("contract"), undefined, {
      authorizedPosts: 55,
      consumedPosts: 2,
    });
    await expect(prepareLiveInferenceAuthorization("contract", contractEnv)).resolves.toMatchObject({
      ledger: { plannedInferencePosts: 44, authorizedPosts: 55, consumedPosts: 2 },
    });
    const currentPlanCatalogue = {
      models: [{ id: "gpt-probe", capabilities: { parallelToolCalls: true, structuredOutput: true } }],
    };
    const currentGrantEnv = await addTestInferenceAuthorization(baseEnv("contract"), currentPlanCatalogue, {
      authorizedPosts: 55,
      consumedPosts: 2,
    });
    const currentPrepared = await prepareLiveInferenceAuthorization("contract", currentGrantEnv);
    expect(currentPrepared).toMatchObject({
      ledger: { plannedInferencePosts: 46, authorizedPosts: 55, consumedPosts: 2 },
    });
    await expect(bindLiveInferenceAuthorizationPlan(
      currentPrepared,
      currentPlanCatalogue,
      "gpt-probe",
      currentGrantEnv,
    )).resolves.toMatchObject({ plan: { inferencePostCount: 46 } });
    const insufficientEnv = await addTestInferenceAuthorization(baseEnv("contract"), undefined, {
      authorizedPosts: 45,
      consumedPosts: 2,
    });
    await expect(prepareLiveInferenceAuthorization("contract", insufficientEnv)).rejects.toThrow(/insufficient/);
  });

  it("refuses capability-resolved matrix or app-transport drift before inference", async () => {
    const env = await addTestInferenceAuthorization(baseEnv("canary"));
    const prepared = await prepareLiveInferenceAuthorization("canary", env);
    await expect(bindLiveInferenceAuthorizationPlan(prepared, {
      models: [{ id: "gpt-probe", capabilities: { tools: true } }],
    }, "gpt-probe", env)).rejects.toThrow(/immutable grant/);
    await expect(bindLiveInferenceAuthorizationPlan(prepared, {
      models: [{ id: "gpt-probe", capabilities: {} }],
    }, "gpt-probe", { ...env, SUPERTWIN_APP_VERSION: "13.12.3" })).rejects.toThrow(/immutable grant/);
    expect(testConsumedInferencePosts(env)).toBe(0);

    const countDrift = await addTestInferenceAuthorization(baseEnv("canary"), undefined, {
      plannedInferencePosts: 43,
    });
    const countPrepared = await prepareLiveInferenceAuthorization("canary", countDrift);
    await expect(bindLiveInferenceAuthorizationPlan(countPrepared, {
      models: [{ id: "gpt-probe", capabilities: {} }],
    }, "gpt-probe", countDrift)).rejects.toThrow(/immutable grant/);
    expect(testConsumedInferencePosts(countDrift)).toBe(0);
  });

  it("charges nothing for SIGINT before reserve and keeps the permit after SIGINT following reserve", async () => {
    const probe = buildContractProbeMatrix("gpt-probe")[0]!;
    const before = new AbortController();
    before.abort(new Error("cancel before reserve"));
    const beforeReserve = vi.fn(async () => undefined);
    const beforeFetch = vi.fn<typeof fetch>();
    await expect(executeContractProbeCase(probe, {}, {
      fetch: beforeFetch,
      sleep: vi.fn(async () => undefined),
      now: () => 0,
      onUserCode: vi.fn(),
      signal: before.signal,
      reserveInferencePosts: beforeReserve,
    }, new Set())).rejects.toThrow(/cancel before reserve/);
    expect(beforeReserve).not.toHaveBeenCalled();
    expect(beforeFetch).not.toHaveBeenCalled();

    const after = new AbortController();
    let consumed = 0;
    const afterFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(consumed).toBe(1);
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("cancel after reserve");
    });
    await expect(executeContractProbeCase(probe, {}, {
      fetch: afterFetch,
      sleep: vi.fn(async () => undefined),
      now: () => 0,
      onUserCode: vi.fn(),
      signal: after.signal,
      reserveInferencePosts: async () => {
        consumed += 1;
        after.abort(new Error("cancel after reserve"));
      },
    }, new Set())).rejects.toThrow(/cancel after reserve/);
    expect(consumed).toBe(1);
    expect(afterFetch).toHaveBeenCalledOnce();
  });
});
