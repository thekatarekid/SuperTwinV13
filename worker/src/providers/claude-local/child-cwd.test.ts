// ===========================================================================
// REGRESSION (spawn level): the `claude` child must be told the truth about
// where it is running.
//
// `spawn(bin, args, { cwd })` sets the real working directory but leaves the
// inherited `PWD` env var untouched, and the CLI trusts `PWD` over getcwd().
// The worker inherits the .app's environment, so a chat turn spawned with
// cwd = tmpdir() was announcing PWD = wherever the .app was launched from
// (in development: the repo, under ~/Documents). macOS protects ~/Documents
// with TCC and attributes the child to the ad-hoc-signed .app, so the CLI's
// startup scan of that directory blocked in openat() until the provider's
// 120s timeout — silently, with no stdout, stderr or network traffic.
//
// This test spawns a FAKE cli (a node script — deliberately not a shell
// script, because a shell repairs PWD itself and would mask the bug) that
// records both values, and asserts they agree.
// ===========================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "st-child-cwd-"));
const fakeCli = join(stage, "fake-claude.cjs");
const probeOut = join(stage, "probe.json");
const runCwd = mkdtempSync(join(tmpdir(), "st-run-cwd-"));

/** A PWD that is wrong for `runCwd` — this is the value that used to leak. */
const POISONED_PWD = join(stage, "not-the-cwd");

const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

beforeAll(() => {
  writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env node",
      'const { writeFileSync } = require("node:fs");',
      "writeFileSync(process.env.ST_PROBE_OUT, JSON.stringify({",
      "  pwd: process.env.PWD ?? null,",
      "  oldpwd: process.env.OLDPWD ?? null,",
      "  cwd: process.cwd(),",
      "}));",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCli, 0o755);

  // resolveClaudeBin() prefers CLAUDE_BIN and caches on first use, so this must
  // be set before the provider ever spawns — which, in this file, it is.
  setEnv("CLAUDE_BIN", fakeCli);
  setEnv("ST_PROBE_OUT", probeOut);
  setEnv("PWD", POISONED_PWD);
  setEnv("OLDPWD", join(stage, "older-still"));
});

afterAll(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("claude-local: the spawned child's PWD", () => {
  it("names the cwd it was actually spawned in, not the inherited one", async () => {
    const { claudeLocalProvider } = await import("./index.js");

    await claudeLocalProvider.send({
      runId: "child-cwd-regression",
      message: "hello",
      cwd: runCwd,
      onEvent: () => {},
    });

    const probe = JSON.parse(readFileSync(probeOut, "utf8")) as {
      pwd: string | null;
      oldpwd: string | null;
      cwd: string;
    };

    // The poisoned values from the parent must not have survived. (Asserted
    // first so a regression reads as "PWD leaked", not as a realpath error on
    // a directory that never existed.)
    expect(probe.pwd).not.toBe(POISONED_PWD);
    expect(probe.oldpwd).toBeNull();

    // The child's own getcwd() and the PWD we handed it must be the same
    // place. (Compared through realpath: /var is a symlink to /private/var on
    // macOS, so the two spellings differ while naming one directory.)
    expect(probe.pwd).not.toBeNull();
    expect(realpathSync(probe.pwd as string)).toBe(realpathSync(probe.cwd));
    expect(realpathSync(probe.pwd as string)).toBe(realpathSync(runCwd));
  });
});
