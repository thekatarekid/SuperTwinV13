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

/** Every vector in one embedding space, for a brute-force similarity pass. */
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
