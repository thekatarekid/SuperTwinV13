// ===========================================================================
// vitest setupFiles (scripts/vitest.config.mjs) — runs before every test file
// in the build-scripts project.
//
// THE SAME RAIL worker/src/test-setup.ts carries, for the same reason, in the
// one suite that was missed when it landed.
//
// `homeRoot()` (worker/src/home.ts) falls back to ~/SuperTwinV13 when
// SUPERTWIN_HOME is unset — right in production, wrong in every test. The
// build-scripts suite imports worker modules directly (stage-media-tools.test
// imports `worker/src/retrieval/embedder.ts`, which reaches
// `activeEmbeddingModel()` → `storedEmbeddingModelId()` → `getDb()`), so with
// no home set it OPENED THE USER'S REAL DATABASE and answered out of it.
//
// That was not theoretical. `stage-media-tools.test.mjs`'s encoder test read
// the user's chosen embedding model out of `~/SuperTwinV13/supertwinv13.db`
// and compared the staged manifest against it — so on a machine where the
// user had upgraded to EmbeddingGemma the test failed, and on a fresh machine
// it passed. Three agents recorded it as an unrelated pre-existing red before
// anyone ran it with a scratch home.
//
// beforeEach rather than a one-shot assignment, matching the worker rail: a
// suite that clears the variable in its own afterEach must not re-open the
// hole for the next test in the file. Hooks a setup file registers run before
// the suite's own beforeEach, so a suite that sets its own home still wins.
// ===========================================================================

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach } from "vitest";

/** One scratch home per test FILE (setupFiles run once per file). */
const scratchHome = mkdtempSync(join(tmpdir(), "supertwin-scripts-test-"));

/** The fallback this rail exists to keep tests away from. Exported for the rail's own test. */
export const TEST_SCRATCH_HOME = scratchHome;

beforeEach(() => {
  const set = process.env.SUPERTWIN_HOME;
  if (!set || set.trim().length === 0) process.env.SUPERTWIN_HOME = scratchHome;
});
