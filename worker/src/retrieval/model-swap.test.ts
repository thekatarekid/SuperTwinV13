// Swapping the embedding model, and the benchmark that argues for it (5.4).
//
// The property under test is the one that is easy to lose: the index NEVER
// holds two models at once, and search never goes dark while a swap runs. So
// the candidate embedder here is a stub that, on every batch, looks at the
// database and reports what the OLD index still contains. If the swap were
// re-embedding in place, that number would be falling.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-model-swap-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { closeDb, getDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const { countEmbeddableEvents, countEventEmbeddings, putEventEmbeddings } = await import(
  "../db/embeddings.js"
);
const {
  ACTIVE_EMBEDDING_MODEL_KEY,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_E5_BASE,
  activeEmbeddingModelId,
} = await import("./model-registry.js");
const { embeddingModelFilePath, forgetEmbedder, setEmbedder } = await import("./embedder.js");
const {
  cancelEmbeddingSwap,
  countEmbeddable,
  embeddingSwapState,
  readCorpus,
  resetEmbeddingSwapForTests,
  startEmbeddingSwap,
} = await import("./model-swap.js");
const { runEmbeddingBenchmark } = await import("./benchmark.js");
const { semanticSearch, resetSemanticCacheForTests } = await import("./semantic.js");
const { setSemanticRetrievalEnabled } = await import("../db/settings.js");

type Spec = typeof EMBEDDING_MODEL;
type Embedder = {
  model: string;
  dim: number;
  embed(texts: readonly string[], role: "query" | "passage"): Promise<Float32Array[]>;
};

const OLD_KEY = { model: EMBEDDING_MODEL.id, dim: EMBEDDING_MODEL.dim };
const NEW_KEY = { model: EMBEDDING_MODEL_E5_BASE.id, dim: EMBEDDING_MODEL_E5_BASE.dim };

const CH = "ch-swap";
const EVENTS = 40;

/** A vector that depends only on the text, so two runs agree with themselves. */
function hashVector(text: string, dim: number, salt = 0): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < text.length; i++) {
    v[(text.charCodeAt(i) + salt * (i + 1)) % dim] += 1;
  }
  // Never the zero vector: cosine of zero against anything is 0 for every row.
  v[(text.length + salt) % dim] += 1;
  return v;
}

function stubEmbedder(
  spec: Spec,
  opts: { salt?: number; onBatch?(texts: readonly string[]): void; dim?: number } = {},
): Embedder {
  return {
    model: spec.id,
    dim: opts.dim ?? spec.dim,
    async embed(texts) {
      opts.onBatch?.(texts);
      return texts.map((t) => hashVector(t, opts.dim ?? spec.dim, opts.salt ?? 0));
    },
  };
}

/** Sparse files at the pinned lengths — the presence check reads lengths only. */
function stageModelFiles(spec: Spec): void {
  for (const file of spec.files) {
    const path = embeddingModelFilePath(file.path, spec);
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "w"));
    truncateSync(path, file.bytes);
  }
}

function addEvent(id: string, text: string, ts: string): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text, external_id)
       VALUES (?, 'whatsapp', 'whatsapp', ?, 'ac-1', ?, 'message', ?, ?)`,
    )
    .run(id, CH, ts, text, id);
}

/** Fill the OLD index the way a settled install has it: every event, one model. */
function seedOldIndex(): void {
  const rows = readCorpus();
  putEventEmbeddings(
    rows.map((r) => ({
      ...OLD_KEY,
      eventId: r.id,
      vector: hashVector(r.text, OLD_KEY.dim),
    })),
  );
}

async function waitForSwap(): Promise<NonNullable<ReturnType<typeof embeddingSwapState>>> {
  for (let i = 0; i < 500; i++) {
    const state = embeddingSwapState();
    if (state && state.phase !== "embedding" && state.phase !== "flipping") return state;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the swap");
}

/** Every (model, dim) pair the vector table holds right now. */
function indexModels(): string[] {
  return (
    getDb()
      .prepare(`SELECT DISTINCT model, dim FROM event_embeddings ORDER BY model`)
      .all() as { model: string; dim: number }[]
  ).map((r) => `${r.model}:${r.dim}`);
}

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  db.prepare(
    `INSERT INTO channels (id, source_id, name, kind) VALUES (?, 'whatsapp', 'Swap', 'group')`,
  ).run(CH);
  db.prepare(
    `INSERT INTO actors (id, source_id, display_name) VALUES ('ac-1', 'whatsapp', 'Rahul')`,
  ).run();
  for (let i = 0; i < EVENTS; i++) {
    addEvent(
      `evt-${i}`,
      `message number ${i} about restaurant booking and weekend plans`,
      new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
    );
  }
  stageModelFiles(EMBEDDING_MODEL);
  stageModelFiles(EMBEDDING_MODEL_E5_BASE);
  setSemanticRetrievalEnabled(true);
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetEmbeddingSwapForTests();
  forgetEmbedder();
  resetSemanticCacheForTests();
  getDb().prepare(`DELETE FROM event_embeddings`).run();
  getDb().prepare(`DELETE FROM app_state WHERE key = ?`).run(ACTIVE_EMBEDDING_MODEL_KEY);
  seedOldIndex();
});

// ===========================================================================

describe("what a swap has to re-embed", () => {
  it("counts exactly what the incremental indexer would claim", () => {
    // The two predicates live in different files; if they ever drift, this is
    // where it is caught rather than in a half-built index.
    expect(countEmbeddable()).toBe(countEmbeddableEvents());
    expect(countEmbeddable()).toBe(EVENTS);
    expect(readCorpus().length).toBe(EVENTS);
  });
});

describe("swapping the model", () => {
  it("keeps the old index serving every batch, then flips in one step", async () => {
    const oldCounts: number[] = [];
    const activeDuring: string[] = [];
    setEmbedder(stubEmbedder(EMBEDDING_MODEL));

    startEmbeddingSwap(EMBEDDING_MODEL_E5_BASE.id, {
      batch: 8,
      loadEmbedder: async () =>
        stubEmbedder(EMBEDDING_MODEL_E5_BASE, {
          salt: 3,
          onBatch: () => {
            oldCounts.push(countEventEmbeddings(OLD_KEY));
            activeDuring.push(activeEmbeddingModelId());
          },
        }),
    });

    const done = await waitForSwap();
    expect(done.phase).toBe("done");
    expect(done.embedded).toBe(EVENTS);
    expect(done.total).toBe(EVENTS);

    // Five batches of events, and the old index was whole for every one.
    expect(oldCounts.length).toBe(EVENTS / 8);
    expect(oldCounts.every((n) => n === EVENTS)).toBe(true);
    // …and the pointer never moved early, so search kept answering from it.
    expect(activeDuring.every((id) => id === EMBEDDING_MODEL.id)).toBe(true);

    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_E5_BASE.id);
    expect(countEventEmbeddings(NEW_KEY)).toBe(EVENTS);
    expect(countEventEmbeddings(OLD_KEY)).toBe(0);
  });

  it("leaves a single-model index — a mixed one is not reachable", async () => {
    setEmbedder(stubEmbedder(EMBEDDING_MODEL));
    expect(indexModels()).toEqual([`${OLD_KEY.model}:${OLD_KEY.dim}`]);

    startEmbeddingSwap(EMBEDDING_MODEL_E5_BASE.id, {
      batch: 8,
      loadEmbedder: async () => stubEmbedder(EMBEDDING_MODEL_E5_BASE, { salt: 3 }),
    });
    expect((await waitForSwap()).phase).toBe("done");

    expect(indexModels()).toEqual([`${NEW_KEY.model}:${NEW_KEY.dim}`]);
  });

  it("search keeps answering while the swap runs", async () => {
    setEmbedder(stubEmbedder(EMBEDDING_MODEL));
    let midSwapHits = -1;

    startEmbeddingSwap(EMBEDDING_MODEL_E5_BASE.id, {
      batch: 8,
      loadEmbedder: async () =>
        stubEmbedder(EMBEDDING_MODEL_E5_BASE, {
          salt: 3,
          onBatch: () => {
            if (midSwapHits < 0) {
              // Deliberately synchronous-ish: the count the searcher would read.
              midSwapHits = countEventEmbeddings(OLD_KEY);
            }
          },
        }),
    });
    const before = await semanticSearch("restaurant booking");
    expect((await waitForSwap()).phase).toBe("done");

    expect(midSwapHits).toBe(EVENTS);
    expect(before.length).toBeGreaterThan(0);
  });

  it("a cancel writes nothing at all — the old index is untouched", async () => {
    setEmbedder(stubEmbedder(EMBEDDING_MODEL));
    startEmbeddingSwap(EMBEDDING_MODEL_E5_BASE.id, {
      batch: 4,
      loadEmbedder: async () =>
        stubEmbedder(EMBEDDING_MODEL_E5_BASE, {
          salt: 3,
          onBatch: () => {
            cancelEmbeddingSwap();
          },
        }),
    });

    expect((await waitForSwap()).phase).toBe("cancelled");
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL.id);
    expect(countEventEmbeddings(OLD_KEY)).toBe(EVENTS);
    expect(countEventEmbeddings(NEW_KEY)).toBe(0);
  });

  it("a candidate that will not load costs nothing", async () => {
    setEmbedder(stubEmbedder(EMBEDDING_MODEL));
    startEmbeddingSwap(EMBEDDING_MODEL_E5_BASE.id, {
      loadEmbedder: async () => {
        throw new Error("onnxruntime fell over");
      },
    });

    const failed = await waitForSwap();
    expect(failed.phase).toBe("error");
    expect(failed.error).toMatch(/onnxruntime/);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL.id);
    expect(countEventEmbeddings(OLD_KEY)).toBe(EVENTS);
  });

  it("refuses a candidate whose vectors are not the shape it declared", async () => {
    startEmbeddingSwap(EMBEDDING_MODEL_E5_BASE.id, {
      loadEmbedder: async () => stubEmbedder(EMBEDDING_MODEL_E5_BASE, { dim: 111 }),
    });
    const failed = await waitForSwap();
    expect(failed.phase).toBe("error");
    expect(failed.error).toMatch(/111 dimensions/);
    expect(countEventEmbeddings(OLD_KEY)).toBe(EVENTS);
  });

  it("refuses a model that is not in the catalogue, and one that is not on disk", () => {
    expect(() => startEmbeddingSwap("not/a-model")).toThrow(/unknown embedding model/);
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = join(tmpRoot, "empty");
    try {
      expect(() => startEmbeddingSwap(EMBEDDING_MODEL_E5_BASE.id)).toThrow(/not downloaded/);
    } finally {
      delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
    }
  });
});

describe("the on-corpus benchmark", () => {
  const loadEither = async (spec: Spec) =>
    spec.id === EMBEDDING_MODEL.id
      ? stubEmbedder(EMBEDDING_MODEL)
      : stubEmbedder(EMBEDDING_MODEL_E5_BASE, { salt: 3 });

  it("measures agreement and speed on the user's own messages", async () => {
    const result = await runEmbeddingBenchmark(EMBEDDING_MODEL_E5_BASE.id, {
      sample: 30,
      k: 5,
      probes: 6,
      loadEmbedder: loadEither,
    });

    expect(result.activeModel).toBe(EMBEDDING_MODEL.id);
    expect(result.candidateModel).toBe(EMBEDDING_MODEL_E5_BASE.id);
    expect(result.sampleSize).toBe(30);
    expect(result.probes).toBe(6);
    expect(result.k).toBe(5);
    expect(result.overlapAtK).toBeGreaterThanOrEqual(0);
    expect(result.overlapAtK).toBeLessThanOrEqual(1);
    expect(result.activeMsPerEvent).toBeGreaterThanOrEqual(0);
    expect(result.candidateMsPerEvent).toBeGreaterThanOrEqual(0);

    // The recommendation is composed from the numbers, not from a table of
    // claims: the percentage in the sentence is the measured one.
    expect(result.recommendation).toContain(`${Math.round(result.overlapAtK * 100)}%`);
    expect(result.recommendation).toContain("30 of your own");
    expect(result.recommendation).toMatch(/google\/embeddinggemma-300m|Xenova\/multilingual-e5-base/);
  });

  it("says a candidate that agrees with the current model is not worth the swap", async () => {
    const result = await runEmbeddingBenchmark(EMBEDDING_MODEL_E5_BASE.id, {
      sample: 20,
      k: 4,
      probes: 5,
      // Same vectors from both: perfect agreement, nothing to gain.
      loadEmbedder: async () => stubEmbedder(EMBEDDING_MODEL_E5_BASE),
    });
    expect(result.overlapAtK).toBe(1);
    expect(result.recommendation).toContain("100%");
    expect(result.recommendation).toMatch(/not worth the swap/);
  });

  it("refuses to benchmark the model already in use, or one it does not know", async () => {
    await expect(
      runEmbeddingBenchmark(EMBEDDING_MODEL.id, { loadEmbedder: loadEither }),
    ).rejects.toThrow(/already the model in use/);
    await expect(runEmbeddingBenchmark("not/a-model")).rejects.toThrow(
      /unknown embedding model/,
    );
  });
});
