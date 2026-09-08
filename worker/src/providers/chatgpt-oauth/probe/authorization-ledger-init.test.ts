import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV } from "./account.js";
import {
  AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV,
  AUTHORIZATION_MATRIX_HASH_ENV,
  AUTHORIZATION_MATRIX_VERSION_ENV,
  initializeInferenceAuthorizationFromEnvironment,
} from "./authorization-ledger-init.js";
import { readInferenceAuthorizationLedger } from "./authorization-ledger.js";
import { PHASE0B_MATRIX_VERSION } from "./authorization-plan.js";
import { runProbeCli } from "./cli.js";
import { FULL_PROBE_INFERENCE_POST_BUDGET } from "./constants.js";
import {
  AUTHORIZATION_ID_ENV,
  AUTHORIZATION_LEDGER_PATH_ENV,
  AUTHORIZATION_OWNER_ENV,
  AUTHORIZED_INFERENCE_POSTS_ENV,
} from "./live-authorization.js";
import { REQUESTED_PROBE_MODEL_ENV } from "./models.js";

const roots = new Set<string>();
const MATRIX_HASH = "a".repeat(64);

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
    [AUTHORIZATION_MATRIX_VERSION_ENV]: PHASE0B_MATRIX_VERSION,
    [AUTHORIZATION_MATRIX_HASH_ENV]: MATRIX_HASH,
    [AUTHORIZED_INFERENCE_POSTS_ENV]: String(FULL_PROBE_INFERENCE_POST_BUDGET),
    [AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV]: "2",
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
    authorizedPosts: Number(env[AUTHORIZED_INFERENCE_POSTS_ENV]),
  };
}

describe("Phase 0b offline authorization ledger initializer", () => {
  it("creates the exact 55-post grant at cumulative count 2 without network access", async () => {
    const env = await initializationEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(initializeInferenceAuthorizationFromEnvironment(env)).resolves.toEqual({
      status: "authorization-ledger-created",
      accountFingerprint: "7d41db9e5a28",
      modelId: "gpt-5.6-sol",
      matrixVersion: PHASE0B_MATRIX_VERSION,
      matrixHash: MATRIX_HASH,
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
    [AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV, "0", /must explicitly equal 2/],
    [AUTHORIZATION_INITIAL_CONSUMED_POSTS_ENV, "3", /must explicitly equal 2/],
    [AUTHORIZATION_MATRIX_VERSION_ENV, "phase0b-contract-matrix-v2", /must equal/],
    [AUTHORIZATION_MATRIX_HASH_ENV, "not-a-hash", /grant values/],
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
