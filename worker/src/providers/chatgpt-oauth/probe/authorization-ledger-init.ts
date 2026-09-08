import { isAbsolute } from "node:path";

import { EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV } from "./account.js";
import {
  initializeInferenceAuthorizationLedger,
  type InferenceAuthorizationLedger,
} from "./authorization-ledger.js";
import { PHASE0B_MATRIX_VERSION } from "./authorization-plan.js";
import { FULL_PROBE_INFERENCE_POST_BUDGET } from "./constants.js";
import {
  AUTHORIZATION_ID_ENV,
  AUTHORIZATION_LEDGER_PATH_ENV,
  AUTHORIZATION_OWNER_ENV,
  AUTHORIZED_INFERENCE_POSTS_ENV,
  AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV,
} from "./live-authorization.js";
import { REQUESTED_PROBE_MODEL_ENV } from "./models.js";

export const AUTHORIZATION_MATRIX_VERSION_ENV = "SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_VERSION";
export const AUTHORIZATION_MATRIX_HASH_ENV = "SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_HASH";
export const AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV =
  "SUPERTWIN_CHATGPT_AUTHORIZATION_INITIAL_CONSUMED_POSTS";
export const REQUIRED_INITIAL_CONSUMED_POSTS = 2;
export const CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS = 46;

export interface AuthorizationLedgerInitializationEvidence {
  status: "authorization-ledger-created";
  accountFingerprint: string;
  modelId: string;
  matrixVersion: typeof PHASE0B_MATRIX_VERSION;
  matrixHash: string;
  plannedInferencePosts: typeof CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS;
  authorizedPosts: number;
  consumedPosts: typeof REQUIRED_INITIAL_CONSUMED_POSTS;
  remainingPosts: number;
  networkCalls: 0;
  createOnce: true;
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

function initializationEvidence(ledger: InferenceAuthorizationLedger): AuthorizationLedgerInitializationEvidence {
  if (ledger.matrixVersion !== PHASE0B_MATRIX_VERSION ||
      ledger.plannedInferencePosts !== CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS ||
      ledger.consumedPosts !== REQUIRED_INITIAL_CONSUMED_POSTS) {
    throw new Error("REFUSED: initialized authorization ledger did not preserve the exact requested grant");
  }
  return Object.freeze({
    status: "authorization-ledger-created",
    accountFingerprint: ledger.accountFingerprint,
    modelId: ledger.modelId,
    matrixVersion: PHASE0B_MATRIX_VERSION,
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
  if (matrixVersion !== PHASE0B_MATRIX_VERSION) {
    throw new Error(`REFUSED: ${AUTHORIZATION_MATRIX_VERSION_ENV} must equal ${PHASE0B_MATRIX_VERSION}`);
  }
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
    matrixHash: required(env, AUTHORIZATION_MATRIX_HASH_ENV),
    plannedInferencePosts,
    authorizedPosts,
  }, REQUIRED_INITIAL_CONSUMED_POSTS);
  return initializationEvidence(ledger);
}
