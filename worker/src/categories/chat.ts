// ===========================================================================
// Chat Cat-1/Cat-2 identification — build P1.6, spec §5.1; eval CAT-01.
//
// CODE-FIRST, AND FOR CHATS CODE-ONLY. The §5.1 table:
//
//   Cat 1: DMs · groups the user EVER replied in · transactional business
//          (OTP/receipts/bookings)
//   Cat 2: never-replied groups · promotional business
//
// user-reply is pure code (a count of self messages); the business tx/promo
// split rides the ALREADY-CACHED one-time tier call (tiers/derive.ts, §9.3:
// T2 transactional / T4 promotional, decided once per channel and stored on
// `streams.tier`). This module therefore makes ZERO model calls of its own —
// CAT-01 asserts exactly that (`model-where-code-works` is its wrong[]).
//
// Safety (spec §5.1): misclassification costs latency, never data. Cat 2 is
// processed later + coarser (the Digest pass), never dropped; any engagement
// instantly promotes via ./promotion.ts.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";

export type StreamCategory = "cat1" | "cat2";

export interface ChatCategoryFacts {
  streamId: string;
  isGroup: boolean;
  isBusiness: boolean;
  /** streams.tier — the cached one-time business split (T2 tx / T4 promo). */
  tier: string | null;
  /** Messages the user themself ever sent into this stream. */
  userMessageCount: number;
}

export interface ChatCategoryDecision {
  category: StreamCategory;
  /** Stable rule id — asserted on, never prose. */
  rule:
    | "user-reply"
    | "dm"
    | "business-transactional"
    | "business-promotional"
    | "group-never-replied";
}

/**
 * The §5.1 chat table as a pure function. No model call exists on any path
 * through this function — the business split consumes the stored tier, whose
 * one cached call was paid at tier-assignment time (tiers/derive.ts).
 */
export function chatCategoryFor(facts: ChatCategoryFacts): ChatCategoryDecision {
  if (facts.userMessageCount > 0) return { category: "cat1", rule: "user-reply" };
  if (facts.isBusiness) {
    // T4 = promotional -> Cat 2. Everything else (T2, or the §12.11
    // "unsure -> tx" default) is transactional -> Cat 1: promo-in-cat1 is the
    // CAT-01 wrong[], but tx-in-cat2 would delay OTPs/receipts — and when the
    // cached call was unsure the cheap failure mode is the early one.
    if (facts.tier === "T4") return { category: "cat2", rule: "business-promotional" };
    return { category: "cat1", rule: "business-transactional" };
  }
  if (facts.isGroup) return { category: "cat2", rule: "group-never-replied" };
  return { category: "cat1", rule: "dm" };
}

// ---- boot backfill (production caller: worker/src/index.ts) ----------------

const GROUP_KINDS = new Set(["group", "channel", "community", "broadcast"]);

interface StreamRow {
  id: string;
  source_id: string;
  stream_kind: string | null;
  is_business: number;
  tier: string | null;
  category: string | null;
  reply_count: number;
  user_msgs: number;
}

export interface CategoryBackfillReport {
  streams: number;
  assigned: number;
  byCategory: Record<StreamCategory, number>;
  /** Streams whose stored category changed (each wrote a decisions row). */
  changes: { streamId: string; from: string | null; to: StreamCategory; rule: string }[];
}

/**
 * Assign `streams.category` for every non-browser stream. Browser streams get
 * their categories per-domain at the watcher boundary (adapters/browser,
 * P0.8) and are synced by `backfillBrowserStreamCategories` below.
 *
 * Idempotent; every change writes a decisions row (reversible via old_json).
 * A stream already promoted to cat1 by engagement is NEVER demoted here —
 * promotion is one-way (spec §5.1) and `user-reply` wins by construction
 * because reply_count > 0 forces cat1.
 */
export function backfillChatCategories(): CategoryBackfillReport {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.source_id, s.stream_kind, s.is_business, s.tier,
              s.category, s.reply_count,
              (SELECT COUNT(*) FROM events e
                LEFT JOIN actors a ON a.id = e.actor_id
                WHERE e.stream_id = s.id
                  AND e.kind IS NOT 'reaction'
                  AND (
                    e.actor = 'self'
                    OR (a.source_ext_id IS NOT NULL AND a.source_ext_id = (
                      SELECT value FROM app_state
                       WHERE key = 'source.' || e.source_id || '.self_identity'))
                  )) AS user_msgs
         FROM streams s
        WHERE s.source_id IS NOT 'browser'
        ORDER BY s.id`,
    )
    .all() as StreamRow[];

  const report: CategoryBackfillReport = {
    streams: rows.length,
    assigned: 0,
    byCategory: { cat1: 0, cat2: 0 },
    changes: [],
  };
  const update = db.prepare(`UPDATE streams SET category = ? WHERE id = ?`);

  for (const row of rows) {
    const decision = chatCategoryFor({
      streamId: row.id,
      isGroup: GROUP_KINDS.has((row.stream_kind ?? "").toLowerCase()),
      isBusiness: row.is_business === 1,
      tier: row.tier,
      userMessageCount: Math.max(row.user_msgs, row.reply_count),
    });
    // One-way: an engagement-promoted cat1 stream never demotes on re-derive.
    const target: StreamCategory =
      row.category === "cat1" ? "cat1" : decision.category;
    report.assigned += 1;
    report.byCategory[target] += 1;
    if (row.category !== target) {
      update.run(target, row.id);
      writeDecision({
        pass: "code:categories",
        targetKind: "stream",
        targetId: row.id,
        action: "categorize",
        old: { category: row.category },
        new: { category: target, rule: decision.rule },
        reason: `chat category by ${decision.rule} (spec §5.1, code-only)`,
      });
      report.changes.push({ streamId: row.id, from: row.category, to: target, rule: decision.rule });
    }
  }
  return report;
}

/**
 * Sync `streams.category` for browser streams from the per-domain verdicts
 * the watcher already stamped on each visit event (P0.8 heuristics + its one
 * cached cheap call for ambiguous domains — no new call is made here).
 * Any cat1 evidence wins ("ambiguous" orders as Cat 2: later, coarser,
 * never dropped).
 */
export function backfillBrowserStreamCategories(): CategoryBackfillReport {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.category,
              SUM(CASE WHEN json_extract(e.payload_json, '$.category') = 'cat1'
                       THEN 1 ELSE 0 END) AS cat1_events,
              COUNT(e.id) AS total
         FROM streams s
         JOIN events e ON e.stream_id = s.id
        WHERE s.source_id = 'browser'
        GROUP BY s.id`,
    )
    .all() as { id: string; category: string | null; cat1_events: number; total: number }[];

  const report: CategoryBackfillReport = {
    streams: rows.length,
    assigned: 0,
    byCategory: { cat1: 0, cat2: 0 },
    changes: [],
  };
  const update = db.prepare(`UPDATE streams SET category = ? WHERE id = ?`);
  for (const row of rows) {
    const derived: StreamCategory = row.cat1_events > 0 ? "cat1" : "cat2";
    const target: StreamCategory = row.category === "cat1" ? "cat1" : derived;
    report.assigned += 1;
    report.byCategory[target] += 1;
    if (row.category !== target) {
      update.run(target, row.id);
      writeDecision({
        pass: "code:categories",
        targetKind: "stream",
        targetId: row.id,
        action: "categorize",
        old: { category: row.category },
        new: { category: target, rule: "browser-domain-heuristics" },
        reason: "browser stream category from per-domain P0.8 verdicts (spec §5.1)",
      });
      report.changes.push({ streamId: row.id, from: row.category, to: target, rule: "browser-domain-heuristics" });
    }
  }
  return report;
}
