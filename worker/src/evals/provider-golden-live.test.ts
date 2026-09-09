import { mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { executeProviderGolden, GOLDEN_LIVE_OPT_IN } from "./provider-golden-live.js";
import { goldenPreflight } from "./provider-golden-cli.js";

const homes: string[] = [];
const cleanIdentity = () => ({ commit: "a".repeat(40), tree: "b".repeat(40), status: "" });
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("hard-refuses source-mode ChatGPT before preflight or any live work", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const declaration = ["--provider", "chatgpt-oauth", "--executor-model", "gpt-exact", "--judge-model", "gpt-judge",
    "--eval-home", home];
  const runEval = vi.fn();
  expect(() => goldenPreflight(declaration, resolve(import.meta.dirname, "../../.."), cleanIdentity)).toThrow(/combined signed-app/);
  await expect(executeProviderGolden(declaration, {}, { runEval, output: () => undefined,
    repositoryIdentity: cleanIdentity })).rejects.toThrow(/combined signed-app/);
  expect(runEval).not.toHaveBeenCalled();
  expect(readdirSync(home)).toEqual([]);
});

it("refuses execution before initialization without exact opt-in and authorization", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const init = vi.fn();
  await expect(executeProviderGolden(["--provider", "claude-local", "--executor-model", "sonnet",
    "--judge-model", "haiku", "--eval-home", home, "--execute", "yes", "--authorization-id", "wrong"], {}, {
      runEval: vi.fn() as never, output: () => undefined,
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
      runEval, output: () => undefined,
      repositoryIdentity: cleanIdentity,
    })).rejects.toThrow("EVAL_FIXTURES");
  expect(runEval).not.toHaveBeenCalled();

  const authState = vi.fn(() => ({ status: "ready" as const, error: null }));
  await executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, {
      runEval, output: () => undefined,
      repositoryIdentity: cleanIdentity,
      authState,
    });
  expect(authState).toHaveBeenCalledOnce();
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
    { [GOLDEN_LIVE_OPT_IN]: "1" }, { runEval, output: () => undefined,
      repositoryIdentity: driftIdentity, authState: () => ({ status: "ready", error: null }) })).rejects.toThrow(/identity changed/);
  expect(runEval).not.toHaveBeenCalled();

  reads = 0;
  const replaceHome = () => {
    if (++reads === 2) { rmSync(home, { recursive: true }); mkdirSync(home, { mode: 0o700 }); }
    return cleanIdentity();
  };
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, { runEval, output: () => undefined,
      repositoryIdentity: replaceHome, authState: () => ({ status: "ready", error: null }) })).rejects.toThrow(/INVALID_DECLARATION/);
  expect(runEval).not.toHaveBeenCalled();
});

it("checks signed-out Claude before mutation and emits exact zero actuals", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-live-"))); homes.push(home);
  const declaration = ["--provider", "claude-local", "--executor-model", "sonnet", "--judge-model", "haiku",
    "--eval-home", home];
  const preflight = JSON.parse(goldenPreflight(declaration, resolve(import.meta.dirname, "../../.."), cleanIdentity));
  const lines: string[] = [];
  const runEval = vi.fn(async () => 0);
  const authState = vi.fn(() => ({ status: "signed_out" as const, error: null }));
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, { runEval, output: (line) => lines.push(line),
      repositoryIdentity: cleanIdentity, authState })).rejects.toThrow(/^AUTH_REQUIRED:/);
  expect(authState).toHaveBeenCalledOnce();
  expect(runEval).not.toHaveBeenCalled();
  expect(readdirSync(home)).toEqual([]);
  expect(JSON.parse(lines.at(-1)!)).toEqual({ provider_golden_actuals: {
    physical: 0, executor: 0, judgeInitial: 0, judgeRepair: 0, http401Retries: 0,
    claudeUsd: 0, models: 0, quota: 0, refresh: 0,
  } });
});
