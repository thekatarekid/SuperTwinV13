import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accountFingerprint } from "./account.js";
import { runProbeCli } from "./cli.js";
import { runContractProbeScaffold } from "./contract-runner.js";
import { runDiscoveryProbe } from "./discovery-runner.js";
import { assertEmptyScratchHome, beginScratchHomeProof } from "./scratch.js";
import { LIVE_CONTRACT_PROBE_ENV, LIVE_DISCOVERY_PROBE_ENV } from "./safety.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

function jwt(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.probe-signature`;
}

function liveEnv(mode: "auth" | "discover" | "contract", home: string): NodeJS.ProcessEnv {
  const accountId = "acct-scratch-proof";
  return {
    SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE: "1",
    ...(mode === "discover" ? { [LIVE_DISCOVERY_PROBE_ENV]: "1" } : {}),
    ...(mode === "contract" ? {
      [LIVE_CONTRACT_PROBE_ENV]: "1",
      SUPERTWIN_CHATGPT_PROBE_MODEL: "gpt-probe",
    } : {}),
    ...(mode === "auth" ? {} : {
      SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT: accountFingerprint(accountId),
    }),
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: home,
  };
}

function errorMessages(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(errorMessages)].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

const zeroActuals = {
  deviceCode: 0, devicePoll: 0, token: 0, models: 0,
  quota: 0, inference: 0, other: 0, total: 0,
};

describe("Phase 0b no-residual-artifacts proof", () => {
  it("accepts only nonexistent or user-owned 0700 empty real directories", () => {
    const base = scratch("supertwin-scratch-shapes-");
    const absent = join(base, "absent", "probe-home");
    expect(assertEmptyScratchHome({ SUPERTWIN_HOME: absent })).toBe(absent);
    expect(beginScratchHomeProof({ SUPERTWIN_HOME: base }).label).toBe("no-residual-artifacts");

    const file = join(base, "file-home");
    writeFileSync(file, "do-not-read-this-body");
    expect(() => assertEmptyScratchHome({ SUPERTWIN_HOME: file })).toThrow(/no-residual-artifacts/);

    const nonempty = scratch("supertwin-scratch-nonempty-");
    writeFileSync(join(nonempty, "secret-entry-name"), "do-not-read-this-body");
    expect(() => assertEmptyScratchHome({ SUPERTWIN_HOME: nonempty })).toThrow(/no-residual-artifacts/);

    const permissive = scratch("supertwin-scratch-permissions-");
    chmodSync(permissive, 0o755);
    expect(() => assertEmptyScratchHome({ SUPERTWIN_HOME: permissive })).toThrow(/no-residual-artifacts/);

    const unreadable = scratch("supertwin-scratch-unreadable-");
    chmodSync(unreadable, 0o000);
    expect(() => assertEmptyScratchHome({ SUPERTWIN_HOME: unreadable })).toThrow(/no-residual-artifacts/);
    chmodSync(unreadable, 0o700);

    const target = scratch("supertwin-scratch-target-");
    const link = join(base, "linked-home");
    symlinkSync(target, link);
    expect(() => assertEmptyScratchHome({ SUPERTWIN_HOME: link })).toThrow(/no-residual-artifacts/);
    expect(() => assertEmptyScratchHome({ SUPERTWIN_HOME: join(link, "child") })).toThrow(/no-residual-artifacts/);
  });

  it("rejects both absent-to-empty and existing-to-absent baseline changes", () => {
    const base = scratch("supertwin-scratch-absence-baseline-");
    const absent = join(base, "absent-home");
    const absentProof = beginScratchHomeProof({ SUPERTWIN_HOME: absent });
    mkdirSync(absent, { mode: 0o700 });
    expect(() => absentProof.assertEmpty()).toThrow(/no-residual-artifacts/);

    const home = scratch("supertwin-scratch-missing-after-");
    const proof = beginScratchHomeProof({ SUPERTWIN_HOME: home });
    rmSync(home, { recursive: true });
    let failure: unknown;
    try {
      proof.assertEmpty();
    } catch (error) {
      failure = error;
    }
    expect(errorMessages(failure)).toContain("no-residual-artifacts");
    expect(errorMessages(failure)).not.toContain(home);
  });

  it("rejects a permissive intermediate and an absent-home parent inode swap without leaking paths", () => {
    const permissiveBase = scratch("supertwin-scratch-permissive-parent-");
    const permissiveParent = join(permissiveBase, "parent");
    mkdirSync(permissiveParent, { mode: 0o700 });
    chmodSync(permissiveParent, 0o777);
    expect(() => beginScratchHomeProof({ SUPERTWIN_HOME: join(permissiveParent, "home") }))
      .toThrow(/no-residual-artifacts/);

    const swapBase = scratch("supertwin-scratch-parent-swap-");
    const parent = join(swapBase, "parent");
    mkdirSync(parent, { mode: 0o700 });
    const home = join(parent, "absent-home");
    const proof = beginScratchHomeProof({ SUPERTWIN_HOME: home });
    renameSync(parent, join(swapBase, "original-parent"));
    mkdirSync(parent, { mode: 0o700 });
    let failure: unknown;
    try {
      proof.assertEmpty();
    } catch (error) {
      failure = error;
    }
    expect(errorMessages(failure)).toContain("no-residual-artifacts");
    expect(errorMessages(failure)).not.toContain(home);
    expect(errorMessages(failure)).not.toContain("absent-home");
  });

  it.each([
    ["auth", ["--live-auth"]],
    ["discover", ["--live-auth", "--live-discover"]],
    ["contract", ["--live-auth", "--live-contract"]],
  ] as const)("refuses nonempty %s home before fetch or runner delegation with zero actuals", async (mode, args) => {
    const home = scratch(`supertwin-scratch-${mode}-preflight-`);
    writeFileSync(join(home, "secret-entry-name"), "secret-body");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const auth = vi.fn();
    const discover = vi.fn();
    const contract = vi.fn();

    await expect(runProbeCli(args, liveEnv(mode, home), {
      runAuthFlow: auth,
      runDiscoveryProbe: discover,
      runContractProbe: contract,
    })).rejects.toThrow(/no-residual-artifacts/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(contract).not.toHaveBeenCalled();
    const stderr = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(stderr.match(/PHASE_0B_HTTP_ACTUALS=/g)).toHaveLength(1);
    expect(stderr).toContain(`PHASE_0B_HTTP_ACTUALS=${JSON.stringify(zeroActuals)}`);
    expect(stderr).not.toContain("secret-entry-name");
    expect(stderr).not.toContain("secret-body");
  });

  it("blocks auth success stdout when the run creates an artifact", async () => {
    const home = scratch("supertwin-scratch-auth-success-");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runAuthFlow = vi.fn(async () => {
      writeFileSync(join(home, "secret-entry-name"), "secret-body");
      return { accessToken: jwt("acct-auth-artifact"), refreshToken: "secret-refresh" };
    });

    let failure: unknown;
    try {
      await runProbeCli(["--live-auth"], liveEnv("auth", home), { runAuthFlow });
    } catch (error) {
      failure = error;
    }
    expect(errorMessages(failure)).toContain("no-residual-artifacts");
    expect(errorMessages(failure)).not.toContain(home);
    expect(errorMessages(failure)).not.toContain("secret-entry-name");
    expect(errorMessages(failure)).not.toContain("secret-body");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy.mock.calls.map(([value]) => String(value)).join("").match(/PHASE_0B_HTTP_ACTUALS=/g))
      .toHaveLength(1);
  });

  it("preserves discovery failure and attaches its artifact violation as secondary", async () => {
    const home = scratch("supertwin-scratch-discovery-failure-");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const runner = vi.fn<typeof runDiscoveryProbe>(async (hooks) => {
      writeFileSync(join(home, "secret-entry-name"), "secret-body");
      hooks.onFinalized?.({
        httpActuals: zeroActuals,
        logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
        aborted: true,
      });
      throw new Error("primary discovery failure");
    });

    let failure: unknown;
    try {
      await runProbeCli(["--live-auth", "--live-discover"], liveEnv("discover", home), {
        runDiscoveryProbe: runner,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(errorMessages(aggregate.errors[0])).toContain("primary discovery failure");
    expect(errorMessages(aggregate.errors[1])).toContain("no-residual-artifacts");
    expect(errorMessages(failure)).not.toContain(home);
    expect(errorMessages(failure)).not.toContain("secret-entry-name");
    expect(errorMessages(failure)).not.toContain("secret-body");
    expect(stderrSpy.mock.calls.map(([value]) => String(value)).join("").match(/PHASE_0B_HTTP_ACTUALS=/g))
      .toHaveLength(1);
  });

  it("preserves contract SIGINT abort and attaches its artifact violation after cleanup", async () => {
    const home = scratch("supertwin-scratch-contract-sigint-");
    const listenersBefore = process.listeners("SIGINT");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const runner = vi.fn<typeof runContractProbeScaffold>(async (hooks) => {
      const prior = new Set(listenersBefore);
      const listener = process.listeners("SIGINT").find((candidate) => !prior.has(candidate));
      expect(listener).toBeDefined();
      listener!("SIGINT");
      writeFileSync(join(home, "secret-entry-name"), "secret-body");
      hooks.onFinalized?.({
        httpActuals: zeroActuals,
        logout: { authenticated: false, hasRefreshToken: false, previousRecoveryPairAvailable: false },
        aborted: true,
      });
      throw hooks.signal?.reason ?? new Error("expected SIGINT abort");
    });

    let failure: unknown;
    try {
      await runProbeCli(["--live-auth", "--live-contract"], liveEnv("contract", home), {
        runContractProbe: runner,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(errorMessages(aggregate.errors[0])).toContain("cancelled by SIGINT");
    expect(errorMessages(aggregate.errors[1])).toContain("no-residual-artifacts");
    expect(process.listeners("SIGINT")).toEqual(listenersBefore);
    expect(stderrSpy.mock.calls.map(([value]) => String(value)).join("").match(/PHASE_0B_HTTP_ACTUALS=/g))
      .toHaveLength(1);
  });

  it("preserves the direct-runner primary abort when finalization also throws", async () => {
    const home = scratch("supertwin-scratch-finalization-");
    const controller = new AbortController();
    controller.abort(new Error("primary runner abort"));
    let failure: unknown;
    try {
      await runDiscoveryProbe({
        fetch: vi.fn<typeof fetch>(),
        sleep: vi.fn(async () => undefined),
        now: vi.fn(() => 0),
        onUserCode: vi.fn(),
        onFinalized: () => {
          throw new Error("secondary finalization failure");
        },
        signal: controller.signal,
        env: liveEnv("discover", home),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(errorMessages(aggregate.errors[0])).toContain("primary runner abort");
    expect(errorMessages(aggregate.errors[1])).toContain("secondary finalization failure");
  });
});
