// ===========================================================================
// [CODE] The enrichment lane's hand-off back to understanding — V13 shape
// (build P1.8, spec §4.4 rule 2). Replaces the V11 session countdown
// (media/enrich-pass.ts): the unit that waits on enrichment is now the
// DISPATCHED BUNDLE, not the sealed session.
//
// Enrichment NEVER blocks understanding. Pass 1 (Orient) ran on text the
// moment the bundle dispatched, with every attachment standing in as an
// explicit placeholder ("[image, description pending]"). What this module owes
// back is one countdown and one job:
//
//   enrichment_bundles.pending_count  −1 per enrichment that resolves
//                                      ↓
//   reaches 0  ──►  exactly ONE scoped re-understand job
//                   (work_queue: unit_kind 'bundle', stage 'understand',
//                    scoped to the episodes the bundle's events landed in)
//              ──►  UNLESS a placeholder forced an episode into `unsorted`:
//                   then the bundle RE-DISPATCHES FULLY (dispatched_at cleared,
//                   stream cursor pulled back) and the next window re-reads it
//                   with the enriched text in hand.
//
// Rules carried over from the V11 lane, still load-bearing (spec §4.4):
//
//   * Ready, failed and skipped ALL count as resolved. A voice note whose
//     transcription failed becomes "[voice note, unreadable]" and the
//     re-understand proceeds — one dead file must not strand a bundle forever.
//   * Exactly one job, not N. The bundle id and the work-queue id are both
//     deterministic, so landing on zero twice cannot produce a second pass.
//   * The salience gate (§8.4 table, V11) stays OFF by default: every final
//     enrichment triggers the completion. On, an enrichment carrying no
//     entity, date, number, price or commitment does not — a [CODE] check.
//
// The job's priority is the same enrichment key as everything else (tier ×
// horizon × recency), never insertion order.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  ATTACHMENT_COLUMNS,
  stateOf,
  type AttachmentRow,
} from "./enrichment-state.js";
import { workId } from "../db/work-queue.js";
import { enrichmentPriority, getEnrichmentSalienceGate } from "./batch.js";

// ---------------------------------------------------------------------------
// Salience gate (§8.4 table) — off by default, everything admits.
// ---------------------------------------------------------------------------

/** What the salience gate counts as material (§8.4 table), as one [CODE] test. */
const MATERIAL =
  /(\p{Lu}\p{L}+|\d|₹|\$|€|£|\b(will|shall|need|must|should|please|send|pay|book|call|meet)\b)/u;

/**
 * Does this enrichment's text justify the completion? With the gate off — the
 * default — everything does, which is the whole point of the default.
 */
export function salienceGateAdmits(text: string | null | undefined): boolean {
  if (!getEnrichmentSalienceGate()) return true;
  if (!text) return false;
  return MATERIAL.test(text);
}

// ---------------------------------------------------------------------------
// Registration — called when a bundle is handed to understanding.
// ---------------------------------------------------------------------------

/** Deterministic bundle id, so a re-register is an upsert and never a dup. */
function enrichmentBundleId(
  streamId: string,
  minRowid: number,
  maxRowid: number,
): string {
  return `eb:${streamId}:${minRowid}-${maxRowid}`;
}

export interface BundleRegistration {
  /** Null when nothing in the bundle was pending — no countdown to track. */
  bundleId: string | null;
  pending: number;
}

interface PendingProbeRow extends AttachmentRow {
  rowid: number;
}

function attachmentRows(eventIds: readonly string[]): PendingProbeRow[] {
  if (eventIds.length === 0) return [];
  const marks = eventIds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT rowid, ${ATTACHMENT_COLUMNS} FROM events WHERE id IN (${marks})`,
    )
    .all(...eventIds) as PendingProbeRow[];
}

function pendingCountOf(rows: readonly PendingProbeRow[]): number {
  let n = 0;
  for (const row of rows) if (stateOf(row) === "pending") n++;
  return n;
}

/**
 * Arm the countdown for one dispatched bundle (spec §4.4 rule 2). Counts the
 * member events whose enrichment is still `pending` (per the same §10.1
 * routing the queue itself reads by) and records the bundle when the count is
 * non-zero. A bundle with nothing pending records nothing: pass 1 already saw
 * every word.
 *
 * Idempotent: the id is deterministic over (stream, rowid range), so a re-run
 * of the same hand-off — or a later re-dispatch of the same events — never
 * creates a second countdown.
 */
export function registerBundleForEnrichment(bundle: {
  streamId: string;
  events: readonly { id: string }[];
}): BundleRegistration {
  const rows = attachmentRows(bundle.events.map((e) => e.id));
  if (rows.length === 0) return { bundleId: null, pending: 0 };
  const pending = pendingCountOf(rows);
  if (pending === 0) return { bundleId: null, pending: 0 };

  // O(n) reduce, never a spread: a hand-off can carry every attachment of a
  // large day and Math.min(...rowids) throws above ~100k of them (C6).
  let minRowid = Number.POSITIVE_INFINITY;
  let maxRowid = 0;
  for (const r of rows) {
    if (r.rowid < minRowid) minRowid = r.rowid;
    if (r.rowid > maxRowid) maxRowid = r.rowid;
  }
  if (!Number.isFinite(minRowid)) minRowid = 0;
  const id = enrichmentBundleId(bundle.streamId, minRowid, maxRowid);
  getDb()
    .prepare(
      `INSERT INTO enrichment_bundles
         (id, stream_id, event_ids_json, min_rowid, max_rowid, pending_count)
       VALUES (@id, @streamId, @eventIds, @minRowid, @maxRowid, @pending)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run({
      id,
      streamId: bundle.streamId,
      eventIds: JSON.stringify(rows.map((r) => r.id)),
      minRowid,
      maxRowid,
      pending,
    });
  return { bundleId: id, pending };
}

// ---------------------------------------------------------------------------
// Resolution — called by the media queue for every enrichment that lands.
// ---------------------------------------------------------------------------

export interface BundleResolution {
  bundleId: string;
  /** Enrichments still outstanding on that bundle after this one. */
  pending: number;
  action:
    | "waiting" // still counting down
    | "understand_enqueued" // zero → the one scoped re-understand job
    | "understand_exists" // zero again — the job was already there
    | "redispatched" // zero + placeholder forced unsorted → full re-dispatch
    | "gated"; // zero, but the salience gate held this text back
  /** Episodes the bundle's events landed in (the re-understand scope). */
  episodeIds: string[];
}

interface BundleRow {
  id: string;
  stream_id: string | null;
  event_ids_json: string;
  min_rowid: number;
  max_rowid: number;
  pending_count: number;
  status: string;
}

/**
 * The episodes this bundle's events landed in — the SCOPE of the re-understand
 * job (spec §4.4: "scoped to the affected episodes"). Membership is by range
 * rowids when the range rows carry them, by endpoint ids otherwise.
 */
export function affectedEpisodes(bundle: {
  streamId: string | null;
  eventIdsJson: string;
  minRowid: number;
  maxRowid: number;
}): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT ee.episode_id AS id
         FROM episode_events ee
         JOIN episodes ep ON ep.id = ee.episode_id
        WHERE ee.start_event_id IN (SELECT value FROM json_each(@ids))
           OR ee.end_event_id   IN (SELECT value FROM json_each(@ids))
           OR (ep.stream_id IS NOT NULL AND ep.stream_id = @streamId
               AND ee.start_rowid IS NOT NULL AND ee.end_rowid IS NOT NULL
               AND ee.start_rowid <= @maxRowid AND ee.end_rowid >= @minRowid)
        ORDER BY ee.episode_id`,
    )
    .all({
      ids: bundle.eventIdsJson,
      streamId: bundle.streamId,
      minRowid: bundle.minRowid,
      maxRowid: bundle.maxRowid,
    }) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Did a placeholder force any of these episodes into `unsorted` (still open)? */
function placeholderForcedUnsorted(episodeIds: readonly string[]): boolean {
  if (episodeIds.length === 0) return false;
  const marks = episodeIds.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT 1 AS hit FROM unsorted
        WHERE status = 'open' AND episode_id IN (${marks}) LIMIT 1`,
    )
    .get(...episodeIds) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * One enrichment finished — ready, failed or skipped, all three count as
 * resolved. Recompute every waiting bundle this event belongs to (recomputing
 * from `events.enrichment_state` rather than blind-decrementing makes a
 * double-settle of the same row harmless), and at zero act exactly once:
 * re-dispatch fully when a placeholder forced unsorted, else enqueue the one
 * scoped re-understand job.
 *
 * An event no bundle is waiting on (all-text bundle, or dispatch has not
 * happened yet) resolves to nothing: nobody is counting.
 */
export function resolveEnrichment(
  eventId: string,
  opts: { text?: string | null; now?: number } = {},
): BundleResolution[] {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const gated = !salienceGateAdmits(opts.text);

  const bundles = db
    .prepare(
      `SELECT id, stream_id, event_ids_json, min_rowid, max_rowid,
              pending_count, status
         FROM enrichment_bundles
        WHERE status = 'waiting'
          AND EXISTS (SELECT 1 FROM json_each(event_ids_json) WHERE value = ?)`,
    )
    .all(eventId) as BundleRow[];

  const out: BundleResolution[] = [];
  for (const bundle of bundles) {
    const eventIds = JSON.parse(bundle.event_ids_json) as string[];
    const pending = pendingCountOf(attachmentRows(eventIds));
    db.prepare(`UPDATE enrichment_bundles SET pending_count = ? WHERE id = ?`).run(
      pending,
      bundle.id,
    );
    if (pending > 0) {
      out.push({ bundleId: bundle.id, pending, action: "waiting", episodeIds: [] });
      continue;
    }
    if (gated) {
      out.push({ bundleId: bundle.id, pending, action: "gated", episodeIds: [] });
      continue;
    }

    const episodeIds = affectedEpisodes({
      streamId: bundle.stream_id,
      eventIdsJson: bundle.event_ids_json,
      minRowid: bundle.min_rowid,
      maxRowid: bundle.max_rowid,
    });

    if (placeholderForcedUnsorted(episodeIds)) {
      redispatchBundle(bundle, now);
      out.push({ bundleId: bundle.id, pending, action: "redispatched", episodeIds });
      continue;
    }

    const enqueued = enqueueUnderstandJob(bundle, now);
    db.prepare(
      `UPDATE enrichment_bundles
          SET status = 'understood', resolved_at = ?
        WHERE id = ?`,
    ).run(new Date(now).toISOString(), bundle.id);
    out.push({
      bundleId: bundle.id,
      pending,
      action: enqueued ? "understand_enqueued" : "understand_exists",
      episodeIds,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two completions.
// ---------------------------------------------------------------------------

/**
 * The one `work_queue` row the re-understand runs from: unit_kind 'bundle',
 * stage 'understand', at the same priority key as the enrichment lane itself
 * (§5.2/§9.2 — tier, then horizon, then recency; never insertion order).
 * Returns false when the row already exists — one job, not N.
 */
function enqueueUnderstandJob(bundle: BundleRow, now: number): boolean {
  const db = getDb();
  const id = workId("understand", "bundle", bundle.id);
  const existing = db.prepare(`SELECT id FROM work_queue WHERE id = ?`).get(id) as
    | { id: string }
    | undefined;
  if (existing) return false;

  const meta = db
    .prepare(
      `SELECT MAX(e.ts) AS ts, s.tier AS tier
         FROM events e
         LEFT JOIN streams s ON s.id = e.stream_id
        WHERE e.id IN (SELECT value FROM json_each(?))`,
    )
    .get(bundle.event_ids_json) as { ts: string | null; tier: string | null } | undefined;

  db.prepare(
    `INSERT INTO work_queue (id, unit_kind, unit_id, cohort_id, stage, priority, state)
     VALUES (@id, 'bundle', @unitId, NULL, 'understand', @priority, 'ready')`,
  ).run({
    id,
    unitId: bundle.id,
    priority: enrichmentPriority(
      { id: bundle.id, ts: meta?.ts ?? null, tier: meta?.tier ?? null },
      now,
    ),
  });
  return true;
}

/**
 * Placeholder→unsorted re-dispatch (spec §4.4 rule 2 last clause): the
 * placeholder was the reason filing declined, so a scoped re-read of the same
 * episodes would re-read the same failure. Clear the members' processed marks
 * and pull the stream cursor back — the next dispatch window rebuilds the
 * bundle from scratch, this time with the enrichment text in the events.
 *
 * Reversible like every mutation: one decisions row records the marks it
 * cleared (`old_json` is the restore payload).
 */
function redispatchBundle(bundle: BundleRow, now: number): void {
  const db = getDb();
  const prior = db
    .prepare(
      `SELECT id, dispatched_at FROM events
        WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(bundle.event_ids_json) as { id: string; dispatched_at: string | null }[];

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE events SET dispatched_at = NULL
        WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(bundle.event_ids_json);
    if (bundle.stream_id !== null) {
      db.prepare(
        `UPDATE streams SET cursor_rowid = MIN(cursor_rowid, ?) WHERE id = ?`,
      ).run(bundle.min_rowid - 1, bundle.stream_id);
    }
    db.prepare(
      `UPDATE enrichment_bundles
          SET status = 'redispatched', resolved_at = ?
        WHERE id = ?`,
    ).run(new Date(now).toISOString(), bundle.id);
    writeDecision({
      pass: "code:enrichment",
      targetKind: "bundle",
      targetId: bundle.id,
      action: "redispatch",
      old: { dispatched: prior },
      new: { dispatched: prior.map((p) => ({ id: p.id, dispatched_at: null })) },
      reason: "placeholder forced unsorted; bundle re-dispatches fully (spec §4.4)",
    });
  });
  run();
}
