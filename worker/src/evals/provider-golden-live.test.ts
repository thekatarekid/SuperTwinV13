import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { enforceGoldenPhysicalSend, keychainAccountForHome } from "./provider-golden-rail.js";
import { executeProviderGolden, GOLDEN_LIVE_OPT_IN } from "./provider-golden-live.js";
import { goldenPreflight } from "./provider-golden-cli.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("keeps runtime boot traffic inside the authorized counter and emits actuals on failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "supertwin-golden-live-")); homes.push(home);
  const accountId = "golden-account-bound-at-fetch";
  const accountFingerprint = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
  const declaration = ["--provider", "chatgpt-oauth", "--executor-model", "gpt-exact", "--judge-model", "gpt-judge",
    "--eval-home", home, "--keychain-account", keychainAccountForHome(home), "--account-fingerprint", accountFingerprint];
  const preflight = JSON.parse(goldenPreflight(declaration, resolve(import.meta.dirname, "../../..")));
  const lines: string[] = [];
  const shutdown = vi.fn(async () => undefined);
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, {
      initializeChatGpt: (async () => {
        // Represents a boot compatibility fetch. If initialization were outside the ALS
        // rail this would not increment and the assertion below would expose the bypass.
        enforceGoldenPhysicalSend({ provider: "chatgpt-oauth", model: "gpt-exact", accountId });
        return { session: { authState: () => ({ status: "ready", error: null }) }, shutdown } as never;
      }) as never,
      runEval: async () => { throw new Error("offline stop after boot proof"); },
      output: (line) => lines.push(line),
    })).rejects.toThrow("offline stop");
  expect(shutdown).toHaveBeenCalledOnce();
  expect(lines.join("\n")).toContain('"physical":1');
});

it("refuses execution before initialization without exact opt-in and authorization", async () => {
  const home = mkdtempSync(join(tmpdir(), "supertwin-golden-live-")); homes.push(home);
  const init = vi.fn();
  await expect(executeProviderGolden(["--provider", "claude-local", "--executor-model", "sonnet",
    "--judge-model", "haiku", "--eval-home", home, "--execute", "yes", "--authorization-id", "wrong"], {}, {
      initializeChatGpt: init as never, runEval: vi.fn() as never, output: () => undefined,
    })).rejects.toThrow("authorization");
  expect(init).not.toHaveBeenCalled();
});

it("pins the frozen corpus, suppresses the boot canary, and rejects fixture overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "supertwin-golden-live-")); homes.push(home);
  const declaration = ["--provider", "claude-local", "--executor-model", "sonnet", "--judge-model", "haiku",
    "--eval-home", home];
  const preflight = JSON.parse(goldenPreflight(declaration, resolve(import.meta.dirname, "../../..")));
  const runEval = vi.fn(async () => 0);
  await expect(executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1", EVAL_FIXTURES: "/tmp/alternate" }, {
      initializeChatGpt: vi.fn() as never, runEval, output: () => undefined,
    })).rejects.toThrow("EVAL_FIXTURES");
  expect(runEval).not.toHaveBeenCalled();

  await executeProviderGolden([...declaration, "--execute", "yes", "--authorization-id", preflight.authorization_id],
    { [GOLDEN_LIVE_OPT_IN]: "1" }, {
      initializeChatGpt: vi.fn() as never, runEval, output: () => undefined,
    });
  expect(runEval).toHaveBeenCalledWith(expect.arrayContaining([
    "--dir", resolve(import.meta.dirname, "../../../evals/v13"), "--allow-pending", "TRC-01,TRC-03",
  ]));
});
