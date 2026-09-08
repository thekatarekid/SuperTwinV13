import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  initializeInferenceAuthorizationLedger,
  readInferenceAuthorizationLedger,
  reserveInferencePosts,
  type AuthorizationLedgerLocation,
  type InferenceAuthorizationGrant,
} from "./authorization-ledger.js";

const MATRIX_HASH = "a".repeat(64);

async function fixture(authorizedPosts = 2): Promise<{
  location: AuthorizationLedgerLocation;
  grant: InferenceAuthorizationGrant;
}> {
  const root = join(tmpdir(), `supertwin-ledger-${process.pid}-${Date.now()}-${Math.random()}`);
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
      authorizedPosts,
    },
  };
}

describe("Phase 0b cumulative inference authorization ledger", () => {
  it("creates a 0600 SQLite ledger with an explicit conservative starting count", async () => {
    const { location, grant } = await fixture(55);
    const ledger = await initializeInferenceAuthorizationLedger(location, grant, 2);
    expect(ledger).toEqual({ ...grant, schemaVersion: 1, consumedPosts: 2 });
    expect((await lstat(location.ledgerPath)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(location.ledgerPath);
    expect(bytes.subarray(0, 16).toString()).toBe("SQLite format 3\0");
    expect(bytes.toString()).not.toMatch(/access[_-]?token|refresh[_-]?token|response[_-]?id/i);
    await expect(initializeInferenceAuthorizationLedger(location, grant)).rejects.toThrow(/already exists|cannot be created/);
  });

  it("commits each reservation before returning, supports batches, and never offers rollback", async () => {
    const { location, grant } = await fixture(4);
    await initializeInferenceAuthorizationLedger(location, grant);
    expect(await reserveInferencePosts(location, grant, 3)).toMatchObject({ consumedPosts: 3 });
    expect(await reserveInferencePosts(location, grant)).toMatchObject({ consumedPosts: 4 });
    await expect(reserveInferencePosts(location, grant)).rejects.toThrow(/exhausted/);
    expect(await readInferenceAuthorizationLedger(location, grant)).toMatchObject({ consumedPosts: 4 });
    await expect(reserveInferencePosts(location, grant, 0)).rejects.toThrow(/reservation size/);
  });

  it("serializes SQLite writers and recovers after an abandoned transaction", async () => {
    const { location, grant } = await fixture(1);
    await initializeInferenceAuthorizationLedger(location, grant);
    const blocker = new Database(location.ledgerPath, { fileMustExist: true, timeout: 0 });
    blocker.pragma("busy_timeout = 0");
    blocker.exec("BEGIN IMMEDIATE");
    await expect(reserveInferencePosts(location, grant)).rejects.toThrow(/reservation failed|locked/);
    blocker.close(); // Closing an uncommitted connection models process-death rollback/release.
    expect(await reserveInferencePosts(location, grant)).toMatchObject({ consumedPosts: 1 });
    const results = await Promise.allSettled([
      reserveInferencePosts(location, grant),
      reserveInferencePosts(location, grant),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("recovers after a separate process dies while holding the write transaction", async () => {
    const { location, grant } = await fixture(1);
    await initializeInferenceAuthorizationLedger(location, grant);
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
      await expect(reserveInferencePosts(location, grant)).rejects.toThrow(/cannot be opened|reservation failed/);
      child.kill("SIGKILL");
      await once(child, "exit");
      expect(await reserveInferencePosts(location, grant)).toMatchObject({ consumedPosts: 1 });
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
