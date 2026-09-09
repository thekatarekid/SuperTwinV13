import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";

import { keychainAccountForHome } from "./provider-golden-rail.js";
import { goldenPreflight, parseGoldenPreflight } from "./provider-golden-cli.js";

const home = mkdtempSync(join(tmpdir(), "supertwin-golden-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

it("emits the exact declaration an owner can authorize without making a call", () => {
  const output = JSON.parse(goldenPreflight([
    "--provider", "chatgpt-oauth", "--executor-model", "gpt-exact", "--judge-model", "gpt-judge-exact",
    "--eval-home", home, "--keychain-account", keychainAccountForHome(home), "--account-fingerprint", "7d41db9e5a28",
  ], resolve(import.meta.dirname, "../../..")));
  expect(output).toMatchObject({ provider: "chatgpt-oauth", executor_model: "gpt-exact", judge_model: "gpt-judge-exact",
    nominal_no_repair_physical_calls: 232, absolute_physical_call_ceiling: 696, cost: "unknown" });
});

it("rejects omissions, duplicates disguised as odd argv and unknown flags", () => {
  expect(() => parseGoldenPreflight(["--provider", "claude-local"])).toThrow(/required/);
  expect(() => parseGoldenPreflight(["--provider", "claude-local", "--wat"])).toThrow(/invalid/);
  expect(() => parseGoldenPreflight(["--provider", "claude-local", "--provider", "chatgpt-oauth"])).toThrow(/invalid/);
});
