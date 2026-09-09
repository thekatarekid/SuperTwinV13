import { isAbsolute } from "node:path";

import { EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV } from "./account.js";
import {
  appendInferenceAuthorizationPlanSuccessor,
  initializeInferenceAuthorizationLedger,
  type InferenceAuthorizationLedger,
} from "./authorization-ledger.js";
import { PHASE0B_MATRIX_VERSION } from "./authorization-plan.js";
import { FULL_PROBE_INFERENCE_POST_BUDGET } from "./constants.js";
import {
  AUTHORIZATION_ID_ENV,
  AUTHORIZATION_LEDGER_PATH_ENV,
  AUTHORIZATION_MATRIX_HASH_ENV,
  AUTHORIZATION_MATRIX_VERSION_ENV,
  AUTHORIZATION_OWNER_ENV,
  AUTHORIZED_INFERENCE_POSTS_ENV,
  AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV,
} from "./live-authorization.js";
import { REQUESTED_PROBE_MODEL_ENV } from "./models.js";

export { AUTHORIZATION_MATRIX_HASH_ENV, AUTHORIZATION_MATRIX_VERSION_ENV } from "./live-authorization.js";
export const AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_INITIAL_CONSUMED_POSTS";
export const REQUIRED_INITIAL_CONSUMED_POSTS = 2;
export const CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS = 46;
export const INITIAL_AUTHORIZATION_MATRIX_VERSION = "phase0b-contract-matrix-v1";
export const INITIAL_AUTHORIZATION_MATRIX_HASH =
  "b02baf6834d23ad8fbaf5df4f693f3f924ce6f8787cc9173f1668995e96cac88";

export const AUTHORIZATION_PREDECESSOR_REVISION_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_REVISION";
export const AUTHORIZATION_PREDECESSOR_MATRIX_VERSION_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_MATRIX_VERSION";
export const AUTHORIZATION_PREDECESSOR_MATRIX_HASH_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_MATRIX_HASH";
export const AUTHORIZATION_PREDECESSOR_PLANNED_INFERENCE_POSTS_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_PLANNED_INFERENCE_POSTS";
export const AUTHORIZATION_EXPECTED_CONSUMED_POSTS_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS";
export const AUTHORIZATION_SUCCESSOR_TRANSITION_ID_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_TRANSITION_ID";
export const AUTHORIZATION_SUCCESSOR_MATRIX_VERSION_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_MATRIX_VERSION";
export const AUTHORIZATION_SUCCESSOR_MATRIX_HASH_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_MATRIX_HASH";
export const AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS";

export const CURRENT_ACTIVE_MATRIX_VERSION = "phase0b-contract-matrix-v2";
export const CURRENT_ACTIVE_MATRIX_HASH = "a6c50fd7c7725b65525d35db1e9ad4d3060619be5e7e405ead68cf19d2555b09";
export const CURRENT_ACTIVE_PLANNED_INFERENCE_POSTS = 45;
export const CURRENT_AUTHORIZATION_PLAN_REVISION = 2;
export const CURRENT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS = 5;
export const SUCCESSOR_AUTHORIZATION_PLAN_REVISION = 3;
export const SUCCESSOR_AUTHORIZED_PLANNED_INFERENCE_POSTS = 45;
export const SUCCESSOR_AUTHORIZATION_MATRIX_HASH =
  "5bcf8cfc86f44bcb16e26b78522d096deaf1527cef32f2b3b37503dbbed2dfd9";

export interface AuthorizationLedgerInitializationEvidence {
  status: "authorization-ledger-created";
  accountFingerprint: string;
  modelId: string;
  matrixVersion: typeof INITIAL_AUTHORIZATION_MATRIX_VERSION;
  matrixHash: string;
  plannedInferencePosts: typeof CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS;
  authorizedPosts: number;
  consumedPosts: typeof REQUIRED_INITIAL_CONSUMED_POSTS;
  remainingPosts: number;
  networkCalls: 0;
  createOnce: true;
}

export interface AuthorizationPlanSuccessorAppendEvidence {
  status: "authorization-plan-successor-appended";
  accountFingerprint: string;
  modelId: string;
  planRevision: typeof SUCCESSOR_AUTHORIZATION_PLAN_REVISION;
  planTransitionId: string;
  matrixVersion: typeof PHASE0B_MATRIX_VERSION;
  matrixHash: typeof SUCCESSOR_AUTHORIZATION_MATRIX_HASH;
  plannedInferencePosts: typeof SUCCESSOR_AUTHORIZED_PLANNED_INFERENCE_POSTS;
  authorizedPosts: typeof FULL_PROBE_INFERENCE_POST_BUDGET;
  consumedPosts: typeof CURRENT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS;
  remainingPosts: number;
  networkCalls: 0;
  appendOnly: true;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`REFUSED: ledger initialization requires explicit ${name}`);
  return value;
}

function explicitPositiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = required(env, name);
  if (!/^[1-9][0-9]{0,6}$/.test(value)) {
    throw new Error(`REFUSED: ${name} must be an explicit positive integer`);
  }
  return Number(value);
}

function requireExact(env: NodeJS.ProcessEnv, name: string, expected: string): string {
  const value = required(env, name);
  if (value !== expected) throw new Error(`REFUSED: ${name} must explicitly equal ${expected}`);
  return value;
}

function requireExactInteger(env: NodeJS.ProcessEnv, name: string, expected: number): number {
  const value = explicitPositiveInteger(env, name);
  if (value !== expected) throw new Error(`REFUSED: ${name} must explicitly equal ${expected}`);
  return value;
}

function initializationEvidence(ledger: InferenceAuthorizationLedger): AuthorizationLedgerInitializationEvidence {
  if (ledger.matrixVersion !== INITIAL_AUTHORIZATION_MATRIX_VERSION ||
      ledger.matrixHash !== INITIAL_AUTHORIZATION_MATRIX_HASH ||
      ledger.plannedInferencePosts !== CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS ||
      ledger.consumedPosts !== REQUIRED_INITIAL_CONSUMED_POSTS) {
    throw new Error("REFUSED: initialized authorization ledger did not preserve the exact requested grant");
  }
  return Object.freeze({
    status: "authorization-ledger-created",
    accountFingerprint: ledger.accountFingerprint,
    modelId: ledger.modelId,
    matrixVersion: INITIAL_AUTHORIZATION_MATRIX_VERSION,
    matrixHash: ledger.matrixHash,
    plannedInferencePosts: CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS,
    authorizedPosts: ledger.authorizedPosts,
    consumedPosts: REQUIRED_INITIAL_CONSUMED_POSTS,
    remainingPosts: ledger.authorizedPosts - REQUIRED_INITIAL_CONSUMED_POSTS,
    networkCalls: 0,
    createOnce: true,
  });
}

/**
 * Explicit, offline, create-once initialization. This command never discovers,
 * guesses, updates, or resets authorization state.
 */
export async function initializeInferenceAuthorizationFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorizationLedgerInitializationEvidence> {
  const ledgerPath = required(env, AUTHORIZATION_LEDGER_PATH_ENV);
  const superTwinHome = required(env, "SUPERTWIN_HOME");
  if (!isAbsolute(ledgerPath) || !isAbsolute(superTwinHome)) {
    throw new Error("REFUSED: ledger initialization paths must be explicit absolute paths");
  }

  const matrixVersion = required(env, AUTHORIZATION_MATRIX_VERSION_ENV);
  if (matrixVersion !== INITIAL_AUTHORIZATION_MATRIX_VERSION) {
    throw new Error(
      `REFUSED: ${AUTHORIZATION_MATRIX_VERSION_ENV} must equal ${INITIAL_AUTHORIZATION_MATRIX_VERSION}`,
    );
  }
  requireExact(env, AUTHORIZATION_MATRIX_HASH_ENV, INITIAL_AUTHORIZATION_MATRIX_HASH);
  const initialConsumed = required(env, AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV);
  if (initialConsumed !== String(REQUIRED_INITIAL_CONSUMED_POSTS)) {
    throw new Error(
      `REFUSED: ${AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV} must explicitly equal ${REQUIRED_INITIAL_CONSUMED_POSTS}`,
    );
  }

  const authorizedPosts = explicitPositiveInteger(env, AUTHORIZED_INFERENCE_POSTS_ENV);
  if (authorizedPosts !== FULL_PROBE_INFERENCE_POST_BUDGET) {
    throw new Error(
      `REFUSED: ${AUTHORIZED_INFERENCE_POSTS_ENV} must explicitly equal ${FULL_PROBE_INFERENCE_POST_BUDGET}`,
    );
  }
  const plannedInferencePosts = explicitPositiveInteger(env, AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV);
  if (plannedInferencePosts !== CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS) {
    throw new Error(
      `REFUSED: ${AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV} must explicitly equal ` +
      CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS,
    );
  }

  const ledger = await initializeInferenceAuthorizationLedger({ ledgerPath, superTwinHome }, {
    authorizationId: required(env, AUTHORIZATION_ID_ENV),
    owner: required(env, AUTHORIZATION_OWNER_ENV),
    accountFingerprint: required(env, EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV),
    modelId: required(env, REQUESTED_PROBE_MODEL_ENV),
    matrixVersion,
    matrixHash: INITIAL_AUTHORIZATION_MATRIX_HASH,
    plannedInferencePosts,
    authorizedPosts,
  }, REQUIRED_INITIAL_CONSUMED_POSTS);
  return initializationEvidence(ledger);
}


/** Explicit offline append-only activation of the observed transport-only matrix successor. */
export async function appendInferenceAuthorizationPlanSuccessorFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorizationPlanSuccessorAppendEvidence> {
  const ledgerPath = required(env, AUTHORIZATION_LEDGER_PATH_ENV);
  const superTwinHome = required(env, "SUPERTWIN_HOME");
  if (!isAbsolute(ledgerPath) || !isAbsolute(superTwinHome)) {
    throw new Error("REFUSED: authorization successor paths must be explicit absolute paths");
  }
  const authorizedPosts = requireExactInteger(
    env,
    AUTHORIZED_INFERENCE_POSTS_ENV,
    FULL_PROBE_INFERENCE_POST_BUDGET,
  );
  const predecessorRevision = requireExactInteger(
    env,
    AUTHORIZATION_PREDECESSOR_REVISION_ENV,
    CURRENT_AUTHORIZATION_PLAN_REVISION,
  );
  const predecessorMatrixVersion = requireExact(
    env,
    AUTHORIZATION_PREDECESSOR_MATRIX_VERSION_ENV,
    CURRENT_ACTIVE_MATRIX_VERSION,
  );
  const predecessorMatrixHash = requireExact(
    env,
    AUTHORIZATION_PREDECESSOR_MATRIX_HASH_ENV,
    CURRENT_ACTIVE_MATRIX_HASH,
  );
  const predecessorPlannedInferencePosts = requireExactInteger(
    env,
    AUTHORIZATION_PREDECESSOR_PLANNED_INFERENCE_POSTS_ENV,
    CURRENT_ACTIVE_PLANNED_INFERENCE_POSTS,
  );
  const expectedConsumedPosts = requireExactInteger(
    env,
    AUTHORIZATION_EXPECTED_CONSUMED_POSTS_ENV,
    CURRENT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS,
  );
  const successorMatrixVersion = requireExact(
    env,
    AUTHORIZATION_SUCCESSOR_MATRIX_VERSION_ENV,
    PHASE0B_MATRIX_VERSION,
  );
  const successorMatrixHash = requireExact(
    env,
    AUTHORIZATION_SUCCESSOR_MATRIX_HASH_ENV,
    SUCCESSOR_AUTHORIZATION_MATRIX_HASH,
  );
  const successorPlannedInferencePosts = requireExactInteger(
    env,
    AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS_ENV,
    SUCCESSOR_AUTHORIZED_PLANNED_INFERENCE_POSTS,
  );
  const transitionId = required(env, AUTHORIZATION_SUCCESSOR_TRANSITION_ID_ENV);
  const ledger = await appendInferenceAuthorizationPlanSuccessor(
    { ledgerPath, superTwinHome },
    {
      authorizationId: required(env, AUTHORIZATION_ID_ENV),
      owner: required(env, AUTHORIZATION_OWNER_ENV),
      accountFingerprint: required(env, EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV),
      modelId: required(env, REQUESTED_PROBE_MODEL_ENV),
      authorizedPosts,
    },
    {
      revision: predecessorRevision,
      matrixVersion: predecessorMatrixVersion,
      matrixHash: predecessorMatrixHash,
      plannedInferencePosts: predecessorPlannedInferencePosts,
      expectedConsumedPosts,
    },
    {
      transitionId,
      matrixVersion: successorMatrixVersion,
      matrixHash: successorMatrixHash,
      plannedInferencePosts: successorPlannedInferencePosts,
    },
  );
  if (ledger.planRevision !== SUCCESSOR_AUTHORIZATION_PLAN_REVISION ||
      ledger.planTransitionId !== transitionId || ledger.matrixVersion !== PHASE0B_MATRIX_VERSION ||
      ledger.matrixHash !== SUCCESSOR_AUTHORIZATION_MATRIX_HASH ||
      ledger.plannedInferencePosts !== SUCCESSOR_AUTHORIZED_PLANNED_INFERENCE_POSTS ||
      ledger.authorizedPosts !== FULL_PROBE_INFERENCE_POST_BUDGET ||
      ledger.consumedPosts !== CURRENT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS) {
    throw new Error("REFUSED: authorization successor did not preserve the exact requested boundary");
  }
  return Object.freeze({
    status: "authorization-plan-successor-appended",
    accountFingerprint: ledger.accountFingerprint,
    modelId: ledger.modelId,
    planRevision: SUCCESSOR_AUTHORIZATION_PLAN_REVISION,
    planTransitionId: transitionId,
    matrixVersion: PHASE0B_MATRIX_VERSION,
    matrixHash: SUCCESSOR_AUTHORIZATION_MATRIX_HASH,
    plannedInferencePosts: SUCCESSOR_AUTHORIZED_PLANNED_INFERENCE_POSTS,
    authorizedPosts: FULL_PROBE_INFERENCE_POST_BUDGET,
    consumedPosts: CURRENT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS,
    remainingPosts: FULL_PROBE_INFERENCE_POST_BUDGET - CURRENT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS,
    networkCalls: 0,
    appendOnly: true,
  });
}
