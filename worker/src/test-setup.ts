// ===========================================================================
// vitest setupFiles (worker/vitest.config.ts) — runs before every test file.
//
// TWO RAILS, both of which exist because production data is one missing env
// var away from every suite in this tree.
//
// 1. CONSENT. The consent gate (db/consent-gate.ts, V6 S1.2) drops any event
//    whose source has no live 'connected' consent row. The worker's suites
//    predate consent and write events to test things that are not consent, so
//    the gate is OPEN for the suite by default. A suite that tests the gate
//    itself (CNS-*) switches it back in its own beforeEach:
//
//      const prev = setConsentGateMode("enforce");   // beforeEach
//      setConsentGateMode(prev);                     // afterEach
//
//    Production never runs this file; there the gate is enforced unconditionally.
//
// 2. HOME. `homeRoot()` (home.ts) falls back to ~/SuperTwinV13 when
//    SUPERTWIN_HOME is unset — correct in production, catastrophic in a test.
//    Most suites set a scratch home; the ones that forget wrote into the USER'S
//    REAL HOME, and nothing failed, because writing a file is not an assertion.
//    `evals/executors/liv.test.ts` did exactly that: it drives the real
//    executor-lite, whose `liteWorkspaceDir()` mkdir -p's
//    <home>/executor/lite-<id>/ and drops result.json in it — so every run left
//    a directory in ~/SuperTwinV13/executor/. Found at the V6P1S6c gate by
//    noticing the production db's mtime move during a suite run.
//
//    So: before EVERY test, if SUPERTWIN_HOME is unset or blank, point it at a
//    scratch directory under $TMPDIR. beforeEach rather than a one-shot
//    assignment because ~20 suites `delete process.env.SUPERTWIN_HOME` in their
//    own afterEach, which would otherwise re-open the hole for the next test in
//    the file. Ordering composes correctly with every existing pattern: hooks
//    registered by a setup file run BEFORE the suite's own beforeEach, so a
//    suite that sets its own home still wins, and home.test.ts — which deletes
//    the var precisely to assert the ~/SuperTwinV13 fallback — still sees it
//    unset. That assertion is a pure read and writes nothing.
//
//    This is a rail, not a convenience: a suite that wants a scratch home
//    should still say so. It exists so that forgetting cannot reach real data.
// ===========================================================================

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach } from "vitest";

import { setConsentGateMode } from "./db/consent-gate.js";

setConsentGateMode("open");

/** One scratch home per test FILE (setupFiles run once per file). */
const scratchHome = mkdtempSync(join(tmpdir(), "supertwin-worker-test-"));

/** The fallback this rail exists to keep tests away from. Exported for the rail's own test. */
export const TEST_SCRATCH_HOME = scratchHome;

beforeEach(() => {
  const set = process.env.SUPERTWIN_HOME;
  if (!set || set.trim().length === 0) process.env.SUPERTWIN_HOME = scratchHome;
});
