import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

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
import { LIVE_CONTRACT_HTTP_REQUEST_BUDGET } from "./accounting.js";
import { requestedProbeModelId } from "./models.js";

export const LIVE_CONTRACT_PROBE_ENV = "SUPERTWIN_RUN_LIVE_CHATGPT_CONTRACT_PROBE";

export interface LiveProbeDeclaration {
  liveAuthInferencePostBudget: number;
  liveAuthHttpRequestBudget: number;
  plannedFullProbeInferencePostBudget: number;
  plannedFullProbeCaseBudget: number;
  retryPolicy: "none";
}

export const LIVE_PROBE_DECLARATION: LiveProbeDeclaration = {
  liveAuthInferencePostBudget: LIVE_AUTH_INFERENCE_CALL_BUDGET,
  liveAuthHttpRequestBudget: LIVE_AUTH_HTTP_REQUEST_BUDGET,
  plannedFullProbeInferencePostBudget: FULL_PROBE_INFERENCE_POST_BUDGET,
  plannedFullProbeCaseBudget: FULL_PROBE_CASE_BUDGET,
  retryPolicy: "none",
};

export function assertScratchProbeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SUPERTWIN_HOME?.trim();
  if (!configured) throw new Error("REFUSED: SUPERTWIN_HOME must name an explicit scratch directory");

  const home = resolve(configured);
  const production = resolve(homedir(), "SuperTwinV13");
  if (home === production) throw new Error("REFUSED: the Phase 0b probe cannot use the production home");

  const temporaryRoot = resolve(tmpdir());
  const fromTemp = relative(temporaryRoot, home);
  if (!fromTemp || fromTemp.startsWith("..") || isAbsolute(fromTemp)) {
    throw new Error(`REFUSED: probe home must be a child of the system temporary directory (${temporaryRoot})`);
  }
  return home;
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

/** Run after OAuth exchange and before model, quota, or inference requests. */
export function assertLiveContractProbeAccount(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): DedicatedProbeAccount {
  assertLiveContractProbePreflight(env);
  return assertExpectedProbeAccount(accessToken, env);
}

export function formatLiveDeclaration(mode: "auth" | "contract" = "auth"): string {
  const inferencePosts =
    mode === "contract"
      ? LIVE_PROBE_DECLARATION.plannedFullProbeInferencePostBudget
      : LIVE_PROBE_DECLARATION.liveAuthInferencePostBudget;
  return [
    mode === "contract" ? "PHASE_0B_LIVE_CONTRACT_DECLARATION" : "PHASE_0B_LIVE_AUTH_DECLARATION",
    `MAX_SELECTED_MODE_INFERENCE_POSTS=${inferencePosts}`,
    `MAX_LIVE_AUTH_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.liveAuthInferencePostBudget}`,
    `MAX_LIVE_AUTH_HTTP_REQUESTS=${LIVE_PROBE_DECLARATION.liveAuthHttpRequestBudget}`,
    `PLANNED_FULL_PHASE_0B_CASES=${LIVE_PROBE_DECLARATION.plannedFullProbeCaseBudget}`,
    `PLANNED_FULL_PHASE_0B_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.plannedFullProbeInferencePostBudget}`,
    `MAX_LIVE_CONTRACT_HTTP_REQUESTS=${LIVE_CONTRACT_HTTP_REQUEST_BUDGET}`,
    "PREFLIGHT_REJECTIONS=15",
    mode === "contract"
      ? "OAUTH_HTTP_BREAKDOWN=1 device-code request + at most 300 polls + 1 token exchange + 1 refresh"
      : "OAUTH_HTTP_BREAKDOWN=1 device-code request + at most 300 polls + 1 token exchange",
    "INFERENCE_RETRIES=0",
    "STOP_ON_RATE_LIMIT_CAPTCHA_OR_ACCOUNT_FLAG=1",
  ].join("\n");
}
