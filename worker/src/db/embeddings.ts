// ===========================================================================
// Semantic-index storage (docs/v6-spec.md §1, tier 3).
//
// Lexical retrieval cannot connect "sunday plans" to "booked oye kake" — they
// share no token. A local embedding model can, and this is where its output
// lives: one vector per event, tagged with the model and dimension that
// produced it.
//
// Two things the schema is shaped by:
//
//   - A model change must invalidate, not mix. Every read filters on
//     (model, dim), so vectors from an older model are invisible to the new
//     model's search instead of being compared against it in a space where the
//     distance means nothing.
//   - Indexing must be incremental. claimUnembeddedEvents() returns only what
//     has no vector for the ACTIVE model, so a turn costs the handful of
//     messages that arrived since the last one — never the whole history. The
//     paths that rewrite an event's text drop its vector (see ingest.ts), which
//     is how a transcript finishing minutes after ingestion gets embedded.
//
// Vectors only. Similarity, model selection and the search itself live above
// this layer.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";

/**
 * Which embedding space a vector belongs to. Both halves matter: two models can
 * share a dimension and still be entirely incomparable.
 */
export interface EmbeddingModelKey {
  /** Model id as the embedder reports it, e.g. "all-MiniLM-L6-v2". */
  model: string;
  dim: number;
}

/**
 * One event still to be embedded, with the short human-scale text it carries.
 *
 * `link_scraped_text` is deliberately absent: a 500 KB article has no single
 * meaning for one vector to hold, and lexical search over it already works.
 * Composing these fields into the string that gets embedded is the caller's
 * decision, so they arrive separately rather than pre-joined.
 */
export interface EmbeddableEventRow {
  id: string;
  ts: string | null;
  channelId: string | null;
  kind: string | null;
  text: string | null;
  mediaDescription: string | null;
  transcript: string | null;
  linkTitle: string | null;
  linkDescription: string | null;
  replyToText: string | null;
}

export interface EventEmbedding {
  eventId: string;
  vector: Float32Array;
}

export interface PutEmbeddingParams extends EmbeddingModelKey {
  eventId: string;
  vector: Float32Array | readonly number[];
}

interface RawEmbeddableRow {
  id: string;
  ts: string | null;
  channel_id: string | null;
  kind: string | null;
  text: string | null;
  media_description: string | null;
  transcript: string | null;
  link_title: string | null;
  link_description: string | null;
  reply_to_text: string | null;
}

/**
 * Characters of its own an event needs before a vector says anything about it.
 * A one-word reply or a lone 🙏 carries no meaning to find AND sits near the
 * centre of the embedding space, so it scores high against every question:
 * measured on 686 real messages, dropping the 128 shortest removed the noise
 * from the top of every probe query. Tier 1 still reaches them, as the window
 * around a real hit.
 */
export const MIN_EMBEDDABLE_CHARS = 12;

/**
 * What makes a row worth embedding at all. `reply_to_text` is not counted: the
 * quote is context the vector gets to carry, not something this message said,
 * so a bare "haan" under a long quote stays out.
 */
const HAS_EMBEDDABLE_TEXT = /* sql */ `
  e.kind IS NOT 'reaction'
  AND e.revoked_at IS NULL
  AND LENGTH(
         TRIM(COALESCE(e.text, ''))
      || TRIM(COALESCE(e.media_description, ''))
      || TRIM(COALESCE(e.transcript, ''))
      || TRIM(COALESCE(e.link_title, ''))
      || TRIM(COALESCE(e.link_description, ''))
  ) >= ${MIN_EMBEDDABLE_CHARS}
`;

interface EmbeddingStatements {
  db: Database.Database;
  claimUnembedded: Database.Statement;
  put: Database.Statement;
  read: Database.Statement;
  readBounded: Database.Statement;
  readByIds: Database.Statement;
  lexicalBranchCount: Database.Statement;
  lexicalCandidates: Database.Statement;
  countIndexed: Database.Statement;
  countEmbeddable: Database.Statement;
  deleteById: Database.Statement;
  deleteByExternalId: Database.Statement;
  deleteByModel: Database.Statement;
  deleteAll: Database.Statement;
}

let stmts: EmbeddingStatements | null = null;

function statements(): EmbeddingStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;

  stmts = {
    db,
    // The model/dim test sits in the JOIN, not the WHERE: a row embedded under
    // the PREVIOUS model has to come back as unembedded, which is what makes a
    // model change re-index itself in the background rather than demanding one
    // big rebuild before semantic search answers anything again.
    claimUnembedded: db.prepare(`
      SELECT
        e.id                AS id,
        e.ts                AS ts,
        e.channel_id        AS channel_id,
        e.kind              AS kind,
        e.text              AS text,
        e.media_description AS media_description,
        e.transcript        AS transcript,
        e.link_title        AS link_title,
        e.link_description  AS link_description,
        e.reply_to_text     AS reply_to_text
      FROM events e
      LEFT JOIN event_embeddings v
        ON v.event_id = e.id AND v.model = @model AND v.dim = @dim
      WHERE v.event_id IS NULL
        AND ${HAS_EMBEDDABLE_TEXT}
      ORDER BY e.ts DESC, e.id DESC
      LIMIT @limit
    `),
    // One vector per event: re-embedding under a new model REPLACES the old one
    // rather than accumulating a second space beside it.
    put: db.prepare(`
      INSERT INTO event_embeddings (event_id, model, dim, vector, indexed_at)
      VALUES (@eventId, @model, @dim, @vector, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(event_id) DO UPDATE SET
        model      = excluded.model,
        dim        = excluded.dim,
        vector     = excluded.vector,
        indexed_at = excluded.indexed_at
    `),
    read: db.prepare(`
      SELECT event_id AS event_id, vector AS vector
      FROM event_embeddings
      WHERE model = @model AND dim = @dim
    `),
    readBounded: db.prepare(`
      SELECT event_id AS event_id, vector AS vector
      FROM event_embeddings
      WHERE model = @model AND dim = @dim
      ORDER BY event_id
      LIMIT @limit
    `),
    // CROSS JOIN on purpose: it pins json_each as the OUTER loop, so each id
    // probes the primary key once (3 ms for 2,000 ids at 300 K rows). Written
    // as `event_id IN (SELECT value FROM json_each(...))` the planner walked
    // the (model, dim) index across all 300 K rows behind a bloom filter —
    // 250 ms, which is the full scan this read exists to avoid.
    readByIds: db.prepare(`
      SELECT v.event_id AS event_id, v.vector AS vector
      FROM json_each(@ids) j
      CROSS JOIN event_embeddings v ON v.event_id = j.value
      WHERE v.model = @model AND v.dim = @dim
    `),
    // How many rows a MATCH has, counted only up to @cap: FTS5 walks matches
    // in rowid order without scoring when there is no ORDER BY, so the cost is
    // O(cap), never O(df). This is what lets the fusion layer drop a term that
    // is in every message before bm25 has to rank every message.
    lexicalBranchCount: db.prepare(`
      SELECT COUNT(*) AS n
      FROM (SELECT rowid FROM events_fts WHERE events_fts MATCH @match LIMIT @cap)
    `),
    lexicalCandidates: db.prepare(`
      SELECT e.id AS id
      FROM events_fts f
      JOIN events e ON e.rowid = f.rowid
      WHERE events_fts MATCH @match
        AND e.kind IS NOT 'reaction'
        AND e.revoked_at IS NULL
      ORDER BY bm25(events_fts)
      LIMIT @limit
    `),
    countIndexed: db.prepare(`
      SELECT COUNT(*) AS n FROM event_embeddings WHERE model = @model AND dim = @dim
    `),
    countEmbeddable: db.prepare(`
      SELECT COUNT(*) AS n FROM events e WHERE ${HAS_EMBEDDABLE_TEXT}
    `),
    deleteById: db.prepare(`DELETE FROM event_embeddings WHERE event_id = ?`),
    deleteByExternalId: db.prepare(`
      DELETE FROM event_embeddings
       WHERE event_id IN (
         SELECT id FROM events WHERE source_id = @sourceId AND external_id = @externalId
       )
    `),
    deleteByModel: db.prepare(`DELETE FROM event_embeddings WHERE model = ?`),
    deleteAll: db.prepare(`DELETE FROM event_embeddings`),
  };
  return stmts;
}

/**
 * The `limit` events with no vector in the active embedding space, newest
 * first. Nothing is marked as claimed — the worker is the only writer, exactly
 * as with the media and transcription queues, and a row leaves this queue when
 * putEventEmbedding() stores its vector.
 */
export function claimUnembeddedEvents(
  limit: number,
  key: EmbeddingModelKey,
): EmbeddableEventRow[] {
  const rows = statements().claimUnembedded.all({
    model: key.model,
    dim: key.dim,
    limit: clampLimit(limit, 64, 2000),
  }) as RawEmbeddableRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    channelId: r.channel_id,
    kind: r.kind,
    text: r.text,
    mediaDescription: r.media_description,
    transcript: r.transcript,
    linkTitle: r.link_title,
    linkDescription: r.link_description,
    replyToText: r.reply_to_text,
  }));
}

/**
 * Store one event's vector. A vector whose length disagrees with `dim` is
 * rejected: a silently truncated or padded row is a permanently wrong answer in
 * a space where nothing looks wrong.
 */
export function putEventEmbedding(params: PutEmbeddingParams): void {
  statements().put.run(toParams(params));
}

/** The same, for a whole batch, in one transaction. Returns how many were stored. */
export function putEventEmbeddings(rows: readonly PutEmbeddingParams[]): number {
  const s = statements();
  const prepared = rows.map(toParams);
  const tx = s.db.transaction((items: ReturnType<typeof toParams>[]) => {
    for (const item of items) s.put.run(item);
    return items.length;
  });
  return tx(prepared);
}

function toParams(params: PutEmbeddingParams): {
  eventId: string;
  model: string;
  dim: number;
  vector: Buffer;
} {
  const vector =
    params.vector instanceof Float32Array
      ? params.vector
      : Float32Array.from(params.vector);
  if (vector.length !== params.dim) {
    throw new Error(
      `embedding for ${params.eventId} has ${vector.length} dimensions, expected ${params.dim}`,
    );
  }
  return {
    eventId: params.eventId,
    model: params.model,
    dim: params.dim,
    vector: encodeVector(vector),
  };
}

/**
 * Every vector in one embedding space. This is the WHOLE-TABLE read: the swap
 * (model-swap.ts) and the tests use it; search does not. retrieval/semantic.ts
 * reads a bounded candidate set through the two functions below instead, and a
 * test asserts it never imports this one (V6 S2.4, `full_vector_scan = 0`).
 */
export function readEventEmbeddings(key: EmbeddingModelKey): EventEmbedding[] {
  const rows = statements().read.all({ model: key.model, dim: key.dim }) as {
    event_id: string;
    vector: Buffer;
  }[];
  return rows.map((r) => ({
    eventId: r.event_id,
    vector: decodeVector(r.vector),
  }));
}

/**
 * At most `limit` vectors of one space — the read a corpus SMALLER than the
 * candidate bound takes, where the whole table is itself a bounded set. Ordered
 * by event id so two reads of the same table are the same rows.
 */
export function readEventEmbeddingsBounded(key: EmbeddingModelKey, limit: number): EventEmbedding[] {
  const rows = statements().readBounded.all({
    model: key.model,
    dim: key.dim,
    limit: clampLimit(limit, 2000, 100_000),
  }) as { event_id: string; vector: Buffer }[];
  return rows.map((r) => ({ eventId: r.event_id, vector: decodeVector(r.vector) }));
}

/** SQLite's default variable ceiling is far above this; the batch keeps each statement small. */
const READ_BY_IDS_BATCH = 500;

/**
 * The vectors of exactly these events, in one space. Ids with no vector are
 * absent; duplicates come back once; the order is the order asked for. This is
 * the read the fusion layer makes — the candidate set, never the table.
 */
export function readEventEmbeddingsByIds(
  key: EmbeddingModelKey,
  ids: readonly string[],
): EventEmbedding[] {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
  if (wanted.length === 0) return [];
  const byId = new Map<string, Float32Array>();
  const s = statements();
  for (let i = 0; i < wanted.length; i += READ_BY_IDS_BATCH) {
    const batch = wanted.slice(i, i + READ_BY_IDS_BATCH);
    const rows = s.readByIds.all({
      model: key.model,
      dim: key.dim,
      ids: JSON.stringify(batch),
    }) as { event_id: string; vector: Buffer }[];
    for (const r of rows) byId.set(r.event_id, decodeVector(r.vector));
  }
  const out: EventEmbedding[] = [];
  for (const id of wanted) {
    const vector = byId.get(id);
    if (vector) out.push({ eventId: id, vector });
  }
  return out;
}

/**
 * How many events match `match`, counted up to `cap` and no further. Returns
 * `cap` for anything at or above it — "at least this many" is all the caller
 * asks. Throws on an expression FTS5 cannot parse.
 */
export function lexicalBranchCount(match: string, cap: number): number {
  if (typeof match !== "string" || match.trim().length === 0) return 0;
  const row = statements().lexicalBranchCount.get({
    match,
    cap: clampLimit(cap, 5000, 1_000_000),
  }) as { n: number };
  return row.n;
}

/**
 * The lexical half of the candidate set: the `limit` events that best match an
 * FTS5 expression, by bm25, best first. Reactions and tombstones are out for
 * the same reason they are out of every other retrieval read. Throws on an
 * expression FTS5 cannot parse — the caller built it and catches it.
 */
export function lexicalCandidateEventIds(match: string, limit: number): string[] {
  if (typeof match !== "string" || match.trim().length === 0) return [];
  const rows = statements().lexicalCandidates.all({
    match,
    limit: clampLimit(limit, 2000, 10_000),
  }) as { id: string }[];
  return rows.map((r) => r.id);
}

/** How many events are indexed in this space, and how many could be. */
export function countEventEmbeddings(key: EmbeddingModelKey): number {
  return (statements().countIndexed.get({ model: key.model, dim: key.dim }) as {
    n: number;
  }).n;
}

export function countEmbeddableEvents(): number {
  return (statements().countEmbeddable.get() as { n: number }).n;
}

/**
 * Drop one event's vector so the next claim re-embeds it. Called from the write
 * paths that rewrite what an event says — a stale vector is worse than a
 * missing one, because search still returns it.
 */
export function invalidateEventEmbedding(eventId: string): void {
  statements().deleteById.run(eventId);
}

/** The same, addressed the way edits and revokes arrive: (source, external id). */
export function invalidateEventEmbeddingByExternalId(
  sourceId: string,
  externalId: string,
): void {
  statements().deleteByExternalId.run({ sourceId, externalId });
}

/**
 * Drop the index, or just one model's half of it. Returns rows deleted.
 * Re-indexing happens on its own afterwards, one claim at a time.
 */
export function clearEventEmbeddings(opts?: { model?: string }): number {
  const s = statements();
  return opts?.model
    ? s.deleteByModel.run(opts.model).changes
    : s.deleteAll.run().changes;
}

// ---- Vector encoding ------------------------------------------------------
//
// The blob is a stored format, not a memory dump, so the byte order is pinned
// little-endian here rather than inherited from whatever CPU wrote it.

export function encodeVector(vector: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4);
  return buf;
}

export function decodeVector(blob: Buffer | Uint8Array): Float32Array {
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const out = new Float32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
