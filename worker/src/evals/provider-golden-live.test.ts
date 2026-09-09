import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { keychainAccountForHome } from "./provider-golden-rail.js";
import { executeProviderGolden, GOLDEN_LIVE_OPT_IN } from "./provider-golden-live.js";
import { goldenPreflight } from "./provider-golden-cli.js";

const homes: string[] = [];
const cleanIdentity = () => ({ commit: "a".repeat(40), tree: "b".repeat(40), status: "" });
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("explicitly suppresses runtime canaries and emits zero extra inference actuals on failure", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const accountId = "golden-account-bound-at-fetch";
  const accountFingerprint = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
  const declaration = ["--provider", "chatgpt-oauth", "--executor-model", "gpt-exact", "--judge-model", "gpt-judge",
    "--eval-home", home, "--keychain-account", keychainAccountForHome(home), "--account-fingerprint", accountFingerprint,
    "--keychain-ownership", "1".repeat(32)];
  const preflight = JSON.parse(goldenPreflight(declaration, resolve(import.meta.dirname, "../../.."), cleanIdentity));
  const lines: string[] = [];
  const shutdown = vi.fn(async () => undefined);
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, {
      initializeChatGpt: (async (options: { suppressCompatibilityCanary?: boolean }) => {
        expect(options.suppressCompatibilityCanary).toBe(true);
        return { session: { authState: () => ({ status: "ready", error: null }) }, shutdown } as never;
      }) as never,
      runEval: async () => { throw new Error("offline stop after boot proof"); },
      output: (line) => lines.push(line),
      repositoryIdentity: cleanIdentity,
      loadCredential: async () => ({ accessToken: "owned", refreshToken: "refresh", expiresAtMs: Date.now() + 60_000,
        accountId }),
      cleanupCredential: async () => true,
    })).rejects.toThrow("offline stop");
  expect(shutdown).toHaveBeenCalledOnce();
  expect(lines.join("\n")).toContain('"physical":0');
});

it("rejects missing exact-owned credentials before database or runtime initialization", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const declaration = ["--provider", "chatgpt-oauth", "--executor-model", "gpt-exact", "--judge-model", "gpt-judge",
    "--eval-home", home, "--keychain-account", keychainAccountForHome(home), "--account-fingerprint", "7d41db9e5a28",
    "--keychain-ownership", "1".repeat(32)];
  const preflight = JSON.parse(goldenPreflight(declaration, resolve(import.meta.dirname, "../../.."), cleanIdentity));
  const initializeChatGpt = vi.fn();
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, { initializeChatGpt: initializeChatGpt as never, runEval: vi.fn() as never,
      output: () => undefined, repositoryIdentity: cleanIdentity, loadCredential: async () => undefined,
      cleanupCredential: async () => false })).rejects.toThrow(/ownership is invalid/);
  expect(initializeChatGpt).not.toHaveBeenCalled();
  expect(readdirSync(home)).toEqual([]);
});

it("refuses execution before initialization without exact opt-in and authorization", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const init = vi.fn();
  await expect(executeProviderGolden(["--provider", "claude-local", "--executor-model", "sonnet",
    "--judge-model", "haiku", "--eval-home", home, "--execute", "yes", "--authorization-id", "wrong"], {}, {
      initializeChatGpt: init as never, runEval: vi.fn() as never, output: () => undefined,
      repositoryIdentity: cleanIdentity,
    })).rejects.toThrow("authorization");
  expect(init).not.toHaveBeenCalled();
});

it("pins the frozen corpus, suppresses the boot canary, and rejects fixture overrides", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const declaration = ["--provider", "claude-local", "--executor-model", "sonnet", "--judge-model", "haiku",
    "--eval-home", home];
  const preflight = JSON.parse(goldenPreflight(declaration, resolve(import.meta.dirname, "../../.."), cleanIdentity));
  const runEval = vi.fn(async () => 0);
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1", EVAL_FIXTURES: "/tmp/alternate" }, {
      initializeChatGpt: vi.fn() as never, runEval, output: () => undefined,
      repositoryIdentity: cleanIdentity,
    })).rejects.toThrow("EVAL_FIXTURES");
  expect(runEval).not.toHaveBeenCalled();

  await executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, {
      initializeChatGpt: vi.fn() as never, runEval, output: () => undefined,
      repositoryIdentity: cleanIdentity,
    });
  expect(runEval).toHaveBeenCalledWith(expect.arrayContaining([
    "--dir", resolve(import.meta.dirname, "../../../evals/v13"), "--allow-pending", "TRC-01,TRC-03",
  ]));
});

it("rechecks repository and eval-home identity immediately before mutation", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const declaration = ["--provider", "claude-local", "--executor-model", "sonnet", "--judge-model", "haiku",
    "--eval-home", home];
  const preflight = JSON.parse(goldenPreflight(declaration, resolve(import.meta.dirname, "../../.."), cleanIdentity));
  let reads = 0;
  const driftIdentity = () => ({ commit: (++reads === 1 ? "a" : "c").repeat(40), tree: "b".repeat(40), status: "" });
  const runEval = vi.fn(async () => 0);
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, { initializeChatGpt: vi.fn() as never, runEval, output: () => undefined,
      repositoryIdentity: driftIdentity })).rejects.toThrow(/identity changed/);
  expect(runEval).not.toHaveBeenCalled();

  reads = 0;
  const replaceHome = () => {
    if (++reads === 2) { rmSync(home, { recursive: true }); mkdirSync(home, { mode: 0o700 }); }
    return cleanIdentity();
  };
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, { initializeChatGpt: vi.fn() as never, runEval, output: () => undefined,
      repositoryIdentity: replaceHome })).rejects.toThrow(/INVALID_DECLARATION/);
  expect(runEval).not.toHaveBeenCalled();
});
