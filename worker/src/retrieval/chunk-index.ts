// ===========================================================================
// The chunk vector index (V6 P1 S2.2; Build §5.1, Product_V6 §23.4, T5-3).
//
// chunker.ts decides WHAT gets a vector; this file gives it one and reads them
// back. Three things live here:
//
//   INDEX    indexChunkBatch(): the chunks with no vector under the ACTIVE
//            model, embedded as passages, stored int8 with a per-vector scale
//            (db/v6graph.ts) in `chunk_embeddings`. Incremental, resumable —
//            the state IS the rows.
//   SEARCH   vectorSearchChunks(): the query as a vector against the active
//            model's chunk vectors — the whole table, or a bounded candidate
//            set handed in by the fusion layer (S2.4). Returns chunk ids and
//            the events they cover; a 12-char message is found because the
//            2 k window that contains it is (RET-03).
//   STAGING  a sibling table with the same body (`chunkEmbeddingsDdl`) that a
//            re-embed fills beside the live one. Search never reads it. The
//            swap (model-swap.ts) flips it live — DROP + RENAME — inside the
//            one transaction that also moves the model pointer, so there is
//            no instant in which a query can see a half-built index (RET-05).
//            A staging table left behind by a killed process is dropped on the
//            next boot; the live table it never touched keeps answering.
// ===========================================================================

import type { Database as Db } from "better-sqlite3";

import { getDb } from "../db/connection.js";
import {
  chunkEmbeddingCount,
  chunkEmbeddingsDdl,
  dequantizeInt8,
  putChunkEmbedding,
  readChunk,
  unembeddedChunkIds,
  type ChunkRow,
} from "../db/v6graph.js";
import { getEmbedder, type Embedder } from "./embedder.js";
import { cosine } from "./semantic.js";

/** Chunks embedded per background pass. */
export const DEFAULT_CHUNK_INDEX_BATCH = 32;

/** Chunk hits a vector search may contribute. */
export const DEFAULT_CHUNK_SEARCH_LIMIT = 20;

/** The live table search reads, and the sibling a re-embed fills. */
export const CHUNK_EMBEDDINGS_TABLE = "chunk_embeddings";
export const CHUNK_EMBEDDINGS_STAGING_TABLE = "chunk_embeddings_staging";

let indexing: Promise<number> | null = null;

// ---- Index --------------------------------------------------------------------

/**
 * Embed the next batch of chunks that have no vector under the active model.
 * Returns how many were stored — 0 when there is nothing to do and when there
 * is no embedder. Overlapping calls share one pass.
 */
export function indexChunkBatch(limit = DEFAULT_CHUNK_INDEX_BATCH): Promise<number> {
  if (indexing) return indexing;
  indexing = runChunkIndexBatch(limit).finally(() => {
    indexing = null;
  });
  return indexing;
}

async function runChunkIndexBatch(limit: number): Promise<number> {
  const embedder = await getEmbedder();
  if (!embedder) return 0;
  return embedChunksInto(embedder, CHUNK_EMBEDDINGS_TABLE, limit);
}

/**
 * Embed up to `limit` chunks that `table` has no vector for under `embedder`'s
 * model, and store them in `table`. Shared by the incremental indexer (live
 * table) and the swap (staging table).
 */
export async function embedChunksInto(embedder: Embedder, table: string, limit: number): Promise<number> {
  const ids = unembeddedChunkIds(embedder.model, limit, table);
  if (ids.length === 0) return 0;
  const chunks = ids.map((id) => readChunk(id)).filter((c): c is ChunkRow => c !== null);
  if (chunks.length === 0) return 0;
  const vectors = await embedder.embed(
    chunks.map((c) => c.text),
    "passage",
  );
  if (vectors.length !== chunks.length) {
    throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`);
  }
  const db = getDb();
  return db.transaction(() => {
    let n = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (vectors[i].length !== embedder.dim) {
        throw new Error(`vector for chunk ${chunks[i].id} has ${vectors[i].length} dimensions, expected ${embedder.dim}`);
      }
      putChunkEmbedding(chunks[i].id, vectors[i], embedder.model, table);
      n++;
    }
    return n;
  })();
}

// ---- Search -------------------------------------------------------------------

export interface ChunkHit {
  chunkId: number;
  similarity: number;
  chunk: ChunkRow;
}

export interface ChunkSearchOptions {
  limit?: number;
  /**
   * Bound the scan to these chunk ids (the fusion layer's lexical candidates
   * plus whatever else it wants scored). Absent = the active model's whole
   * chunk table, which at one vector per 2 k window is small by design.
   */
  candidateIds?: readonly number[];
  /** Restrict to these chunk kinds. */
  kinds?: readonly string[];
}

/**
 * Chunks closest in meaning to `query` under the active model. Empty — never
 * an error, never a wait — when the tier is off or nothing is indexed.
 */
export async function vectorSearchChunks(query: string, opts: ChunkSearchOptions = {}): Promise<ChunkHit[]> {
  const text = query.trim();
  if (!text) return [];
  const embedder = await getEmbedder();
  if (!embedder) return [];
  let probe: Float32Array;
  try {
    [probe] = await embedder.embed([text], "query");
  } catch (err) {
    console.error(`[retrieval] embedding the query failed: ${(err as Error).message}`);
    return [];
  }
  if (!probe) return [];
  return rankChunks(probe, embedder.model, opts);
}

/** The same, with the query already a vector (the fusion layer embeds once). */
export function rankChunks(probe: Float32Array, model: string, opts: ChunkSearchOptions = {}): ChunkHit[] {
  const limit = Math.max(0, opts.limit ?? DEFAULT_CHUNK_SEARCH_LIMIT);
  const rows = readChunkVectors(model, opts.candidateIds);
  const scored: { chunkId: number; similarity: number }[] = [];
  for (const r of rows) {
    if (r.vector.length !== probe.length) continue;
    const sim = cosine(probe, r.vector);
    if (sim > 0) scored.push({ chunkId: r.chunkId, similarity: sim });
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.chunkId - b.chunkId);
  const out: ChunkHit[] = [];
  for (const s of scored) {
    if (out.length >= limit) break;
    const chunk = readChunk(s.chunkId);
    if (!chunk) continue;
    if (opts.kinds && !opts.kinds.includes(chunk.kind)) continue;
    out.push({ chunkId: s.chunkId, similarity: s.similarity, chunk });
  }
  return out;
}

function readChunkVectors(model: string, candidateIds?: readonly number[]): { chunkId: number; vector: Float32Array }[] {
  const db = getDb();
  let rows: { chunk_id: number; dim: number; scale: number; vec: Buffer }[];
  if (candidateIds) {
    if (candidateIds.length === 0) return [];
    rows = [];
    const stmt = db.prepare(`SELECT chunk_id, dim, scale, vec FROM ${CHUNK_EMBEDDINGS_TABLE} WHERE model = ? AND chunk_id = ?`);
    for (const id of candidateIds) {
      const r = stmt.get(model, id) as { chunk_id: number; dim: number; scale: number; vec: Buffer } | undefined;
      if (r) rows.push(r);
    }
  } else {
    rows = db
      .prepare(`SELECT chunk_id, dim, scale, vec FROM ${CHUNK_EMBEDDINGS_TABLE} WHERE model = ?`)
      .all(model) as typeof rows;
  }
  return rows.map((r) => ({ chunkId: r.chunk_id, vector: dequantizeInt8(r.vec, r.scale, r.dim) }));
}

// ---- Status -------------------------------------------------------------------

export interface ChunkIndexStatus {
  /** Chunks in the table, and chunks with a vector under `model`. */
  chunks: number;
  indexed: number;
  model: string;
  /** A re-embed's staging sibling exists (a swap is running, or was killed). */
  staging: boolean;
}

export function chunkIndexStatus(model: string): ChunkIndexStatus {
  const db = getDb();
  const chunks = (db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
  return {
    chunks,
    indexed: safe(() => chunkEmbeddingCount(model)),
    model,
    staging: chunkStagingExists(),
  };
}

function safe(read: () => number): number {
  try {
    return read();
  } catch {
    return 0;
  }
}

// ---- Staging + flip -----------------------------------------------------------

export function chunkStagingExists(db: Db = getDb()): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(CHUNK_EMBEDDINGS_STAGING_TABLE);
}

/** Start a re-embed: an empty sibling table. Any leftover from a killed run goes first. */
export function beginChunkStaging(db: Db = getDb()): void {
  db.exec(`DROP TABLE IF EXISTS ${CHUNK_EMBEDDINGS_STAGING_TABLE};`);
  db.exec(chunkEmbeddingsDdl(CHUNK_EMBEDDINGS_STAGING_TABLE));
}

/**
 * Drop a staging table a killed or cancelled re-embed left behind. Called at
 * boot: the live table it never touched is exactly as it was, and the next
 * swap starts from an empty sibling (RET-05).
 */
export function dropChunkStaging(db: Db = getDb()): boolean {
  if (!chunkStagingExists(db)) return false;
  db.exec(`DROP TABLE IF EXISTS ${CHUNK_EMBEDDINGS_STAGING_TABLE};`);
  return true;
}

/**
 * Make the staging table THE table. Must run inside the caller's transaction
 * — the swap's — so this, the legacy vector rewrite and the pointer move are
 * one atomic step. Throws when there is no staging table.
 */
export function flipChunkStagingLive(db: Db = getDb()): void {
  if (!chunkStagingExists(db)) {
    throw new Error(`${CHUNK_EMBEDDINGS_STAGING_TABLE} does not exist — nothing to flip`);
  }
  db.exec(`DROP TABLE IF EXISTS ${CHUNK_EMBEDDINGS_TABLE};`);
  db.exec(`ALTER TABLE ${CHUNK_EMBEDDINGS_STAGING_TABLE} RENAME TO ${CHUNK_EMBEDDINGS_TABLE};`);
  // The index followed the rename under its staging name; give the live table
  // the name the migration uses so a later IF NOT EXISTS is a no-op.
  db.exec(`DROP INDEX IF EXISTS idx_${CHUNK_EMBEDDINGS_STAGING_TABLE}_model;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${CHUNK_EMBEDDINGS_TABLE}_model ON ${CHUNK_EMBEDDINGS_TABLE}(model, dim);`);
}

/** Test hook. */
export function resetChunkIndexForTests(): void {
  indexing = null;
}
