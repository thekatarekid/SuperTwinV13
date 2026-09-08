import {
  FULL_PROBE_CASE_BUDGET,
  FULL_PROBE_INFERENCE_POST_BUDGET,
  LIVE_AUTH_HTTP_REQUEST_BUDGET,
  LIVE_AUTH_INFERENCE_CALL_BUDGET,
  LIVE_PROBE_ENV,
} from "./constants.js";
import {
  assertExpectedProbeAccount,
  expectedProbeAccountFingerprint,
  type DedicatedProbeAccount,
} from "./account.js";
import {
  LIVE_CONTRACT_HTTP_REQUEST_BUDGET,
  LIVE_CANARY_HTTP_REQUEST_BUDGET,
  LIVE_DISCOVERY_HTTP_REQUEST_BUDGET,
} from "./accounting.js";
import { requestedProbeModelId } from "./models.js";
import { assertEmptyScratchHome } from "./scratch.js";

export const LIVE_CONTRACT_PROBE_ENV = "SUPERTWIN_RUN_LIVE_CHATGPT_CONTRACT_PROBE";
export const LIVE_DISCOVERY_PROBE_ENV = "SUPERTWIN_RUN_LIVE_CHATGPT_DISCOVERY_PROBE";
export const LIVE_CANARY_PROBE_ENV = "SUPERTWIN_RUN_LIVE_CHATGPT_CANARY_PROBE";

export interface LiveProbeDeclaration {
  liveAuthInferencePostBudget: number;
  liveAuthHttpRequestBudget: number;
  liveDiscoveryInferencePostBudget: 0;
  liveDiscoveryHttpRequestBudget: number;
  liveCanaryInferencePostBudget: 1;
  liveCanaryHttpRequestBudget: number;
  plannedFullProbeInferencePostBudget: number;
  plannedFullProbeCaseBudget: number;
  retryPolicy: "none";
}

export const LIVE_PROBE_DECLARATION: LiveProbeDeclaration = {
  liveAuthInferencePostBudget: LIVE_AUTH_INFERENCE_CALL_BUDGET,
  liveAuthHttpRequestBudget: LIVE_AUTH_HTTP_REQUEST_BUDGET,
  liveDiscoveryInferencePostBudget: 0,
  liveDiscoveryHttpRequestBudget: LIVE_DISCOVERY_HTTP_REQUEST_BUDGET,
  liveCanaryInferencePostBudget: 1,
  liveCanaryHttpRequestBudget: LIVE_CANARY_HTTP_REQUEST_BUDGET,
  plannedFullProbeInferencePostBudget: FULL_PROBE_INFERENCE_POST_BUDGET,
  plannedFullProbeCaseBudget: FULL_PROBE_CASE_BUDGET,
  retryPolicy: "none",
};

export function assertScratchProbeHome(env: NodeJS.ProcessEnv = process.env): string {
  return assertEmptyScratchHome(env);
}

export function assertLiveProbeOptIn(env: NodeJS.ProcessEnv = process.env): string {
  if (env[LIVE_PROBE_ENV] !== "1") {
    throw new Error(`REFUSED: live OAuth/network access requires ${LIVE_PROBE_ENV}=1`);
  }
  const version = env.SUPERTWIN_APP_VERSION?.trim() || env.npm_package_version?.trim();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("REFUSED: live probing requires a concrete semver SUPERTWIN_APP_VERSION");
  }
  return assertScratchProbeHome(env);
}

/** A second opt-in is required for the 70-case contract ladder. */
export function assertLiveContractProbeOptIn(env: NodeJS.ProcessEnv = process.env): string {
  const scratchHome = assertLiveProbeOptIn(env);
  if (env[LIVE_CONTRACT_PROBE_ENV] !== "1") {
    throw new Error(`REFUSED: live contract probing requires ${LIVE_CONTRACT_PROBE_ENV}=1`);
  }
  return scratchHome;
}

/** Every value knowable before OAuth must pass before the first network request. */
export function assertLiveContractProbePreflight(env: NodeJS.ProcessEnv = process.env): string {
  const scratchHome = assertLiveContractProbeOptIn(env);
  expectedProbeAccountFingerprint(env);
  requestedProbeModelId(env);
  return scratchHome;
}

/** Discovery has its own opt-in and account binding, but never requires or selects a model. */
export function assertLiveDiscoveryProbePreflight(env: NodeJS.ProcessEnv = process.env): string {
  const scratchHome = assertLiveProbeOptIn(env);
  if (env[LIVE_DISCOVERY_PROBE_ENV] !== "1") {
    throw new Error(`REFUSED: live discovery requires ${LIVE_DISCOVERY_PROBE_ENV}=1`);
  }
  expectedProbeAccountFingerprint(env);
  return scratchHome;
}

export function assertLiveDiscoveryProbeAccount(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): DedicatedProbeAccount {
  assertLiveDiscoveryProbePreflight(env);
  return assertExpectedProbeAccount(accessToken, env);
}

export function assertLiveCanaryProbePreflight(env: NodeJS.ProcessEnv = process.env): string {
  const scratchHome = assertLiveProbeOptIn(env);
  if (env[LIVE_CANARY_PROBE_ENV] !== "1") {
    throw new Error(`REFUSED: live canary probing requires ${LIVE_CANARY_PROBE_ENV}=1`);
  }
  expectedProbeAccountFingerprint(env);
  requestedProbeModelId(env);
  return scratchHome;
}

export function assertLiveCanaryProbeAccount(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): DedicatedProbeAccount {
  assertLiveCanaryProbePreflight(env);
  return assertExpectedProbeAccount(accessToken, env);
}

/** Run after OAuth exchange and before model, quota, or inference requests. */
export function assertLiveContractProbeAccount(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): DedicatedProbeAccount {
  assertLiveContractProbePreflight(env);
  return assertExpectedProbeAccount(accessToken, env);
}

export function formatLiveDeclaration(mode: "auth" | "discover" | "canary" | "contract" = "auth"): string {
  const inferencePosts =
    mode === "contract"
      ? LIVE_PROBE_DECLARATION.plannedFullProbeInferencePostBudget
      : mode === "canary"
        ? LIVE_PROBE_DECLARATION.liveCanaryInferencePostBudget
        : LIVE_PROBE_DECLARATION.liveAuthInferencePostBudget;
  return [
    mode === "contract"
      ? "PHASE_0B_LIVE_CONTRACT_DECLARATION"
      : mode === "canary"
        ? "PHASE_0B_LIVE_CANARY_DECLARATION"
      : mode === "discover"
        ? "PHASE_0B_LIVE_DISCOVERY_DECLARATION"
        : "PHASE_0B_LIVE_AUTH_DECLARATION",
    `MAX_SELECTED_MODE_INFERENCE_POSTS=${inferencePosts}`,
    `MAX_LIVE_AUTH_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.liveAuthInferencePostBudget}`,
    `MAX_LIVE_AUTH_HTTP_REQUESTS=${LIVE_PROBE_DECLARATION.liveAuthHttpRequestBudget}`,
    `MAX_LIVE_DISCOVERY_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.liveDiscoveryInferencePostBudget}`,
    `MAX_LIVE_DISCOVERY_HTTP_REQUESTS=${LIVE_PROBE_DECLARATION.liveDiscoveryHttpRequestBudget}`,
    `MAX_LIVE_CANARY_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.liveCanaryInferencePostBudget}`,
    `MAX_LIVE_CANARY_HTTP_REQUESTS=${LIVE_PROBE_DECLARATION.liveCanaryHttpRequestBudget}`,
    `PLANNED_FULL_PHASE_0B_CASES=${LIVE_PROBE_DECLARATION.plannedFullProbeCaseBudget}`,
    `PLANNED_FULL_PHASE_0B_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.plannedFullProbeInferencePostBudget}`,
    `MAX_LIVE_CONTRACT_HTTP_REQUESTS=${LIVE_CONTRACT_HTTP_REQUEST_BUDGET}`,
    mode === "contract" || mode === "canary"
      ? "CUMULATIVE_AUTHORIZATION=existing external SQLite ledger required"
      : "CUMULATIVE_AUTHORIZATION=not-applicable-no-inference",
    ...(mode === "contract" || mode === "canary" ? [
      "AUTHORIZATION_ENV=SUPERTWIN_CHATGPT_AUTHORIZATION_LEDGER_PATH + SUPERTWIN_CHATGPT_AUTHORIZATION_ID + SUPERTWIN_CHATGPT_AUTHORIZATION_OWNER + SUPERTWIN_CHATGPT_AUTHORIZED_INFERENCE_POSTS",
      mode === "contract"
        ? `PREFLIGHT_REMAINING_INFERENCE_POSTS=${FULL_PROBE_INFERENCE_POST_BUDGET} fresh; ${FULL_PROBE_INFERENCE_POST_BUDGET - 1} only with an exact matched canary checkpoint`
        : "PREFLIGHT_REMAINING_INFERENCE_POSTS=1",
      "RESERVATION_POLICY=durable-before-fetch-no-refunds; ladder-stage-batch-before-peers",
    ] : []),
    "PREFLIGHT_REJECTIONS=15",
    mode === "contract" || mode === "canary"
      ? "OAUTH_HTTP_BREAKDOWN=1 device-code request + at most 300 polls + 1 token exchange + 1 refresh"
      : "OAUTH_HTTP_BREAKDOWN=1 device-code request + at most 300 polls + 1 token exchange",
    "INFERENCE_RETRIES=0",
    "STOP_ON_RATE_LIMIT_CAPTCHA_OR_ACCOUNT_FLAG=1",
  ].join("\n");
}
