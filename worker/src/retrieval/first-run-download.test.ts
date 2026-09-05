// ===========================================================================
// First-run download of the default encoder (V6 S2.2 — Build §5.1: Gemma
// downloads on first run; the bundled encoder covers search until then).
//
// The download manager is stubbed: nothing here touches the network. What is
// asserted is the DECISION — when boot asks for the fetch and when it must not.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-first-run-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
delete process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD;

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { EMBEDDING_MODEL_GEMMA, EMBEDDING_MODEL_E5_BASE, activeEmbeddingModelId, setActiveEmbeddingModelId } =
  await import("./model-registry.js");
const { embeddingModelFilePath } = await import("./embedder.js");
const {
  EMBEDDING_MODEL_CHOSEN_KEY,
  ensureDefaultEmbeddingModelDownload,
  firstRunDownloadEnabled,
  markEmbeddingModelChosenByUser,
} = await import("./default-model.js");

type Spec = typeof EMBEDDING_MODEL_GEMMA;

function stage(spec: Spec): void {
  for (const f of spec.files) {
    const p = embeddingModelFilePath(f.path, spec);
    mkdirSync(dirname(p), { recursive: true });
    closeSync(openSync(p, "w"));
    truncateSync(p, f.bytes);
  }
}

function unstage(spec: Spec): void {
  rmSync(dirname(embeddingModelFilePath(spec.files[0].path, spec)), { recursive: true, force: true });
}

beforeAll(() => runMigrations());
afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  unstage(EMBEDDING_MODEL_GEMMA);
  getDb().prepare(`DELETE FROM app_state WHERE key LIKE 'retrieval.embedding_model%'`).run();
  delete process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD;
});

describe("the switch", () => {
  it("is off under test unless forced, and SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD=0 always wins", () => {
    expect(firstRunDownloadEnabled()).toBe(false); // NODE_ENV=test
    process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD = "1";
    expect(firstRunDownloadEnabled()).toBe(true);
    process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD = "0";
    expect(firstRunDownloadEnabled()).toBe(false);
  });
});

describe("ensureDefaultEmbeddingModelDownload", () => {
  it("does nothing when the default's weights are already here", () => {
    stage(EMBEDDING_MODEL_GEMMA);
    process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD = "1";
    let called = 0;
    expect(ensureDefaultEmbeddingModelDownload({ start: () => (called++, null) })).toBe("present");
    expect(called).toBe(0);
  });

  it("never fetches over a human's pick", () => {
    process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD = "1";
    setActiveEmbeddingModelId(EMBEDDING_MODEL_E5_BASE.id);
    markEmbeddingModelChosenByUser();
    expect(getDb().prepare(`SELECT value FROM app_state WHERE key = ?`).get(EMBEDDING_MODEL_CHOSEN_KEY)).toBeTruthy();
    let called = 0;
    expect(ensureDefaultEmbeddingModelDownload({ start: () => (called++, null) })).toBe("user-chose");
    expect(called).toBe(0);
  });

  it("is disabled under test by default", () => {
    let called = 0;
    expect(ensureDefaultEmbeddingModelDownload({ start: () => (called++, null) })).toBe("disabled");
    expect(called).toBe(0);
  });

  it("starts the default's download and adopts it when the bytes land", async () => {
    process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD = "1";
    let asked: Spec | null = null;
    let onComplete: ((spec: Spec) => void | Promise<void>) | undefined;
    const outcome = ensureDefaultEmbeddingModelDownload({
      start: (spec, opts) => {
        asked = spec;
        onComplete = opts?.onComplete;
        return {
          modelId: spec.id,
          status: "downloading",
          receivedBytes: 0,
          totalBytes: 1,
          file: spec.files[0].path,
          error: null,
        };
      },
    });
    expect(outcome).toBe("started");
    expect(asked!.id).toBe(EMBEDDING_MODEL_GEMMA.id);
    // Until it lands, the bundled encoder is what answers.
    expect(activeEmbeddingModelId()).not.toBe(EMBEDDING_MODEL_GEMMA.id);
    // The bytes land (staged at their pinned lengths) → the empty index is
    // pointed at the default. No swap needed: nothing to re-embed.
    stage(EMBEDDING_MODEL_GEMMA);
    await onComplete!(EMBEDDING_MODEL_GEMMA);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_GEMMA.id);
  });

  it("reports a download already in flight rather than starting a second", () => {
    process.env.SUPERTWIN_EMBEDDING_AUTO_DOWNLOAD = "1";
    const outcome = ensureDefaultEmbeddingModelDownload({
      start: (spec) => ({
        modelId: spec.id,
        status: "downloading",
        receivedBytes: 4096,
        totalBytes: 1,
        file: spec.files[2].path,
        error: null,
      }),
    });
    expect(outcome).toBe("already-downloading");
  });
});
