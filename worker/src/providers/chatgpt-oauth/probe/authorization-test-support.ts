import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  appendInferenceAuthorizationPlanSuccessor,
  initializeInferenceAuthorizationLedger,
  ROOT_AUTHORIZATION_PLAN_TRANSITION_ID,
} from "./authorization-ledger.js";
import {
  INITIAL_AUTHORIZATION_MATRIX_HASH,
  INITIAL_AUTHORIZATION_MATRIX_VERSION,
} from "./authorization-ledger-init.js";
import { buildPhase0bAuthorizationPlan } from "./authorization-plan.js";
import {
  AUTHORIZATION_ID_ENV,
  AUTHORIZATION_LEDGER_PATH_ENV,
  AUTHORIZATION_MATRIX_HASH_ENV,
  AUTHORIZATION_MATRIX_VERSION_ENV,
  AUTHORIZATION_OWNER_ENV,
  AUTHORIZATION_PLAN_REVISION_ENV,
  AUTHORIZATION_PLAN_TRANSITION_ID_ENV,
  AUTHORIZED_INFERENCE_POSTS_ENV,
  AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV,
} from "./live-authorization.js";
import type { ProbeModelCatalogue } from "./models.js";

const authorizationRoots = new Set<string>();

export async function addTestInferenceAuthorization(
  env: NodeJS.ProcessEnv,
  catalogue: ProbeModelCatalogue = { models: [{ id: "gpt-probe", capabilities: {} }] },
  options: { authorizedPosts?: number; consumedPosts?: number; plannedInferencePosts?: number } = {},
): Promise<NodeJS.ProcessEnv> {
  const authorizedPosts = options.authorizedPosts ?? 55;
  const root = await mkdtemp(join(tmpdir(), "supertwin-live-auth-test-"));
  authorizationRoots.add(root);
  const directory = join(root, "ledger");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const ledgerPath = join(directory, "authorization.sqlite");
  const authorizationId = "test-owner-approval";
  const owner = "Test Owner";
  const accountFingerprint = env.SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT!;
  const modelId = env.SUPERTWIN_CHATGPT_PROBE_MODEL!;
  const plan = buildPhase0bAuthorizationPlan(catalogue, modelId, env);
  const plannedInferencePosts = options.plannedInferencePosts ?? plan.inferencePostCount;
  await initializeInferenceAuthorizationLedger({
    ledgerPath,
    superTwinHome: env.SUPERTWIN_HOME!,
  }, {
    authorizationId,
    owner,
    accountFingerprint,
    modelId,
    matrixVersion: plan.matrixVersion,
    matrixHash: plan.matrixHash,
    plannedInferencePosts,
    authorizedPosts,
  }, options.consumedPosts ?? 0);
  return {
    ...env,
    [AUTHORIZATION_LEDGER_PATH_ENV]: ledgerPath,
    [AUTHORIZATION_ID_ENV]: authorizationId,
    [AUTHORIZATION_OWNER_ENV]: owner,
    [AUTHORIZATION_MATRIX_VERSION_ENV]: plan.matrixVersion,
    [AUTHORIZATION_MATRIX_HASH_ENV]: plan.matrixHash,
    [AUTHORIZATION_PLAN_REVISION_ENV]: "1",
    [AUTHORIZATION_PLAN_TRANSITION_ID_ENV]: ROOT_AUTHORIZATION_PLAN_TRANSITION_ID,
    [AUTHORIZED_INFERENCE_POSTS_ENV]: String(authorizedPosts),
    [AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV]: String(plannedInferencePosts),
  };
}

export async function addTestSuccessorInferenceAuthorization(
  env: NodeJS.ProcessEnv,
  catalogue: ProbeModelCatalogue,
): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "supertwin-live-auth-successor-test-"));
  authorizationRoots.add(root);
  const directory = join(root, "ledger");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const ledgerPath = join(directory, "authorization.sqlite");
  const authorizationId = "test-owner-approval";
  const owner = "Test Owner";
  const accountFingerprint = env.SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT!;
  const modelId = env.SUPERTWIN_CHATGPT_PROBE_MODEL!;
  const plan = buildPhase0bAuthorizationPlan(catalogue, modelId, env);
  const rootGrant = {
    authorizationId,
    owner,
    accountFingerprint,
    modelId,
    matrixVersion: INITIAL_AUTHORIZATION_MATRIX_VERSION,
    matrixHash: INITIAL_AUTHORIZATION_MATRIX_HASH,
    plannedInferencePosts: 46,
    authorizedPosts: 55,
  };
  await initializeInferenceAuthorizationLedger({ ledgerPath, superTwinHome: env.SUPERTWIN_HOME! }, rootGrant, 2);
  const db = new Database(ledgerPath);
  db.pragma("foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  db.exec("DROP TABLE revisioned_inference_attempt; DROP TABLE authorization_plan_revision");
  db.prepare("UPDATE inference_authorization SET consumed_posts = 3").run();
  db.prepare(`
    INSERT INTO inference_attempt VALUES (
      3, 1, ?, ?, ?, 46, 1, 'canary.blank-context', 'phase0b-canary-success-v1', 'reserved', NULL
    )
  `).run(authorizationId, INITIAL_AUTHORIZATION_MATRIX_VERSION, INITIAL_AUTHORIZATION_MATRIX_HASH);
  db.pragma("user_version = 3");
  db.exec("COMMIT");
  db.close();
  const transitionId = "transport-only-request-matrix-v2";
  await appendInferenceAuthorizationPlanSuccessor(
    { ledgerPath, superTwinHome: env.SUPERTWIN_HOME! },
    { authorizationId, owner, accountFingerprint, modelId, authorizedPosts: 55 },
    {
      revision: 1,
      matrixVersion: INITIAL_AUTHORIZATION_MATRIX_VERSION,
      matrixHash: INITIAL_AUTHORIZATION_MATRIX_HASH,
      plannedInferencePosts: 46,
      expectedConsumedPosts: 3,
    },
    {
      transitionId,
      matrixVersion: plan.matrixVersion,
      matrixHash: plan.matrixHash,
      plannedInferencePosts: plan.inferencePostCount,
    },
  );
  return {
    ...env,
    [AUTHORIZATION_LEDGER_PATH_ENV]: ledgerPath,
    [AUTHORIZATION_ID_ENV]: authorizationId,
    [AUTHORIZATION_OWNER_ENV]: owner,
    [AUTHORIZATION_MATRIX_VERSION_ENV]: plan.matrixVersion,
    [AUTHORIZATION_MATRIX_HASH_ENV]: plan.matrixHash,
    [AUTHORIZATION_PLAN_REVISION_ENV]: "2",
    [AUTHORIZATION_PLAN_TRANSITION_ID_ENV]: transitionId,
    [AUTHORIZED_INFERENCE_POSTS_ENV]: "55",
    [AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV]: String(plan.inferencePostCount),
  };
}

export async function cleanupTestInferenceAuthorizations(): Promise<void> {
  const roots = [...authorizationRoots];
  authorizationRoots.clear();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

export function testConsumedInferencePosts(env: NodeJS.ProcessEnv): number {
  const db = new Database(env[AUTHORIZATION_LEDGER_PATH_ENV]!, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(
      "SELECT consumed_posts AS consumedPosts FROM inference_authorization WHERE singleton = 1",
    ).get() as { consumedPosts: number }).consumedPosts;
  } finally {
    db.close();
  }
}

export function testMatchedCanaryReservationPost(env: NodeJS.ProcessEnv): number | undefined {
  const db = new Database(env[AUTHORIZATION_LEDGER_PATH_ENV]!, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(
      "SELECT reservation_post AS reservationPost FROM revisioned_inference_attempt WHERE state = 'matched'",
    ).get() as { reservationPost: number } | undefined)?.reservationPost;
  } finally {
    db.close();
  }
}
