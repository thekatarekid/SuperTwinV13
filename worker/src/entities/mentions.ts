// ===========================================================================
// [CODE] Mentions — the entity ↔ event link the graph walks (V6 P1 S2.6,
// Product_V6 §23.5).
//
// `mentions` (0020) has existed since V2 as the model-side "this event names
// this entity" row, but nothing in the tree wrote it. The graph walk needs it:
// a person reaches the episodes they appear in through the events that
// mention them, and an episode reaches the things it is about the same way
// (Ma ─mentioned_in─► ep_882 ─about─► Diwali gifts). This is the one writer.
//
// Rules:
//   * One row per (event, entity). A second sighting raises confidence and
//     never duplicates.
//   * `entity_id` is merge-resolved on write — a mention of an alias lands on
//     the surviving entity, so the walk never has to chase `merged_into`.
//   * A name string is never an id: callers that could not resolve pass
//     `entityHint` and get no graph edge — hints are for the resolver, not
//     the walk.
//
// Zero model calls; SQL only.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { resolveEntityId } from "./registry.js";

export interface WriteMentionParams {
  eventId: string;
  /** Resolved entity id. Merge-resolved on write. */
  entityId: string;
  surfaceText?: string | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  /** 0..1; default 1 (a structural mention is exact). */
  confidence?: number | null;
  decidedBy: string;
}

export interface MentionRow {
  id: string;
  eventId: string;
  entityId: string;
  surfaceText: string | null;
  confidence: number | null;
  decidedBy: string | null;
}

export function mintMentionId(): string {
  return `mnt_${randomBytes(9).toString("hex")}`;
}

interface RawMention {
  id: string;
  event_id: string;
  entity_id: string | null;
  surface_text: string | null;
  confidence: number | null;
  decided_by: string | null;
}

function hydrate(r: RawMention): MentionRow {
  return {
    id: r.id,
    eventId: r.event_id,
    entityId: r.entity_id ?? "",
    surfaceText: r.surface_text,
    confidence: r.confidence,
    decidedBy: r.decided_by,
  };
}

/**
 * Link an event to an entity. Idempotent per (event, entity): a repeat only
 * ever raises confidence. Returns the row, or null when the entity does not
 * exist (an unresolved id is not a link).
 */
export function writeMention(p: WriteMentionParams): MentionRow | null {
  if (!p.eventId) throw new Error("writeMention: eventId is required");
  if (!p.decidedBy) throw new Error("writeMention: decidedBy is required");
  const entityId = resolveEntityId(p.entityId);
  if (!entityId) return null;
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM events WHERE id = ?`).get(p.eventId);
  if (!exists) return null;
  const confidence = p.confidence ?? 1;
  return db.transaction(() => {
    const existing = db
      .prepare(`SELECT id, event_id, entity_id, surface_text, confidence, decided_by FROM mentions WHERE event_id = ? AND entity_id = ?`)
      .get(p.eventId, entityId) as RawMention | undefined;
    if (existing) {
      db.prepare(
        `UPDATE mentions SET confidence = MAX(COALESCE(confidence, 0), ?),
                             surface_text = COALESCE(?, surface_text)
          WHERE id = ?`,
      ).run(confidence, p.surfaceText ?? null, existing.id);
      return hydrate(
        db.prepare(`SELECT id, event_id, entity_id, surface_text, confidence, decided_by FROM mentions WHERE id = ?`).get(existing.id) as RawMention,
      );
    }
    const id = mintMentionId();
    db.prepare(
      `INSERT INTO mentions (id, event_id, span_start, span_end, surface_text, entity_id, confidence, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, p.eventId, p.spanStart ?? null, p.spanEnd ?? null, p.surfaceText ?? null, entityId, confidence, p.decidedBy);
    return hydrate(
      db.prepare(`SELECT id, event_id, entity_id, surface_text, confidence, decided_by FROM mentions WHERE id = ?`).get(id) as RawMention,
    );
  })();
}

/** Resolved mentions on one event (rows with no entity are the resolver's, not the graph's). */
export function mentionsOfEvent(eventId: string): MentionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, event_id, entity_id, surface_text, confidence, decided_by FROM mentions
        WHERE event_id = ? AND entity_id IS NOT NULL ORDER BY COALESCE(confidence, 0) DESC, id`,
    )
    .all(eventId) as RawMention[];
  return rows.map(hydrate);
}

/** Events that mention an entity, newest first, capped. */
export function mentionsOfEntity(entityId: string, limit = 50): MentionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.event_id, m.entity_id, m.surface_text, m.confidence, m.decided_by
         FROM mentions m JOIN events ev ON ev.id = m.event_id
        WHERE m.entity_id = ? ORDER BY ev.ts DESC, m.id LIMIT ?`,
    )
    .all(entityId, Math.max(0, limit)) as RawMention[];
  return rows.map(hydrate);
}
