import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { FULL_PROBE_INFERENCE_POST_BUDGET } from "./constants.js";

const LEDGER_SCHEMA_VERSION = 4;
const ROOT_RECORD_SCHEMA_VERSION = 3;
const PLAN_REVISION_DIGEST_FORMAT = "phase0b-authorization-plan-revision-v1";
export const ROOT_AUTHORIZATION_PLAN_TRANSITION_ID = "phase0b-root-plan";
export const CANARY_ACCEPTANCE_POLICY_VERSION = "phase0b-canary-success-v1";
export const CANARY_CASE_NAME = "canary.blank-context";
export const CANARY_CASE_SEQUENCE = 1;
const MAX_AUTHORIZED_POSTS = 1_000_000;
const SAFE_LEDGER_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:@+ -]{0,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const GRANT_KEYS = [
  "accountFingerprint",
  "authorizationId",
  "authorizedPosts",
  "matrixHash",
  "matrixVersion",
  "modelId",
  "owner",
  "plannedInferencePosts",
] as const;

export interface InferenceAuthorizationGrant {
  authorizationId: string;
  owner: string;
  accountFingerprint: string;
  modelId: string;
  matrixVersion: string;
  matrixHash: string;
  plannedInferencePosts: number;
  authorizedPosts: number;
}

export interface InferenceAuthorizationLedger extends InferenceAuthorizationGrant {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  consumedPosts: number;
  planRevision: number;
  planTransitionId: string;
  planRevisionDigest: string;
  activatedAfterConsumedPosts: number;
  canaryCheckpoint?: CanaryCompletionCheckpoint;
}

export interface CanaryInferenceReservation {
  authorizationId: string;
  matrixVersion: string;
  matrixHash: string;
  plannedInferencePosts: number;
  planRevision: number;
  planRevisionDigest: string;
  reservationPost: number;
  caseSequence: typeof CANARY_CASE_SEQUENCE;
  caseName: typeof CANARY_CASE_NAME;
  acceptancePolicyVersion: typeof CANARY_ACCEPTANCE_POLICY_VERSION;
  state: "reserved";
}

export interface CanaryCompletionCheckpoint extends Omit<CanaryInferenceReservation, "state"> {
  state: "matched";
}

export type InferenceAuthorizationBinding = Pick<
  InferenceAuthorizationGrant,
  "authorizationId" | "owner" | "accountFingerprint" | "modelId" | "matrixVersion" | "matrixHash" |
  "plannedInferencePosts" | "authorizedPosts"
> & Pick<InferenceAuthorizationLedger, "planRevision" | "planTransitionId">;

export type InferenceAuthorizationRootBinding = Pick<
  InferenceAuthorizationGrant,
  "authorizationId" | "owner" | "accountFingerprint" | "modelId" | "authorizedPosts"
>;

export type InferenceAuthorizationPlanBinding = InferenceAuthorizationGrant & Pick<
  InferenceAuthorizationLedger,
  "planRevision" | "planTransitionId" | "planRevisionDigest"
>;

export interface AuthorizationPlanSuccessor {
  transitionId: string;
  matrixVersion: string;
  matrixHash: string;
  plannedInferencePosts: number;
}

export interface AuthorizationPlanPredecessor {
  revision: number;
  matrixVersion: string;
  matrixHash: string;
  plannedInferencePosts: number;
  expectedConsumedPosts: number;
}

export interface AuthorizationLedgerLocation {
  /** Explicit path to the external ledger. There is intentionally no default. */
  ledgerPath: string;
  /** Snapshotted SuperTwin home; the ledger must be outside this tree. */
  superTwinHome: string;
}

export class AuthorizationLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationLedgerError";
  }
}

function fail(message: string): never {
  throw new AuthorizationLedgerError(`REFUSED: ${message}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
}

function validateGrant(value: unknown): InferenceAuthorizationGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid authorization grant");
  const grant = value as Record<string, unknown>;
  if (!exactKeys(grant, [...GRANT_KEYS].sort())) fail("invalid authorization grant fields");
  if (typeof grant.authorizationId !== "string" || !SAFE_TEXT.test(grant.authorizationId) ||
      typeof grant.owner !== "string" || !SAFE_TEXT.test(grant.owner) ||
      typeof grant.accountFingerprint !== "string" || !/^[a-f0-9]{12}$/.test(grant.accountFingerprint) ||
      typeof grant.modelId !== "string" || !SAFE_MODEL.test(grant.modelId) ||
      typeof grant.matrixVersion !== "string" || !SAFE_TEXT.test(grant.matrixVersion) ||
      typeof grant.matrixHash !== "string" || !SHA256_HEX.test(grant.matrixHash) ||
      typeof grant.plannedInferencePosts !== "number" || !Number.isSafeInteger(grant.plannedInferencePosts) ||
      grant.plannedInferencePosts < 1 || grant.plannedInferencePosts > FULL_PROBE_INFERENCE_POST_BUDGET ||
      typeof grant.authorizedPosts !== "number" || !Number.isSafeInteger(grant.authorizedPosts) ||
      grant.authorizedPosts < 1 || grant.authorizedPosts > MAX_AUTHORIZED_POSTS) {
    fail("invalid authorization grant values");
  }
  return Object.freeze({
    authorizationId: grant.authorizationId,
    owner: grant.owner,
    accountFingerprint: grant.accountFingerprint,
    modelId: grant.modelId,
    matrixVersion: grant.matrixVersion,
    matrixHash: grant.matrixHash,
    plannedInferencePosts: grant.plannedInferencePosts,
    authorizedPosts: grant.authorizedPosts,
  });
}

interface AuthorizationPlanRevision {
  revision: number;
  predecessorRevision: number | null;
  transitionId: string;
  matrixVersion: string;
  matrixHash: string;
  plannedInferencePosts: number;
  activatedAfterConsumedPosts: number;
  revisionDigest: string;
}

function revisionDigest(
  root: Pick<InferenceAuthorizationGrant, "authorizationId" | "accountFingerprint" | "modelId" | "authorizedPosts">,
  revision: Omit<AuthorizationPlanRevision, "revisionDigest">,
  predecessorDigest: string | null,
): string {
  const canonical = JSON.stringify({
    format: PLAN_REVISION_DIGEST_FORMAT,
    authorizationId: root.authorizationId,
    accountFingerprint: root.accountFingerprint,
    modelId: root.modelId,
    authorizedPosts: root.authorizedPosts,
    revision: revision.revision,
    predecessorDigest,
    transitionId: revision.transitionId,
    matrixVersion: revision.matrixVersion,
    matrixHash: revision.matrixHash,
    plannedInferencePosts: revision.plannedInferencePosts,
    activatedAfterConsumedPosts: revision.activatedAfterConsumedPosts,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function rootRevision(root: InferenceAuthorizationGrant): AuthorizationPlanRevision {
  const revision = {
    revision: 1,
    predecessorRevision: null,
    transitionId: ROOT_AUTHORIZATION_PLAN_TRANSITION_ID,
    matrixVersion: root.matrixVersion,
    matrixHash: root.matrixHash,
    plannedInferencePosts: root.plannedInferencePosts,
    activatedAfterConsumedPosts: 0,
  };
  return Object.freeze({ ...revision, revisionDigest: revisionDigest(root, revision, null) });
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

async function canonicalPotentialPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function validateDirectory(path: string): Promise<DirectoryIdentity> {
  const uid = process.getuid?.();
  if (uid === undefined) fail("authorization ledger requires an owner identity");
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail("authorization ledger directory is unavailable");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    fail("authorization ledger directory must be owner-only");
  }
  return { path, dev: stat.dev, ino: stat.ino, uid };
}

async function verifyDirectory(identity: DirectoryIdentity): Promise<void> {
  const current = await validateDirectory(identity.path);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid) {
    fail("authorization ledger directory changed");
  }
}

async function resolveLocation(location: AuthorizationLedgerLocation): Promise<{
  ledgerPath: string;
  directory: DirectoryIdentity;
}> {
  if (typeof location.ledgerPath !== "string" || !isAbsolute(location.ledgerPath) ||
      typeof location.superTwinHome !== "string" || !isAbsolute(location.superTwinHome) ||
      !SAFE_LEDGER_BASENAME.test(basename(location.ledgerPath))) {
    fail("authorization ledger paths must be explicit and safe");
  }
  let directoryReal: string;
  let homeReal: string;
  try {
    directoryReal = await realpath(dirname(resolve(location.ledgerPath)));
    homeReal = await canonicalPotentialPath(location.superTwinHome);
  } catch {
    fail("authorization ledger location is unavailable");
  }
  const directory = await validateDirectory(directoryReal);
  const ledgerPath = resolve(directoryReal, basename(location.ledgerPath));
  const fromHome = relative(homeReal, ledgerPath);
  if (fromHome === "" || (!fromHome.startsWith("..") && !isAbsolute(fromHome))) {
    fail("authorization ledger must be outside SuperTwin home");
  }
  return { ledgerPath, directory };
}

async function validateLedgerFile(path: string, expected?: FileIdentity): Promise<FileIdentity> {
  const uid = process.getuid?.();
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail("authorization ledger is missing or unavailable");
  }
  if (uid === undefined || stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600) {
    fail("authorization ledger file is not a secure owner-only regular file");
  }
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
    fail("authorization ledger file changed");
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch {
    fail("authorization ledger directory could not be synchronized");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createEmptyLedgerFile(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await handle.sync();
  } catch {
    fail("authorization ledger already exists or cannot be created securely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function configure(db: Database.Database): void {
  db.pragma("busy_timeout = 0");
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
}

function openLedger(path: string): Database.Database {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { fileMustExist: true, timeout: 0 });
    configure(db);
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      // The fixed outward error below remains the only exposed detail.
    }
    fail("authorization ledger cannot be opened");
  }
}

interface RootAuthorizationRecord extends InferenceAuthorizationGrant {
  consumedPosts: number;
}

function rowToRoot(row: unknown): RootAuthorizationRecord {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("authorization ledger is corrupt");
  const value = row as Record<string, unknown>;
  const grant = validateGrant({
    accountFingerprint: value.accountFingerprint,
    authorizationId: value.authorizationId,
    authorizedPosts: value.authorizedPosts,
    matrixHash: value.matrixHash,
    matrixVersion: value.matrixVersion,
    modelId: value.modelId,
    owner: value.owner,
    plannedInferencePosts: value.plannedInferencePosts,
  });
  if (value.schemaVersion !== ROOT_RECORD_SCHEMA_VERSION || typeof value.consumedPosts !== "number" ||
      !Number.isSafeInteger(value.consumedPosts) || value.consumedPosts < 0 ||
      value.consumedPosts > grant.authorizedPosts) {
    fail("authorization ledger counters are invalid");
  }
  return Object.freeze({ ...grant, consumedPosts: value.consumedPosts });
}

function readLegacyCanaryAttempts(
  db: Database.Database,
  root: RootAuthorizationRecord,
  rootPlan: AuthorizationPlanRevision,
): CanaryCompletionCheckpoint | undefined {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`
      SELECT
        reservation_post AS reservationPost,
        authorization_id AS authorizationId,
        matrix_version AS matrixVersion,
        matrix_hash AS matrixHash,
        planned_inference_posts AS plannedInferencePosts,
        case_sequence AS caseSequence,
        case_name AS caseName,
        acceptance_policy_version AS acceptancePolicyVersion,
        state,
        matched_singleton AS matchedSingleton
      FROM inference_attempt
      ORDER BY reservation_post
    `).all() as Array<Record<string, unknown>>;
  } catch {
    fail("authorization ledger attempt records are corrupt");
  }
  let checkpoint: CanaryCompletionCheckpoint | undefined;
  for (const row of rows) {
    const valid = typeof row.reservationPost === "number" && Number.isSafeInteger(row.reservationPost) &&
      row.reservationPost >= 1 && row.reservationPost <= root.consumedPosts &&
      row.authorizationId === root.authorizationId &&
      row.matrixVersion === root.matrixVersion && row.matrixHash === root.matrixHash &&
      row.plannedInferencePosts === root.plannedInferencePosts &&
      row.caseSequence === CANARY_CASE_SEQUENCE && row.caseName === CANARY_CASE_NAME &&
      row.acceptancePolicyVersion === CANARY_ACCEPTANCE_POLICY_VERSION &&
      (row.state === "reserved" || row.state === "matched") &&
      (row.state === "matched" ? row.matchedSingleton === 1 : row.matchedSingleton === null);
    if (!valid) fail("authorization ledger attempt records are corrupt");
    if (row.state === "matched") {
      if (checkpoint) fail("authorization ledger contains conflicting canary checkpoints");
      checkpoint = Object.freeze({
        authorizationId: root.authorizationId,
        matrixVersion: root.matrixVersion,
        matrixHash: root.matrixHash,
        plannedInferencePosts: root.plannedInferencePosts,
        planRevision: 1,
        planRevisionDigest: rootPlan.revisionDigest,
        reservationPost: row.reservationPost as number,
        caseSequence: CANARY_CASE_SEQUENCE,
        caseName: CANARY_CASE_NAME,
        acceptancePolicyVersion: CANARY_ACCEPTANCE_POLICY_VERSION,
        state: "matched",
      });
    }
  }
  return checkpoint;
}

function assertLegacySuccessorBoundary(
  db: Database.Database,
  root: RootAuthorizationRecord,
  rootPlan: AuthorizationPlanRevision,
): void {
  if (readLegacyCanaryAttempts(db, root, rootPlan)) {
    fail("schema v3 with a matched canary cannot activate a successor plan");
  }
  let rows: Array<{ reservationPost?: unknown; state?: unknown }>;
  try {
    rows = db.prepare(`
      SELECT reservation_post AS reservationPost, state
      FROM inference_attempt
      ORDER BY reservation_post
    `).all() as Array<{ reservationPost?: unknown; state?: unknown }>;
  } catch {
    fail("authorization ledger attempt records are corrupt");
  }
  if (rows.length !== 1 || rows[0]?.reservationPost !== root.consumedPosts || rows[0]?.state !== "reserved") {
    fail("schema v3 successor requires the exact latest unmatched canary attempt");
  }
}

const ROOT_COLUMNS = [
  "singleton", "schema_version", "authorization_id", "owner", "account_fingerprint", "model_id",
  "matrix_version", "matrix_hash", "planned_inference_posts", "authorized_posts", "consumed_posts",
] as const;
const LEGACY_ATTEMPT_COLUMNS = [
  "reservation_post", "authorization_singleton", "authorization_id", "matrix_version", "matrix_hash",
  "planned_inference_posts", "case_sequence", "case_name", "acceptance_policy_version", "state",
  "matched_singleton",
] as const;
const REVISION_COLUMNS = [
  "revision", "authorization_singleton", "predecessor_revision", "transition_id", "matrix_version",
  "matrix_hash", "planned_inference_posts", "activated_after_consumed_posts", "revision_digest",
] as const;
const REVISIONED_ATTEMPT_COLUMNS = [
  "reservation_post", "authorization_singleton", "plan_revision", "case_sequence", "case_name",
  "acceptance_policy_version", "state", "matched_singleton",
] as const;

function assertColumns(db: Database.Database, table: string, expected: readonly string[]): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name?: unknown }>;
  if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index])) {
    fail("authorization ledger schema is unsupported");
  }
}

function readRoot(db: Database.Database): RootAuthorizationRecord {
  assertColumns(db, "inference_authorization", ROOT_COLUMNS);
  let rows: unknown[];
  try {
    rows = db.prepare(`
      SELECT schema_version AS schemaVersion, authorization_id AS authorizationId, owner,
        account_fingerprint AS accountFingerprint, model_id AS modelId, matrix_version AS matrixVersion,
        matrix_hash AS matrixHash, planned_inference_posts AS plannedInferencePosts,
        authorized_posts AS authorizedPosts, consumed_posts AS consumedPosts
      FROM inference_authorization
    `).all();
  } catch {
    fail("authorization ledger schema is corrupt");
  }
  if (rows.length !== 1) fail("authorization ledger is corrupt");
  return rowToRoot(rows[0]);
}

function readRevisions(db: Database.Database, root: RootAuthorizationRecord): AuthorizationPlanRevision[] {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`
      SELECT revision, predecessor_revision AS predecessorRevision, transition_id AS transitionId,
        matrix_version AS matrixVersion,
        matrix_hash AS matrixHash,
        planned_inference_posts AS plannedInferencePosts,
        activated_after_consumed_posts AS activatedAfterConsumedPosts,
        revision_digest AS revisionDigest
      FROM authorization_plan_revision ORDER BY revision
    `).all() as Array<Record<string, unknown>>;
  } catch {
    fail("authorization plan revisions are corrupt");
  }
  if (!rows.length) fail("authorization plan revision chain is empty");
  const revisions: AuthorizationPlanRevision[] = [];
  for (const [index, row] of rows.entries()) {
    const previous = revisions.at(-1);
    const candidate = {
      revision: row.revision,
      predecessorRevision: row.predecessorRevision,
      transitionId: row.transitionId,
      matrixVersion: row.matrixVersion,
      matrixHash: row.matrixHash,
      plannedInferencePosts: row.plannedInferencePosts,
      activatedAfterConsumedPosts: row.activatedAfterConsumedPosts,
    };
    const valid = typeof candidate.revision === "number" && candidate.revision === index + 1 &&
      candidate.predecessorRevision === (index === 0 ? null : index) &&
      typeof candidate.transitionId === "string" && SAFE_TEXT.test(candidate.transitionId) &&
      typeof candidate.matrixVersion === "string" && SAFE_TEXT.test(candidate.matrixVersion) &&
      typeof candidate.matrixHash === "string" && SHA256_HEX.test(candidate.matrixHash) &&
      typeof candidate.plannedInferencePosts === "number" &&
      Number.isSafeInteger(candidate.plannedInferencePosts) && candidate.plannedInferencePosts >= 1 &&
      candidate.plannedInferencePosts <= FULL_PROBE_INFERENCE_POST_BUDGET &&
      typeof candidate.activatedAfterConsumedPosts === "number" &&
      Number.isSafeInteger(candidate.activatedAfterConsumedPosts) &&
      candidate.activatedAfterConsumedPosts >= (previous?.activatedAfterConsumedPosts ?? 0) &&
      candidate.activatedAfterConsumedPosts <= root.consumedPosts &&
      typeof row.revisionDigest === "string" && SHA256_HEX.test(row.revisionDigest);
    if (!valid) fail("authorization plan revision chain is corrupt");
    const expectedDigest = revisionDigest(root, candidate as Omit<AuthorizationPlanRevision, "revisionDigest">,
      previous?.revisionDigest ?? null);
    if (row.revisionDigest !== expectedDigest) fail("authorization plan revision digest is invalid");
    const revision = Object.freeze({ ...candidate, revisionDigest: row.revisionDigest }) as AuthorizationPlanRevision;
    revisions.push(revision);
  }
  const first = revisions[0]!;
  if (first.transitionId !== ROOT_AUTHORIZATION_PLAN_TRANSITION_ID || first.matrixVersion !== root.matrixVersion ||
      first.matrixHash !== root.matrixHash || first.plannedInferencePosts !== root.plannedInferencePosts ||
      first.activatedAfterConsumedPosts !== 0) {
    fail("authorization plan root revision is invalid");
  }
  return revisions;
}

function readRevisionedCanaryAttempts(
  db: Database.Database,
  root: RootAuthorizationRecord,
  revisions: readonly AuthorizationPlanRevision[],
): CanaryCompletionCheckpoint | undefined {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`
      SELECT reservation_post AS reservationPost, plan_revision AS planRevision,
        case_sequence AS caseSequence, case_name AS caseName,
        acceptance_policy_version AS acceptancePolicyVersion, state,
        matched_singleton AS matchedSingleton
      FROM revisioned_inference_attempt ORDER BY reservation_post
    `).all() as Array<Record<string, unknown>>;
  } catch {
    fail("revisioned authorization attempts are corrupt");
  }
  const active = revisions.at(-1)!;
  let checkpoint: CanaryCompletionCheckpoint | undefined;
  for (const row of rows) {
    const revision = typeof row.planRevision === "number" ? revisions[row.planRevision - 1] : undefined;
    const nextRevision = typeof row.planRevision === "number" ? revisions[row.planRevision] : undefined;
    const valid = revision && typeof row.reservationPost === "number" &&
      Number.isSafeInteger(row.reservationPost) && row.reservationPost > revision.activatedAfterConsumedPosts &&
      row.reservationPost <= (nextRevision?.activatedAfterConsumedPosts ?? root.consumedPosts) &&
      row.caseSequence === CANARY_CASE_SEQUENCE &&
      row.caseName === CANARY_CASE_NAME && row.acceptancePolicyVersion === CANARY_ACCEPTANCE_POLICY_VERSION &&
      (row.state === "reserved" || row.state === "matched") &&
      (row.state === "matched" ? row.matchedSingleton === 1 : row.matchedSingleton === null);
    if (!valid) fail("revisioned authorization attempts are corrupt");
    if (row.state === "matched" && revision.revision === active.revision) {
      if (checkpoint) fail("active authorization revision contains conflicting canary checkpoints");
      checkpoint = Object.freeze({
        authorizationId: root.authorizationId,
        matrixVersion: revision.matrixVersion,
        matrixHash: revision.matrixHash,
        plannedInferencePosts: revision.plannedInferencePosts,
        planRevision: revision.revision,
        planRevisionDigest: revision.revisionDigest,
        reservationPost: row.reservationPost as number,
        caseSequence: CANARY_CASE_SEQUENCE,
        caseName: CANARY_CASE_NAME,
        acceptancePolicyVersion: CANARY_ACCEPTANCE_POLICY_VERSION,
        state: "matched",
      });
    }
  }
  return checkpoint;
}

function schemaState(db: Database.Database): { userVersion: number; tables: string[] } {
  try {
    return {
      userVersion: db.pragma("user_version", { simple: true }) as number,
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as
        Array<{ name: string }>).map(({ name }) => name),
    };
  } catch {
    fail("authorization ledger schema is corrupt");
  }
}

function readV3Root(db: Database.Database): RootAuthorizationRecord {
  const state = schemaState(db);
  if (state.userVersion !== 3 || state.tables.join(",") !== "inference_attempt,inference_authorization") {
    fail("authorization ledger is not an exact schema v3 predecessor");
  }
  assertColumns(db, "inference_attempt", LEGACY_ATTEMPT_COLUMNS);
  return readRoot(db);
}

function readRow(db: Database.Database): InferenceAuthorizationLedger {
  const state = schemaState(db);
  if (state.userVersion !== LEDGER_SCHEMA_VERSION || state.tables.join(",") !==
      "authorization_plan_revision,inference_attempt,inference_authorization,revisioned_inference_attempt") {
    fail("authorization ledger schema is unsupported");
  }
  assertColumns(db, "inference_attempt", LEGACY_ATTEMPT_COLUMNS);
  assertColumns(db, "authorization_plan_revision", REVISION_COLUMNS);
  assertColumns(db, "revisioned_inference_attempt", REVISIONED_ATTEMPT_COLUMNS);
  const root = readRoot(db);
  const revisions = readRevisions(db, root);
  const active = revisions.at(-1)!;
  const legacyCheckpoint = readLegacyCanaryAttempts(db, root, revisions[0]!);
  const revisionedCheckpoint = readRevisionedCanaryAttempts(db, root, revisions);
  if (active.revision === 1 && legacyCheckpoint && revisionedCheckpoint) {
    fail("authorization ledger contains conflicting root canary checkpoints");
  }
  const canaryCheckpoint = active.revision === 1
    ? (revisionedCheckpoint ?? legacyCheckpoint)
    : revisionedCheckpoint;
  return Object.freeze({
    ...root,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    matrixVersion: active.matrixVersion,
    matrixHash: active.matrixHash,
    plannedInferencePosts: active.plannedInferencePosts,
    planRevision: active.revision,
    planTransitionId: active.transitionId,
    planRevisionDigest: active.revisionDigest,
    activatedAfterConsumedPosts: active.activatedAfterConsumedPosts,
    ...(canaryCheckpoint ? { canaryCheckpoint } : {}),
  });
}

function sameGrant(actual: InferenceAuthorizationLedger, expected: InferenceAuthorizationGrant): boolean {
  return GRANT_KEYS.every((key) => actual[key] === expected[key]);
}

function validatePlanBinding(value: unknown): InferenceAuthorizationPlanBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid authorization plan binding");
  const binding = value as Record<string, unknown>;
  const keys = [...GRANT_KEYS, "planRevision", "planRevisionDigest", "planTransitionId"].sort();
  if (!exactKeys(binding, keys)) fail("invalid authorization plan binding fields");
  const grant = validateGrant(Object.fromEntries(GRANT_KEYS.map((key) => [key, binding[key]])));
  if (typeof binding.planRevision !== "number" || !Number.isSafeInteger(binding.planRevision) ||
      binding.planRevision < 1 || typeof binding.planRevisionDigest !== "string" ||
      !SHA256_HEX.test(binding.planRevisionDigest) || typeof binding.planTransitionId !== "string" ||
      !SAFE_TEXT.test(binding.planTransitionId)) {
    fail("invalid authorization plan binding values");
  }
  return Object.freeze({
    ...grant,
    planRevision: binding.planRevision,
    planRevisionDigest: binding.planRevisionDigest,
    planTransitionId: binding.planTransitionId,
  }) as InferenceAuthorizationPlanBinding;
}

function samePlanBinding(
  actual: InferenceAuthorizationLedger,
  expected: InferenceAuthorizationPlanBinding,
): boolean {
  return sameGrant(actual, expected) && actual.planRevision === expected.planRevision &&
    actual.planRevisionDigest === expected.planRevisionDigest &&
    actual.planTransitionId === expected.planTransitionId;
}

function validateBinding(value: unknown): InferenceAuthorizationBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid authorization binding");
  const binding = value as Record<string, unknown>;
  const keys = [
    "accountFingerprint", "authorizationId", "authorizedPosts", "matrixHash", "matrixVersion", "modelId",
    "owner", "plannedInferencePosts", "planRevision", "planTransitionId",
  ];
  if (!exactKeys(binding, [...keys].sort())) fail("invalid authorization binding fields");
  const grant = validateGrant({
    accountFingerprint: binding.accountFingerprint,
    authorizationId: binding.authorizationId,
    authorizedPosts: binding.authorizedPosts,
    matrixHash: binding.matrixHash,
    matrixVersion: binding.matrixVersion,
    modelId: binding.modelId,
    owner: binding.owner,
    plannedInferencePosts: binding.plannedInferencePosts,
  });
  if (typeof binding.planRevision !== "number" || !Number.isSafeInteger(binding.planRevision) ||
      binding.planRevision < 1 || typeof binding.planTransitionId !== "string" ||
      !SAFE_TEXT.test(binding.planTransitionId)) {
    fail("invalid authorization binding revision");
  }
  return Object.freeze({
    ...grant,
    planRevision: binding.planRevision,
    planTransitionId: binding.planTransitionId,
  });
}

function sameBinding(
  actual: InferenceAuthorizationLedger,
  expected: InferenceAuthorizationBinding,
): boolean {
  return actual.authorizationId === expected.authorizationId &&
    actual.owner === expected.owner &&
    actual.accountFingerprint === expected.accountFingerprint &&
    actual.modelId === expected.modelId &&
    actual.matrixVersion === expected.matrixVersion &&
    actual.matrixHash === expected.matrixHash &&
    actual.plannedInferencePosts === expected.plannedInferencePosts &&
    actual.authorizedPosts === expected.authorizedPosts && actual.planRevision === expected.planRevision &&
    actual.planTransitionId === expected.planTransitionId;
}

function validateCanaryReservation(value: unknown): CanaryInferenceReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid canary reservation");
  const reservation = value as Record<string, unknown>;
  const keys = [
    "acceptancePolicyVersion", "authorizationId", "caseName", "caseSequence",
    "matrixHash", "matrixVersion", "plannedInferencePosts", "planRevision", "planRevisionDigest",
    "reservationPost", "state",
  ];
  if (!exactKeys(reservation, [...keys].sort())) fail("invalid canary reservation fields");
  if (typeof reservation.authorizationId !== "string" || !SAFE_TEXT.test(reservation.authorizationId) ||
      typeof reservation.matrixVersion !== "string" || !SAFE_TEXT.test(reservation.matrixVersion) ||
      typeof reservation.matrixHash !== "string" || !SHA256_HEX.test(reservation.matrixHash) ||
      typeof reservation.plannedInferencePosts !== "number" ||
      !Number.isSafeInteger(reservation.plannedInferencePosts) || reservation.plannedInferencePosts < 1 ||
      reservation.plannedInferencePosts > FULL_PROBE_INFERENCE_POST_BUDGET ||
      typeof reservation.planRevision !== "number" || !Number.isSafeInteger(reservation.planRevision) ||
      reservation.planRevision < 1 || typeof reservation.planRevisionDigest !== "string" ||
      !SHA256_HEX.test(reservation.planRevisionDigest) ||
      typeof reservation.reservationPost !== "number" || !Number.isSafeInteger(reservation.reservationPost) ||
      reservation.reservationPost < 1 || reservation.caseSequence !== CANARY_CASE_SEQUENCE ||
      reservation.caseName !== CANARY_CASE_NAME ||
      reservation.acceptancePolicyVersion !== CANARY_ACCEPTANCE_POLICY_VERSION ||
      reservation.state !== "reserved") {
    fail("invalid canary reservation values");
  }
  return Object.freeze(reservation as unknown as CanaryInferenceReservation);
}

function reservationFor(
  ledger: InferenceAuthorizationLedger,
  reservationPost: number,
): CanaryInferenceReservation {
  return Object.freeze({
    authorizationId: ledger.authorizationId,
    matrixVersion: ledger.matrixVersion,
    matrixHash: ledger.matrixHash,
    plannedInferencePosts: ledger.plannedInferencePosts,
    planRevision: ledger.planRevision,
    planRevisionDigest: ledger.planRevisionDigest,
    reservationPost,
    caseSequence: CANARY_CASE_SEQUENCE,
    caseName: CANARY_CASE_NAME,
    acceptancePolicyVersion: CANARY_ACCEPTANCE_POLICY_VERSION,
    state: "reserved",
  });
}

async function closeAndVerify(
  db: Database.Database | undefined,
  directory: DirectoryIdentity,
  path: string,
  file: FileIdentity,
): Promise<void> {
  try {
    db?.close();
  } catch {
    fail("authorization ledger could not close securely");
  }
  await verifyDirectory(directory);
  await validateLedgerFile(path, file);
  await syncDirectory(directory.path);
}

function createRevisionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE authorization_plan_revision (
      revision INTEGER PRIMARY KEY CHECK (revision >= 1),
      authorization_singleton INTEGER NOT NULL CHECK (authorization_singleton = 1)
        REFERENCES inference_authorization(singleton),
      predecessor_revision INTEGER UNIQUE REFERENCES authorization_plan_revision(revision),
      transition_id TEXT UNIQUE NOT NULL,
      matrix_version TEXT NOT NULL,
      matrix_hash TEXT NOT NULL,
      planned_inference_posts INTEGER NOT NULL
        CHECK (planned_inference_posts >= 1 AND planned_inference_posts <= ${FULL_PROBE_INFERENCE_POST_BUDGET}),
      activated_after_consumed_posts INTEGER NOT NULL CHECK (activated_after_consumed_posts >= 0),
      revision_digest TEXT UNIQUE NOT NULL,
      CHECK (
        (revision = 1 AND predecessor_revision IS NULL) OR
        (revision > 1 AND predecessor_revision = revision - 1)
      )
    ) STRICT;
    CREATE TABLE revisioned_inference_attempt (
      reservation_post INTEGER PRIMARY KEY CHECK (reservation_post >= 1),
      authorization_singleton INTEGER NOT NULL CHECK (authorization_singleton = 1)
        REFERENCES inference_authorization(singleton),
      plan_revision INTEGER NOT NULL REFERENCES authorization_plan_revision(revision),
      case_sequence INTEGER NOT NULL CHECK (case_sequence = 1),
      case_name TEXT NOT NULL CHECK (case_name = 'canary.blank-context'),
      acceptance_policy_version TEXT NOT NULL CHECK (acceptance_policy_version = 'phase0b-canary-success-v1'),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'matched')),
      matched_singleton INTEGER,
      UNIQUE (plan_revision, matched_singleton),
      CHECK (
        (state = 'reserved' AND matched_singleton IS NULL) OR
        (state = 'matched' AND matched_singleton = 1)
      )
    ) STRICT;
  `);
}

function insertRevision(db: Database.Database, revision: AuthorizationPlanRevision): void {
  db.prepare(`
    INSERT INTO authorization_plan_revision (
      revision, authorization_singleton, predecessor_revision, transition_id, matrix_version,
      matrix_hash, planned_inference_posts, activated_after_consumed_posts, revision_digest
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.revision,
    revision.predecessorRevision,
    revision.transitionId,
    revision.matrixVersion,
    revision.matrixHash,
    revision.plannedInferencePosts,
    revision.activatedAfterConsumedPosts,
    revision.revisionDigest,
  );
}

/**
 * Explicit ledger initialization workflow. Live runners never call this: an
 * owner must create the ledger out of band before selecting an inference mode.
 */
export async function initializeInferenceAuthorizationLedger(
  location: AuthorizationLedgerLocation,
  grantInput: InferenceAuthorizationGrant,
  initialConsumedPosts = 0,
): Promise<InferenceAuthorizationLedger> {
  const grant = validateGrant(grantInput);
  if (!Number.isSafeInteger(initialConsumedPosts) || initialConsumedPosts < 0 ||
      initialConsumedPosts > grant.authorizedPosts) {
    fail("invalid initial inference count");
  }
  const { ledgerPath, directory } = await resolveLocation(location);
  await createEmptyLedgerFile(ledgerPath);
  const file = await validateLedgerFile(ledgerPath);
  await syncDirectory(directory.path);
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE inference_authorization (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 3),
        authorization_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        matrix_version TEXT NOT NULL,
        matrix_hash TEXT NOT NULL,
        planned_inference_posts INTEGER NOT NULL
          CHECK (planned_inference_posts >= 1 AND planned_inference_posts <= ${FULL_PROBE_INFERENCE_POST_BUDGET}),
        authorized_posts INTEGER NOT NULL CHECK (authorized_posts >= 1),
        consumed_posts INTEGER NOT NULL CHECK (consumed_posts >= 0 AND consumed_posts <= authorized_posts)
      ) STRICT;
      CREATE TABLE inference_attempt (
        reservation_post INTEGER PRIMARY KEY CHECK (reservation_post >= 1),
        authorization_singleton INTEGER NOT NULL CHECK (authorization_singleton = 1)
          REFERENCES inference_authorization(singleton),
        authorization_id TEXT NOT NULL,
        matrix_version TEXT NOT NULL,
        matrix_hash TEXT NOT NULL,
        planned_inference_posts INTEGER NOT NULL
          CHECK (planned_inference_posts >= 1 AND planned_inference_posts <= ${FULL_PROBE_INFERENCE_POST_BUDGET}),
        case_sequence INTEGER NOT NULL CHECK (case_sequence = 1),
        case_name TEXT NOT NULL CHECK (case_name = 'canary.blank-context'),
        acceptance_policy_version TEXT NOT NULL CHECK (acceptance_policy_version = 'phase0b-canary-success-v1'),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'matched')),
        matched_singleton INTEGER UNIQUE,
        CHECK (
          (state = 'reserved' AND matched_singleton IS NULL) OR
          (state = 'matched' AND matched_singleton = 1)
        )
      ) STRICT;
    `);
    createRevisionTables(db);
    db.prepare(`
      INSERT INTO inference_authorization VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ROOT_RECORD_SCHEMA_VERSION,
      grant.authorizationId,
      grant.owner,
      grant.accountFingerprint,
      grant.modelId,
      grant.matrixVersion,
      grant.matrixHash,
      grant.plannedInferencePosts,
      grant.authorizedPosts,
      initialConsumedPosts,
    );
    insertRevision(db, rootRevision(grant));
    db.pragma(`user_version = ${LEDGER_SCHEMA_VERSION}`);
    db.exec("COMMIT");
    const ledger = readRow(db);
    await closeAndVerify(db, directory, ledgerPath, file);
    db = undefined;
    return ledger;
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    try {
      await closeAndVerify(db, directory, ledgerPath, file);
    } catch {
      // Preserve the primary initialization error; the file remains fail-closed.
    }
    db = undefined;
    if (error instanceof AuthorizationLedgerError) throw error;
    fail("authorization ledger could not be initialized");
  }
}

function validateRootBinding(value: unknown): InferenceAuthorizationRootBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid authorization root binding");
  const binding = value as Record<string, unknown>;
  const keys = ["accountFingerprint", "authorizationId", "authorizedPosts", "modelId", "owner"];
  if (!exactKeys(binding, keys)) fail("invalid authorization root binding fields");
  const grant = validateGrant({
    ...binding,
    matrixVersion: "root-binding",
    matrixHash: "0".repeat(64),
    plannedInferencePosts: 1,
  });
  return Object.freeze({
    authorizationId: grant.authorizationId,
    owner: grant.owner,
    accountFingerprint: grant.accountFingerprint,
    modelId: grant.modelId,
    authorizedPosts: grant.authorizedPosts,
  });
}

function validatePredecessor(value: unknown): AuthorizationPlanPredecessor {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid plan predecessor");
  const candidate = value as Record<string, unknown>;
  const keys = ["expectedConsumedPosts", "matrixHash", "matrixVersion", "plannedInferencePosts", "revision"];
  if (!exactKeys(candidate, keys) || typeof candidate.revision !== "number" ||
      !Number.isSafeInteger(candidate.revision) || candidate.revision < 1 ||
      typeof candidate.expectedConsumedPosts !== "number" ||
      !Number.isSafeInteger(candidate.expectedConsumedPosts) || candidate.expectedConsumedPosts < 0 ||
      typeof candidate.matrixVersion !== "string" || !SAFE_TEXT.test(candidate.matrixVersion) ||
      typeof candidate.matrixHash !== "string" || !SHA256_HEX.test(candidate.matrixHash) ||
      typeof candidate.plannedInferencePosts !== "number" ||
      !Number.isSafeInteger(candidate.plannedInferencePosts) || candidate.plannedInferencePosts < 1 ||
      candidate.plannedInferencePosts > FULL_PROBE_INFERENCE_POST_BUDGET) {
    fail("invalid plan predecessor values");
  }
  return Object.freeze(candidate as unknown as AuthorizationPlanPredecessor);
}

function validateSuccessor(value: unknown): AuthorizationPlanSuccessor {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid plan successor");
  const candidate = value as Record<string, unknown>;
  const keys = ["matrixHash", "matrixVersion", "plannedInferencePosts", "transitionId"];
  if (!exactKeys(candidate, keys) || typeof candidate.transitionId !== "string" ||
      !SAFE_TEXT.test(candidate.transitionId) || candidate.transitionId === ROOT_AUTHORIZATION_PLAN_TRANSITION_ID ||
      typeof candidate.matrixVersion !== "string" || !SAFE_TEXT.test(candidate.matrixVersion) ||
      typeof candidate.matrixHash !== "string" || !SHA256_HEX.test(candidate.matrixHash) ||
      typeof candidate.plannedInferencePosts !== "number" ||
      !Number.isSafeInteger(candidate.plannedInferencePosts) || candidate.plannedInferencePosts < 1 ||
      candidate.plannedInferencePosts > FULL_PROBE_INFERENCE_POST_BUDGET) {
    fail("invalid plan successor values");
  }
  return Object.freeze(candidate as unknown as AuthorizationPlanSuccessor);
}

function sameRootBinding(root: RootAuthorizationRecord, expected: InferenceAuthorizationRootBinding): boolean {
  return root.authorizationId === expected.authorizationId && root.owner === expected.owner &&
    root.accountFingerprint === expected.accountFingerprint && root.modelId === expected.modelId &&
    root.authorizedPosts === expected.authorizedPosts;
}

/** Atomically appends one successor plan; schema v3 is upgraded in-place once without changing usage. */
export async function appendInferenceAuthorizationPlanSuccessor(
  location: AuthorizationLedgerLocation,
  expectedRootInput: InferenceAuthorizationRootBinding,
  predecessorInput: AuthorizationPlanPredecessor,
  successorInput: AuthorizationPlanSuccessor,
): Promise<InferenceAuthorizationLedger> {
  const expectedRoot = validateRootBinding(expectedRootInput);
  const predecessor = validatePredecessor(predecessorInput);
  const successor = validateSuccessor(successorInput);
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    db.exec("BEGIN IMMEDIATE");
    const before = schemaState(db);
    let root: RootAuthorizationRecord;
    let revisions: AuthorizationPlanRevision[];
    if (before.userVersion === 3) {
      root = readV3Root(db);
      const first = rootRevision(root);
      assertLegacySuccessorBoundary(db, root, first);
      revisions = [first];
    } else if (before.userVersion === LEDGER_SCHEMA_VERSION) {
      const activeLedger = readRow(db);
      root = readRoot(db);
      revisions = readRevisions(db, root);
      if (activeLedger.planRevision !== revisions.at(-1)!.revision) {
        fail("authorization plan active revision is inconsistent");
      }
    } else {
      fail("authorization ledger schema is unsupported for successor append");
    }
    if (!sameRootBinding(root, expectedRoot) || root.consumedPosts !== predecessor.expectedConsumedPosts) {
      fail("authorization root or activation boundary does not match");
    }
    const active = revisions.at(-1)!;
    if (active.revision !== predecessor.revision || active.matrixVersion !== predecessor.matrixVersion ||
        active.matrixHash !== predecessor.matrixHash ||
        active.plannedInferencePosts !== predecessor.plannedInferencePosts) {
      fail("authorization plan predecessor does not match the active revision");
    }
    if (successor.matrixVersion === active.matrixVersion && successor.matrixHash === active.matrixHash &&
        successor.plannedInferencePosts === active.plannedInferencePosts) {
      fail("authorization plan successor must change the active plan identity");
    }
    if (before.userVersion === 3) {
      createRevisionTables(db);
      insertRevision(db, active);
    }
    const nextBase = {
      revision: active.revision + 1,
      predecessorRevision: active.revision,
      transitionId: successor.transitionId,
      matrixVersion: successor.matrixVersion,
      matrixHash: successor.matrixHash,
      plannedInferencePosts: successor.plannedInferencePosts,
      activatedAfterConsumedPosts: root.consumedPosts,
    };
    const next = Object.freeze({
      ...nextBase,
      revisionDigest: revisionDigest(root, nextBase, active.revisionDigest),
    });
    insertRevision(db, next);
    if (before.userVersion === 3) db.pragma(`user_version = ${LEDGER_SCHEMA_VERSION}`);
    db.exec("COMMIT");
    const ledger = readRow(db);
    if (ledger.consumedPosts !== predecessor.expectedConsumedPosts ||
        ledger.planRevision !== next.revision || ledger.planRevisionDigest !== next.revisionDigest) {
      fail("authorization plan successor did not commit exactly");
    }
    await closeAndVerify(db, directory, ledgerPath, file);
    db = undefined;
    return ledger;
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    try {
      await closeAndVerify(db, directory, ledgerPath, file);
    } catch {
      // Preserve the primary append error.
    }
    db = undefined;
    if (error instanceof AuthorizationLedgerError) throw error;
    fail("authorization plan successor append failed");
  }
}

export async function readInferenceAuthorizationLedger(
  location: AuthorizationLedgerLocation,
  expectedGrantInput: InferenceAuthorizationGrant,
): Promise<InferenceAuthorizationLedger> {
  const expected = validateGrant(expectedGrantInput);
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    const ledger = readRow(db);
    if (!sameGrant(ledger, expected)) fail("authorization ledger does not match the immutable grant");
    await closeAndVerify(db, directory, ledgerPath, file);
    db = undefined;
    return ledger;
  } catch (error) {
    try {
      await closeAndVerify(db, directory, ledgerPath, file);
    } catch {
      // Preserve the primary validation error.
    }
    db = undefined;
    if (error instanceof AuthorizationLedgerError) throw error;
    fail("authorization ledger could not be read securely");
  }
}

/**
 * Pre-OAuth validation for the grant fields known without account metadata.
 * Matrix identity is deliberately checked later against the capability-resolved plan.
 */
export async function readInferenceAuthorizationBinding(
  location: AuthorizationLedgerLocation,
  expectedBindingInput: InferenceAuthorizationBinding,
): Promise<InferenceAuthorizationLedger> {
  const expected = validateBinding(expectedBindingInput);
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    const ledger = readRow(db);
    if (!sameBinding(ledger, expected)) fail("authorization ledger does not match the preflight binding");
    await closeAndVerify(db, directory, ledgerPath, file);
    db = undefined;
    return ledger;
  } catch (error) {
    try {
      await closeAndVerify(db, directory, ledgerPath, file);
    } catch {
      // Preserve the primary validation error.
    }
    db = undefined;
    if (error instanceof AuthorizationLedgerError) throw error;
    fail("authorization ledger could not be read securely");
  }
}

/** Durably consumes authorization before returning. There is no rollback API. */
export async function reserveInferencePosts(
  location: AuthorizationLedgerLocation,
  expectedGrantInput: InferenceAuthorizationPlanBinding,
  posts = 1,
): Promise<InferenceAuthorizationLedger> {
  const expected = validatePlanBinding(expectedGrantInput);
  if (!Number.isSafeInteger(posts) || posts < 1 || posts > MAX_AUTHORIZED_POSTS) {
    fail("invalid inference reservation size");
  }
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    db.exec("BEGIN IMMEDIATE");
    const ledger = readRow(db);
    if (!samePlanBinding(ledger, expected)) {
      fail("authorization ledger does not match the immutable plan revision");
    }
    if (ledger.consumedPosts + posts > ledger.authorizedPosts) fail("inference authorization is exhausted");
    const result = db.prepare(`
      UPDATE inference_authorization
      SET consumed_posts = consumed_posts + ?
      WHERE singleton = 1 AND consumed_posts + ? <= authorized_posts
    `).run(posts, posts);
    if (result.changes !== 1) fail("inference authorization is exhausted");
    db.exec("COMMIT");
    const updated = readRow(db);
    await closeAndVerify(db, directory, ledgerPath, file);
    db = undefined;
    return updated;
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    try {
      await closeAndVerify(db, directory, ledgerPath, file);
    } catch {
      // Preserve the primary reservation error.
    }
    db = undefined;
    if (error instanceof AuthorizationLedgerError) throw error;
    fail("authorization ledger reservation failed");
  }
}

/** Atomically consumes one post and tags it as the exact Phase 0b canary attempt. */
export async function reserveCanaryInferencePost(
  location: AuthorizationLedgerLocation,
  expectedGrantInput: InferenceAuthorizationPlanBinding,
): Promise<CanaryInferenceReservation> {
  const expected = validatePlanBinding(expectedGrantInput);
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    db.exec("BEGIN IMMEDIATE");
    const ledger = readRow(db);
    if (!samePlanBinding(ledger, expected)) {
      fail("authorization ledger does not match the immutable plan revision");
    }
    if (ledger.canaryCheckpoint) fail("successful canary checkpoint already exists");
    if (ledger.consumedPosts + 1 > ledger.authorizedPosts) fail("inference authorization is exhausted");
    const reservationPost = ledger.consumedPosts + 1;
    const updated = db.prepare(`
      UPDATE inference_authorization
      SET consumed_posts = consumed_posts + 1
      WHERE singleton = 1 AND consumed_posts + 1 <= authorized_posts
    `).run();
    if (updated.changes !== 1) fail("inference authorization is exhausted");
    db.prepare(`
      INSERT INTO revisioned_inference_attempt (
        reservation_post, authorization_singleton, plan_revision, case_sequence, case_name,
        acceptance_policy_version, state, matched_singleton
      ) VALUES (?, 1, ?, ?, ?, ?, 'reserved', NULL)
    `).run(
      reservationPost,
      ledger.planRevision,
      CANARY_CASE_SEQUENCE,
      CANARY_CASE_NAME,
      CANARY_ACCEPTANCE_POLICY_VERSION,
    );
    db.exec("COMMIT");
    const committed = readRow(db);
    if (committed.consumedPosts < reservationPost || committed.canaryCheckpoint) {
      fail("canary reservation did not commit exactly");
    }
    const reservation = reservationFor(committed, reservationPost);
    await closeAndVerify(db, directory, ledgerPath, file);
    db = undefined;
    return reservation;
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    try {
      await closeAndVerify(db, directory, ledgerPath, file);
    } catch {
      // Preserve the primary reservation error.
    }
    db = undefined;
    if (error instanceof AuthorizationLedgerError) throw error;
    fail("canary inference reservation failed");
  }
}

/** Idempotently marks only the exact previously reserved canary attempt as matched. */
export async function markCanaryInferenceMatched(
  location: AuthorizationLedgerLocation,
  expectedGrantInput: InferenceAuthorizationPlanBinding,
  reservationInput: CanaryInferenceReservation,
  signal?: AbortSignal,
): Promise<CanaryCompletionCheckpoint> {
  const expected = validatePlanBinding(expectedGrantInput);
  const reservation = validateCanaryReservation(reservationInput);
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  signal?.throwIfAborted();
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    db.exec("BEGIN IMMEDIATE");
    const ledger = readRow(db);
    if (!samePlanBinding(ledger, expected) || reservation.authorizationId !== ledger.authorizationId ||
        reservation.matrixVersion !== ledger.matrixVersion || reservation.matrixHash !== ledger.matrixHash ||
        reservation.plannedInferencePosts !== ledger.plannedInferencePosts ||
        reservation.planRevision !== ledger.planRevision ||
        reservation.planRevisionDigest !== ledger.planRevisionDigest ||
        reservation.reservationPost > ledger.consumedPosts) {
      fail("canary completion does not match the immutable grant and reservation");
    }
    if (ledger.canaryCheckpoint) {
      if (ledger.canaryCheckpoint.reservationPost !== reservation.reservationPost) {
        fail("a conflicting successful canary checkpoint already exists");
      }
      db.exec("COMMIT");
      const checkpoint = ledger.canaryCheckpoint;
      await closeAndVerify(db, directory, ledgerPath, file);
      db = undefined;
      return checkpoint;
    }
    const result = db.prepare(`
      UPDATE revisioned_inference_attempt
      SET state = 'matched', matched_singleton = 1
      WHERE reservation_post = ? AND plan_revision = ?
        AND case_sequence = ? AND case_name = ? AND acceptance_policy_version = ?
        AND state = 'reserved' AND matched_singleton IS NULL
    `).run(
      reservation.reservationPost,
      reservation.planRevision,
      CANARY_CASE_SEQUENCE,
      CANARY_CASE_NAME,
      CANARY_ACCEPTANCE_POLICY_VERSION,
    );
    if (result.changes !== 1) fail("canary completion has no exact pending reservation");
    db.exec("COMMIT");
    const committed = readRow(db);
    const checkpoint = committed.canaryCheckpoint;
    if (!checkpoint || checkpoint.reservationPost !== reservation.reservationPost) {
      fail("canary completion did not commit exactly");
    }
    await closeAndVerify(db, directory, ledgerPath, file);
    db = undefined;
    return checkpoint;
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    try {
      await closeAndVerify(db, directory, ledgerPath, file);
    } catch {
      // Preserve the primary completion error.
    }
    db = undefined;
    if (error instanceof AuthorizationLedgerError) throw error;
    fail("canary completion failed");
  }
}
