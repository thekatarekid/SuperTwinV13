import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";

import { goldenPreflight, parseGoldenPreflight } from "./provider-golden-cli.js";

const cleanIdentity = () => ({ commit: "a".repeat(40), tree: "b".repeat(40), status: "" });

const home = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-cli-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

it("hard-refuses source-mode ChatGPT golden without making a call", () => {
  expect(() => goldenPreflight([
    "--provider", "chatgpt-oauth", "--executor-model", "gpt-exact", "--judge-model", "gpt-judge-exact",
    "--eval-home", home,
  ], resolve(import.meta.dirname, "../../.."), cleanIdentity)).toThrow(/combined signed-app/);
});

it("rejects scoped tracked/untracked drift and binds commit/tree identity", () => {
  const args = ["--provider", "claude-local", "--executor-model", "sonnet", "--judge-model", "haiku", "--eval-home", home];
  expect(() => goldenPreflight(args, resolve(import.meta.dirname, "../../.."),
    () => ({ commit: "a".repeat(40), tree: "b".repeat(40), status: "?? worker/src/drift.ts\n" })))
    .toThrow(/INVALID_DECLARATION/);
});

it("rejects omissions, duplicates disguised as odd argv and unknown flags", () => {
  expect(() => parseGoldenPreflight(["--provider", "claude-local"])).toThrow(/required/);
  expect(() => parseGoldenPreflight(["--provider", "claude-local", "--wat"])).toThrow(/invalid/);
  expect(() => parseGoldenPreflight(["--provider", "claude-local", "--provider", "chatgpt-oauth"])).toThrow(/invalid/);
});
