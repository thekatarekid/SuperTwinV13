import { isAbsolute } from "node:path";

import { expectedProbeAccountFingerprint } from "./account.js";
import {
  readInferenceAuthorizationBinding,
  readInferenceAuthorizationLedger,
  reserveInferencePosts,
  type AuthorizationLedgerLocation,
  type InferenceAuthorizationLedger,
} from "./authorization-ledger.js";
import {
  buildPhase0bAuthorizationPlan,
  type Phase0bAuthorizationPlan,
} from "./authorization-plan.js";
import { FULL_PROBE_INFERENCE_POST_BUDGET } from "./constants.js";
import { requestedProbeModelId } from "./models.js";
import type { ProbeModelCatalogue } from "./models.js";
import {
  assertLiveCanaryProbePreflight,
  assertLiveContractProbePreflight,
} from "./safety.js";

export const AUTHORIZATION_LEDGER_PATH_ENV = "SUPERTWIN_CHATGPT_AUTHORIZATION_LEDGER_PATH";
export const AUTHORIZATION_ID_ENV = "SUPERTWIN_CHATGPT_AUTHORIZATION_ID";
export const AUTHORIZATION_OWNER_ENV = "SUPERTWIN_CHATGPT_AUTHORIZATION_OWNER";
export const AUTHORIZED_INFERENCE_POSTS_ENV = "SUPERTWIN_CHATGPT_AUTHORIZED_INFERENCE_POSTS";

export type LiveInferenceAuthorizationMode = "canary" | "contract";

export interface LiveInferenceAuthorization {
  mode: LiveInferenceAuthorizationMode;
  location: AuthorizationLedgerLocation;
  ledger: InferenceAuthorizationLedger;
}

export interface BoundLiveInferenceAuthorization extends LiveInferenceAuthorization {
  plan: Phase0bAuthorizationPlan;
}

function authorizationId(env: NodeJS.ProcessEnv): string {
  const value = env[AUTHORIZATION_ID_ENV]?.trim();
  if (!value) throw new Error(`REFUSED: live inference requires explicit ${AUTHORIZATION_ID_ENV}`);
  return value;
}

function authorizationOwner(env: NodeJS.ProcessEnv): string {
  const value = env[AUTHORIZATION_OWNER_ENV]?.trim();
  if (!value) throw new Error(`REFUSED: live inference requires explicit ${AUTHORIZATION_OWNER_ENV}`);
  return value;
}

function authorizedPosts(env: NodeJS.ProcessEnv): number {
  const value = env[AUTHORIZED_INFERENCE_POSTS_ENV]?.trim();
  if (!value || !/^[1-9][0-9]{0,6}$/.test(value)) {
    throw new Error(`REFUSED: ${AUTHORIZED_INFERENCE_POSTS_ENV} must be an explicit positive integer cap`);
  }
  return Number(value);
}

function authorizationLocation(env: NodeJS.ProcessEnv, superTwinHome: string): AuthorizationLedgerLocation {
  const ledgerPath = env[AUTHORIZATION_LEDGER_PATH_ENV]?.trim();
  if (!ledgerPath || !isAbsolute(ledgerPath)) {
    throw new Error(`REFUSED: ${AUTHORIZATION_LEDGER_PATH_ENV} must be an explicit absolute path to an existing ledger`);
  }
  return { ledgerPath, superTwinHome };
}

/** Reads an existing ledger and enforces the conservative run ceiling before OAuth. */
export async function prepareLiveInferenceAuthorization(
  mode: LiveInferenceAuthorizationMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveInferenceAuthorization> {
  const superTwinHome = mode === "canary"
    ? assertLiveCanaryProbePreflight(env)
    : assertLiveContractProbePreflight(env);
  const location = authorizationLocation(env, superTwinHome);
  const ledger = await readInferenceAuthorizationBinding(location, {
    authorizationId: authorizationId(env),
    owner: authorizationOwner(env),
    accountFingerprint: expectedProbeAccountFingerprint(env),
    modelId: requestedProbeModelId(env),
    authorizedPosts: authorizedPosts(env),
  });
  const intendedPosts = mode === "canary" ? 1 : FULL_PROBE_INFERENCE_POST_BUDGET;
  if (ledger.authorizedPosts - ledger.consumedPosts < intendedPosts) {
    throw new Error(`REFUSED: cumulative inference authorization is insufficient for ${mode}`);
  }
  return Object.freeze({ mode, location, ledger });
}

/** Binds the post-catalogue matrix and transport fingerprint before inference. */
export async function bindLiveInferenceAuthorizationPlan(
  authorization: LiveInferenceAuthorization,
  catalogue: ProbeModelCatalogue,
  selectedModelId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BoundLiveInferenceAuthorization> {
  const plan = buildPhase0bAuthorizationPlan(catalogue, selectedModelId, env);
  const ledger = await readInferenceAuthorizationLedger(authorization.location, {
    authorizationId: authorization.ledger.authorizationId,
    owner: authorization.ledger.owner,
    accountFingerprint: authorization.ledger.accountFingerprint,
    modelId: selectedModelId,
    matrixVersion: plan.matrixVersion,
    matrixHash: plan.matrixHash,
    authorizedPosts: authorization.ledger.authorizedPosts,
  });
  const required = authorization.mode === "contract" ? plan.inferencePostCount : 1;
  if (ledger.authorizedPosts - ledger.consumedPosts < required) {
    throw new Error(`REFUSED: cumulative inference authorization is insufficient for ${authorization.mode}`);
  }
  return Object.freeze({ ...authorization, ledger, plan });
}

/** No refund path exists: a successful return means the capacity is durably consumed. */
export async function reserveLiveInferencePosts(
  authorization: BoundLiveInferenceAuthorization,
  posts: number,
): Promise<void> {
  await reserveInferencePosts(authorization.location, {
    authorizationId: authorization.ledger.authorizationId,
    owner: authorization.ledger.owner,
    accountFingerprint: authorization.ledger.accountFingerprint,
    modelId: authorization.ledger.modelId,
    matrixVersion: authorization.plan.matrixVersion,
    matrixHash: authorization.plan.matrixHash,
    authorizedPosts: authorization.ledger.authorizedPosts,
  }, posts);
}
