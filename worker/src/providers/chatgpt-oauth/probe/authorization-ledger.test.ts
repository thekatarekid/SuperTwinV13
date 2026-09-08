import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  appendInferenceAuthorizationPlanSuccessor,
  initializeInferenceAuthorizationLedger,
  markCanaryInferenceMatched,
  readInferenceAuthorizationLedger,
  reserveCanaryInferencePost,
  reserveInferencePosts,
  type AuthorizationLedgerLocation,
  type InferenceAuthorizationGrant,
  type InferenceAuthorizationLedger,
  type InferenceAuthorizationPlanBinding,
} from "./authorization-ledger.js";

const MATRIX_HASH = "a".repeat(64);
const ROOT_MATRIX_HASH = "b02baf6834d23ad8fbaf5df4f693f3f924ce6f8787cc9173f1668995e96cac88";
const SUCCESSOR_MATRIX_HASH = "a6c50fd7c7725b65525d35db1e9ad4d3060619be5e7e405ead68cf19d2555b09";
const fixtureRoots: string[] = [];

async function fixture(authorizedPosts = 2): Promise<{
  location: AuthorizationLedgerLocation;
  grant: InferenceAuthorizationGrant;
}> {
  const root = join(tmpdir(), `supertwin-ledger-${process.pid}-${Date.now()}-${Math.random()}`);
  fixtureRoots.push(root);
  const directory = join(root, "authorization");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return {
    location: {
      ledgerPath: join(directory, "inference-authorization.sqlite"),
      superTwinHome: join(root, "supertwin-home"),
    },
    grant: {
      authorizationId: "owner-approval-2026-09-08",
      owner: "Test Owner",
      accountFingerprint: "7d41db9e5a28",
      modelId: "gpt-probe",
      matrixVersion: "phase0b-v1",
      matrixHash: MATRIX_HASH,
      plannedInferencePosts: 1,
      authorizedPosts,
    },
  };
}

async function exactV3SuccessorFixture(): Promise<{
  location: AuthorizationLedgerLocation;
  grant: InferenceAuthorizationGrant;
}> {
  const result = await fixture(55);
  result.grant = {
    ...result.grant,
    modelId: "gpt-5.6-sol",
    matrixVersion: "phase0b-contract-matrix-v1",
    matrixHash: ROOT_MATRIX_HASH,
    plannedInferencePosts: 46,
  };
  await initializeInferenceAuthorizationLedger(result.location, result.grant, 2);
  const db = new Database(result.location.ledgerPath);
  db.pragma("foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  db.exec("DROP TABLE revisioned_inference_attempt; DROP TABLE authorization_plan_revision");
  db.prepare("UPDATE inference_authorization SET consumed_posts = 3").run();
  db.prepare(`
    INSERT INTO inference_attempt (
      reservation_post, authorization_singleton, authorization_id, matrix_version, matrix_hash,
      planned_inference_posts, case_sequence, case_name, acceptance_policy_version, state, matched_singleton
    ) VALUES (3, 1, ?, ?, ?, 46, 1, 'canary.blank-context', 'phase0b-canary-success-v1', 'reserved', NULL)
  `).run(result.grant.authorizationId, result.grant.matrixVersion, result.grant.matrixHash);
  db.pragma("user_version = 3");
  db.exec("COMMIT");
  db.close();
  return result;
}

function rootBinding(grant: InferenceAuthorizationGrant) {
  const { matrixVersion: _matrixVersion, matrixHash: _matrixHash,
    plannedInferencePosts: _plannedInferencePosts, ...binding } = grant;
  return binding;
}

function predecessor() {
  return {
    revision: 1,
    matrixVersion: "phase0b-contract-matrix-v1",
    matrixHash: ROOT_MATRIX_HASH,
    plannedInferencePosts: 46,
    expectedConsumedPosts: 3,
  };
}

function successor() {
  return {
    transitionId: "transport-only-request-matrix-v2",
    matrixVersion: "phase0b-contract-matrix-v2",
    matrixHash: SUCCESSOR_MATRIX_HASH,
    plannedInferencePosts: 45,
  };
}

function planBinding(
  grant: InferenceAuthorizationGrant,
  ledger: InferenceAuthorizationLedger,
): InferenceAuthorizationPlanBinding {
  return {
    ...grant,
    planRevision: ledger.planRevision,
    planRevisionDigest: ledger.planRevisionDigest,
    planTransitionId: ledger.planTransitionId,
  };
}

async function activePlanBinding(
  location: AuthorizationLedgerLocation,
  grant: InferenceAuthorizationGrant,
): Promise<InferenceAuthorizationPlanBinding> {
  return planBinding(grant, await readInferenceAuthorizationLedger(location, grant));
}

afterAll(async () => {
  await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 0b cumulative inference authorization ledger", () => {
  it("creates a 0600 SQLite ledger with an explicit conservative starting count", async () => {
    const { location, grant } = await fixture(55);
    const ledger = await initializeInferenceAuthorizationLedger(location, grant, 2);
    expect(ledger).toMatchObject({ ...grant, schemaVersion: 4, consumedPosts: 2, planRevision: 1 });
    expect((await lstat(location.ledgerPath)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(location.ledgerPath);
    expect(bytes.subarray(0, 16).toString()).toBe("SQLite format 3\0");
    expect(bytes.toString()).not.toMatch(/access[_-]?token|refresh[_-]?token|response[_-]?id/i);
    await expect(initializeInferenceAuthorizationLedger(location, grant)).rejects.toThrow(/already exists|cannot be created/);
  });

  it("commits each reservation before returning, supports batches, and never offers rollback", async () => {
    const { location, grant } = await fixture(4);
    await initializeInferenceAuthorizationLedger(location, grant);
    const binding = await activePlanBinding(location, grant);
    expect(await reserveInferencePosts(location, binding, 3)).toMatchObject({ consumedPosts: 3 });
    expect(await reserveInferencePosts(location, binding)).toMatchObject({ consumedPosts: 4 });
    await expect(reserveInferencePosts(location, binding)).rejects.toThrow(/exhausted/);
    expect(await readInferenceAuthorizationLedger(location, grant)).toMatchObject({ consumedPosts: 4 });
    await expect(reserveInferencePosts(location, binding, 0)).rejects.toThrow(/reservation size/);
  });

  it("atomically tags canary reservations and marks only the exact pending attempt", async () => {
    const { location, grant } = await fixture(5);
    await initializeInferenceAuthorizationLedger(location, grant, 2);
    const binding = await activePlanBinding(location, grant);
    const reservation = await reserveCanaryInferencePost(location, binding);
    expect(reservation).toMatchObject({
      reservationPost: 3,
      caseSequence: 1,
      caseName: "canary.blank-context",
      acceptancePolicyVersion: "phase0b-canary-success-v1",
      plannedInferencePosts: 1,
      state: "reserved",
    });
    const reservedLedger = await readInferenceAuthorizationLedger(location, grant);
    expect(reservedLedger.consumedPosts).toBe(3);
    expect(reservedLedger.canaryCheckpoint).toBeUndefined();
    const checkpoint = await markCanaryInferenceMatched(location, binding, reservation);
    expect(checkpoint).toMatchObject({ reservationPost: 3, state: "matched" });
    await expect(markCanaryInferenceMatched(location, binding, reservation)).resolves.toEqual(checkpoint);
    expect(await readInferenceAuthorizationLedger(location, grant)).toMatchObject({
      consumedPosts: 3,
      canaryCheckpoint: checkpoint,
    });
  });

  it("leaves crashed reservations charged and refuses conflicting completion", async () => {
    const { location, grant } = await fixture(5);
    await initializeInferenceAuthorizationLedger(location, grant);
    const binding = await activePlanBinding(location, grant);
    const abandoned = await reserveCanaryInferencePost(location, binding);
    const abandonedLedger = await readInferenceAuthorizationLedger(location, grant);
    expect(abandonedLedger.consumedPosts).toBe(1);
    expect(abandonedLedger.canaryCheckpoint).toBeUndefined();
    const winner = await reserveCanaryInferencePost(location, binding);
    await expect(markCanaryInferenceMatched(location, binding, winner)).resolves.toMatchObject({
      reservationPost: 2,
      state: "matched",
    });
    await expect(markCanaryInferenceMatched(location, binding, abandoned)).rejects.toThrow(/conflicting/);
    expect((await readInferenceAuthorizationLedger(location, grant)).consumedPosts).toBe(2);
  });

  it("refuses fabricated or altered completion claims without changing cumulative consumption", async () => {
    const { location, grant } = await fixture(4);
    await initializeInferenceAuthorizationLedger(location, grant);
    const binding = await activePlanBinding(location, grant);
    await reserveInferencePosts(location, binding);
    const active = await readInferenceAuthorizationLedger(location, grant);
    const fabricated = {
      authorizationId: grant.authorizationId,
      matrixVersion: grant.matrixVersion,
      matrixHash: grant.matrixHash,
      plannedInferencePosts: grant.plannedInferencePosts,
      planRevision: active.planRevision,
      planRevisionDigest: active.planRevisionDigest,
      reservationPost: 1,
      caseSequence: 1 as const,
      caseName: "canary.blank-context" as const,
      acceptancePolicyVersion: "phase0b-canary-success-v1" as const,
      state: "reserved" as const,
    };
    await expect(markCanaryInferenceMatched(location, binding, fabricated)).rejects.toThrow(/no exact pending reservation/);
    expect((await readInferenceAuthorizationLedger(location, grant)).consumedPosts).toBe(1);

    const reservation = await reserveCanaryInferencePost(location, binding);
    await expect(markCanaryInferenceMatched(location, binding, {
      ...reservation,
      authorizationId: "different-authorization",
    })).rejects.toThrow(/immutable grant and reservation/);
    await expect(markCanaryInferenceMatched(location, binding, {
      ...reservation,
      plannedInferencePosts: 2,
    })).rejects.toThrow(/immutable grant and reservation/);
    await expect(markCanaryInferenceMatched(location, {
      ...binding,
      owner: "Different Owner",
    }, reservation)).rejects.toThrow(/immutable grant/);
    expect((await readInferenceAuthorizationLedger(location, grant)).canaryCheckpoint).toBeUndefined();
    expect((await readInferenceAuthorizationLedger(location, grant)).consumedPosts).toBe(2);
  });

  it("serializes competing tagged attempts and permits exactly one matched checkpoint", async () => {
    const { location, grant } = await fixture(2);
    await initializeInferenceAuthorizationLedger(location, grant);
    const binding = await activePlanBinding(location, grant);
    const reservations = await Promise.all([
      reserveCanaryInferencePost(location, binding),
      reserveCanaryInferencePost(location, binding),
    ]);
    expect(reservations.map(({ reservationPost }) => reservationPost).sort()).toEqual([1, 2]);
    const completions = await Promise.allSettled(
      reservations.map((reservation) => markCanaryInferenceMatched(location, binding, reservation)),
    );
    expect(completions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(completions.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const ledger = await readInferenceAuthorizationLedger(location, grant);
    expect(ledger.consumedPosts).toBe(2);
    expect(reservations.map(({ reservationPost }) => reservationPost)).toContain(
      ledger.canaryCheckpoint?.reservationPost,
    );
  });

  it("refuses a corrupt tagged-attempt row without resetting the ledger", async () => {
    const { location, grant } = await fixture(2);
    await initializeInferenceAuthorizationLedger(location, grant);
    await reserveCanaryInferencePost(location, await activePlanBinding(location, grant));
    const db = new Database(location.ledgerPath);
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE revisioned_inference_attempt SET case_name = 'corrupt-case'").run();
    db.close();
    await expect(readInferenceAuthorizationLedger(location, grant)).rejects.toThrow(/authorization attempts are corrupt/);
  });

  it("refuses schema v2 explicitly without migrating or resetting it", async () => {
    const { location, grant } = await fixture(3);
    await initializeInferenceAuthorizationLedger(location, grant, 2);
    const db = new Database(location.ledgerPath);
    db.pragma("user_version = 2");
    db.close();
    await expect(readInferenceAuthorizationLedger(location, grant)).rejects.toThrow(/schema is unsupported/);
    const inspect = new Database(location.ledgerPath, { readonly: true });
    expect((inspect.prepare("SELECT consumed_posts FROM inference_authorization").get() as {
      consumed_posts: number;
    }).consumed_posts).toBe(2);
    inspect.close();
  });

  it("upgrades the exact schema-v3 3/55 predecessor by appending a revision without rewriting its root or attempt", async () => {
    const { location, grant } = await exactV3SuccessorFixture();
    await expect(readInferenceAuthorizationLedger(location, {
      ...grant,
      matrixVersion: successor().matrixVersion,
      matrixHash: successor().matrixHash,
      plannedInferencePosts: successor().plannedInferencePosts,
    })).rejects.toThrow(/schema is unsupported/);

    const ledger = await appendInferenceAuthorizationPlanSuccessor(
      location,
      rootBinding(grant),
      predecessor(),
      successor(),
    );
    expect(ledger).toMatchObject({
      schemaVersion: 4,
      authorizedPosts: 55,
      consumedPosts: 3,
      planRevision: 2,
      planTransitionId: "transport-only-request-matrix-v2",
      matrixVersion: "phase0b-contract-matrix-v2",
      matrixHash: SUCCESSOR_MATRIX_HASH,
      plannedInferencePosts: 45,
    });
    expect(ledger.canaryCheckpoint).toBeUndefined();

    const db = new Database(location.ledgerPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    expect(db.prepare(`
      SELECT schema_version AS schemaVersion, matrix_version AS matrixVersion,
        matrix_hash AS matrixHash, planned_inference_posts AS plannedInferencePosts,
        authorized_posts AS authorizedPosts, consumed_posts AS consumedPosts
      FROM inference_authorization
    `).get()).toEqual({
      schemaVersion: 3,
      matrixVersion: grant.matrixVersion,
      matrixHash: grant.matrixHash,
      plannedInferencePosts: 46,
      authorizedPosts: 55,
      consumedPosts: 3,
    });
    expect(db.prepare("SELECT * FROM inference_attempt").all()).toHaveLength(1);
    expect(db.prepare("SELECT reservation_post, state FROM inference_attempt").get())
      .toEqual({ reservation_post: 3, state: "reserved" });
    expect(db.prepare("SELECT revision FROM authorization_plan_revision ORDER BY revision").all())
      .toEqual([{ revision: 1 }, { revision: 2 }]);
    db.close();
  });

  it("rejects altered roots, predecessors, boundaries and missing legacy attempts atomically", async () => {
    for (const mutate of [
      (grant: InferenceAuthorizationGrant) => ({ root: { ...rootBinding(grant), owner: "Other Owner" },
        predecessor: predecessor() }),
      (grant: InferenceAuthorizationGrant) => ({ root: rootBinding(grant),
        predecessor: { ...predecessor(), matrixHash: "c".repeat(64) } }),
      (grant: InferenceAuthorizationGrant) => ({ root: rootBinding(grant),
        predecessor: { ...predecessor(), expectedConsumedPosts: 2 } }),
    ]) {
      const { location, grant } = await exactV3SuccessorFixture();
      const changed = mutate(grant);
      await expect(appendInferenceAuthorizationPlanSuccessor(
        location,
        changed.root,
        changed.predecessor,
        successor(),
      )).rejects.toThrow(/REFUSED/);
      const db = new Database(location.ledgerPath, { readonly: true });
      expect(db.pragma("user_version", { simple: true })).toBe(3);
      expect(db.prepare("SELECT consumed_posts FROM inference_authorization").get())
        .toEqual({ consumed_posts: 3 });
      expect(db.prepare("SELECT reservation_post, state FROM inference_attempt").get())
        .toEqual({ reservation_post: 3, state: "reserved" });
      db.close();
    }

    const missingAttempt = await exactV3SuccessorFixture();
    const db = new Database(missingAttempt.location.ledgerPath);
    db.prepare("DELETE FROM inference_attempt").run();
    db.close();
    await expect(appendInferenceAuthorizationPlanSuccessor(
      missingAttempt.location,
      rootBinding(missingAttempt.grant),
      predecessor(),
      successor(),
    )).rejects.toThrow(/exact latest unmatched canary attempt/);
  });

  it("serializes competing successor appends and keeps a deterministic unbranched digest chain", async () => {
    const { location, grant } = await exactV3SuccessorFixture();
    const results = await Promise.allSettled([
      appendInferenceAuthorizationPlanSuccessor(location, rootBinding(grant), predecessor(), successor()),
      appendInferenceAuthorizationPlanSuccessor(location, rootBinding(grant), predecessor(), successor()),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const winner = results.find(({ status }) => status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof appendInferenceAuthorizationPlanSuccessor>>
    >;
    expect(winner.value.planRevisionDigest).toMatch(/^[a-f0-9]{64}$/);
    const db = new Database(location.ledgerPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM authorization_plan_revision").get())
      .toEqual({ count: 2 });
    expect(db.prepare("SELECT authorized_posts, consumed_posts FROM inference_authorization").get())
      .toEqual({ authorized_posts: 55, consumed_posts: 3 });
    db.close();
  });

  it("refuses a tampered revision digest without consuming or rewriting authorization", async () => {
    const { location, grant } = await exactV3SuccessorFixture();
    const appended = await appendInferenceAuthorizationPlanSuccessor(
      location, rootBinding(grant), predecessor(), successor(),
    );
    const activeBinding = planBinding({
      ...grant,
      matrixVersion: successor().matrixVersion,
      matrixHash: successor().matrixHash,
      plannedInferencePosts: successor().plannedInferencePosts,
    }, appended);
    const db = new Database(location.ledgerPath);
    db.prepare("UPDATE authorization_plan_revision SET revision_digest = ? WHERE revision = 2")
      .run("e".repeat(64));
    db.close();
    const activeGrant = {
      ...grant,
      matrixVersion: successor().matrixVersion,
      matrixHash: successor().matrixHash,
      plannedInferencePosts: successor().plannedInferencePosts,
    };
    await expect(readInferenceAuthorizationLedger(location, activeGrant)).rejects.toThrow(/digest is invalid/);
    await expect(reserveInferencePosts(location, activeBinding)).rejects.toThrow(/digest is invalid/);
    const inspect = new Database(location.ledgerPath, { readonly: true });
    expect(inspect.prepare("SELECT authorized_posts, consumed_posts FROM inference_authorization").get())
      .toEqual({ authorized_posts: 55, consumed_posts: 3 });
    inspect.close();
  });

  it("rolls back an interrupted upgrade transaction and permits the exact append after writer death", async () => {
    const { location, grant } = await exactV3SuccessorFixture();
    const script = `
      import Database from "better-sqlite3";
      const db = new Database(process.env.LEDGER_PATH, { fileMustExist: true, timeout: 0 });
      db.exec("BEGIN IMMEDIATE");
      db.exec("CREATE TABLE interrupted_upgrade (value INTEGER) STRICT");
      globalThis.__ledgerDb = db;
      process.stdout.write("READY\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, LEDGER_PATH: location.ledgerPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ready = Promise.race([
        once(child.stdout!, "data"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not lock ledger")), 5_000)),
      ]);
      expect(String((await ready)[0])).toContain("READY");
      await expect(appendInferenceAuthorizationPlanSuccessor(
        location, rootBinding(grant), predecessor(), successor(),
      )).rejects.toThrow(/cannot be opened|append failed/);
      child.kill("SIGKILL");
      await once(child, "exit");
      await expect(appendInferenceAuthorizationPlanSuccessor(
        location, rootBinding(grant), predecessor(), successor(),
      )).resolves.toMatchObject({ planRevision: 2, consumedPosts: 3 });
      const db = new Database(location.ledgerPath, { readonly: true });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'interrupted_upgrade'").get())
        .toBeUndefined();
      db.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("binds reservations and checkpoints to the active revision and never reuses them after a successor", async () => {
    const { location, grant } = await exactV3SuccessorFixture();
    const revisionTwo = await appendInferenceAuthorizationPlanSuccessor(
      location, rootBinding(grant), predecessor(), successor(),
    );
    const revisionTwoGrant = {
      ...grant,
      matrixVersion: revisionTwo.matrixVersion,
      matrixHash: revisionTwo.matrixHash,
      plannedInferencePosts: revisionTwo.plannedInferencePosts,
    };
    const revisionTwoBinding = planBinding(revisionTwoGrant, revisionTwo);
    const reservation = await reserveCanaryInferencePost(location, revisionTwoBinding);
    expect(reservation).toMatchObject({ reservationPost: 4, planRevision: 2 });
    await markCanaryInferenceMatched(location, revisionTwoBinding, reservation);
    const revisionThree = await appendInferenceAuthorizationPlanSuccessor(
      location,
      rootBinding(grant),
      {
        revision: 2,
        matrixVersion: successor().matrixVersion,
        matrixHash: successor().matrixHash,
        plannedInferencePosts: successor().plannedInferencePosts,
        expectedConsumedPosts: 4,
      },
      {
        transitionId: "transport-only-request-matrix-v3-test",
        matrixVersion: "phase0b-contract-matrix-v3-test",
        matrixHash: "d".repeat(64),
        plannedInferencePosts: 44,
      },
    );
    expect(revisionThree).toMatchObject({ planRevision: 3, consumedPosts: 4 });
    expect(revisionThree.canaryCheckpoint).toBeUndefined();
    await expect(markCanaryInferenceMatched(location, revisionTwoBinding, reservation))
      .rejects.toThrow(/immutable grant|reservation/);
  });

  it("refuses stale ordinary and canary reservations after an A-to-B-to-A plan cycle", async () => {
    const { location, grant } = await fixture(5);
    const revisionOne = await initializeInferenceAuthorizationLedger(location, grant);
    const stale = planBinding(grant, revisionOne);
    const revisionTwo = await appendInferenceAuthorizationPlanSuccessor(
      location,
      rootBinding(grant),
      {
        revision: 1,
        matrixVersion: grant.matrixVersion,
        matrixHash: grant.matrixHash,
        plannedInferencePosts: grant.plannedInferencePosts,
        expectedConsumedPosts: 0,
      },
      {
        transitionId: "cycle-to-plan-b",
        matrixVersion: "phase0b-plan-b",
        matrixHash: "b".repeat(64),
        plannedInferencePosts: 2,
      },
    );
    const revisionThree = await appendInferenceAuthorizationPlanSuccessor(
      location,
      rootBinding(grant),
      {
        revision: 2,
        matrixVersion: revisionTwo.matrixVersion,
        matrixHash: revisionTwo.matrixHash,
        plannedInferencePosts: revisionTwo.plannedInferencePosts,
        expectedConsumedPosts: 0,
      },
      {
        transitionId: "cycle-back-to-plan-a",
        matrixVersion: grant.matrixVersion,
        matrixHash: grant.matrixHash,
        plannedInferencePosts: grant.plannedInferencePosts,
      },
    );

    await expect(reserveInferencePosts(location, stale)).rejects.toThrow(/immutable plan revision/);
    await expect(reserveCanaryInferencePost(location, stale)).rejects.toThrow(/immutable plan revision/);
    expect((await readInferenceAuthorizationLedger(location, grant)).consumedPosts).toBe(0);
    const inspect = new Database(location.ledgerPath, { readonly: true });
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM revisioned_inference_attempt").get())
      .toEqual({ count: 0 });
    inspect.close();

    const current = planBinding(grant, revisionThree);
    await expect(reserveInferencePosts(location, current)).resolves.toMatchObject({ consumedPosts: 1 });
    await expect(reserveCanaryInferencePost(location, current)).resolves.toMatchObject({
      reservationPost: 2,
      planRevision: 3,
      planRevisionDigest: revisionThree.planRevisionDigest,
    });
  });

  it("serializes SQLite writers and recovers after an abandoned transaction", async () => {
    const { location, grant } = await fixture(1);
    await initializeInferenceAuthorizationLedger(location, grant);
    const binding = await activePlanBinding(location, grant);
    const blocker = new Database(location.ledgerPath, { fileMustExist: true, timeout: 0 });
    blocker.pragma("busy_timeout = 0");
    blocker.exec("BEGIN IMMEDIATE");
    await expect(reserveInferencePosts(location, binding)).rejects.toThrow(/reservation failed|locked/);
    blocker.close(); // Closing an uncommitted connection models process-death rollback/release.
    expect(await reserveInferencePosts(location, binding)).toMatchObject({ consumedPosts: 1 });
    const results = await Promise.allSettled([
      reserveInferencePosts(location, binding),
      reserveInferencePosts(location, binding),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("recovers after a separate process dies while holding the write transaction", async () => {
    const { location, grant } = await fixture(1);
    await initializeInferenceAuthorizationLedger(location, grant);
    const binding = await activePlanBinding(location, grant);
    const script = `
      import Database from "better-sqlite3";
      const db = new Database(process.env.LEDGER_PATH, { fileMustExist: true, timeout: 0 });
      db.exec("BEGIN IMMEDIATE");
      globalThis.__ledgerDb = db;
      process.stdout.write(db.inTransaction ? "READY\\n" : "FAILED\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, LEDGER_PATH: location.ledgerPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ready = Promise.race([
        once(child.stdout!, "data"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not lock ledger")), 5_000)),
      ]);
      expect(String((await ready)[0])).toContain("READY");
      await expect(reserveInferencePosts(location, binding)).rejects.toThrow(/cannot be opened|reservation failed/);
      child.kill("SIGKILL");
      await once(child, "exit");
      expect(await reserveInferencePosts(location, binding)).toMatchObject({ consumedPosts: 1 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("rejects malformed hashes, extra grant fields, immutable drift, and corrupt schemas", async () => {
    const malformed = await fixture();
    await expect(initializeInferenceAuthorizationLedger(malformed.location, {
      ...malformed.grant,
      matrixHash: "not-a-sha256",
    })).rejects.toThrow(/grant values/);
    await expect(initializeInferenceAuthorizationLedger(malformed.location, {
      ...malformed.grant,
      plannedInferencePosts: 56,
    })).rejects.toThrow(/grant values/);
    const extra = await fixture();
    await expect(initializeInferenceAuthorizationLedger(
      extra.location,
      { ...extra.grant, accessToken: "must-not-persist" } as InferenceAuthorizationGrant,
    )).rejects.toThrow(/grant fields/);

    const drift = await fixture();
    await initializeInferenceAuthorizationLedger(drift.location, drift.grant);
    await expect(readInferenceAuthorizationLedger(drift.location, {
      ...drift.grant,
      matrixHash: "b".repeat(64),
    })).rejects.toThrow(/immutable grant/);
    await expect(readInferenceAuthorizationLedger(drift.location, {
      ...drift.grant,
      plannedInferencePosts: 2,
    })).rejects.toThrow(/immutable grant/);

    const corrupt = await fixture();
    await writeFile(corrupt.location.ledgerPath, "not sqlite", { mode: 0o600 });
    await expect(readInferenceAuthorizationLedger(corrupt.location, corrupt.grant)).rejects.toThrow(/cannot be opened|corrupt/);

    const extraColumn = await fixture();
    await initializeInferenceAuthorizationLedger(extraColumn.location, extraColumn.grant);
    const db = new Database(extraColumn.location.ledgerPath);
    db.exec("ALTER TABLE inference_authorization ADD COLUMN unexpected TEXT");
    db.close();
    await expect(readInferenceAuthorizationLedger(extraColumn.location, extraColumn.grant))
      .rejects.toThrow(/schema is unsupported/);
  });

  it("uses the canonical owner-only directory and refuses insecure files or SuperTwin-home placement", async () => {
    const insecureDirectory = await fixture();
    await chmod(join(insecureDirectory.location.ledgerPath, ".."), 0o755);
    await expect(initializeInferenceAuthorizationLedger(insecureDirectory.location, insecureDirectory.grant))
      .rejects.toThrow(/owner-only/);

    const inside = await fixture();
    inside.location.superTwinHome = join(inside.location.ledgerPath, "..");
    await expect(initializeInferenceAuthorizationLedger(inside.location, inside.grant))
      .rejects.toThrow(/outside SuperTwin home/);

    const insecureFile = await fixture();
    await initializeInferenceAuthorizationLedger(insecureFile.location, insecureFile.grant);
    await chmod(insecureFile.location.ledgerPath, 0o644);
    await expect(readInferenceAuthorizationLedger(insecureFile.location, insecureFile.grant))
      .rejects.toThrow(/secure owner-only/);

    const linked = await fixture();
    const target = `${linked.location.ledgerPath}.target`;
    await writeFile(target, "not sqlite", { mode: 0o600 });
    await symlink(target, linked.location.ledgerPath);
    await expect(readInferenceAuthorizationLedger(linked.location, linked.grant))
      .rejects.toThrow(/secure owner-only/);

    const throughParentLink = await fixture();
    const realDirectory = await realpath(join(throughParentLink.location.ledgerPath, ".."));
    const alias = join(realDirectory, "..", "authorization-alias");
    await symlink(realDirectory, alias);
    throughParentLink.location.ledgerPath = join(alias, "canonical.sqlite");
    await initializeInferenceAuthorizationLedger(throughParentLink.location, throughParentLink.grant);
    expect(await readInferenceAuthorizationLedger(throughParentLink.location, throughParentLink.grant))
      .toMatchObject({ consumedPosts: 0 });
  });

  it("is wired only into inference-capable live entry points", async () => {
    const liveAuthorization = await readFile(new URL("live-authorization.ts", import.meta.url), "utf8");
    const discovery = await readFile(new URL("discovery-runner.ts", import.meta.url), "utf8");
    expect(liveAuthorization).toContain("readInferenceAuthorizationBinding");
    expect(liveAuthorization).toContain("reserveInferencePosts");
    expect(discovery).not.toContain("live-authorization");
    expect(discovery).not.toContain("reserveInferencePosts");
  });
});
