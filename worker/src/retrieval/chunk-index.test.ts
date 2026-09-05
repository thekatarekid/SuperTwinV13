// ===========================================================================
// The chunk vector index (V6 P1 S2.2) — RET-03 and RET-05 as vitest, with a
// FAKE encoder (deterministic token-hash vectors; zero model calls, no network).
//
//   RET-03  "did I confirm the villa" → "yes, book it" (12 chars) is returned
//           through the chat chunk that contains it. The message itself has
//           no vector; the 2 k window it sits in does, and it cites the event.
//   RET-05  the embedding flip is atomic. A re-embed writes into a staging
//           table search never reads; the process dying mid-way leaves the
//           live index exactly as it was (and boot drops the leftover); a flip
//           that fails half-way rolls everything back — vectors AND pointer;
//           at no observable instant does the live table hold two models.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-chunk-index-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { appendEvent } = await import("../db/eventlog.js");
const { chunkEmbeddingCount, chunksFor, readChunk } = await import("../db/v6graph.js");
const { runChunker, resetChunkerMarks } = await import("./chunker.js");
const {
  CHUNK_EMBEDDINGS_STAGING_TABLE,
  CHUNK_EMBEDDINGS_TABLE,
  beginChunkStaging,
  chunkIndexStatus,
  chunkStagingExists,
  dropChunkStaging,
  embedChunksInto,
  flipChunkStagingLive,
  indexChunkBatch,
  rankChunks,
  resetChunkIndexForTests,
  vectorSearchChunks,
} = await import("./chunk-index.js");
const { EMBEDDING_MODEL, EMBEDDING_MODEL_GEMMA, activeEmbeddingModelId, setActiveEmbeddingModelId } = await import(
  "./model-registry.js"
);
const { embeddingModelFilePath, forgetEmbedder, setEmbedder } = await import("./embedder.js");
const { countEmbeddable, embeddingSwapState, resetEmbeddingSwapForTests, startEmbeddingSwap } = await import("./model-swap.js");
const { setSemanticRetrievalEnabled } = await import("../db/settings.js");

type Spec = typeof EMBEDDING_MODEL;
type Embedder = {
  model: string;
  dim: number;
  embed(texts: readonly string[], role: "query" | "passage"): Promise<Float32Array[]>;
};

// ---- The fake encoder -----------------------------------------------------------
//
// A bag of hashed tokens: each word lands in one of `dim` buckets. Two texts
// that share words share buckets; texts that share none are near-orthogonal.
// Honest about being a fixture — it proves the PLUMBING (chunk → vector →
// search → cited event), not multilingual retrieval quality.

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function bucket(word: string, dim: number, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return Math.abs(h) % dim;
}

function fakeVector(text: string, dim: number, salt = 0): Float32Array {
  const v = new Float32Array(dim);
  for (const w of tokens(text)) v[bucket(w, dim, salt)] += 1;
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  if (n === 0) v[salt % dim] = 1;
  else for (let i = 0; i < dim; i++) v[i] /= Math.sqrt(n);
  return v;
}

function fakeEmbedder(spec: Spec, opts: { salt?: number; onBatch?(texts: readonly string[]): void | Promise<void> } = {}): Embedder {
  return {
    model: spec.id,
    dim: spec.dim,
    async embed(texts) {
      await opts.onBatch?.(texts);
      return texts.map((t) => fakeVector(t, spec.dim, opts.salt ?? 0));
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

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
let clock = 0;
function ts(): string {
  clock += 1;
  return new Date(T0 + clock * 1000).toISOString();
}

function chat(streamKey: string, actor: string, text: string): string {
  return appendEvent({
    ts: ts(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor,
    roles: { sender: actor, audience: ["self", actor], receiver: ["self"], mentions: [] },
    payload: { text },
  }).id;
}

/** Distinct-vocabulary filler so distractor windows share no token with the probe. */
const FILLER = [
  "office standup moved to eleven, slides pending review",
  "gym leg day then protein shake, knees feel fine",
  "mom asked about the plumber invoice and the tap",
  "quarterly numbers landed, margins slightly better",
  "cricket final tonight, who has the stream link",
  "dentist appointment shifted to thursday morning",
];

function seedGoaChat(): { yes: string; stream: string } {
  const stream = "goa-gang@g.us";
  for (let i = 0; i < 90; i++) chat(stream, i % 2 ? "contact:rohan" : "contact:priya", `${FILLER[i % FILLER.length]} ${i}`);
  chat(stream, "contact:rohan", "so are we confirming the villa with the pool for october?");
  const yes = chat(stream, "self", "yes, book it");
  for (let i = 0; i < 30; i++) chat(stream, "contact:priya", `${FILLER[(i + 3) % FILLER.length]} again ${i}`);
  // Other streams, none about a villa.
  for (let i = 0; i < 40; i++) chat("work@g.us", "contact:anita", `${FILLER[i % FILLER.length]} w${i}`);
  return { yes, stream };
}

async function waitForSwap() {
  for (let i = 0; i < 1000; i++) {
    const s = embeddingSwapState();
    if (s && s.phase !== "embedding" && s.phase !== "flipping") return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the swap");
}

function liveModels(): string[] {
  return (getDb().prepare(`SELECT DISTINCT model FROM ${CHUNK_EMBEDDINGS_TABLE} ORDER BY model`).all() as { model: string }[]).map((r) => r.model);
}

beforeAll(() => {
  runMigrations();
  setSemanticRetrievalEnabled(true);
});

afterAll(() => {
  setEmbedder(null);
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  dropChunkStaging();
  db.exec(`DELETE FROM chunk_embeddings; DELETE FROM chunks; DELETE FROM events; DELETE FROM archive; DELETE FROM event_embeddings;
           DELETE FROM app_state WHERE key LIKE 'chunker.%' OR key LIKE 'retrieval.embedding_model%';`);
  resetChunkerMarks();
  resetChunkIndexForTests();
  resetEmbeddingSwapForTests();
  forgetEmbedder();
  setActiveEmbeddingModelId(EMBEDDING_MODEL.id);
  setEmbedder(fakeEmbedder(EMBEDDING_MODEL));
  clock = 0;
});

// ---------------------------------------------------------------------------

describe("indexing chunks", () => {
  it("embeds what has no vector, incrementally, and reports status", async () => {
    seedGoaChat();
    const r = runChunker();
    expect(r.chatChunks).toBeGreaterThan(3);
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
    let stored = 0;
    for (;;) {
      const n = await indexChunkBatch(3);
      if (n === 0) break;
      stored += n;
      expect(n).toBeLessThanOrEqual(3);
    }
    expect(stored).toBe(total);
    expect(chunkEmbeddingCount(EMBEDDING_MODEL.id)).toBe(total);
    const st = chunkIndexStatus(EMBEDDING_MODEL.id);
    expect(st).toMatchObject({ chunks: total, indexed: total, model: EMBEDDING_MODEL.id, staging: false });
    // Nothing left; a second pass is a no-op.
    expect(await indexChunkBatch()).toBe(0);
  });

  it("stores nothing and returns 0 when the tier is off", async () => {
    setEmbedder(null);
    process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "0";
    try {
      seedGoaChat();
      runChunker();
      expect(await indexChunkBatch()).toBe(0);
      expect(await vectorSearchChunks("villa")).toEqual([]);
    } finally {
      delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
    }
  });
});

describe("RET-03 — short message found via its window", () => {
  it('"did I confirm the villa" returns "yes, book it" through the chat chunk that contains it', async () => {
    const { yes, stream } = seedGoaChat();
    runChunker();
    while ((await indexChunkBatch(64)) > 0) {
      /* drain */
    }
    // The 12-char message has no vector of its own — its window does.
    const yesRow = getDb().prepare(`SELECT text FROM events WHERE id = ?`).get(yes) as { text: string };
    expect(yesRow.text).toBe("yes, book it");
    expect(yesRow.text.length).toBe(12);

    const hits = await vectorSearchChunks("did I confirm the villa", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top.chunk.kind).toBe("chat");
    expect(top.chunk.streamKey).toBe(stream);
    expect(top.chunk.eventIds).toContain(yes);
    expect(top.chunk.text).toContain("me: yes, book it");
    expect(top.chunk.text).toContain("confirming the villa");
    // The window is the citation unit and it names the event it covers.
    expect(readChunk(top.chunkId)?.eventIds).toContain(yes);
    // Bounded candidates (what the fusion layer hands in) rank the same way.
    const ids = chunksFor("chat", { streamKey: stream }).map((c) => c.id);
    const probe = fakeVector("did I confirm the villa", EMBEDDING_MODEL.dim);
    const bounded = rankChunks(probe, EMBEDDING_MODEL.id, { candidateIds: ids, limit: 1 });
    expect(bounded[0]?.chunkId).toBe(top.chunkId);
    expect(rankChunks(probe, EMBEDDING_MODEL.id, { candidateIds: [] })).toEqual([]);
  });
});

describe("RET-05 — embedding flip is atomic", () => {
  async function buildOldIndex(): Promise<number> {
    seedGoaChat();
    runChunker();
    while ((await indexChunkBatch(64)) > 0) {
      /* drain */
    }
    return chunkEmbeddingCount(EMBEDDING_MODEL.id);
  }

  it("a process killed mid re-embed leaves the live index whole; boot drops the leftover", async () => {
    const total = await buildOldIndex();
    expect(total).toBeGreaterThan(5);
    stageModelFiles(EMBEDDING_MODEL_GEMMA);

    // The "kill": the candidate encoder dies on its third batch. Everything
    // it embedded so far sits in the staging table — never in the live one.
    let batches = 0;
    const observed: { live: number; models: string[]; hitsFromOld: number }[] = [];
    const dying = fakeEmbedder(EMBEDDING_MODEL_GEMMA, {
      salt: 7,
      async onBatch() {
        batches++;
        // Mid-swap, every query is still answered by the OLD, complete index.
        const probe = fakeVector("did I confirm the villa", EMBEDDING_MODEL.dim);
        const hits = rankChunks(probe, EMBEDDING_MODEL.id, { limit: 5 });
        observed.push({ live: chunkEmbeddingCount(), models: liveModels(), hitsFromOld: hits.length });
        if (batches === 3) throw new Error("SIGKILL (simulated)");
      },
    });
    startEmbeddingSwap(EMBEDDING_MODEL_GEMMA.id, { loadEmbedder: async () => dying, batch: 2 });
    const state = await waitForSwap();
    expect(state.phase).toBe("error");
    expect(state.error).toContain("SIGKILL");

    expect(observed.length).toBe(3);
    for (const o of observed) {
      expect(o.live).toBe(total);
      expect(o.models).toEqual([EMBEDDING_MODEL.id]);
      expect(o.hitsFromOld).toBeGreaterThan(0);
    }
    // After the death: live table untouched, pointer untouched, leftover gone.
    expect(chunkEmbeddingCount()).toBe(total);
    expect(liveModels()).toEqual([EMBEDDING_MODEL.id]);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL.id);
    expect(chunkStagingExists()).toBe(false);

    // A harder death — the process is gone before the error path runs — leaves
    // a partial staging table on disk. Search never reads it; boot drops it.
    beginChunkStaging();
    await embedChunksInto(fakeEmbedder(EMBEDDING_MODEL_GEMMA, { salt: 7 }), CHUNK_EMBEDDINGS_STAGING_TABLE, 4);
    expect(chunkEmbeddingCount(EMBEDDING_MODEL_GEMMA.id, CHUNK_EMBEDDINGS_STAGING_TABLE)).toBe(4);
    expect(chunkIndexStatus(EMBEDDING_MODEL.id).staging).toBe(true);
    expect((await vectorSearchChunks("did I confirm the villa")).length).toBeGreaterThan(0);
    expect(liveModels()).toEqual([EMBEDDING_MODEL.id]);
    expect(chunkEmbeddingCount()).toBe(total);
    expect(dropChunkStaging()).toBe(true); // what server boot does
    expect(chunkStagingExists()).toBe(false);
    expect(dropChunkStaging()).toBe(false);
    expect(chunkEmbeddingCount()).toBe(total);
  });

  it("a flip that fails half-way rolls back vectors and pointer together", async () => {
    const total = await buildOldIndex();
    beginChunkStaging();
    while ((await embedChunksInto(fakeEmbedder(EMBEDDING_MODEL_GEMMA, { salt: 7 }), CHUNK_EMBEDDINGS_STAGING_TABLE, 16)) > 0) {
      /* fill the sibling completely */
    }
    expect(chunkEmbeddingCount(EMBEDDING_MODEL_GEMMA.id, CHUNK_EMBEDDINGS_STAGING_TABLE)).toBe(total);

    const db = getDb();
    expect(() =>
      db.transaction(() => {
        flipChunkStagingLive(db);
        setActiveEmbeddingModelId(EMBEDDING_MODEL_GEMMA.id);
        throw new Error("power cut inside the flip");
      })(),
    ).toThrow("power cut");
    // Nothing moved: the old table, the old model, the old pointer, and the
    // staging sibling is still there to retry from.
    expect(liveModels()).toEqual([EMBEDDING_MODEL.id]);
    expect(chunkEmbeddingCount()).toBe(total);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL.id);
    expect(chunkStagingExists()).toBe(true);
    expect(chunkEmbeddingCount(EMBEDDING_MODEL_GEMMA.id, CHUNK_EMBEDDINGS_STAGING_TABLE)).toBe(total);

    // The same flip, completed: one step, both tables and the pointer agree.
    db.transaction(() => {
      flipChunkStagingLive(db);
      setActiveEmbeddingModelId(EMBEDDING_MODEL_GEMMA.id);
    })();
    expect(liveModels()).toEqual([EMBEDDING_MODEL_GEMMA.id]);
    expect(chunkEmbeddingCount()).toBe(total);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_GEMMA.id);
    expect(chunkStagingExists()).toBe(false);
    // The live table kept the migration's index name, so IF NOT EXISTS is a no-op.
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(CHUNK_EMBEDDINGS_TABLE) as { name: string }[]).map((r) => r.name);
    expect(idx).toContain(`idx_${CHUNK_EMBEDDINGS_TABLE}_model`);
    expect(idx).not.toContain(`idx_${CHUNK_EMBEDDINGS_STAGING_TABLE}_model`);
  });

  it("a full swap never lets the live table hold two models, and answers from the new one after", async () => {
    const total = await buildOldIndex();
    stageModelFiles(EMBEDDING_MODEL_GEMMA);
    const seen = new Set<string>();
    const candidate = fakeEmbedder(EMBEDDING_MODEL_GEMMA, {
      salt: 7,
      onBatch() {
        for (const m of liveModels()) seen.add(m);
        expect(liveModels()).toEqual([EMBEDDING_MODEL.id]);
        expect(chunkEmbeddingCount()).toBe(total);
      },
    });
    const started = startEmbeddingSwap(EMBEDDING_MODEL_GEMMA.id, { loadEmbedder: async () => candidate, batch: 4 });
    // The swap re-embeds both units: every chunk, and (until the lanes stop
    // reading it) every legacy embeddable event.
    const legacy = countEmbeddable();
    expect(started.total).toBe(total + legacy);
    const state = await waitForSwap();
    expect(state.phase).toBe("done");
    expect(state.embedded).toBe(total + legacy);
    expect([...seen]).toEqual([EMBEDDING_MODEL.id]);

    expect(liveModels()).toEqual([EMBEDDING_MODEL_GEMMA.id]);
    expect(chunkEmbeddingCount(EMBEDDING_MODEL_GEMMA.id)).toBe(total);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL_GEMMA.id);
    expect(chunkStagingExists()).toBe(false);

    // The swapped index answers under the new model — RET-03 still holds.
    setEmbedder(fakeEmbedder(EMBEDDING_MODEL_GEMMA, { salt: 7 }));
    const hits = await vectorSearchChunks("did I confirm the villa", { limit: 1 });
    expect(hits[0]?.chunk.text).toContain("me: yes, book it");
  });

  it("cancel mid-swap drops the staging sibling and leaves the live index alone", async () => {
    const total = await buildOldIndex();
    stageModelFiles(EMBEDDING_MODEL_GEMMA);
    const { cancelEmbeddingSwap } = await import("./model-swap.js");
    let n = 0;
    const slow = fakeEmbedder(EMBEDDING_MODEL_GEMMA, {
      salt: 7,
      async onBatch() {
        if (++n === 2) cancelEmbeddingSwap();
      },
    });
    startEmbeddingSwap(EMBEDDING_MODEL_GEMMA.id, { loadEmbedder: async () => slow, batch: 2 });
    const state = await waitForSwap();
    expect(state.phase).toBe("cancelled");
    expect(chunkStagingExists()).toBe(false);
    expect(liveModels()).toEqual([EMBEDDING_MODEL.id]);
    expect(chunkEmbeddingCount()).toBe(total);
    expect(activeEmbeddingModelId()).toBe(EMBEDDING_MODEL.id);
  });
});
