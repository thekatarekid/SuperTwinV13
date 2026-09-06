// ===========================================================================
// Engagement -> instant Cat-2 -> Cat-1 promotion — build P1.6, spec §5.1;
// eval CAT-03.
//
// "Any engagement (reply, click, save) INSTANTLY promotes the stream to
//  Cat 1 with retroactive full processing." The failure mode this file
// exists to kill is the CAT-03 `caste-system`: a stream stuck in Cat 2
// despite the user engaging with it.
//
// Promotion is a RE-QUEUE, never a hand-off (the tier lane learned this the
// hard way — tiers/derive.ts rule 3): the stream's already-digested backfill
// events get their processed mark cleared and the cursor rewinds to 0, so the
// next dispatch window re-bundles the full history through the full passes.
// Nothing is deleted, nothing is skipped; misclassification cost latency,
// never data.
//
// Every promotion writes a decisions row (logged + reversible, spec §5.1 /
// build convention 1.4) — `old_json` carries the pre-promotion state.
//
// Production callers: db/eventlog.ts (v13 single-writer append) and
// db/ingest.ts (the WhatsApp writer) call noteUserReply() for every event
// whose envelope actor is "self".
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { promoteOnEngagement } from "../tiers/promote.js";

const DAY_MS = 86_400_000;
/** Recency half-life of the engagement score, days (ordering signal only). */
export const ENGAGEMENT_HALF_LIFE_DAYS = 30;

/**
 * Recency-weighted user-reply frequency (spec §5.2) — an ORDERING signal
 * only, never relationship value. reply_count decayed by a 30-day half-life
 * on the last reply.
 */
export function engagementScore(
  replyCount: number,
  lastReplyTs: string | null,
  nowMs: number = Date.now(),
): number {
  if (replyCount <= 0) return 0;
  const last = lastReplyTs ? Date.parse(lastReplyTs) : NaN;
  const ageDays = Number.isFinite(last) ? Math.max(0, nowMs - last) / DAY_MS : 0;
  return replyCount * Math.pow(0.5, ageDays / ENGAGEMENT_HALF_LIFE_DAYS);
}

export interface EngagementReport {
  streamId: string;
  /** true when this reply flipped a Cat-2 stream to Cat 1. */
  promoted: boolean;
  /** Backfill events re-queued for retroactive full processing. */
  requeued: number;
  replyCount: number;
  engagementScore: number;
  /**
   * V6 tier promotion (tiers/promote.ts, S3.8): true when this engagement
   * flipped the stream's TIER to 1 — instantly, with its digested history
   * re-queued (counted in `requeued`).
   */
  tierPromoted: boolean;
}

interface StreamRow {
  id: string;
  category: string | null;
  reply_count: number;
  last_user_reply_ts: string | null;
  cursor_rowid: number;
}

/**
 * Record one user engagement (a reply) on a stream: bump the reply counters
 * and the engagement score, and — if the stream sat in Cat 2 — promote it
 * IMMEDIATELY with retroactive full processing (CAT-03).
 */
export function noteUserReply(
  streamId: string,
  ts: string,
  nowMs: number = Date.now(),
): EngagementReport {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, category, reply_count, last_user_reply_ts, cursor_rowid
         FROM streams WHERE id = ?`,
    )
    .get(streamId) as StreamRow | undefined;
  if (!row) {
    return { streamId, promoted: false, requeued: 0, replyCount: 0, engagementScore: 0, tierPromoted: false };
  }

  const replyCount = row.reply_count + 1;
  const lastReply =
    row.last_user_reply_ts && row.last_user_reply_ts > ts ? row.last_user_reply_ts : ts;
  const score = engagementScore(replyCount, lastReply, nowMs);

  let promoted = false;
  let requeued = 0;
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE streams
          SET reply_count = ?, last_user_reply_ts = ?, engagement_score = ?
        WHERE id = ?`,
    ).run(replyCount, lastReply, score, streamId);

    if (row.category === "cat2") {
      promoted = true;
      // Retroactive full processing: clear the processed mark on everything
      // this stream only ever saw at Digest granularity and rewind the
      // cursor, so collectTick re-bundles the history for the full passes.
      const res = db
        .prepare(
          `UPDATE events SET dispatched_at = NULL
            WHERE stream_id = ? AND dispatched_at IS NOT NULL AND origin = 'backfill'`,
        )
        .run(streamId);
      requeued = res.changes;
      db.prepare(`UPDATE streams SET category = 'cat1', cursor_rowid = 0 WHERE id = ?`).run(
        streamId,
      );
      // The promotion is LOGGED (CAT-03) and reversible: old_json restores.
      writeDecision({
        pass: "code:promotion",
        targetKind: "stream",
        targetId: streamId,
        action: "promote",
        old: { category: "cat2", cursor_rowid: row.cursor_rowid },
        new: { category: "cat1", cursor_rowid: 0, requeued },
        reason: `user engagement at ${ts} promotes Cat 2 -> Cat 1 with retroactive full processing (spec §5.1)`,
      });
    }
  });
  run();

  // V6 tiers (Product_V6 §11.1, P1 §5.3; S3.8, TIER-04): the same engagement
  // promotes the stream's TIER to 1 — instantly (before the dispatcher's next
  // tick reads streams.tier) and retroactively (its digest-only history is
  // re-queued through the S1.2 widening replay). Idempotent at tier 1.
  const tier = promoteOnEngagement(streamId, ts, nowMs);

  return {
    streamId,
    promoted,
    requeued: requeued + tier.requeued,
    replyCount,
    engagementScore: score,
    tierPromoted: tier.promoted,
  };
}

/**
 * Best-effort hook for the event writers: given the envelopes just appended,
 * record an engagement for every self-authored message. Never throws — an
 * engagement-stat failure must not unwind an append that committed.
 */
export function noteSelfAuthoredEvents(
  events: readonly { source: string; streamKey: string; actor: string; ts: string }[],
  nowMs: number = Date.now(),
): void {
  for (const e of events) {
    if (e.actor !== "self") continue;
    try {
      noteUserReply(`${e.source}:st:${e.streamKey}`, e.ts, nowMs);
    } catch (err) {
      console.error("[categories] engagement note failed (continuing):", err);
    }
  }
}
