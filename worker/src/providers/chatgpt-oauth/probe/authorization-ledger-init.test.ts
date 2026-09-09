import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV } from "./account.js";
import {
  AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV,
  AUTHORIZATION_EXPECTED_CONSUMED_POSTS_ENV,
  AUTHORIZATION_MATRIX_HASH_ENV,
  AUTHORIZATION_MATRIX_VERSION_ENV,
  AUTHORIZATION_PREDECESSOR_MATRIX_HASH_ENV,
  AUTHORIZATION_PREDECESSOR_MATRIX_VERSION_ENV,
  AUTHORIZATION_PREDECESSOR_PLANNED_INFERENCE_POSTS_ENV,
  AUTHORIZATION_PREDECESSOR_REVISION_ENV,
  AUTHORIZATION_SUCCESSOR_MATRIX_HASH_ENV,
  AUTHORIZATION_SUCCESSOR_MATRIX_VERSION_ENV,
  AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS_ENV,
  AUTHORIZATION_SUCCESSOR_TRANSITION_ID_ENV,
  INITIAL_AUTHORIZATION_MATRIX_VERSION,
  INITIAL_AUTHORIZATION_MATRIX_HASH,
  SUCCESSOR_AUTHORIZATION_MATRIX_HASH,
  appendInferenceAuthorizationPlanSuccessorFromEnvironment,
  CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS,
  initializeInferenceAuthorizationFromEnvironment,
} from "./authorization-ledger-init.js";
import { appendInferenceAuthorizationPlanSuccessor, readInferenceAuthorizationLedger,
  reserveInferencePosts } from "./authorization-ledger.js";
import { runProbeCli } from "./cli.js";
import { FULL_PROBE_INFERENCE_POST_BUDGET } from "./constants.js";
import {
  AUTHORIZATION_ID_ENV,
  AUTHORIZATION_LEDGER_PATH_ENV,
  AUTHORIZATION_OWNER_ENV,
  AUTHORIZED_INFERENCE_POSTS_ENV,
  AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV,
} from "./live-authorization.js";
import { REQUESTED_PROBE_MODEL_ENV } from "./models.js";

const roots = new Set<string>();
const MATRIX_HASH = "b02baf6834d23ad8fbaf5df4f693f3f924ce6f8787cc9173f1668995e96cac88";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function initializationEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "supertwin-ledger-init-"));
  roots.add(root);
  const directory = join(root, "owner-only");
  await mkdir(directory, { mode: 0o700 });
  return {
    SUPERTWIN_HOME: join(root, "supertwin-home"),
    [AUTHORIZATION_LEDGER_PATH_ENV]: join(directory, "inference-authorization.sqlite"),
    [AUTHORIZATION_ID_ENV]: "owner-approval-2026-09-08",
    [AUTHORIZATION_OWNER_ENV]: "Aditya Katare",
    [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: "7d41db9e5a28",
    [REQUESTED_PROBE_MODEL_ENV]: "gpt-5.6-sol",
    [AUTHORIZATION_MATRIX_VERSION_ENV]: INITIAL_AUTHORIZATION_MATRIX_VERSION,
    [AUTHORIZATION_MATRIX_HASH_ENV]: MATRIX_HASH,
    [AUTHORIZED_INFERENCE_POSTS_ENV]: String(FULL_PROBE_INFERENCE_POST_BUDGET),
    [AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV]: String(CURRENT_AUTHORIZED_PLANNED_INFERENCE_POSTS),
    [AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV]: "2",
  };
}

async function successorEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await initializationEnv();
  await initializeInferenceAuthorizationFromEnvironment(env);
  const db = new Database(env[AUTHORIZATION_LEDGER_PATH_ENV]!);
  db.pragma("foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  db.exec("DROP TABLE revisioned_inference_attempt; DROP TABLE authorization_plan_revision");
  db.prepare("UPDATE inference_authorization SET consumed_posts = 3").run();
  db.prepare(`
    INSERT INTO inference_attempt (
      reservation_post, authorization_singleton, authorization_id, matrix_version, matrix_hash,
      planned_inference_posts, case_sequence, case_name, acceptance_policy_version, state, matched_singleton
    ) VALUES (3, 1, ?, ?, ?, 46, 1, 'canary.blank-context', 'phase0b-canary-success-v1', 'reserved', NULL)
  `).run(
    env[AUTHORIZATION_ID_ENV],
    INITIAL_AUTHORIZATION_MATRIX_VERSION,
    INITIAL_AUTHORIZATION_MATRIX_HASH,
  );
  db.pragma("user_version = 3");
  db.exec("COMMIT");
  db.close();
  const location = { ledgerPath: env[AUTHORIZATION_LEDGER_PATH_ENV]!, superTwinHome: env.SUPERTWIN_HOME! };
  const baseGrant = { authorizationId: env[AUTHORIZATION_ID_ENV]!, owner: env[AUTHORIZATION_OWNER_ENV]!,
    accountFingerprint: env[EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]!, modelId: env[REQUESTED_PROBE_MODEL_ENV]!,
    authorizedPosts: FULL_PROBE_INFERENCE_POST_BUDGET };
  await appendInferenceAuthorizationPlanSuccessor(location, baseGrant,
    { revision: 1, matrixVersion: INITIAL_AUTHORIZATION_MATRIX_VERSION, matrixHash: INITIAL_AUTHORIZATION_MATRIX_HASH,
      plannedInferencePosts: 46, expectedConsumedPosts: 3 },
    { transitionId: "transport-only-request-matrix-v2", matrixVersion: "phase0b-contract-matrix-v2",
      matrixHash: "a6c50fd7c7725b65525d35db1e9ad4d3060619be5e7e405ead68cf19d2555b09", plannedInferencePosts: 45 });
  const v2Grant = { ...baseGrant, matrixVersion: "phase0b-contract-matrix-v2",
    matrixHash: "a6c50fd7c7725b65525d35db1e9ad4d3060619be5e7e405ead68cf19d2555b09",
    plannedInferencePosts: 45 };
  const active = await readInferenceAuthorizationLedger(location, v2Grant);
  const binding = { ...v2Grant, planRevision: active.planRevision, planRevisionDigest: active.planRevisionDigest,
    planTransitionId: active.planTransitionId! };
  await reserveInferencePosts(location, binding, 1);
  await reserveInferencePosts(location, binding, 1);
  await appendInferenceAuthorizationPlanSuccessor(location, baseGrant,
    { revision: 2, matrixVersion: "phase0b-contract-matrix-v2",
      matrixHash: "a6c50fd7c7725b65525d35db1e9ad4d3060619be5e7e405ead68cf19d2555b09",
      plannedInferencePosts: 45, expectedConsumedPosts: 5 },
    { transitionId: "request-matrix-v3-production-canary", matrixVersion: "phase0b-contract-matrix-v3",
      matrixHash: "5bcf8cfc86f44bcb16e26b78522d096deaf1527cef32f2b3b37503dbbed2dfd9",
      plannedInferencePosts: 45 });
  const v3Grant = { ...baseGrant, matrixVersion: "phase0b-contract-matrix-v3",
    matrixHash: "5bcf8cfc86f44bcb16e26b78522d096deaf1527cef32f2b3b37503dbbed2dfd9",
    plannedInferencePosts: 45 };
  const v3Active = await readInferenceAuthorizationLedger(location, v3Grant);
  const v3Binding = { ...v3Grant, planRevision: v3Active.planRevision,
    planRevisionDigest: v3Active.planRevisionDigest, planTransitionId: v3Active.planTransitionId! };
  await reserveInferencePosts(location, v3Binding, 8);
  // The attended run removes its scratch home. A successor is deliberately
  // allowed to bind a new empty owner-only scratch; the durable ledger is
  // external and binds the grant/revision rather than a disposable pathname.
  const successorHome = join(dirname(env[AUTHORIZATION_LEDGER_PATH_ENV]!), "..", "fresh-resume-home");
  await mkdir(successorHome, { mode: 0o700 });
  return {
    ...env,
    SUPERTWIN_HOME: successorHome,
    [AUTHORIZATION_PREDECESSOR_REVISION_ENV]: "3",
    [AUTHORIZATION_PREDECESSOR_MATRIX_VERSION_ENV]: "phase0b-contract-matrix-v3",
    [AUTHORIZATION_PREDECESSOR_MATRIX_HASH_ENV]: "5bcf8cfc86f44bcb16e26b78522d096deaf1527cef32f2b3b37503dbbed2dfd9",
    [AUTHORIZATION_PREDECESSOR_PLANNED_INFERENCE_POSTS_ENV]: "45",
    [AUTHORIZATION_EXPECTED_CONSUMED_POSTS_ENV]: "13",
    [AUTHORIZATION_SUCCESSOR_TRANSITION_ID_ENV]: "request-matrix-v4-continuation-fail-closed",
    [AUTHORIZATION_SUCCESSOR_MATRIX_VERSION_ENV]: "phase0b-contract-matrix-v4",
    [AUTHORIZATION_SUCCESSOR_MATRIX_HASH_ENV]: SUCCESSOR_AUTHORIZATION_MATRIX_HASH,
    [AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS_ENV]: "37",
  };
}

function grant(env: NodeJS.ProcessEnv) {
  return {
    authorizationId: env[AUTHORIZATION_ID_ENV]!,
    owner: env[AUTHORIZATION_OWNER_ENV]!,
    accountFingerprint: env[EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]!,
    modelId: env[REQUESTED_PROBE_MODEL_ENV]!,
    matrixVersion: env[AUTHORIZATION_MATRIX_VERSION_ENV]!,
    matrixHash: env[AUTHORIZATION_MATRIX_HASH_ENV]!,
    plannedInferencePosts: Number(env[AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV]),
    authorizedPosts: Number(env[AUTHORIZED_INFERENCE_POSTS_ENV]),
  };
}

describe("Phase 0b offline authorization ledger initializer", () => {
  it("creates the exact 55-post cap and 46-post plan at cumulative count 2 without network access", async () => {
    const env = await initializationEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(initializeInferenceAuthorizationFromEnvironment(env)).resolves.toEqual({
      status: "authorization-ledger-created",
      accountFingerprint: "7d41db9e5a28",
      modelId: "gpt-5.6-sol",
      matrixVersion: INITIAL_AUTHORIZATION_MATRIX_VERSION,
      matrixHash: MATRIX_HASH,
      plannedInferencePosts: 46,
      authorizedPosts: 55,
      consumedPosts: 2,
      remainingPosts: 53,
      networkCalls: 0,
      createOnce: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await lstat(env[AUTHORIZATION_LEDGER_PATH_ENV]!)).mode & 0o777).toBe(0o600);
    await expect(readInferenceAuthorizationLedger({
      ledgerPath: env[AUTHORIZATION_LEDGER_PATH_ENV]!,
      superTwinHome: env.SUPERTWIN_HOME!,
    }, grant(env))).resolves.toMatchObject({ consumedPosts: 2 });
  });

  it("is create-once and leaves inode, bytes, and cumulative counter unchanged on a second attempt", async () => {
    const env = await initializationEnv();
    await initializeInferenceAuthorizationFromEnvironment(env);
    const path = env[AUTHORIZATION_LEDGER_PATH_ENV]!;
    const beforeStat = await lstat(path);
    const beforeBytes = await readFile(path);

    await expect(initializeInferenceAuthorizationFromEnvironment(env)).rejects.toThrow(
      /already exists|cannot be created/,
    );

    const afterStat = await lstat(path);
    expect({ dev: afterStat.dev, ino: afterStat.ino }).toEqual({ dev: beforeStat.dev, ino: beforeStat.ino });
    expect(await readFile(path)).toEqual(beforeBytes);
    await expect(readInferenceAuthorizationLedger({
      ledgerPath: path,
      superTwinHome: env.SUPERTWIN_HOME!,
    }, grant(env))).resolves.toMatchObject({ consumedPosts: 2 });
  });

  it.each([
    AUTHORIZATION_LEDGER_PATH_ENV,
    "SUPERTWIN_HOME",
    AUTHORIZATION_ID_ENV,
    AUTHORIZATION_OWNER_ENV,
    EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV,
    REQUESTED_PROBE_MODEL_ENV,
    AUTHORIZATION_MATRIX_VERSION_ENV,
    AUTHORIZATION_MATRIX_HASH_ENV,
    AUTHORIZED_INFERENCE_POSTS_ENV,
    AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV,
    AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV,
  ])("requires explicit %s before creating a ledger", async (missing) => {
    const env = await initializationEnv();
    const path = env[AUTHORIZATION_LEDGER_PATH_ENV]!;
    delete env[missing];
    await expect(initializeInferenceAuthorizationFromEnvironment(env)).rejects.toThrow(/REFUSED/);
    if (missing !== AUTHORIZATION_LEDGER_PATH_ENV) {
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    [AUTHORIZED_INFERENCE_POSTS_ENV, "54", /must explicitly equal 55/],
    [AUTHORIZED_INFERENCE_POSTS_ENV, "56", /must explicitly equal 55/],
    [AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV, "45", /must explicitly equal 46/],
    [AUTHORIZED_PLANNED_INFERENCE_POSTS_ENV, "47", /must explicitly equal 46/],
    [AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV, "0", /must explicitly equal 2/],
    [AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV, "3", /must explicitly equal 2/],
    [AUTHORIZATION_MATRIX_VERSION_ENV, "phase0b-contract-matrix-v2", /must equal/],
    [AUTHORIZATION_MATRIX_HASH_ENV, "not-a-hash", /must explicitly equal/],
  ])("refuses invalid exact binding %s=%s", async (name, value, message) => {
    const env = await initializationEnv();
    env[name] = value;
    await expect(initializeInferenceAuthorizationFromEnvironment(env)).rejects.toThrow(message);
  });

  it("requires a pre-existing owner-only ledger directory and absolute paths", async () => {
    const insecure = await initializationEnv();
    await chmod(join(insecure[AUTHORIZATION_LEDGER_PATH_ENV]!, ".."), 0o755);
    await expect(initializeInferenceAuthorizationFromEnvironment(insecure)).rejects.toThrow(/owner-only/);

    const missing = await initializationEnv();
    missing[AUTHORIZATION_LEDGER_PATH_ENV] = join(
      missing[AUTHORIZATION_LEDGER_PATH_ENV]!,
      "missing",
      "authorization.sqlite",
    );
    await expect(initializeInferenceAuthorizationFromEnvironment(missing)).rejects.toThrow(/unavailable/);

    const relative = await initializationEnv();
    relative[AUTHORIZATION_LEDGER_PATH_ENV] = "relative.sqlite";
    await expect(initializeInferenceAuthorizationFromEnvironment(relative)).rejects.toThrow(/absolute paths/);
  });

  it("appends matrix v4 offline while preserving 13/55 and path-free evidence", async () => {
    const env = await successorEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(appendInferenceAuthorizationPlanSuccessorFromEnvironment(env)).resolves.toEqual({
      status: "authorization-plan-successor-appended",
      accountFingerprint: "7d41db9e5a28",
      modelId: "gpt-5.6-sol",
      planRevision: 4,
      planTransitionId: "request-matrix-v4-continuation-fail-closed",
      matrixVersion: "phase0b-contract-matrix-v4",
      matrixHash: SUCCESSOR_AUTHORIZATION_MATRIX_HASH,
      plannedInferencePosts: 37,
      authorizedPosts: 55,
      consumedPosts: 13,
      remainingPosts: 42,
      networkCalls: 0,
      appendOnly: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const db = new Database(env[AUTHORIZATION_LEDGER_PATH_ENV]!, { readonly: true });
    expect(db.prepare("SELECT authorized_posts, consumed_posts FROM inference_authorization").get())
      .toEqual({ authorized_posts: 55, consumed_posts: 13 });
    expect(db.prepare("SELECT reservation_post, state FROM inference_attempt").get())
      .toEqual({ reservation_post: 3, state: "reserved" });
    db.close();
  });

  it("requires every explicit successor field and refuses drift without upgrading the ledger", async () => {
    const names = [
      AUTHORIZATION_LEDGER_PATH_ENV,
      "SUPERTWIN_HOME",
      AUTHORIZATION_ID_ENV,
      AUTHORIZATION_OWNER_ENV,
      EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV,
      REQUESTED_PROBE_MODEL_ENV,
      AUTHORIZED_INFERENCE_POSTS_ENV,
      AUTHORIZATION_PREDECESSOR_REVISION_ENV,
      AUTHORIZATION_PREDECESSOR_MATRIX_VERSION_ENV,
      AUTHORIZATION_PREDECESSOR_MATRIX_HASH_ENV,
      AUTHORIZATION_PREDECESSOR_PLANNED_INFERENCE_POSTS_ENV,
      AUTHORIZATION_EXPECTED_CONSUMED_POSTS_ENV,
      AUTHORIZATION_SUCCESSOR_TRANSITION_ID_ENV,
      AUTHORIZATION_SUCCESSOR_MATRIX_VERSION_ENV,
      AUTHORIZATION_SUCCESSOR_MATRIX_HASH_ENV,
      AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS_ENV,
    ];
    for (const name of names) {
      const env = await successorEnv();
      const ledgerPath = env[AUTHORIZATION_LEDGER_PATH_ENV]!;
      delete env[name];
      await expect(appendInferenceAuthorizationPlanSuccessorFromEnvironment(env)).rejects.toThrow(/REFUSED/);
      const db = new Database(ledgerPath, { readonly: true });
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      expect(db.prepare("SELECT authorized_posts, consumed_posts FROM inference_authorization").get())
        .toEqual({ authorized_posts: 55, consumed_posts: 13 });
      db.close();
    }

    for (const [name, value] of [
      [AUTHORIZATION_PREDECESSOR_REVISION_ENV, "1"],
      [AUTHORIZATION_PREDECESSOR_MATRIX_HASH_ENV, "c".repeat(64)],
      [AUTHORIZATION_EXPECTED_CONSUMED_POSTS_ENV, "4"],
      [AUTHORIZATION_SUCCESSOR_TRANSITION_ID_ENV, "request-matrix-v4-alternate"],
      [AUTHORIZATION_SUCCESSOR_MATRIX_VERSION_ENV, "phase0b-contract-matrix-v1"],
      [AUTHORIZATION_SUCCESSOR_MATRIX_HASH_ENV, "d".repeat(64)],
      [AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS_ENV, "46"],
    ] as const) {
      const env = await successorEnv();
      env[name] = value;
      await expect(appendInferenceAuthorizationPlanSuccessorFromEnvironment(env)).rejects.toThrow(
        /must explicitly equal/,
      );
      const db = new Database(env[AUTHORIZATION_LEDGER_PATH_ENV]!, { readonly: true });
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      db.close();
    }
  });

  it.each(["missing", "symlink", "nonempty", "broad", "wrong-mode"])(
    "rejects a %s successor scratch home before appending",
    async (variant) => {
      const env = await successorEnv();
      const validHome = env.SUPERTWIN_HOME!;
      if (variant === "missing") {
        env.SUPERTWIN_HOME = join(dirname(validHome), "missing-home");
      } else if (variant === "symlink") {
        const link = join(dirname(validHome), "linked-home");
        await symlink(validHome, link);
        env.SUPERTWIN_HOME = link;
      } else if (variant === "nonempty") {
        await writeFile(join(validHome, "artifact"), "x");
      } else if (variant === "broad") {
        env.SUPERTWIN_HOME = tmpdir();
      } else {
        await chmod(validHome, 0o755);
      }
      await expect(appendInferenceAuthorizationPlanSuccessorFromEnvironment(env)).rejects.toThrow(
        /scratch home|no-residual-artifacts|system temporary directory/,
      );
      const db = new Database(env[AUTHORIZATION_LEDGER_PATH_ENV]!, { readonly: true });
      expect(db.prepare("SELECT COUNT(*) AS count FROM authorization_plan_revision").get())
        .toEqual({ count: 3 });
      db.close();
    },
  );

  it("refuses an exact second successor append without changing the active revision or counter", async () => {
    const env = await successorEnv();
    await appendInferenceAuthorizationPlanSuccessorFromEnvironment(env);
    await expect(appendInferenceAuthorizationPlanSuccessorFromEnvironment(env)).rejects.toThrow(/predecessor/);
    const db = new Database(env[AUTHORIZATION_LEDGER_PATH_ENV]!, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM authorization_plan_revision").get())
      .toEqual({ count: 4 });
    expect(db.prepare("SELECT authorized_posts, consumed_posts FROM inference_authorization").get())
      .toEqual({ authorized_posts: 55, consumed_posts: 13 });
    db.close();
  });

  it("runs the successor append only as its sole offline CLI flag and emits bounded evidence", async () => {
    const env = await successorEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runProbeCli(["--append-authorization-plan-successor"], env)).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('"status": "authorization-plan-successor-appended"');
    expect(output).toContain('"planRevision": 4');
    expect(output).toContain('"plannedInferencePosts": 37');
    expect(output).toContain('"consumedPosts": 13');
    expect(output).not.toContain(env[AUTHORIZATION_LEDGER_PATH_ENV]!);
    expect(output).not.toContain(env[AUTHORIZATION_ID_ENV]!);
    expect(output).not.toContain(env[AUTHORIZATION_OWNER_ENV]!);
  });

  it.each([
    ["--append-authorization-plan-successor", "--append-authorization-plan-successor"],
    ["--append-authorization-plan-successor", "--initialize-authorization-ledger"],
    ["--append-authorization-plan-successor", "--live-auth"],
    ["--append-authorization-plan-successor", "--live-discover"],
    ["--append-authorization-plan-successor", "--live-canary"],
    ["--append-authorization-plan-successor", "--live-contract"],
    ["--append-authorization-plan-successor", "--live-browser-auth-smoke"],
    ["--append-authorization-plan-successor", "--unknown"],
  ])("rejects coexisting successor arguments %s %s with zero work", async (...args) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const append = vi.fn<typeof appendInferenceAuthorizationPlanSuccessorFromEnvironment>();
    await expect(runProbeCli(args, {}, { appendAuthorizationPlanSuccessor: append })).rejects.toThrow(
      /must be the only CLI argument/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("runs only as a sole offline CLI flag and emits minimal path-free evidence", async () => {
    const env = await initializationEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runProbeCli(["--initialize-authorization-ledger"], env)).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain(`"matrixHash": "${MATRIX_HASH}"`);
    expect(output).toContain('"plannedInferencePosts": 46');
    expect(output).toContain('"remainingPosts": 53');
    expect(output).not.toContain(env[AUTHORIZATION_LEDGER_PATH_ENV]!);
    expect(output).not.toContain("Aditya Katare");
    expect(output).not.toContain("owner-approval-2026-09-08");
  });

  it.each([
    ["--initialize-authorization-ledger", "--initialize-authorization-ledger"],
    ["--initialize-authorization-ledger", "--live-auth"],
    ["--initialize-authorization-ledger", "--live-discover"],
    ["--initialize-authorization-ledger", "--live-canary"],
    ["--initialize-authorization-ledger", "--live-contract"],
    ["--initialize-authorization-ledger", "--append-authorization-plan-successor"],
    ["--initialize-authorization-ledger", "--unknown"],
  ])("rejects coexisting initializer arguments %s %s with zero work", async (...args) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const initializer = vi.fn<typeof initializeInferenceAuthorizationFromEnvironment>();
    await expect(runProbeCli(args, {}, { initializeAuthorizationLedger: initializer })).rejects.toThrow(
      /must be the only CLI argument/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(initializer).not.toHaveBeenCalled();
  });
});
