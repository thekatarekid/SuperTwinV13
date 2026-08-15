// ===========================================================================
// connection.ts path-resolution tests (vitest). Proves resolveDbPath() honours
// the same precedence as brainRoot()/mediaRoot() so one env var (SUPERTWIN_HOME)
// sandboxes db+brain+media together — and that SUPERTWIN_DB_PATH still wins.
//
// Pure env-driven unit tests (resolveDbPath reads env at call time): no DB is
// opened. Env is snapshotted and fully restored so nothing leaks to other tests.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveDbPath } from "./connection.js";

const KEYS = ["SUPERTWIN_DB_PATH", "SUPERTWIN_HOME"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveDbPath precedence", () => {
  it("defaults to ~/SuperTwinV11/supertwinv11.db when nothing is set", () => {
    expect(resolveDbPath()).toBe(join(homedir(), "SuperTwinV11", "supertwinv11.db"));
  });

  it("SUPERTWIN_HOME redirects the db under that home dir", () => {
    process.env.SUPERTWIN_HOME = "/tmp/st-home-xyz";
    expect(resolveDbPath()).toBe(join("/tmp/st-home-xyz", "supertwinv11.db"));
  });

  it("SUPERTWIN_DB_PATH wins over SUPERTWIN_HOME (most specific)", () => {
    process.env.SUPERTWIN_HOME = "/tmp/st-home-xyz";
    process.env.SUPERTWIN_DB_PATH = "/tmp/explicit/only-this.db";
    expect(resolveDbPath()).toBe("/tmp/explicit/only-this.db");
  });

  it("ignores a blank/whitespace SUPERTWIN_HOME and falls through to default", () => {
    process.env.SUPERTWIN_HOME = "   ";
    expect(resolveDbPath()).toBe(join(homedir(), "SuperTwinV11", "supertwinv11.db"));
  });
});
