// ===========================================================================
// The regression suite for the eval-data leak (defect fix, shipped 13.4.1).
//
// The bug: `npm run eval` set neither SUPERTWIN_HOME nor SUPERTWIN_DB_PATH, so
// every fixture seed resolved to ~/SuperTwinV13/supertwinv13.db and 181
// fixture events ("Rohan: villa advance by 5pm", villas.example/…,
// ast-04-…-chat) landed in a real user's Timeline.
//
// These tests fail if that ever becomes possible again:
//   - establishEvalHome() must never hand back a production path;
//   - registerProductExecutors() must refuse to wire the DB-touching
//     executors while pointed at the production home;
//   - the CLI's fixture path must go through the boundary (exit 3, not a run).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, resolveDbPath } from "../db/connection.js";
import { registerProductExecutors } from "./executors/index.js";
import { main, repoRoot } from "./cli.js";
import {
  ALLOW_PRODUCTION_FLAG,
  assertEvalDbIsolated,
  establishEvalHome,
  EvalHomeLeakError,
  isProductionDbPath,
  productionDbPath,
  productionHome,
  resetProductionHomeWaiver,
} from "./home.js";

const PROD_DB = productionDbPath();

function clearEnv(): void {
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
}

beforeEach(() => {
  clearEnv();
  resetProductionHomeWaiver();
  closeDb();
});

afterEach(() => {
  clearEnv();
  resetProductionHomeWaiver();
  closeDb();
});

describe("isProductionDbPath", () => {
  it("recognises the installed app's home, by containment not prefix", () => {
    expect(isProductionDbPath(PROD_DB)).toBe(true);
    expect(isProductionDbPath(join(productionHome(), "nested", "x.db"))).toBe(true);
    // A sibling directory that merely shares the leading characters is NOT it.
    expect(isProductionDbPath(`${productionHome()}-eval/st.db`)).toBe(false);
    expect(isProductionDbPath(join(tmpdir(), "supertwin-eval", "st.db"))).toBe(false);
    expect(isProductionDbPath(":memory:")).toBe(false);
  });

  it("is computed against the given home, so it is testable anywhere", () => {
    expect(isProductionDbPath("/u/bob/SuperTwinV13/supertwinv13.db", "/u/bob")).toBe(true);
    expect(isProductionDbPath("/u/bob/SuperTwinV13/supertwinv13.db", "/u/ann")).toBe(false);
  });
});

describe("establishEvalHome", () => {
  it("THE LEAK: an unconfigured run gets a throwaway home, never ~/SuperTwinV13", () => {
    // This is precisely the shipped 13.4.1 state: no env, so resolveDbPath()
    // pointed at the user's real database.
    expect(resolveDbPath()).toBe(PROD_DB);

    const home = establishEvalHome();
    expect(home.ephemeral).toBe(true);
    expect(home.production).toBe(false);
    expect(isProductionDbPath(home.dbPath)).toBe(false);
    // And the worker itself now resolves there — the seeds cannot escape.
    expect(resolveDbPath()).toBe(home.dbPath);
    expect(process.env.SUPERTWIN_HOME).toBe(home.home);

    home.dispose();
    expect(existsSync(home.home)).toBe(false);
    expect(process.env.SUPERTWIN_HOME).toBeUndefined();
    expect(process.env.SUPERTWIN_DB_PATH).toBeUndefined();
  });

  it("keeps an operator-supplied sandbox as-is", () => {
    const dir = mkdtempSync(join(tmpdir(), "supertwin-home-test-"));
    try {
      process.env.SUPERTWIN_HOME = dir;
      const home = establishEvalHome();
      expect(home.ephemeral).toBe(false);
      expect(home.production).toBe(false);
      expect(home.dbPath).toBe(join(dir, "supertwinv13.db"));
      home.dispose();
      // dispose() of a caller-owned home must not delete the caller's data.
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("THROWS when the environment explicitly points at the production home", () => {
    process.env.SUPERTWIN_HOME = productionHome();
    expect(() => establishEvalHome()).toThrow(EvalHomeLeakError);
    expect(() => establishEvalHome()).toThrow(/PRODUCTION database/);
    expect(() => establishEvalHome()).toThrow(ALLOW_PRODUCTION_FLAG);

    clearEnv();
    process.env.SUPERTWIN_DB_PATH = PROD_DB;
    expect(() => establishEvalHome()).toThrow(EvalHomeLeakError);
  });

  it("only an explicit override may target the real home", () => {
    process.env.SUPERTWIN_HOME = productionHome();
    const home = establishEvalHome({ allowProductionHome: true });
    expect(home.production).toBe(true);
    expect(home.dbPath).toBe(PROD_DB);
    home.dispose();
  });
});

describe("assertEvalDbIsolated — the chokepoint", () => {
  it("throws while the resolved DB is the production one", () => {
    expect(resolveDbPath()).toBe(PROD_DB);
    expect(() => assertEvalDbIsolated("test")).toThrow(EvalHomeLeakError);
    expect(() => assertEvalDbIsolated("test")).toThrow(/test resolves to the PRODUCTION database/);
  });

  it("passes once a sandbox is in place, and again after the waiver is reset", () => {
    const home = establishEvalHome();
    expect(() => assertEvalDbIsolated()).not.toThrow();
    home.dispose();
    expect(() => assertEvalDbIsolated()).toThrow(EvalHomeLeakError);
  });

  it("honours the waiver establishEvalHome recorded", () => {
    process.env.SUPERTWIN_HOME = productionHome();
    const home = establishEvalHome({ allowProductionHome: true });
    expect(() => assertEvalDbIsolated()).not.toThrow();
    home.dispose();
    expect(() => assertEvalDbIsolated()).toThrow(EvalHomeLeakError);
  });
});

describe("registerProductExecutors refuses the production home", () => {
  it("REGRESSION: wiring the seeding executors against ~/SuperTwinV13 throws", async () => {
    expect(resolveDbPath()).toBe(PROD_DB);
    await expect(registerProductExecutors()).rejects.toThrow(EvalHomeLeakError);
    await expect(registerProductExecutors()).rejects.toThrow(
      /registerProductExecutors\(\) resolves to the PRODUCTION database/,
    );
  });

  it("wires normally inside a sandbox", async () => {
    const home = establishEvalHome();
    try {
      await expect(registerProductExecutors()).resolves.toBeUndefined();
    } finally {
      home.dispose();
    }
  });
});

describe("the eval CLI's fixture path", () => {
  it("REGRESSION: refuses to start (exit 3) when aimed at the production home", async () => {
    process.env.SUPERTWIN_HOME = productionHome();
    const lines: string[] = [];
    const code = await main(
      ["--dir", join(repoRoot(), "evals", "v13", "selftest"), "--judge", "stub"],
      (l) => lines.push(l),
    );
    expect(code).toBe(3);
    expect(lines.join("\n")).toContain(ALLOW_PRODUCTION_FLAG);
  });

  it("REGRESSION: an unconfigured run announces a temp home and restores the env", async () => {
    const lines: string[] = [];
    const code = await main(
      ["--dir", join(repoRoot(), "evals", "v13", "selftest"), "--judge", "stub"],
      (l) => lines.push(l),
    );
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("eval home:");
    expect(text).toContain("(temporary, deleted after the run)");
    expect(text).not.toContain(productionHome());
    // The sandbox is torn down; a later `npm run worker` is unaffected.
    expect(process.env.SUPERTWIN_HOME).toBeUndefined();
  });
});

describe("homedir sanity", () => {
  it("productionHome is ~/SuperTwinV13", () => {
    expect(productionHome()).toBe(join(homedir(), "SuperTwinV13"));
  });
});
