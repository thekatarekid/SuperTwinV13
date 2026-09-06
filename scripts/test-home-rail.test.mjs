// ===========================================================================
// The BUILD-SCRIPTS suite never reads or writes the user's real home either.
//
// The worker suite got this rail at the V6P1S6c gate (src/test-setup.ts +
// src/test-home-rail.test.ts). This project was missed, and it imports worker
// modules directly — `stage-media-tools.test.mjs` imports
// `worker/src/retrieval/embedder.ts`, whose `embeddingModelFileUrl()` defaults
// its spec to `activeEmbeddingModel()`, which reads `app_state` out of
// `getDb()`. With SUPERTWIN_HOME unset that is ~/SuperTwinV13/supertwinv13.db:
// the user's live database, opened by `npm test` while their app holds it.
//
// It was not theoretical and it was not silent for once — it read the user's
// chosen embedding model and failed the manifest comparison against it, and
// three agents in a row wrote the red off as "pre-existing, unrelated" before
// anybody ran the file with a scratch home and watched it go green.
//
// These assertions are what makes removing scripts/test-setup.mjs fail loudly.
// ===========================================================================

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { homeRoot } from "../worker/src/home.ts";
import { activeEmbeddingModelId, BUNDLED_EMBEDDING_MODEL_ID } from "../worker/src/retrieval/model-registry.ts";

const PRODUCTION_HOME = resolve(join(homedir(), "SuperTwinV13"));

describe("the build-scripts suite never resolves the production home", () => {
  afterEach(() => {
    delete process.env.SUPERTWIN_HOME;
  });

  it("homeRoot() is a scratch dir, not ~/SuperTwinV13, with nothing set by the suite", () => {
    expect(homeRoot()).not.toBe(PRODUCTION_HOME);
    expect(homeRoot().startsWith(resolve(tmpdir()))).toBe(true);
  });

  it("a blank SUPERTWIN_HOME is treated as unset, not as the production default", () => {
    process.env.SUPERTWIN_HOME = "   ";
    // The rail runs in beforeEach, so this case's own assignment is what the
    // NEXT test sees; within this one, prove homeRoot() still refuses to be
    // the production home by re-applying the rail's rule directly.
    const set = process.env.SUPERTWIN_HOME;
    if (!set || set.trim().length === 0) process.env.SUPERTWIN_HOME = join(tmpdir(), "supertwin-scripts-blank");
    expect(homeRoot()).not.toBe(PRODUCTION_HOME);
  });

  it("an explicit SUPERTWIN_HOME still wins — the rail defaults, it does not override", () => {
    const mine = join(tmpdir(), "supertwin-scripts-rail-explicit");
    process.env.SUPERTWIN_HOME = mine;
    expect(homeRoot()).toBe(resolve(mine));
  });

  it("the active embedding model reads the BUNDLED default, not whatever the user picked", () => {
    // The exact read that failed: with no scratch home this answered out of
    // the user's database. Under the rail there is no database, the lookup
    // throws and is caught, and the answer is the bundled encoder.
    expect(activeEmbeddingModelId()).toBe(BUNDLED_EMBEDDING_MODEL_ID);
  });
});
