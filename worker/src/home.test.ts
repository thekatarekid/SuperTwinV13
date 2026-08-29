// ===========================================================================
// Boot smoke test for the V13 install identity (build P0.1).
//
// Asserts the three things the rebrand pinned down:
//   - data home: ~/SuperTwinV13 by default, SUPERTWIN_HOME override kept, and
//     ensureHomeLayout() creates media/ logs/ browser-profile/ traces/;
//   - DB name: supertwinv13.db under the home (resolveDbPath agrees);
//   - worker port: 8013 by default (not the V11 port — no collision with a live V11).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  DB_FILENAME,
  DEFAULT_WORKER_PORT,
  HOME_SUBDIRS,
  ensureHomeLayout,
  homeRoot,
} from "./home.js";
import { browserProfileDir } from "./browser/chromium.js";
import { resolveDbPath } from "./db/connection.js";
import { logsDir } from "./logs.js";
import { brainRoot } from "./brain/root.js";

const KEYS = [
  "SUPERTWIN_HOME",
  "SUPERTWIN_DB_PATH",
  "SUPERTWIN_WORKER_PORT",
  "SUPERTWIN_BROWSER_PROFILE",
  "SUPERTWIN_BRAIN_DIR",
  "SUPERTWIN_MEDIA_DIR",
] as const;
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

describe("P0.1 boot smoke: install identity", () => {
  it("home dir defaults to ~/SuperTwinV13", () => {
    expect(homeRoot()).toBe(join(homedir(), "SuperTwinV13"));
  });

  it("SUPERTWIN_HOME override is kept", () => {
    process.env.SUPERTWIN_HOME = "/tmp/st-home-override";
    expect(homeRoot()).toBe("/tmp/st-home-override");
  });

  it("DB file is supertwinv13.db under the home", () => {
    expect(DB_FILENAME).toBe("supertwinv13.db");
    expect(resolveDbPath()).toBe(join(homeRoot(), DB_FILENAME));
    process.env.SUPERTWIN_HOME = "/tmp/st-home-override";
    expect(resolveDbPath()).toBe(join("/tmp/st-home-override", DB_FILENAME));
  });

  it("default worker port is 8013", () => {
    expect(DEFAULT_WORKER_PORT).toBe(8013);
  });

  // Regression: browserProfileDir() hardcoded ~/SuperTwinV13/browser-profile
  // and was the ONLY home-derived resolver that ignored SUPERTWIN_HOME. A
  // sandboxed run therefore created an empty <sandbox>/browser-profile and
  // then launched Chromium into the user's REAL logged-in profile. Every
  // resolver under the home is asserted together so the next one added cannot
  // quietly reintroduce the same leak.
  it("every home-derived path follows SUPERTWIN_HOME into the sandbox", () => {
    const sandbox = "/tmp/st-home-sandbox";
    process.env.SUPERTWIN_HOME = sandbox;
    const resolvers: [string, () => string][] = [
      ["db", resolveDbPath],
      ["logs", logsDir],
      ["brain", brainRoot],
      ["browser-profile", browserProfileDir],
    ];
    for (const [name, resolver] of resolvers) {
      const got = resolver();
      expect(got.startsWith(`${sandbox}/`), `${name} escaped the sandbox: ${got}`).toBe(true);
      expect(got.includes(join(homedir(), "SuperTwinV13"))).toBe(false);
    }
    expect(browserProfileDir()).toBe(join(sandbox, "browser-profile"));
  });

  it("browser profile falls back to the real home, and the explicit pin still wins", () => {
    expect(browserProfileDir()).toBe(join(homedir(), "SuperTwinV13", "browser-profile"));
    process.env.SUPERTWIN_BROWSER_PROFILE = "/tmp/st-pinned-profile";
    process.env.SUPERTWIN_HOME = "/tmp/st-home-sandbox";
    expect(browserProfileDir()).toBe("/tmp/st-pinned-profile");
  });

  it("ensureHomeLayout creates media/ logs/ browser-profile/ traces/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "st13-home-"));
    try {
      process.env.SUPERTWIN_HOME = tmp;
      const root = ensureHomeLayout();
      expect(root).toBe(tmp);
      expect([...HOME_SUBDIRS]).toEqual(["media", "logs", "browser-profile", "traces"]);
      for (const sub of HOME_SUBDIRS) {
        expect(existsSync(join(tmp, sub))).toBe(true);
        expect(statSync(join(tmp, sub)).isDirectory()).toBe(true);
      }
      // Idempotent.
      expect(ensureHomeLayout()).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
