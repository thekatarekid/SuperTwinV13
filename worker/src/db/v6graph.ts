// ===========================================================================
// [CODE] Typed row helpers over 0201_v6_graph — V6 P1 S2.1 (Build §5.1).
//
// One API for every Stage-2 lane, so the embedder (S2.2), the FTS projection
// (S2.3), structured retrieval (S2.5) and the graph walk (S2.6) do not each
// hand-roll SQL over the same tables.
//
//   Self               SELF_ENTITY_ID · selfEntity
//                      The fixed, pinned entity row the migration seeds.
//
//   Hubs (§23.5)       addHub · removeHub · isHub · listHubs · hubIds
//                      Entities the walk never passes through. `self` is
//                      seeded; degree-based hubs are added by code later.
//
//   Edges (walk)       neighborEdges · edgeEvidenceFor · evidenceByEvent
//                      READ side for the BFS: active edges of a node, valid at
//                      `now`, best confidence first, fan-out capped, hubs
//                      excluded. Writes stay in entities/edges.ts (writeEdge,
//                      addEdgeEvidence) — one writer, one set of rules.
//
//   Typed fields       setClaimTypedFields · claimTypedFields · TYPED_FIELDS
//   (§11.14)           The eight columns on `claims`. `status` on the wire is
//                      `typed_status` in the row (the claim's own lifecycle
//                      already owns `status`). Unset keys are left alone; an
//                      explicit null clears.
//
//   Chunks (T5-3)      upsertChunk · readChunk · chunksFor · deleteChunks ·
//                      chunkCount
//                      Deduped by (kind, stream_key, content_hash); the rowid
//                      is the key everything else cites.
//
//   Embeddings         quantizeInt8 · dequantizeInt8 · putChunkEmbedding ·
//   (int8, rowid)      getChunkEmbedding · unembeddedChunkIds ·
//                      chunkEmbeddingCount · chunkEmbeddingsDdl
//                      Symmetric per-vector int8: scale = max|x| / 127. One
//                      vector per chunk, tagged with its model.
//
// Everything here uses the shared handle from ./connection.ts, so tests
// sandbox it the way every db module is sandboxed. No model calls.
// ===========================================================================

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { getDb } from "./connection.js";
import { SELF_ENTITY_ID, chunkEmbeddingsDdl } from "./migrations/0201_v6_graph.js";

export { SELF_ENTITY_ID, chunkEmbeddingsDdl };

// ---- Shared ----------------------------------------------------------------

let stmtsDb: Database.Database | null = null;
let cache = new Map<string, Database.Statement>();

function prep(sql: string): Database.Statement {
  const db = getDb();
  if (stmtsDb !== db) {
    stmtsDb = db;
    cache = new Map();
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- Self ------------------------------------------------------------------

export interface SelfEntityRow {
  id: string;
  type: string;
  canonical: string | null;
  provisional: boolean;
  userPinned: boolean;
}

/** The seeded self row, or null if a test wiped `entities`. */
export function selfEntity(): SelfEntityRow | null {
  const r = prep(`SELECT id, type, canonical, provisional, user_pinned FROM entities WHERE id = ?`).get(
    SELF_ENTITY_ID,
  ) as { id: string; type: string; canonical: string | null; provisional: number; user_pinned: number } | undefined;
  if (!r) return null;
  return { id: r.id, type: r.type, canonical: r.canonical, provisional: r.provisional === 1, userPinned: r.user_pinned === 1 };
}

// ---- Hubs ------------------------------------------------------------------

export type HubReason = "self" | "degree" | "user";

export interface HubRow {
  entityId: string;
  reason: HubReason;
  degree: number | null;
  addedBy: string | null;
  createdAt: string;
}

export function addHub(entityId: string, reason: HubReason, opts: { degree?: number | null; addedBy?: string } = {}): HubRow {
  prep(
    `INSERT INTO hub_nodes (entity_id, reason, degree, added_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (entity_id) DO UPDATE SET reason = excluded.reason, degree = excluded.degree, added_by = excluded.added_by`,
  ).run(entityId, reason, opts.degree ?? null, opts.addedBy ?? "code");
  return listHubs().find((h) => h.entityId === entityId)!;
}

/** Remove a hub. `self` cannot be removed: the walk through it is always noise. */
export function removeHub(entityId: string): boolean {
  if (entityId === SELF_ENTITY_ID) return false;
  return prep(`DELETE FROM hub_nodes WHERE entity_id = ?`).run(entityId).changes > 0;
}

export function isHub(entityId: string): boolean {
  return prep(`SELECT 1 FROM hub_nodes WHERE entity_id = ?`).get(entityId) !== undefined;
}

export function listHubs(): HubRow[] {
  const rows = prep(`SELECT entity_id, reason, degree, added_by, created_at FROM hub_nodes ORDER BY created_at, entity_id`).all() as {
    entity_id: string; reason: string; degree: number | null; added_by: string | null; created_at: string;
  }[];
  return rows.map((r) => ({ entityId: r.entity_id, reason: r.reason as HubReason, degree: r.degree, addedBy: r.added_by, createdAt: r.created_at }));
}

/** The exclusion set the BFS carries. */
export function hubIds(): Set<string> {
  return new Set((prep(`SELECT entity_id FROM hub_nodes`).all() as { entity_id: string }[]).map((r) => r.entity_id));
}

// ---- Edges: read side for the walk -----------------------------------------

export interface WalkEdge {
  id: string;
  kind: string;
  subtype: string | null;
  srcEntityId: string;
  dstEntityId: string;
  /** The end that is not `entityId`. */
  neighborId: string;
  confidence: number;
  validFrom: string | null;
  validTo: string | null;
}

export interface NeighborOptions {
  /** ISO instant the edge must be valid at. Default: now. */
  now?: string;
  /** Restrict to these kinds. Default: all. */
  kinds?: readonly string[];
  /** Fan-out cap per node — top edges by confidence. Default: 20. */
  fanOut?: number;
  /** Skip edges whose far end is a hub. Default: true. */
  excludeHubs?: boolean;
  /** Confidence to assume for an edge with none recorded. Default 0.5. */
  defaultConfidence?: number;
}

/**
 * Active edges touching `entityId`, valid at `now`, best confidence first,
 * capped at `fanOut`. Superseded / rejected and expired edges are pruned in
 * SQL; hub neighbours are dropped before the cap so the cap is spent on
 * nodes the walk can actually enter.
 */
export function neighborEdges(entityId: string, opts: NeighborOptions = {}): WalkEdge[] {
  const now = opts.now ?? nowIso();
  const fanOut = Math.max(0, opts.fanOut ?? 20);
  const dflt = opts.defaultConfidence ?? 0.5;
  const excludeHubs = opts.excludeHubs ?? true;
  const kinds = opts.kinds && opts.kinds.length > 0 ? [...new Set(opts.kinds)] : null;

  const kindClause = kinds ? ` AND e.kind IN (${kinds.map(() => "?").join(",")})` : "";
  const hubClause = excludeHubs
    ? ` AND NOT EXISTS (SELECT 1 FROM hub_nodes h WHERE h.entity_id = CASE WHEN e.src_entity_id = ? THEN e.dst_entity_id ELSE e.src_entity_id END)`
    : "";
  const sql = `SELECT e.id, e.kind, e.subtype, e.src_entity_id, e.dst_entity_id, e.confidence, e.valid_from, e.valid_to
                 FROM entity_edges e
                WHERE (e.src_entity_id = ? OR e.dst_entity_id = ?)
                  AND e.status = 'active'
                  AND (e.valid_from IS NULL OR e.valid_from <= ?)
                  AND (e.valid_to IS NULL OR e.valid_to > ?)${kindClause}${hubClause}
                ORDER BY COALESCE(e.confidence, ?) DESC, e.created_at ASC, e.id ASC
                LIMIT ?`;
  const params: unknown[] = [entityId, entityId, now, now];
  if (kinds) params.push(...kinds);
  if (excludeHubs) params.push(entityId);
  params.push(dflt, fanOut);

  const rows = prep(sql).all(...params) as {
    id: string; kind: string; subtype: string | null; src_entity_id: string; dst_entity_id: string;
    confidence: number | null; valid_from: string | null; valid_to: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    subtype: r.subtype,
    srcEntityId: r.src_entity_id,
    dstEntityId: r.dst_entity_id,
    neighborId: r.src_entity_id === entityId ? r.dst_entity_id : r.src_entity_id,
    confidence: r.confidence ?? dflt,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }));
}

export interface EvidenceRow {
  edgeId: string;
  eventId: string;
  quote: string;
}

/** Evidence for a set of edges, in one statement. */
export function edgeEvidenceFor(edgeIds: readonly string[]): EvidenceRow[] {
  if (edgeIds.length === 0) return [];
  const rows = getDb()
    .prepare(`SELECT edge_id, event_id, quote FROM edge_evidence WHERE edge_id IN (${edgeIds.map(() => "?").join(",")}) ORDER BY edge_id, event_id`)
    .all(...edgeIds) as { edge_id: string; event_id: string; quote: string }[];
  return rows.map((r) => ({ edgeId: r.edge_id, eventId: r.event_id, quote: r.quote }));
}

/** Every edge an event is evidence for — the reverse lookup the new index serves. */
export function evidenceByEvent(eventId: string): EvidenceRow[] {
  const rows = prep(`SELECT edge_id, event_id, quote FROM edge_evidence WHERE event_id = ? ORDER BY edge_id`).all(eventId) as {
    edge_id: string; event_id: string; quote: string;
  }[];
  return rows.map((r) => ({ edgeId: r.edge_id, eventId: r.event_id, quote: r.quote }));
}

// ---- Typed fields on claims ------------------------------------------------

/** Wire-facing names (§11.14) → column on `claims`. */
export const TYPED_FIELDS = {
  amount: "amount",
  currency: "currency",
  date: "date",
  status: "typed_status",
  merchant: "merchant",
  order_id: "order_id",
  location: "location",
  duration_s: "duration_s",
} as const;

export type TypedFieldName = keyof typeof TYPED_FIELDS;

export interface TypedFields {
  amount: number | null;
  currency: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  status: string | null;
  merchant: string | null;
  order_id: string | null;
  location: string | null;
  duration_s: number | null;
}

const EMPTY_TYPED: TypedFields = {
  amount: null, currency: null, date: null, status: null, merchant: null, order_id: null, location: null, duration_s: null,
};

function normaliseTyped(name: TypedFieldName, value: unknown): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  switch (name) {
    case "amount": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[,\s]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`typed field amount: ${JSON.stringify(value)} is not a number`);
      return n;
    }
    case "duration_s": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`typed field duration_s: ${JSON.stringify(value)} is not a number`);
      return Math.round(n);
    }
    case "currency":
      return String(value).trim().toUpperCase();
    case "date": {
      const s = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`typed field date: ${JSON.stringify(value)} is not YYYY-MM-DD`);
      return s;
    }
    default:
      return String(value).trim();
  }
}

/**
 * Set typed fields on a claim header. Keys absent from `fields` are untouched;
 * an explicit null clears. Returns false when the claim_key has no header.
 */
export function setClaimTypedFields(claimKey: string, fields: Partial<TypedFields>): boolean {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const name of Object.keys(TYPED_FIELDS) as TypedFieldName[]) {
    if (!(name in fields)) continue;
    sets.push(`${TYPED_FIELDS[name]} = ?`);
    params.push(normaliseTyped(name, fields[name]));
  }
  if (sets.length === 0) return prep(`SELECT 1 FROM claims WHERE claim_key = ?`).get(claimKey) !== undefined;
  params.push(claimKey);
  return getDb().prepare(`UPDATE claims SET ${sets.join(", ")} WHERE claim_key = ?`).run(...params).changes > 0;
}

/** Typed fields of a claim (all null when unset); null when no header exists. */
export function claimTypedFields(claimKey: string): TypedFields | null {
  const r = prep(
    `SELECT amount, currency, date, typed_status, merchant, order_id, location, duration_s FROM claims WHERE claim_key = ?`,
  ).get(claimKey) as
    | { amount: number | null; currency: string | null; date: string | null; typed_status: string | null; merchant: string | null; order_id: string | null; location: string | null; duration_s: number | null }
    | undefined;
  if (!r) return null;
  return {
    ...EMPTY_TYPED,
    amount: r.amount,
    currency: r.currency,
    date: r.date,
    status: r.typed_status,
    merchant: r.merchant,
    order_id: r.order_id,
    location: r.location,
    duration_s: r.duration_s,
  };
}

// ---- Chunks ----------------------------------------------------------------

export const CHUNK_KINDS = ["chat", "screen", "browser", "episode", "space", "claim", "person", "artifact"] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export function isChunkKind(value: unknown): value is ChunkKind {
  return typeof value === "string" && (CHUNK_KINDS as readonly string[]).includes(value);
}

export interface UpsertChunkParams {
  kind: ChunkKind;
  text: string;
  source?: string | null;
  streamKey?: string | null;
  refId?: string | null;
  seq?: number;
  tsStart?: string | null;
  tsEnd?: string | null;
  eventIds?: readonly string[] | null;
  tier?: number | null;
  consentId?: string | null;
}

export interface ChunkRow {
  id: number;
  kind: ChunkKind;
  source: string | null;
  streamKey: string | null;
  refId: string | null;
  seq: number;
  text: string;
  textLen: number;
  contentHash: string;
  tsStart: string | null;
  tsEnd: string | null;
  eventIds: string[];
  tier: number | null;
  consentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function chunkHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Insert a chunk, or return the existing row id when the same text already
 * exists in the same (kind, stream). On a hit the ref/seq/ts columns are
 * refreshed (a re-cut window may cover a slightly different id set) but the
 * vector is left in place — the text, and therefore the embedding, is the same.
 */
export function upsertChunk(p: UpsertChunkParams): { id: number; inserted: boolean } {
  if (!isChunkKind(p.kind)) throw new Error(`upsertChunk: ${JSON.stringify(p.kind)} is not a chunk kind`);
  if (typeof p.text !== "string" || p.text.length === 0) throw new Error("upsertChunk: text is required");
  const hash = chunkHash(p.text);
  const streamKey = p.streamKey ?? null;
  const eventIdsJson = p.eventIds ? JSON.stringify([...p.eventIds]) : null;
  const db = getDb();
  return db.transaction(() => {
    const existing = prep(`SELECT id FROM chunks WHERE kind = ? AND COALESCE(stream_key, '') = COALESCE(?, '') AND content_hash = ?`).get(
      p.kind, streamKey, hash,
    ) as { id: number } | undefined;
    if (existing) {
      prep(
        `UPDATE chunks SET ref_id = COALESCE(?, ref_id), seq = ?, ts_start = COALESCE(?, ts_start), ts_end = COALESCE(?, ts_end),
                           event_ids_json = COALESCE(?, event_ids_json), tier = COALESCE(?, tier), consent_id = COALESCE(?, consent_id),
                           updated_at = ? WHERE id = ?`,
      ).run(p.refId ?? null, p.seq ?? 0, p.tsStart ?? null, p.tsEnd ?? null, eventIdsJson, p.tier ?? null, p.consentId ?? null, nowIso(), existing.id);
      return { id: existing.id, inserted: false };
    }
    const r = prep(
      `INSERT INTO chunks (kind, source, stream_key, ref_id, seq, text, text_len, content_hash, ts_start, ts_end, event_ids_json, tier, consent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.kind, p.source ?? null, streamKey, p.refId ?? null, p.seq ?? 0, p.text, p.text.length, hash, p.tsStart ?? null, p.tsEnd ?? null, eventIdsJson, p.tier ?? null, p.consentId ?? null);
    return { id: Number(r.lastInsertRowid), inserted: true };
  })();
}

interface RawChunkRow {
  id: number; kind: string; source: string | null; stream_key: string | null; ref_id: string | null; seq: number;
  text: string; text_len: number; content_hash: string; ts_start: string | null; ts_end: string | null;
  event_ids_json: string | null; tier: number | null; consent_id: string | null; created_at: string; updated_at: string;
}

const CHUNK_SELECT = `SELECT id, kind, source, stream_key, ref_id, seq, text, text_len, content_hash, ts_start, ts_end,
                             event_ids_json, tier, consent_id, created_at, updated_at FROM chunks`;

function hydrateChunk(r: RawChunkRow): ChunkRow {
  let eventIds: string[] = [];
  if (r.event_ids_json) {
    try {
      const parsed = JSON.parse(r.event_ids_json);
      if (Array.isArray(parsed)) eventIds = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      eventIds = [];
    }
  }
  return {
    id: r.id, kind: r.kind as ChunkKind, source: r.source, streamKey: r.stream_key, refId: r.ref_id, seq: r.seq,
    text: r.text, textLen: r.text_len, contentHash: r.content_hash, tsStart: r.ts_start, tsEnd: r.ts_end,
    eventIds, tier: r.tier, consentId: r.consent_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function readChunk(id: number): ChunkRow | null {
  const r = prep(`${CHUNK_SELECT} WHERE id = ?`).get(id) as RawChunkRow | undefined;
  return r ? hydrateChunk(r) : null;
}

/** Chunks of one kind, optionally narrowed to a stream or a ref, in window order. */
export function chunksFor(kind: ChunkKind, where: { streamKey?: string | null; refId?: string | null } = {}): ChunkRow[] {
  const clauses = ["kind = ?"];
  const params: unknown[] = [kind];
  if (where.streamKey !== undefined) { clauses.push("COALESCE(stream_key, '') = COALESCE(?, '')"); params.push(where.streamKey); }
  if (where.refId !== undefined) { clauses.push("COALESCE(ref_id, '') = COALESCE(?, '')"); params.push(where.refId); }
  const rows = getDb().prepare(`${CHUNK_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY seq, id`).all(...params) as RawChunkRow[];
  return rows.map(hydrateChunk);
}

/**
 * Delete chunks (their vectors cascade). Screen re-anchor and a chat window
 * re-cut both drop and rewrite — this is the drop.
 */
export function deleteChunks(kind: ChunkKind, where: { streamKey?: string | null; refId?: string | null } = {}): number {
  const clauses = ["kind = ?"];
  const params: unknown[] = [kind];
  if (where.streamKey !== undefined) { clauses.push("COALESCE(stream_key, '') = COALESCE(?, '')"); params.push(where.streamKey); }
  if (where.refId !== undefined) { clauses.push("COALESCE(ref_id, '') = COALESCE(?, '')"); params.push(where.refId); }
  return getDb().prepare(`DELETE FROM chunks WHERE ${clauses.join(" AND ")}`).run(...params).changes;
}

export function chunkCount(kind?: ChunkKind): number {
  const r = kind
    ? (prep(`SELECT COUNT(*) AS n FROM chunks WHERE kind = ?`).get(kind) as { n: number })
    : (prep(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number });
  return r.n;
}

// ---- Embeddings: int8, rowid-keyed -----------------------------------------

export interface Int8Vector {
  /** dim signed bytes. */
  vec: Buffer;
  /** x ≈ q × scale. 0 for the zero vector. */
  scale: number;
  dim: number;
}

/**
 * Symmetric per-vector int8 quantisation: q = round(x / scale), scale =
 * max|x| / 127. Cosine over the dequantised vectors matches fp32 to ~1e-3 on
 * unit-norm embeddings, at a quarter of the bytes.
 */
export function quantizeInt8(x: ArrayLike<number>): Int8Vector {
  const dim = x.length;
  let maxAbs = 0;
  for (let i = 0; i < dim; i++) {
    const a = Math.abs(x[i]);
    if (!Number.isFinite(a)) throw new Error(`quantizeInt8: non-finite component at ${i}`);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs === 0 ? 0 : maxAbs / 127;
  const out = Buffer.alloc(dim);
  if (scale > 0) {
    for (let i = 0; i < dim; i++) {
      const q = Math.round(x[i] / scale);
      out.writeInt8(Math.max(-127, Math.min(127, q)), i);
    }
  }
  return { vec: out, scale, dim };
}

export function dequantizeInt8(vec: Buffer | Uint8Array, scale: number, dim = vec.length): Float32Array {
  if (vec.length < dim) throw new Error(`dequantizeInt8: blob holds ${vec.length} bytes, dim is ${dim}`);
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buf.readInt8(i) * scale;
  return out;
}

export interface ChunkEmbeddingRow {
  chunkId: number;
  model: string;
  dim: number;
  scale: number;
  vec: Buffer;
}

/** Store (or replace) the one vector a chunk has. `table` lets S2.2 fill a staging sibling. */
export function putChunkEmbedding(
  chunkId: number,
  vector: ArrayLike<number>,
  model: string,
  table = "chunk_embeddings",
): Int8Vector {
  assertTable(table);
  const q = quantizeInt8(vector);
  getDb()
    .prepare(
      `INSERT INTO ${table} (chunk_id, model, dim, scale, vec) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chunk_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, scale = excluded.scale, vec = excluded.vec,
                                            created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run(chunkId, model, q.dim, q.scale, q.vec);
  return q;
}

export function getChunkEmbedding(chunkId: number, table = "chunk_embeddings"): (ChunkEmbeddingRow & { vector: Float32Array }) | null {
  assertTable(table);
  const r = getDb().prepare(`SELECT chunk_id, model, dim, scale, vec FROM ${table} WHERE chunk_id = ?`).get(chunkId) as
    | { chunk_id: number; model: string; dim: number; scale: number; vec: Buffer }
    | undefined;
  if (!r) return null;
  return { chunkId: r.chunk_id, model: r.model, dim: r.dim, scale: r.scale, vec: r.vec, vector: dequantizeInt8(r.vec, r.scale, r.dim) };
}

/** Chunk ids with no vector from `model` — the incremental embed queue. */
export function unembeddedChunkIds(model: string, limit = 500, table = "chunk_embeddings"): number[] {
  assertTable(table);
  const rows = getDb()
    .prepare(
      `SELECT c.id FROM chunks c LEFT JOIN ${table} e ON e.chunk_id = c.id AND e.model = ?
        WHERE e.chunk_id IS NULL ORDER BY c.id LIMIT ?`,
    )
    .all(model, limit) as { id: number }[];
  return rows.map((r) => r.id);
}

export function chunkEmbeddingCount(model?: string, table = "chunk_embeddings"): number {
  assertTable(table);
  const r = model
    ? (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE model = ?`).get(model) as { n: number })
    : (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number });
  return r.n;
}

function assertTable(table: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad table name ${JSON.stringify(table)}`);
}
