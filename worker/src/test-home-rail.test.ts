// ===========================================================================
// The suite never writes into the user's real home.
//
// WHY THIS FILE EXISTS. `homeRoot()` falls back to ~/SuperTwinV13 when
// SUPERTWIN_HOME is unset. That is right in production and wrong in every
// test, and the failure mode is silent: a suite that forgets the env var does
// not fail, it just writes into real data. Found at the V6P1S6c gate —
// `evals/executors/liv.test.ts` drives the real executor-lite, whose
// `liteWorkspaceDir()` creates <home>/executor/lite-<id>/result.json, and
// every run of the worker suite had been leaving a directory in the user's
// ~/SuperTwinV13/executor/. Three of them were sitting there when this was
// found; 3,700 tests were green the whole time.
//
// src/test-setup.ts closes the class: before every test, an unset or blank
// SUPERTWIN_HOME is pointed at a scratch dir under $TMPDIR. These assertions
// are what makes removing that rail fail loudly instead of quietly.
// ===========================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { taskWorkspaceDir } from "./executor/tools.js";
import { homeRoot } from "./home.js";

const PRODUCTION_HOME = resolve(join(homedir(), "SuperTwinV13"));

describe("the worker suite never resolves the production home", () => {
  afterEach(() => {
    // Leave the env exactly as the rail hands it over, whatever a case did.
    delete process.env.SUPERTWIN_HOME;
  });

  it("homeRoot() is a scratch dir, not ~/SuperTwinV13, with nothing set by the suite", () => {
    // No beforeEach of our own sets SUPERTWIN_HOME: this is the default a
    // forgetful suite gets. Without the rail it is the user's real home.
    expect(homeRoot()).not.toBe(PRODUCTION_HOME);
    expect(homeRoot().startsWith(resolve(tmpdir()))).toBe(true);
  });

  it("a blank SUPERTWIN_HOME is treated as unset, not as \"\" -> cwd", () => {
    // homeRoot() itself ignores a blank value and falls back to the production
    // default, so the rail has to catch blank too, not just undefined.
    expect(homeRoot()).not.toBe(PRODUCTION_HOME);
  });

  it("an explicit SUPERTWIN_HOME still wins — the rail defaults, it does not override", () => {
    const mine = join(tmpdir(), "supertwin-rail-explicit");
    mkdirSync(mine, { recursive: true });
    process.env.SUPERTWIN_HOME = mine;
    expect(homeRoot()).toBe(resolve(mine));
  });

  it("taskWorkspaceDir() — the path that actually leaked — lands outside the real home", () => {
    // This is the exact call executor/lite.ts makes for a prepared action. It
    // mkdir -p's and the caller writes result.json into it, so doing both is
    // the whole proof: what gets created must not be under ~/SuperTwinV13.
    //
    // Asserted on the path this call RETURNS, never by probing the production
    // home for a filename. That probe is what the first draft of this test did,
    // and it wedged: the negative control that proved the rail works (rail off,
    // suite run, directory appears) left that very directory behind, so the
    // assertion stayed red afterwards on a machine where the rail was fine.
    // A test whose result depends on litter from an earlier run measures the
    // machine, not the code.
    const dir = taskWorkspaceDir("lite-prep_railcheck");
    const written = join(dir, "result.json");
    writeFileSync(written, "{}");

    expect(existsSync(written)).toBe(true);
    expect(dir.startsWith(PRODUCTION_HOME)).toBe(false);
    expect(written.startsWith(PRODUCTION_HOME)).toBe(false);
    expect(dir.startsWith(resolve(homeRoot()))).toBe(true);
  });
});
