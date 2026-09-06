// ===========================================================================
// [CODE] Tier promotion — instant and retroactive (Product_V6 §11.1 rule 1,
// P1 §5.3; build S3.8; eval TIER-04).
//
// "Any engagement promotes a stream: a reply, a click, a save, a reaction.
//  Promotion is instant and retroactive: the stream's history is re-processed
//  at the new tier."
//
//   INSTANT      the tier flips inside the writer's own call (categories/
//                promotion.ts → promoteOnEngagement), before the dispatcher's
//                next tick reads the row — so the engaging message itself is
//                gated as tier 1.
//   RETROACTIVE  everything the stream was only ever digested (tier 3) or
//                index-stamped (tier 4) gets its processed mark cleared and
//                becomes history-lane work again. This is the S1.2 widening
//                replay, re-used: the same chunked, resumable UPDATE
//                (`dispatched_at = NULL, origin = 'backfill'`), the same
//                predicate-on-the-row's-own-state so a kill between chunks
//                loses nothing. Archive rows (outside the UNDERSTAND window)
//                are never touched — consent still bounds what is understood.
//
// Nothing is deleted; misclassification cost latency, never data (§11.1 rule 3).
// Every promotion writes a decisions row with old/new so it is reversible.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { flipInChunks, REPLAY_CHUNK } from "../db/consent-gate.js";
import { writeDecision } from "../db/decisions.js";
import { assignTier, readTier } from "./derive.js";
import type { Tier } from "./priority.js";

/** 1 is the most urgent tier; null (unassigned) ranks after everything. */
export function tierRank(tier: Tier | null): number {
  if (!tier) return 5;
  return Number(tier.slice(1));
}

export interface RequeueReport {
  streamId: string;
  /** Stamped rows flipped back onto the dispatch path. */
  requeued: number;
  chunks: number;
}

/**
 * Re-queue a stream's already-processed history: every stamped, unrevoked,
 * non-archive row loses its processed mark and becomes backfill (so the history
 * lane, not the live gate, picks it up). Chunked and resumable exactly like
 * consent-gate.replayArchive. The stream cursor rewinds so collectTick sees it
 * all again.
 */
export function requeueStreamHistory(
  streamId: string,
  opts: { chunk?: number; maxChunks?: number; nowMs?: number } = {},
): RequeueReport {
  const db = getDb();
  const flip = db.prepare(
    `UPDATE events
        SET dispatched_at = NULL, origin = 'backfill', is_historical = 1
      WHERE rowid IN (
        SELECT rowid FROM events
         WHERE stream_id = ?
           AND dispatched_at IS NOT NULL
           AND origin <> 'archive'
           AND revoked_at IS NULL
         ORDER BY ts DESC
         LIMIT ?)`,
  );
  const { flipped, chunks } = flipInChunks(flip, [streamId], { chunk: opts.chunk ?? REPLAY_CHUNK, maxChunks: opts.maxChunks });
  if (flipped > 0) db.prepare(`UPDATE streams SET cursor_rowid = 0 WHERE id = ?`).run(streamId);
  return { streamId, requeued: flipped, chunks };
}

/** Rows of the stream still stamped and eligible for a re-queue (0 after a complete one). */
export function pendingRequeueCount(streamId: string): number {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE stream_id = ? AND dispatched_at IS NOT NULL AND origin <> 'archive' AND revoked_at IS NULL`,
    )
    .get(streamId) as { n: number };
  return r.n;
}

export interface PromotionReport {
  streamId: string;
  promoted: boolean;
  from: Tier | null;
  to: Tier;
  requeued: number;
  decisionId: string | null;
}

/**
 * The user engaged with the stream (wrote into it, reacted in it): tier 1, now,
 * and its history re-queued. Idempotent — a stream already at tier 1 is left
 * alone and nothing is re-queued.
 */
export function promoteOnEngagement(
  streamId: string,
  ts: string,
  nowMs: number = Date.now(),
): PromotionReport {
  const from = readTier(streamId);
  if (from === "T1") return { streamId, promoted: false, from, to: "T1", requeued: 0, decisionId: null };
  const exists = getDb().prepare(`SELECT 1 FROM streams WHERE id = ?`).get(streamId);
  if (!exists) return { streamId, promoted: false, from, to: "T1", requeued: 0, decisionId: null };

  let requeued = 0;
  let decisionId: string | null = null;
  const run = getDb().transaction(() => {
    assignTier(streamId, {
      tier: "T1",
      rule: "engaged_promotion",
      source: "code",
      confidence: null,
      reason: `the user engaged at ${ts}; any engagement promotes to tier 1 (Product_V6 §11.1)`,
      needsModel: false,
    });
    // A stream that never had a tier has nothing stamped at a coarser
    // granularity; a T2/T3/T4 one may — re-queue it all, chunked.
    if (from !== null) requeued = requeueStreamHistory(streamId, { nowMs }).requeued;
    decisionId = writeDecision({
      pass: "code:tier-promotion",
      targetKind: "stream",
      targetId: streamId,
      action: "promote",
      old: { tier: from },
      new: { tier: "T1", requeued, engaged_at: ts },
      reason: `engagement at ${ts} promotes ${from ?? "untiered"} → T1, instantly and retroactively (${requeued} stamped rows re-queued)`,
    });
  });
  run();
  return { streamId, promoted: true, from, to: "T1", requeued, decisionId };
}
