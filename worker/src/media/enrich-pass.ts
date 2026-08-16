// ===========================================================================
// [CODE] The enrichment lane's hand-off to pass 2 — arch §8.4 "Text-first,
// enrich-later — exactly two passes", build item 1.4.
//
// Enrichment NEVER blocks the text path. Pass 1 ran on text the moment the
// events landed, with every attachment standing in as an explicit placeholder
// ("[image, description pending]"). What this module owes the text path back is
// one countdown and one row:
//
//   sessions.pending_enrichment_count  −1 per enrichment that resolves
//                                       ↓
//   reaches 0  ──►  ONE work_queue row (unit_kind session, stage extract)
//                   = pass 2, the complete re-read of the same episode
//
// Three rules from §8.4 are load-bearing here:
//
//   * Ready, failed and skipped ALL count as resolved (rule 3). A voice note
//     whose transcription failed becomes "[voice note, unreadable]" and pass 2
//     proceeds — otherwise one bad file strands the episode at ◍ forever.
//   * Two passes, not N (rule 1). The insert is guarded on the queue row
//     already existing, so landing on zero twice cannot produce a third pass.
//   * The salience gate (§8.4 table) is OFF by default: every enrichment
//     triggers the completion pass. On, an enrichment carrying no entity, date,
//     number, price or commitment does not — a [CODE] check, no model call.
//
// The completion pass is scheduled by the same priority key as everything else
// (§9.2), never by insertion order.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { getDb } from "../db/connection.js";
import { enrichmentPriority, getEnrichmentSalienceGate } from "./batch.js";

/** What the salience gate counts as material (§8.4 table), as one [CODE] test. */
const MATERIAL =
  /(\p{Lu}\p{L}+|\d|₹|\$|€|£|\b(will|shall|need|must|should|please|send|pay|book|call|meet)\b)/u;

/**
 * Does this enrichment's text justify the completion pass? With the gate off —
 * the default — everything does, which is the whole point of the default.
 */
export function salienceGateAdmits(text: string | null | undefined): boolean {
  if (!getEnrichmentSalienceGate()) return true;
  if (!text) return false;
  return MATERIAL.test(text);
}

/** The session an event belongs to, or null before segmentation has run. */
export function sessionOfEvent(eventId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT s.id AS id
         FROM sessions s
        WHERE EXISTS (SELECT 1 FROM json_each(s.event_ids) je WHERE je.value = ?)
        LIMIT 1`,
    )
    .get(eventId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Arm the countdown: how many attachments this session is still waiting on. */
export function setPendingEnrichmentCount(sessionId: string, count: number): void {
  getDb()
    .prepare(`UPDATE sessions SET pending_enrichment_count = ? WHERE id = ?`)
    .run(Math.max(0, Math.floor(count)), sessionId);
}

export function pendingEnrichmentCount(sessionId: string): number {
  const row = getDb()
    .prepare(`SELECT pending_enrichment_count AS n FROM sessions WHERE id = ?`)
    .get(sessionId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface EnrichmentResolution {
  sessionId: string | null;
  /** Enrichments still outstanding on that session after this one. */
  pending: number;
  /** A `work_queue` row was written for the completion pass. */
  completionEnqueued: boolean;
  /** The gate was on and this text did not clear it (§8.4 table). */
  gated: boolean;
}

/**
 * One enrichment finished — ready, failed or skipped, all three count as
 * resolved. Decrement the session's countdown and, at zero, enqueue pass 2 once.
 *
 * An event no session claims yet (segmentation has not run, or this is a bare
 * media row) resolves to nothing: there is no episode waiting on it, so there
 * is nothing to complete.
 */
export function resolveEnrichment(
  eventId: string,
  opts: { text?: string | null; now?: number } = {},
): EnrichmentResolution {
  const sessionId = sessionOfEvent(eventId);
  const gated = !salienceGateAdmits(opts.text);
  if (sessionId === null) {
    return { sessionId: null, pending: 0, completionEnqueued: false, gated };
  }

  getDb()
    .prepare(
      `UPDATE sessions
          SET pending_enrichment_count = MAX(0, pending_enrichment_count - 1)
        WHERE id = ?`,
    )
    .run(sessionId);
  const pending = pendingEnrichmentCount(sessionId);

  if (pending > 0 || gated) {
    return { sessionId, pending, completionEnqueued: false, gated };
  }
  return {
    sessionId,
    pending,
    completionEnqueued: enqueueCompletionPass(sessionId, opts.now ?? Date.now()),
    gated,
  };
}

/**
 * The one `work_queue` row pass 2 runs from: `unit_kind = session`, stage
 * `extract`, at the session's own priority. Returns false when the row is
 * already there — two passes, not N.
 */
export function enqueueCompletionPass(sessionId: string, now: number = Date.now()): boolean {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM work_queue
        WHERE unit_kind = 'session' AND unit_id = ? AND stage = 'extract'
        LIMIT 1`,
    )
    .get(sessionId) as { id: string } | undefined;
  if (existing) return false;

  const session = db
    .prepare(
      `SELECT s.ended_at AS ts, st.tier AS tier
         FROM sessions s
         LEFT JOIN streams st ON st.id = s.stream_id
        WHERE s.id = ?`,
    )
    .get(sessionId) as { ts: string | null; tier: string | null } | undefined;

  db.prepare(
    `INSERT INTO work_queue (id, unit_kind, unit_id, cohort_id, stage, priority, state)
     VALUES (@id, 'session', @unitId, NULL, 'extract', @priority, 'ready')`,
  ).run({
    id: `wq-${randomUUID()}`,
    unitId: sessionId,
    priority: enrichmentPriority(
      { id: sessionId, ts: session?.ts ?? null, tier: session?.tier ?? null },
      now,
    ),
  });
  return true;
}
