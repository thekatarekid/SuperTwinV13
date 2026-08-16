// ===========================================================================
// [CODE] Entity edges — build item 1.5, arch §10.3.
//
// Seven kinds, closed subtype lists, and three rules that the rest of the
// system leans on:
//
//   1. METADATA EDGES ARE FREE AND EXACT. A group participant list is an
//      `affiliated_with:member` edge at confidence 1.0 with ZERO model calls,
//      written before any model runs. Same for calendar attendees
//      (`participates_in:attendee`). During bootstrap this means a usable
//      relationship graph exists within seconds of the first import.
//
//   2. A TEXT EDGE REQUIRES A VERBATIM QUOTE. No evidence, no write. The quote
//      is stored in `edge_evidence` against the event it came from, so every
//      edge on a surface can show why it is there.
//
//   3. EDGES ARE BITEMPORAL-LITE. A contradiction CLOSES an edge — `valid_to`
//      plus `status='superseded'`, with the closing quote as evidence — and
//      never deletes it. A move opens a new `located_at:current` and closes the
//      old one. Both survive, because "where did Rahul live in March" is a
//      question the graph is supposed to be able to answer.
//
// Edges are STRUCTURAL ONLY. An opinion, a preference or a feeling about a
// person is a claim; there is deliberately no edge kind that can hold one.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import {
  EDGE_SUBTYPES,
  isEdgeKind,
  isEdgeSubtype,
  mergedAliasIds,
  resolveEntityId,
  type EdgeKind,
} from "./registry.js";

export type EdgeStatus = "active" | "superseded" | "rejected";

export interface EdgeRow {
  id: string;
  kind: EdgeKind;
  subtype: string | null;
  srcEntityId: string;
  dstEntityId: string;
  confidence: number | null;
  decidedBy: string | null;
  status: EdgeStatus;
  validFrom: string | null;
  validTo: string | null;
}

export interface EdgeEvidenceRow {
  edgeId: string;
  eventId: string;
  quote: string;
}

interface RawEdgeRow {
  id: string;
  kind: string;
  subtype: string | null;
  src_entity_id: string;
  dst_entity_id: string;
  confidence: number | null;
  decided_by: string | null;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
}

const SELECT = `SELECT id, kind, subtype, src_entity_id, dst_entity_id, confidence, decided_by,
                       status, valid_from, valid_to
                  FROM entity_edges`;

function hydrate(row: RawEdgeRow | undefined): EdgeRow | null {
  if (!row) return null;
  if (!isEdgeKind(row.kind)) {
    throw new Error(`edge ${row.id}: kind ${JSON.stringify(row.kind)} is outside the closed set`);
  }
  return {
    id: row.id,
    kind: row.kind,
    subtype: row.subtype,
    srcEntityId: row.src_entity_id,
    dstEntityId: row.dst_entity_id,
    confidence: row.confidence,
    decidedBy: row.decided_by,
    status: (row.status as EdgeStatus) ?? "active",
    validFrom: row.valid_from,
    validTo: row.valid_to,
  };
}

export function mintEdgeId(): string {
  return `edg_${randomBytes(12).toString("hex")}`;
}

/** `code:metadata` is the only decider allowed to write an edge with no quote. */
export const METADATA_DECIDER = "code:metadata";

export interface WriteEdgeParams {
  kind: EdgeKind;
  subtype?: string | null;
  srcEntityId: string;
  dstEntityId: string;
  confidence?: number;
  decidedBy: string;
  validFrom?: string | null;
  /** Verbatim, from the event. Required for anything but a metadata edge. */
  quote?: string | null;
  eventId?: string | null;
}

export interface WriteEdgeResult {
  edge: EdgeRow;
  created: boolean;
  /** Edges this write closed — a move, a job change, a switched provider. */
  superseded: EdgeRow[];
}

/**
 * Kinds whose `current` subtype is exclusive per source entity: opening a new
 * one closes whatever was open. A person lives in one current place.
 */
const EXCLUSIVE_CURRENT: Readonly<Partial<Record<EdgeKind, string>>> = {
  located_at: "current",
};

export function writeEdge(params: WriteEdgeParams): WriteEdgeResult {
  if (!isEdgeKind(params.kind)) {
    throw new Error(`writeEdge: ${JSON.stringify(params.kind)} is not one of the 7 edge kinds`);
  }
  const subtype = params.subtype === "" ? null : (params.subtype ?? null);
  if (!isEdgeSubtype(params.kind, subtype)) {
    throw new Error(
      `writeEdge: ${JSON.stringify(subtype)} is not a subtype of ${params.kind} ` +
        `(closed list: ${EDGE_SUBTYPES[params.kind].join(", ") || "none"})`,
    );
  }
  if (!params.decidedBy) throw new Error("writeEdge: decided_by is required");

  const src = resolveEntityId(params.srcEntityId);
  const dst = resolveEntityId(params.dstEntityId);
  if (!src) throw new Error(`writeEdge: no entity ${params.srcEntityId}`);
  if (!dst) throw new Error(`writeEdge: no entity ${params.dstEntityId}`);
  if (src === dst) throw new Error(`writeEdge: ${params.kind} from an entity to itself`);

  const quote = typeof params.quote === "string" ? params.quote.trim() : "";
  const metadata = params.decidedBy === METADATA_DECIDER;
  if (!metadata && quote === "") {
    throw new Error(`writeEdge: ${params.kind} from ${params.decidedBy} carries no quote — no evidence, no write`);
  }
  if (!metadata && !params.eventId) {
    throw new Error(`writeEdge: ${params.kind} from ${params.decidedBy} carries a quote with no event`);
  }

  const db = getDb();
  const superseded: EdgeRow[] = [];
  const exclusive = EXCLUSIVE_CURRENT[params.kind];
  if (exclusive && subtype === exclusive) {
    for (const open of edgesFrom(src, { kind: params.kind, subtype, status: "active" })) {
      if (open.dstEntityId === dst) continue;
      superseded.push(
        supersedeEdge(open.id, {
          validTo: params.validFrom ?? null,
          eventId: params.eventId ?? null,
          quote: quote || null,
        }),
      );
    }
  }

  const existing = hydrate(
    db
      .prepare(`${SELECT} WHERE kind = ? AND COALESCE(subtype,'') = ? AND src_entity_id = ? AND dst_entity_id = ?`)
      .get(params.kind, subtype ?? "", src, dst) as RawEdgeRow | undefined,
  );

  let edgeId: string;
  let created: boolean;
  if (existing) {
    edgeId = existing.id;
    created = false;
    // Repeated evidence only ever raises confidence and re-opens a closed edge
    // when the new evidence is a fresh assertion. It never lowers either: an
    // edge seen again is not an edge seen less.
    const confidence = Math.max(existing.confidence ?? 0, params.confidence ?? 0);
    db.prepare(
      `UPDATE entity_edges
          SET confidence = ?,
              status = CASE WHEN status = 'rejected' THEN status ELSE 'active' END,
              valid_to = CASE WHEN status = 'rejected' THEN valid_to ELSE NULL END,
              valid_from = COALESCE(valid_from, ?)
        WHERE id = ?`,
    ).run(confidence, params.validFrom ?? null, edgeId);
  } else {
    edgeId = mintEdgeId();
    created = true;
    db.prepare(
      `INSERT INTO entity_edges (id, kind, subtype, src_entity_id, dst_entity_id, confidence,
                                 decided_by, status, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
    ).run(
      edgeId,
      params.kind,
      subtype,
      src,
      dst,
      params.confidence ?? (metadata ? 1 : null),
      params.decidedBy,
      params.validFrom ?? null,
    );
  }

  if (params.eventId && quote !== "") addEdgeEvidence(edgeId, params.eventId, quote);
  return { edge: readEdge(edgeId)!, created, superseded };
}

export interface SupersedeParams {
  validTo?: string | null;
  eventId?: string | null;
  quote?: string | null;
  status?: Extract<EdgeStatus, "superseded" | "rejected">;
}

/**
 * Close an edge. The row stays; a contradiction is history, not a mistake, and
 * deleting it would make "Prabhat used to cook for us" unanswerable.
 */
export function supersedeEdge(edgeId: string, params: SupersedeParams = {}): EdgeRow {
  const before = readEdge(edgeId);
  if (!before) throw new Error(`supersedeEdge: no edge ${edgeId}`);
  getDb()
    .prepare(`UPDATE entity_edges SET status = ?, valid_to = COALESCE(?, valid_to) WHERE id = ?`)
    .run(params.status ?? "superseded", params.validTo ?? null, edgeId);
  const quote = typeof params.quote === "string" ? params.quote.trim() : "";
  if (params.eventId && quote !== "") addEdgeEvidence(edgeId, params.eventId, quote);
  return readEdge(edgeId)!;
}

/** A user rejecting an edge on the Entities surface. Also never a delete. */
export function rejectEdge(edgeId: string, params: SupersedeParams = {}): EdgeRow {
  return supersedeEdge(edgeId, { ...params, status: "rejected" });
}

export function addEdgeEvidence(edgeId: string, eventId: string, quote: string): void {
  const text = String(quote ?? "").trim();
  if (text === "") throw new Error(`addEdgeEvidence: empty quote for ${edgeId}`);
  getDb()
    .prepare(`INSERT OR IGNORE INTO edge_evidence (edge_id, event_id, quote) VALUES (?, ?, ?)`)
    .run(edgeId, eventId, text);
}

export function edgeEvidence(edgeId: string): EdgeEvidenceRow[] {
  return (
    getDb()
      // Ordered by when the quote was SAID (`events.ts`), never by when it was
      // ingested and never by rowid, so an edge reads as the story it is.
      .prepare(
        `SELECT edge_id, event_id, quote FROM edge_evidence
          WHERE edge_id = ?
          ORDER BY (SELECT ts FROM events WHERE id = event_id), event_id`,
      )
      .all(edgeId) as { edge_id: string; event_id: string; quote: string }[]
  ).map((r) => ({ edgeId: r.edge_id, eventId: r.event_id, quote: r.quote }));
}

export function readEdge(edgeId: string): EdgeRow | null {
  return hydrate(getDb().prepare(`${SELECT} WHERE id = ?`).get(edgeId) as RawEdgeRow | undefined);
}

export interface EdgeFilter {
  kind?: EdgeKind;
  subtype?: string | null;
  status?: EdgeStatus;
}

function filterClause(filter: EdgeFilter): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.kind) {
    where.push("kind = ?");
    args.push(filter.kind);
  }
  if (filter.subtype !== undefined) {
    where.push("COALESCE(subtype,'') = ?");
    args.push(filter.subtype ?? "");
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  return { sql: where.length ? ` AND ${where.join(" AND ")}` : "", args };
}

export function edgesFrom(entityId: string, filter: EdgeFilter = {}): EdgeRow[] {
  const ids = mergedAliasIds(entityId);
  if (ids.length === 0) return [];
  const { sql, args } = filterClause(filter);
  const marks = ids.map(() => "?").join(",");
  return (
    getDb().prepare(`${SELECT} WHERE src_entity_id IN (${marks})${sql} ORDER BY id`).all(...ids, ...args) as RawEdgeRow[]
  ).map((r) => hydrate(r)!);
}

export function edgesTo(entityId: string, filter: EdgeFilter = {}): EdgeRow[] {
  const ids = mergedAliasIds(entityId);
  if (ids.length === 0) return [];
  const { sql, args } = filterClause(filter);
  const marks = ids.map(() => "?").join(",");
  return (
    getDb().prepare(`${SELECT} WHERE dst_entity_id IN (${marks})${sql} ORDER BY id`).all(...ids, ...args) as RawEdgeRow[]
  ).map((r) => hydrate(r)!);
}

/** Every edge touching an entity in either direction — the 1-hop graph. */
export function edgesOf(entityId: string, filter: EdgeFilter = {}): EdgeRow[] {
  const seen = new Map<string, EdgeRow>();
  for (const e of [...edgesFrom(entityId, filter), ...edgesTo(entityId, filter)]) seen.set(e.id, e);
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function listEdges(filter: EdgeFilter = {}): EdgeRow[] {
  const { sql, args } = filterClause(filter);
  const where = sql === "" ? "" : ` WHERE ${sql.slice(5)}`;
  return (getDb().prepare(`${SELECT}${where} ORDER BY id`).all(...args) as RawEdgeRow[]).map((r) => hydrate(r)!);
}

/** Re-points every edge of a merged-away entity onto the survivor. */
export function repointEdges(fromId: string, toId: string): number {
  const db = getDb();
  let moved = 0;
  for (const row of db
    .prepare(`SELECT id, src_entity_id, dst_entity_id FROM entity_edges WHERE src_entity_id = ? OR dst_entity_id = ?`)
    .all(fromId, fromId) as { id: string; src_entity_id: string; dst_entity_id: string }[]) {
    const src = row.src_entity_id === fromId ? toId : row.src_entity_id;
    const dst = row.dst_entity_id === fromId ? toId : row.dst_entity_id;
    if (src === dst) {
      // The merge made this edge point at itself. Close it rather than delete
      // it: its evidence is still a true thing somebody said.
      db.prepare(`UPDATE entity_edges SET status = 'superseded' WHERE id = ?`).run(row.id);
      continue;
    }
    try {
      db.prepare(`UPDATE entity_edges SET src_entity_id = ?, dst_entity_id = ? WHERE id = ?`).run(src, dst, row.id);
      moved += 1;
    } catch {
      // The survivor already has this exact edge. Fold the evidence into it and
      // retire the duplicate — the unique index is doing its job.
      const twin = db
        .prepare(
          `SELECT id FROM entity_edges
            WHERE kind = (SELECT kind FROM entity_edges WHERE id = ?)
              AND COALESCE(subtype,'') = (SELECT COALESCE(subtype,'') FROM entity_edges WHERE id = ?)
              AND src_entity_id = ? AND dst_entity_id = ? AND id <> ?`,
        )
        .get(row.id, row.id, src, dst, row.id) as { id: string } | undefined;
      if (twin) {
        db.prepare(`UPDATE OR IGNORE edge_evidence SET edge_id = ? WHERE edge_id = ?`).run(twin.id, row.id);
        db.prepare(`DELETE FROM entity_edges WHERE id = ?`).run(row.id);
      }
    }
  }
  return moved;
}
