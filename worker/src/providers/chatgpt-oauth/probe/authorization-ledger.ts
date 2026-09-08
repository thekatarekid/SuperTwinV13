import Database from "better-sqlite3";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const LEDGER_SCHEMA_VERSION = 2;
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
] as const;

export interface InferenceAuthorizationGrant {
  authorizationId: string;
  owner: string;
  accountFingerprint: string;
  modelId: string;
  matrixVersion: string;
  matrixHash: string;
  authorizedPosts: number;
}

export interface InferenceAuthorizationLedger extends InferenceAuthorizationGrant {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  consumedPosts: number;
  canaryCheckpoint?: CanaryCompletionCheckpoint;
}

export interface CanaryInferenceReservation {
  authorizationId: string;
  matrixVersion: string;
  matrixHash: string;
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
  "authorizationId" | "owner" | "accountFingerprint" | "modelId" | "authorizedPosts"
>;

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
    authorizedPosts: grant.authorizedPosts,
  });
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

function rowToLedger(row: unknown): InferenceAuthorizationLedger {
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
  });
  if (value.schemaVersion !== LEDGER_SCHEMA_VERSION || typeof value.consumedPosts !== "number" ||
      !Number.isSafeInteger(value.consumedPosts) || value.consumedPosts < 0 ||
      value.consumedPosts > grant.authorizedPosts) {
    fail("authorization ledger counters are invalid");
  }
  return Object.freeze({ ...grant, schemaVersion: LEDGER_SCHEMA_VERSION, consumedPosts: value.consumedPosts });
}

function readCanaryAttempts(
  db: Database.Database,
  ledger: InferenceAuthorizationLedger,
): CanaryCompletionCheckpoint | undefined {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`
      SELECT
        reservation_post AS reservationPost,
        authorization_id AS authorizationId,
        matrix_version AS matrixVersion,
        matrix_hash AS matrixHash,
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
      row.reservationPost >= 1 && row.reservationPost <= ledger.consumedPosts &&
      row.authorizationId === ledger.authorizationId &&
      row.matrixVersion === ledger.matrixVersion && row.matrixHash === ledger.matrixHash &&
      row.caseSequence === CANARY_CASE_SEQUENCE && row.caseName === CANARY_CASE_NAME &&
      row.acceptancePolicyVersion === CANARY_ACCEPTANCE_POLICY_VERSION &&
      (row.state === "reserved" || row.state === "matched") &&
      (row.state === "matched" ? row.matchedSingleton === 1 : row.matchedSingleton === null);
    if (!valid) fail("authorization ledger attempt records are corrupt");
    if (row.state === "matched") {
      if (checkpoint) fail("authorization ledger contains conflicting canary checkpoints");
      checkpoint = Object.freeze({
        authorizationId: ledger.authorizationId,
        matrixVersion: ledger.matrixVersion,
        matrixHash: ledger.matrixHash,
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

function readRow(db: Database.Database): InferenceAuthorizationLedger {
  let userVersion: number;
  let tables: Array<{ name: string }>;
  try {
    userVersion = db.pragma("user_version", { simple: true }) as number;
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  } catch {
    fail("authorization ledger schema is corrupt");
  }
  if (userVersion !== LEDGER_SCHEMA_VERSION || tables.length !== 2 ||
      tables[0]?.name !== "inference_attempt" || tables[1]?.name !== "inference_authorization") {
    fail("authorization ledger schema is unsupported");
  }
  const columns = db.pragma("table_info(inference_authorization)") as Array<{ name?: unknown }>;
  const expectedColumns = [
    "singleton",
    "schema_version",
    "authorization_id",
    "owner",
    "account_fingerprint",
    "model_id",
    "matrix_version",
    "matrix_hash",
    "authorized_posts",
    "consumed_posts",
  ];
  if (columns.length !== expectedColumns.length ||
      columns.some((column, index) => column.name !== expectedColumns[index])) {
    fail("authorization ledger schema is unsupported");
  }
  const attemptColumns = db.pragma("table_info(inference_attempt)") as Array<{ name?: unknown }>;
  const expectedAttemptColumns = [
    "reservation_post",
    "authorization_singleton",
    "authorization_id",
    "matrix_version",
    "matrix_hash",
    "case_sequence",
    "case_name",
    "acceptance_policy_version",
    "state",
    "matched_singleton",
  ];
  if (attemptColumns.length !== expectedAttemptColumns.length ||
      attemptColumns.some((column, index) => column.name !== expectedAttemptColumns[index])) {
    fail("authorization ledger schema is unsupported");
  }
  let rows: unknown[];
  try {
    rows = db.prepare(`
      SELECT
        schema_version AS schemaVersion,
        authorization_id AS authorizationId,
        owner,
        account_fingerprint AS accountFingerprint,
        model_id AS modelId,
        matrix_version AS matrixVersion,
        matrix_hash AS matrixHash,
        authorized_posts AS authorizedPosts,
        consumed_posts AS consumedPosts
      FROM inference_authorization
    `).all();
  } catch {
    fail("authorization ledger schema is corrupt");
  }
  if (rows.length !== 1) fail("authorization ledger is corrupt");
  const ledger = rowToLedger(rows[0]);
  const canaryCheckpoint = readCanaryAttempts(db, ledger);
  return Object.freeze({ ...ledger, ...(canaryCheckpoint ? { canaryCheckpoint } : {}) });
}

function sameGrant(actual: InferenceAuthorizationLedger, expected: InferenceAuthorizationGrant): boolean {
  return GRANT_KEYS.every((key) => actual[key] === expected[key]);
}

function validateBinding(value: unknown): InferenceAuthorizationBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid authorization binding");
  const binding = value as Record<string, unknown>;
  const keys = ["accountFingerprint", "authorizationId", "authorizedPosts", "modelId", "owner"];
  if (!exactKeys(binding, keys)) fail("invalid authorization binding fields");
  const placeholderGrant = validateGrant({
    ...binding,
    matrixVersion: "preflight-matrix",
    matrixHash: "0".repeat(64),
  });
  return Object.freeze({
    authorizationId: placeholderGrant.authorizationId,
    owner: placeholderGrant.owner,
    accountFingerprint: placeholderGrant.accountFingerprint,
    modelId: placeholderGrant.modelId,
    authorizedPosts: placeholderGrant.authorizedPosts,
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
    actual.authorizedPosts === expected.authorizedPosts;
}

function validateCanaryReservation(value: unknown): CanaryInferenceReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid canary reservation");
  const reservation = value as Record<string, unknown>;
  const keys = [
    "acceptancePolicyVersion", "authorizationId", "caseName", "caseSequence",
    "matrixHash", "matrixVersion", "reservationPost", "state",
  ];
  if (!exactKeys(reservation, keys)) fail("invalid canary reservation fields");
  if (typeof reservation.authorizationId !== "string" || !SAFE_TEXT.test(reservation.authorizationId) ||
      typeof reservation.matrixVersion !== "string" || !SAFE_TEXT.test(reservation.matrixVersion) ||
      typeof reservation.matrixHash !== "string" || !SHA256_HEX.test(reservation.matrixHash) ||
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
        schema_version INTEGER NOT NULL CHECK (schema_version = 2),
        authorization_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        matrix_version TEXT NOT NULL,
        matrix_hash TEXT NOT NULL,
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
    db.prepare(`
      INSERT INTO inference_authorization VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      LEDGER_SCHEMA_VERSION,
      grant.authorizationId,
      grant.owner,
      grant.accountFingerprint,
      grant.modelId,
      grant.matrixVersion,
      grant.matrixHash,
      grant.authorizedPosts,
      initialConsumedPosts,
    );
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
  expectedGrantInput: InferenceAuthorizationGrant,
  posts = 1,
): Promise<InferenceAuthorizationLedger> {
  const expected = validateGrant(expectedGrantInput);
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
    if (!sameGrant(ledger, expected)) fail("authorization ledger does not match the immutable grant");
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
  expectedGrantInput: InferenceAuthorizationGrant,
): Promise<CanaryInferenceReservation> {
  const expected = validateGrant(expectedGrantInput);
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    db.exec("BEGIN IMMEDIATE");
    const ledger = readRow(db);
    if (!sameGrant(ledger, expected)) fail("authorization ledger does not match the immutable grant");
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
      INSERT INTO inference_attempt (
        reservation_post, authorization_singleton, authorization_id, matrix_version, matrix_hash,
        case_sequence, case_name, acceptance_policy_version, state, matched_singleton
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'reserved', NULL)
    `).run(
      reservationPost,
      ledger.authorizationId,
      ledger.matrixVersion,
      ledger.matrixHash,
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
  expectedGrantInput: InferenceAuthorizationGrant,
  reservationInput: CanaryInferenceReservation,
  signal?: AbortSignal,
): Promise<CanaryCompletionCheckpoint> {
  const expected = validateGrant(expectedGrantInput);
  const reservation = validateCanaryReservation(reservationInput);
  const { ledgerPath, directory } = await resolveLocation(location);
  const file = await validateLedgerFile(ledgerPath);
  signal?.throwIfAborted();
  let db: Database.Database | undefined;
  try {
    db = openLedger(ledgerPath);
    db.exec("BEGIN IMMEDIATE");
    const ledger = readRow(db);
    if (!sameGrant(ledger, expected) || reservation.authorizationId !== ledger.authorizationId ||
        reservation.matrixVersion !== ledger.matrixVersion || reservation.matrixHash !== ledger.matrixHash ||
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
      UPDATE inference_attempt
      SET state = 'matched', matched_singleton = 1
      WHERE reservation_post = ? AND authorization_id = ? AND matrix_version = ? AND matrix_hash = ?
        AND case_sequence = ? AND case_name = ? AND acceptance_policy_version = ?
        AND state = 'reserved' AND matched_singleton IS NULL
    `).run(
      reservation.reservationPost,
      reservation.authorizationId,
      reservation.matrixVersion,
      reservation.matrixHash,
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
