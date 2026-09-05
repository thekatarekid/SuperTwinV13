// ===========================================================================
// 0201_v6_graph tests (vitest) — V6 P1 S2.1 (Build §5.1).
//
//   1. migrate up on an EMPTY db; re-running is a no-op; 0201 follows 0200;
//      every S2 table exists; `claims` gained the eight typed columns;
//      entity_edges / edge_evidence are the 0022 tables plus walk indexes;
//      the fresh file has 16 KB pages; `self` exists and is seeded as a hub.
//   2. round-trip each table through db/v6graph.ts — hubs (self cannot be
//      removed), the walk's neighbour read (status, validity, fan-out cap,
//      hub exclusion), typed fields (status → typed_status, no invented
//      values, survives the header upsert), chunks (rowid key, dedupe by
//      hash within a stream, cascade to the vector), int8 embeddings
//      (quantise/dequantise error bound, cosine ≈ 1, staging sibling DDL).
//
// Zero model calls: pure SQLite on a temp file.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeClaimVersion } from "../../claims/store.js";
import { addEdgeEvidence, writeEdge, supersedeEdge } from "../../entities/edges.js";
import { createEntity } from "../../entities/registry.js";
import { closeDb, getDb, runMigrations, runMigrationsOn } from "../connection.js";
import { appendEvent } from "../eventlog.js";
import { MIGRATIONS } from "../schema.js";
import { grantConsent } from "../v6core.js";
import {
  addHub,
  chunkCount,
  chunkEmbeddingCount,
  chunkEmbeddingsDdl,
  chunkHash,
  chunksFor,
  claimTypedFields,
  deleteChunks,
  dequantizeInt8,
  edgeEvidenceFor,
  evidenceByEvent,
  getChunkEmbedding,
  hubIds,
  isHub,
  listHubs,
  neighborEdges,
  putChunkEmbedding,
  quantizeInt8,
  readChunk,
  removeHub,
  SELF_ENTITY_ID,
  selfEntity,
  setClaimTypedFields,
  TYPED_FIELDS,
  unembeddedChunkIds,
  upsertChunk,
} from "../v6graph.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-0201-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  // The consent gate (S1.2) drops uncovered envelopes; the events below need a live grant.
  grantConsent({ source: "wa" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function tables(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
  );
}

function indexes(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name);
}

function person(name: string): string {
  return createEntity({ type: "person", canonical: name }).id;
}

function event(text: string): string {
  const id = appendEvent({
    ts: "2026-08-25T14:12:10.000Z",
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "9198xx-1602@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  }).id;
  if (!id) throw new Error("test event was not written");
  return id;
}

// ---------------------------------------------------------------------------
// 1. Migrate up on empty
// ---------------------------------------------------------------------------

describe("0201_v6_graph — migrate up on empty", () => {
  it("follows 0200, is the last migration, applies clean on a fresh file; a second run is a no-op", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids[ids.length - 1]).toBe("0201_v6_graph");
    expect(ids.indexOf("0201_v6_graph")).toBe(ids.indexOf("0200_v6_core") + 1);
    const fresh = new Database(join(tmpDir, "fresh.db"));
    fresh.pragma("foreign_keys = ON");
    runMigrationsOn(fresh);
    const applied = () =>
      (fresh.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    const first = applied();
    expect(first).toContain("0201_v6_graph");
    runMigrationsOn(fresh);
    expect(applied()).toEqual(first);
    fresh.close();
  });

  it("creates chunks, chunk_embeddings, hub_nodes and keeps the 0022 edge tables", () => {
    const db = getDb();
    const t = tables(db);
    for (const name of ["entity_edges", "edge_evidence", "chunks", "chunk_embeddings", "hub_nodes"]) {
      expect(t.has(name), name).toBe(true);
    }
    expect(columns(db, "entity_edges")).toEqual(
      expect.arrayContaining(["kind", "subtype", "src_entity_id", "dst_entity_id", "confidence", "status", "valid_from", "valid_to"]),
    );
    expect(columns(db, "edge_evidence")).toEqual(expect.arrayContaining(["edge_id", "event_id", "quote"]));
    expect(indexes(db, "entity_edges")).toEqual(expect.arrayContaining(["idx_entity_edges_walk_src", "idx_entity_edges_walk_dst"]));
    expect(indexes(db, "edge_evidence")).toContain("idx_edge_evidence_event");
    expect(columns(db, "chunks")).toEqual(
      expect.arrayContaining(["id", "kind", "source", "stream_key", "ref_id", "seq", "text", "text_len", "content_hash", "ts_start", "ts_end", "event_ids_json", "tier", "consent_id"]),
    );
    expect(columns(db, "chunk_embeddings")).toEqual(["chunk_id", "model", "dim", "scale", "vec", "created_at"]);
    // rowid key: chunk_id is the INTEGER PRIMARY KEY alias.
    const pk = (db.prepare(`PRAGMA table_info(chunk_embeddings)`).all() as { name: string; type: string; pk: number }[]).find((c) => c.pk === 1)!;
    expect(pk).toMatchObject({ name: "chunk_id", type: "INTEGER" });
    expect(columns(db, "hub_nodes")).toEqual(expect.arrayContaining(["entity_id", "reason", "degree", "added_by"]));
  });

  it("adds the eight typed-field columns to claims (status as typed_status)", () => {
    const c = columns(getDb(), "claims");
    for (const col of Object.values(TYPED_FIELDS)) expect(c, col).toContain(col);
    expect(c).toContain("status"); // the claim lifecycle column is untouched
    expect(TYPED_FIELDS.status).toBe("typed_status");
  });

  it("opens fresh files with 16 KB pages", () => {
    expect(getDb().pragma("page_size", { simple: true })).toBe(16384);
    expect(getDb().pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("seeds self as an entity and as a hub", () => {
    const self = selfEntity();
    expect(self).toMatchObject({ id: SELF_ENTITY_ID, type: "person", provisional: false, userPinned: true });
    expect(SELF_ENTITY_ID).toMatch(/^ent_[0-9a-f]{24}$/);
    expect(isHub(SELF_ENTITY_ID)).toBe(true);
    expect(listHubs()).toEqual([expect.objectContaining({ entityId: SELF_ENTITY_ID, reason: "self", addedBy: "migration:0201" })]);
    expect(hubIds()).toEqual(new Set([SELF_ENTITY_ID]));
    // People lists others: the self row is not a contact.
    expect(getDb().prepare(`SELECT id FROM people`).all()).toEqual([]);
    const rohan = person("Rohan");
    expect((getDb().prepare(`SELECT id FROM people`).all() as { id: string }[]).map((r) => r.id)).toEqual([rohan]);
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trips
// ---------------------------------------------------------------------------

describe("hub_nodes", () => {
  it("adds, upserts and removes hubs — except self", () => {
    const wa = createEntity({ type: "group", subtype: "community", canonical: "Colony group" }).id;
    expect(addHub(wa, "degree", { degree: 412, addedBy: "code:degree" })).toMatchObject({ entityId: wa, reason: "degree", degree: 412 });
    expect(addHub(wa, "user").reason).toBe("user");
    expect(hubIds()).toEqual(new Set([SELF_ENTITY_ID, wa]));
    expect(removeHub(wa)).toBe(true);
    expect(removeHub(wa)).toBe(false);
    expect(removeHub(SELF_ENTITY_ID)).toBe(false);
    expect(isHub(SELF_ENTITY_ID)).toBe(true);
    // Cascade: a deleted entity leaves no hub row behind.
    addHub(wa, "degree");
    getDb().prepare(`DELETE FROM entities WHERE id = ?`).run(wa);
    expect(isHub(wa)).toBe(false);
  });
});

describe("neighborEdges — the walk's read side", () => {
  it("prunes superseded and expired edges, excludes hubs, caps fan-out by confidence", () => {
    const ma = person("Ma");
    const tea = createEntity({ type: "thing", subtype: "food_item", canonical: "jasmine tea" }).id;
    const rohan = person("Rohan");
    const oldFlat = createEntity({ type: "place", subtype: "home", canonical: "old flat" }).id;
    const ev = event("ma prefers jasmine tea");

    // Ma → self (hub), Ma → tea, Rohan → Ma, Ma → old flat (expired).
    writeEdge({ kind: "related_to", subtype: "mother", srcEntityId: ma, dstEntityId: SELF_ENTITY_ID, confidence: 0.95, decidedBy: "test", quote: "ma", eventId: ev });
    const teaEdge = writeEdge({ kind: "about", srcEntityId: ma, dstEntityId: tea, confidence: 0.8, decidedBy: "test", quote: "prefers jasmine tea", eventId: ev }).edge;
    writeEdge({ kind: "related_to", subtype: "friend", srcEntityId: rohan, dstEntityId: ma, confidence: 0.6, decidedBy: "test", quote: "ma", eventId: ev });
    const flat = writeEdge({ kind: "located_at", subtype: "current", srcEntityId: ma, dstEntityId: oldFlat, confidence: 0.9, decidedBy: "test", quote: "ma", eventId: ev, validFrom: "2020-01-01T00:00:00.000Z" }).edge;
    supersedeEdge(flat.id, { validTo: "2024-01-01T00:00:00.000Z" });

    const now = "2026-09-06T00:00:00.000Z";
    const all = neighborEdges(ma, { now });
    expect(all.map((e) => e.neighborId)).toEqual([tea, rohan]); // by confidence desc; self excluded; flat superseded
    expect(all[0]).toMatchObject({ id: teaEdge.id, kind: "about", subtype: null, confidence: 0.8, neighborId: tea });

    expect(neighborEdges(ma, { now, excludeHubs: false }).map((e) => e.neighborId)).toEqual([SELF_ENTITY_ID, tea, rohan]);
    expect(neighborEdges(ma, { now, fanOut: 1 }).map((e) => e.neighborId)).toEqual([tea]);
    expect(neighborEdges(ma, { now, kinds: ["related_to"] }).map((e) => e.neighborId)).toEqual([rohan]);
    expect(neighborEdges(ma, { now, fanOut: 0 })).toEqual([]);

    // Validity: an active edge not yet valid at `now` is skipped; expired edges too.
    const future = writeEdge({ kind: "participates_in", subtype: "attendee", srcEntityId: ma, dstEntityId: rohan, confidence: 1, decidedBy: "test", quote: "x", eventId: ev, validFrom: "2030-01-01T00:00:00.000Z" }).edge;
    expect(neighborEdges(ma, { now }).map((e) => e.id)).not.toContain(future.id);
    expect(neighborEdges(ma, { now: "2031-01-01T00:00:00.000Z" }).map((e) => e.id)).toContain(future.id);
    expect(neighborEdges(ma, { now: "2022-06-01T00:00:00.000Z", excludeHubs: false }).map((e) => e.id)).not.toContain(flat.id); // superseded, even inside its window

    // Evidence, both directions.
    const ev2 = event("still jasmine");
    addEdgeEvidence(teaEdge.id, ev2, "still jasmine");
    expect(edgeEvidenceFor([teaEdge.id]).map((r) => r.eventId).sort()).toEqual([ev, ev2].sort());
    expect(evidenceByEvent(ev2)).toEqual([{ edgeId: teaEdge.id, eventId: ev2, quote: "still jasmine" }]);
    expect(edgeEvidenceFor([])).toEqual([]);
    // Deleting the event drops its evidence rows (cascade through the new index).
    getDb().prepare(`DELETE FROM events WHERE id = ?`).run(ev2);
    expect(evidenceByEvent(ev2)).toEqual([]);
  });
});

describe("claims — typed fields", () => {
  function claim(key: string): void {
    const ev = event("Paid ₹340 to Uber, 4 Sep");
    writeClaimVersion({
      claimKey: key,
      kind: "fact",
      subjectId: SELF_ENTITY_ID,
      text: "paid ₹340 to Uber on 4 Sep",
      statedAt: "2026-09-04T10:00:00.000Z",
      confidence: 0.9,
      evidence: [{ event_ids: [ev], quote: "Paid ₹340 to Uber, 4 Sep" }],
      decidedBy: "test",
    });
  }

  it("writes the receipt columns (TYP-01) and leaves unset ones null (TYP-03)", () => {
    claim("c:uber:1");
    expect(claimTypedFields("c:uber:1")).toEqual({
      amount: null, currency: null, date: null, status: null, merchant: null, order_id: null, location: null, duration_s: null,
    });
    expect(setClaimTypedFields("c:uber:1", { amount: 340, currency: "inr", merchant: "Uber", date: "2026-09-04" })).toBe(true);
    expect(claimTypedFields("c:uber:1")).toMatchObject({ amount: 340, currency: "INR", merchant: "Uber", date: "2026-09-04", status: null, order_id: null });
    // Partial update leaves the rest alone; explicit null clears.
    setClaimTypedFields("c:uber:1", { status: "paid", duration_s: 1260.4 });
    expect(claimTypedFields("c:uber:1")).toMatchObject({ amount: 340, status: "paid", duration_s: 1260 });
    setClaimTypedFields("c:uber:1", { merchant: null });
    expect(claimTypedFields("c:uber:1")?.merchant).toBeNull();
    // The wire's `status` lands in typed_status; the lifecycle column is untouched.
    const row = getDb().prepare(`SELECT status, typed_status FROM claims WHERE claim_key = ?`).get("c:uber:1") as { status: string; typed_status: string };
    expect(row).toEqual({ status: "active", typed_status: "paid" });
    // Bad shapes are rejected, never coerced into a guess.
    expect(() => setClaimTypedFields("c:uber:1", { date: "4 Sep" })).toThrow(/YYYY-MM-DD/);
    expect(() => setClaimTypedFields("c:uber:1", { amount: "5-6k" as unknown as number })).toThrow(/not a number/);
    expect(setClaimTypedFields("c:missing", { amount: 1 })).toBe(false);
    expect(claimTypedFields("c:missing")).toBeNull();
  });

  it("survives the header upsert a new version triggers", () => {
    claim("c:uber:2");
    setClaimTypedFields("c:uber:2", { amount: 340, merchant: "Uber" });
    claim("c:uber:2"); // second version → header re-upserted
    expect(claimTypedFields("c:uber:2")).toMatchObject({ amount: 340, merchant: "Uber" });
    // Structured method shape (RET-07): SUM over typed columns, not over a ranked list.
    claim("c:uber:3");
    setClaimTypedFields("c:uber:3", { amount: 680, merchant: "Uber", date: "2026-08-20" });
    const sum = getDb().prepare(`SELECT SUM(amount) AS s FROM claims WHERE merchant = 'Uber'`).get() as { s: number };
    expect(sum.s).toBe(1020);
  });
});

describe("chunks", () => {
  it("keys by rowid, dedupes by hash within a stream, refreshes coverage on a hit", () => {
    const text = "yes, book it";
    const a = upsertChunk({ kind: "chat", source: "wa", streamKey: "goa-group", seq: 0, text, tsStart: "2026-08-25T14:00:00.000Z", tsEnd: "2026-08-25T14:12:00.000Z", eventIds: ["e1", "e2"], tier: 2 });
    expect(a.inserted).toBe(true);
    expect(Number.isInteger(a.id)).toBe(true);
    const again = upsertChunk({ kind: "chat", source: "wa", streamKey: "goa-group", seq: 3, text, eventIds: ["e1", "e2", "e3"] });
    expect(again).toEqual({ id: a.id, inserted: false });
    const other = upsertChunk({ kind: "chat", source: "wa", streamKey: "other-stream", text });
    expect(other.inserted).toBe(true); // same text, different stream → its own chunk
    expect(upsertChunk({ kind: "browser", source: "browser", streamKey: "airbnb.com", refId: "visit-1", text }).inserted).toBe(true);
    expect(chunkCount()).toBe(3);
    expect(chunkCount("chat")).toBe(2);

    const row = readChunk(a.id)!;
    expect(row).toMatchObject({ kind: "chat", streamKey: "goa-group", seq: 3, text, textLen: text.length, contentHash: chunkHash(text), tsStart: "2026-08-25T14:00:00.000Z", tier: 2 });
    expect(row.eventIds).toEqual(["e1", "e2", "e3"]);
    expect(chunksFor("chat", { streamKey: "goa-group" }).map((c) => c.id)).toEqual([a.id]);
    expect(chunksFor("browser", { refId: "visit-1" })).toHaveLength(1);
    expect(readChunk(999_999)).toBeNull();
    expect(() => upsertChunk({ kind: "chat", text: "" })).toThrow(/text is required/);
    expect(() => upsertChunk({ kind: "pdf" as never, text: "x" })).toThrow(/not a chunk kind/);
  });

  it("stores one int8 vector per chunk and cascades it with the chunk", () => {
    const { id } = upsertChunk({ kind: "screen", source: "screen", streamKey: "doc:villa", text: "the villa with the pool" });
    // A unit-norm 768-d vector, as the embedder would hand over.
    const dim = 768;
    const raw = new Float32Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) { raw[i] = Math.sin(i * 0.37) * (i % 7 === 0 ? -1 : 1); norm += raw[i] * raw[i]; }
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) raw[i] /= norm;

    const q = putChunkEmbedding(id, raw, "embeddinggemma-300m");
    expect(q.dim).toBe(dim);
    expect(q.vec.length).toBe(dim); // one byte per component
    const back = getChunkEmbedding(id)!;
    expect(back).toMatchObject({ chunkId: id, model: "embeddinggemma-300m", dim, scale: q.scale });
    let dot = 0, maxErr = 0;
    for (let i = 0; i < dim; i++) { dot += back.vector[i] * raw[i]; maxErr = Math.max(maxErr, Math.abs(back.vector[i] - raw[i])); }
    expect(dot).toBeGreaterThan(0.999); // cosine over unit vectors
    expect(maxErr).toBeLessThanOrEqual(q.scale / 2 + 1e-9);
    // On-disk width: 768 int8 + row overhead is well under the fp32 3,072.
    const width = getDb().prepare(`SELECT length(vec) AS n FROM chunk_embeddings WHERE chunk_id = ?`).get(id) as { n: number };
    expect(width.n).toBe(dim);

    // Replace on re-embed with a new model; the incremental queue sees the difference.
    expect(unembeddedChunkIds("embeddinggemma-300m")).toEqual([]);
    expect(unembeddedChunkIds("minilm-bundled")).toEqual([id]);
    putChunkEmbedding(id, raw, "minilm-bundled");
    expect(chunkEmbeddingCount()).toBe(1);
    expect(chunkEmbeddingCount("minilm-bundled")).toBe(1);
    expect(chunkEmbeddingCount("embeddinggemma-300m")).toBe(0);

    // Cascade: deleting the chunk removes its vector.
    expect(deleteChunks("screen", { streamKey: "doc:villa" })).toBe(1);
    expect(getChunkEmbedding(id)).toBeNull();
    expect(chunkEmbeddingCount()).toBe(0);
  });

  it("quantises edge cases and can build the staging sibling S2.2 flips", () => {
    expect(quantizeInt8([0, 0, 0])).toMatchObject({ scale: 0, dim: 3 });
    expect(Array.from(dequantizeInt8(quantizeInt8([0, 0, 0]).vec, 0))).toEqual([0, 0, 0]);
    const q = quantizeInt8([1, -1, 0.5]);
    expect(Array.from(q.vec.values()).map((b) => (b > 127 ? b - 256 : b))).toEqual([127, -127, 64]);
    expect(() => quantizeInt8([1, Number.NaN])).toThrow(/non-finite/);
    expect(() => dequantizeInt8(Buffer.alloc(2), 1, 3)).toThrow(/holds 2 bytes/);
    expect(() => chunkEmbeddingsDdl("chunk_embeddings; DROP TABLE chunks")).toThrow(/bad table name/);

    const db = getDb();
    db.exec(chunkEmbeddingsDdl("chunk_embeddings_next"));
    const { id } = upsertChunk({ kind: "episode", refId: "ep_882", text: "Diwali gifts for Ma" });
    putChunkEmbedding(id, [0.1, 0.2, 0.3], "embeddinggemma-300m", "chunk_embeddings_next");
    expect(chunkEmbeddingCount(undefined, "chunk_embeddings_next")).toBe(1);
    expect(chunkEmbeddingCount()).toBe(0);
    // The flip S2.2 performs: one transaction, never a half-built index.
    db.transaction(() => {
      db.exec(`DROP TABLE chunk_embeddings; ALTER TABLE chunk_embeddings_next RENAME TO chunk_embeddings;`);
    })();
    expect(getChunkEmbedding(id)?.model).toBe("embeddinggemma-300m");
    expect(tables(db).has("chunk_embeddings_next")).toBe(false);
  });
});
