// Which encoder a fresh install ends up on (defect 5b).
//
// The 13.4.1 build defaulted to the bundled E5 Small and offered EmbeddingGemma
// as an inert line of text with no way to fetch it, so every install stayed on
// E5 Small for good. The default is Gemma now, and this pins the three rules
// that make moving onto it safe:
//
//   1. never before the weights are on disk;
//   2. never over a choice a human made;
//   3. never as a silent flip on an index that already holds vectors — that
//      goes through the background swap, which flips the pointer only at the
//      end.
//
// Nothing here loads an ONNX runtime or calls a model: adoption is a decision
// about files and rows.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-default-model-"));
const MODEL_DIR = join(tmpRoot, "models");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = MODEL_DIR;

const { runMigrations } = await import("../db/index.js");
const { getDb, closeDb } = await import("../db/connection.js");
const {
  ACTIVE_EMBEDDING_MODEL_KEY,
  BUNDLED_EMBEDDING_MODEL_ID,
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_E5_BASE,
  EMBEDDING_MODEL_GEMMA,
  activeEmbeddingModelId,
} = await import("./model-registry.js");
const {
  EMBEDDING_MODEL_CHOSEN_KEY,
  adoptDefaultEmbeddingModel,
  markEmbeddingModelChosenByUser,
  seedActiveEmbeddingModel,
} = await import("./default-model.js");

runMigrations();

/** Write every one of a model's files at its pinned length, so it reads present. */
function stage(spec: { id: string; files: readonly { path: string; bytes: number }[] }): void {
  for (const f of spec.files) {
    const path = join(MODEL_DIR, ...spec.id.split("/"), ...f.path.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.alloc(f.bytes));
  }
}

function unstage(): void {
  rmSync(MODEL_DIR, { recursive: true, force: true });
}

function clearState(): void {
  const db = getDb();
  db.prepare(`DELETE FROM app_state WHERE key IN (?, ?)`).run(
    ACTIVE_EMBEDDING_MODEL_KEY,
    EMBEDDING_MODEL_CHOSEN_KEY,
  );
  db.prepare(`DELETE FROM event_embeddings`).run();
}

beforeEach(() => {
  clearState();
  unstage();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the default encoder", () => {
  it("is EmbeddingGemma 300M, and it is not the bundled one", () => {
    expect(DEFAULT_EMBEDDING_MODEL_ID).toBe(EMBEDDING_MODEL_GEMMA.id);
    expect(BUNDLED_EMBEDDING_MODEL_ID).not.toBe(DEFAULT_EMBEDDING_MODEL_ID);
  });

  it("a fresh install with the weights here ends up on EmbeddingGemma", () => {
    stage(EMBEDDING_MODEL_GEMMA);
    expect(seedActiveEmbeddingModel()).toBe("activated");
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_GEMMA.id);
  });

  it("a fresh install WITHOUT them stays on the bundled encoder rather than going dark", () => {
    // The default's weights are 330 MB and are not in the .app. Naming a model
    // the runtime cannot load would leave search answering out of nothing.
    expect(seedActiveEmbeddingModel()).toBe("not-downloaded");
    expect(activeEmbeddingModelId()).toBe(BUNDLED_EMBEDDING_MODEL_ID);
  });

  it("adopts the default the moment its download lands — that IS the fresh-install path", () => {
    expect(adoptDefaultEmbeddingModel()).toBe("not-downloaded");
    expect(activeEmbeddingModelId()).toBe(BUNDLED_EMBEDDING_MODEL_ID);
    stage(EMBEDDING_MODEL_GEMMA);
    expect(adoptDefaultEmbeddingModel()).toBe("activated");
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_GEMMA.id);
    // Idempotent: the next download, boot or poll changes nothing.
    expect(adoptDefaultEmbeddingModel()).toBe("already-default");
  });
});

describe("what adoption refuses to do", () => {
  it("never overrules a human's pick", () => {
    stage(EMBEDDING_MODEL_GEMMA);
    getDb()
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(ACTIVE_EMBEDDING_MODEL_KEY, EMBEDDING_MODEL_E5_BASE.id);
    markEmbeddingModelChosenByUser();
    expect(adoptDefaultEmbeddingModel()).toBe("user-chose");
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_E5_BASE.id);
  });

  it("never flips a populated index — it starts the background swap instead", () => {
    stage(EMBEDDING_MODEL_GEMMA);
    const db = getDb();
    // One vector is all this needs: what is under test is the branch, not the
    // corpus. The row's event is not being created, so its foreign key is
    // stood down for the insert and restored immediately.
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO event_embeddings (event_id, model, dim, vector)
       VALUES ('e1', ?, 384, X'00')`,
    ).run(BUNDLED_EMBEDDING_MODEL_ID);
    db.pragma("foreign_keys = ON");
    const outcome = adoptDefaultEmbeddingModel();
    expect(["swap-started", "swap-running"]).toContain(outcome);
    // The pointer has NOT moved: the swap moves it inside the flip
    // transaction, once the new vectors exist. Until then every question is
    // still answered by the index that is actually there.
    expect(activeEmbeddingModelId()).toBe(BUNDLED_EMBEDDING_MODEL_ID);
  });
});
