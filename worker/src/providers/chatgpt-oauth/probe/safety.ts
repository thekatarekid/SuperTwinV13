import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import {
  FULL_PROBE_INFERENCE_CALL_BUDGET,
  LIVE_AUTH_HTTP_REQUEST_BUDGET,
  LIVE_AUTH_INFERENCE_CALL_BUDGET,
  LIVE_PROBE_ENV,
} from "./constants.js";

export interface LiveProbeDeclaration {
  liveAuthInferencePostBudget: number;
  liveAuthHttpRequestBudget: number;
  plannedFullProbeInferencePostBudget: number;
  retryPolicy: "none";
}

export const LIVE_PROBE_DECLARATION: LiveProbeDeclaration = {
  liveAuthInferencePostBudget: LIVE_AUTH_INFERENCE_CALL_BUDGET,
  liveAuthHttpRequestBudget: LIVE_AUTH_HTTP_REQUEST_BUDGET,
  plannedFullProbeInferencePostBudget: FULL_PROBE_INFERENCE_CALL_BUDGET,
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

export function formatLiveDeclaration(): string {
  return [
    "PHASE_0B_LIVE_AUTH_DECLARATION",
    `MAX_LIVE_AUTH_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.liveAuthInferencePostBudget}`,
    `MAX_LIVE_AUTH_HTTP_REQUESTS=${LIVE_PROBE_DECLARATION.liveAuthHttpRequestBudget}`,
    `PLANNED_FULL_PHASE_0B_INFERENCE_POSTS=${LIVE_PROBE_DECLARATION.plannedFullProbeInferencePostBudget}`,
    "OAUTH_HTTP_BREAKDOWN=4 device-code requests + at most 300 polls + 1 token exchange",
    "INFERENCE_RETRIES=0",
    "STOP_ON_RATE_LIMIT_CAPTCHA_OR_ACCOUNT_FLAG=1",
  ].join("\n");
}
