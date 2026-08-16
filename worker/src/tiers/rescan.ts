// ===========================================================================
// [CODE] The tier-change re-scan — arch §9.3 rule 3, build item 1.2.
//
// ⚠ THE DEFECT THIS FILE EXISTS FOR. When a user replies in a group for the
// first time the stream moves T3 -> T1. In the prior system that exact
// transition permanently lost 10 real scheduling messages in a 16-minute run:
// the events sat below the destination lane's watermark and became
// unreachable by every lane.
//
// The rule, from the doc: on any tier change, RE-ENQUEUE the stream's
// unprocessed events at the new tier's priority, and NEVER move a watermark
// backwards. A tier change is a re-scan, not a hand-off.
//
// Both halves are enforced here rather than assumed:
//
//   * `enqueueStreamEvents` walks the stream's pending events and writes a
//     `work_queue` row per lane-entry stage at the new priority, then
//     `orphanedEvents` counts what is left with nowhere to be picked up from.
//     That count is gate `tiers_no_orphans_on_promotion`, and it is a query,
//     not a comment.
//   * `rescanOnTierChange` touches no watermark at all — the strongest form of
//     "never backwards" available — and reports both cursors before and after
//     so the caller can assert the direction instead of trusting it.
//
// The stages enqueued do not depend on the tier (§9.3 rule 1). A T4 channel's
// real bill is enqueued for exactly the same work as a T1 conversation's
// message; the tier changes the number the queue sorts by, and nothing else.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { readWatermark, type Watermark } from "../db/watermarks.js";
import { computePriority, horizonFor, isTier, type Tier } from "./priority.js";

/**
 * The stored tier, read straight off the column. Deliberately a local read
 * rather than an import from ./derive.js: the re-scan is what tier assignment
 * calls, so the dependency runs one way only.
 */
function storedTier(streamId: string): Tier | null {
  const row = getDb().prepare(`SELECT tier FROM streams WHERE id = ?`).get(streamId) as
    | { tier: string | null }
    | undefined;
  return row && isTier(row.tier) ? row.tier : null;
}

// ---- the work queue --------------------------------------------------------

/**
 * Lane E's entry stage and Lane U's (§9.4). BOTH, always — the two lanes are
 * independent and a re-scan that re-enqueued only one of them would strand the
 * other exactly as thoroughly as enqueueing neither.
 */
export const LANE_ENTRY_STAGES = ["enrich", "entity"] as const;

interface PendingEvent {
  id: string;
  ts: string | null;
}

/**
 * Events of this stream that still have work to do: everything except the ones
 * whose lane-entry rows are all `done`. An event with no row at all counts —
 * that is precisely the event the prior build lost.
 */
export function pendingEvents(streamId: string): PendingEvent[] {
  return getDb()
    .prepare(
      `SELECT e.id AS id, e.ts AS ts
         FROM events e
        WHERE e.stream_id = ?
          AND e.kind IS NOT 'reaction'
          AND (
            SELECT COUNT(*) FROM work_queue w
             WHERE w.unit_kind = 'event' AND w.unit_id = e.id
               AND w.stage IN (${LANE_ENTRY_STAGES.map(() => "?").join(",")})
               AND w.state = 'done'
          ) < ${LANE_ENTRY_STAGES.length}
        ORDER BY e.ts DESC, e.id DESC`,
    )
    .all(streamId, ...LANE_ENTRY_STAGES) as PendingEvent[];
}

export interface EnqueueReport {
  streamId: string;
  tier: Tier;
  inserted: number;
  repriced: number;
  events: number;
  /** Events left with no ready row afterwards. Must be 0. */
  orphans: string[];
  /** Event id -> the priority its rows now carry. */
  priorities: Record<string, number>;
}

/**
 * Enqueue (or reprice) every pending event of a stream at its tier's priority.
 *
 * The SAME stages are enqueued whatever the tier — §9.3 rule 1. A T4 channel's
 * bill goes through `enrich` and `entity` exactly like a T1 message; the only
 * thing the tier changes is the number the queue sorts by.
 *
 * An already-done row is left alone. Repricing one would be the second half of
 * the orphaning defect: work that was finished coming back as work that is
 * pending.
 */
export function enqueueStreamEvents(
  streamId: string,
  options: { now?: number; tier?: Tier } = {},
): EnqueueReport {
  const now = options.now ?? Date.now();
  const tier = options.tier ?? storedTier(streamId);
  if (!tier) {
    throw new Error(`enqueueStreamEvents(${streamId}): the stream has no tier — run the backfill first`);
  }
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO work_queue (id, unit_kind, unit_id, cohort_id, stage, priority, state)
     VALUES (@id, 'event', @unitId, NULL, @stage, @priority, 'ready')
     ON CONFLICT(id) DO UPDATE SET
       priority = excluded.priority,
       -- Finished work stays finished and in-flight work is not restarted;
       -- everything else becomes ready again at the new number. Repricing a
       -- running row is harmless, resetting one is not.
       state = CASE WHEN work_queue.state IN ('done', 'running') THEN work_queue.state ELSE 'ready' END`,
  );
  const existing = db.prepare(
    `SELECT state FROM work_queue WHERE id = ?`,
  );

  const report: EnqueueReport = {
    streamId,
    tier,
    inserted: 0,
    repriced: 0,
    events: 0,
    orphans: [],
    priorities: {},
  };

  for (const event of pendingEvents(streamId)) {
    report.events += 1;
    const ts = event.ts ?? new Date(now).toISOString();
    const priority = computePriority({ tier, horizon: horizonFor(ts, now), ts, now });
    report.priorities[event.id] = priority;
    for (const stage of LANE_ENTRY_STAGES) {
      const id = `wq:${stage}:${event.id}`;
      const before = existing.get(id) as { state: string } | undefined;
      if (before?.state === "done") continue;
      upsert.run({ id, unitId: event.id, stage, priority });
      if (before) report.repriced += 1;
      else report.inserted += 1;
    }
  }

  report.orphans = orphanedEvents(streamId);
  return report;
}

/** The states from which a lane will still reach a queued unit. */
const REACHABLE_STATES = ["ready", "running", "done"] as const;

/**
 * Events with work left and no row a lane can reach them from — the 10 lost
 * messages, counted. Gate `tiers_no_orphans_on_promotion` reads this.
 *
 * "Reachable" is the operative word: a missing row orphans an event, and so
 * does a row parked in a state nothing dequeues. The prior build's events were
 * lost the second way round (below a watermark), which is why this asks about
 * reachability rather than existence.
 */
export function orphanedEvents(streamId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT e.id AS id
           FROM events e
          WHERE e.stream_id = ?
            AND e.kind IS NOT 'reaction'
            AND EXISTS (
              SELECT 1 FROM (${LANE_ENTRY_STAGES.map(() => "SELECT ? AS stage").join(" UNION ALL ")}) s
               WHERE NOT EXISTS (
                 SELECT 1 FROM work_queue w
                  WHERE w.unit_kind = 'event' AND w.unit_id = e.id AND w.stage = s.stage
                    AND w.state IN (${REACHABLE_STATES.map(() => "?").join(",")})
               )
            )
          ORDER BY e.id`,
      )
      .all(streamId, ...LANE_ENTRY_STAGES, ...REACHABLE_STATES) as { id: string }[]
  ).map((r) => r.id);
}

// ---- the tier-change re-scan (§9.3 rule 3) ---------------------------------

export interface RescanReport {
  streamId: string;
  from: Tier | null;
  to: Tier;
  requeued: string[];
  enqueue: EnqueueReport;
  orphans: string[];
  watermarkBefore: Watermark | null;
  watermarkAfter: Watermark | null;
  /** "same" | "up" | "down" per cursor. A promotion must never say "down". */
  liveDirection: string;
  backfillDirection: string;
  watermarkRegressions: string[];
}

function direction(before: string | null | undefined, after: string | null | undefined): string {
  const a = before ?? null;
  const b = after ?? null;
  if (a === null && b === null) return "same";
  if (a === null) return "set";
  if (b === null) return "cleared";
  if (b > a) return "up";
  if (b < a) return "down";
  return "same";
}

/**
 * A tier change is a RE-SCAN, not a hand-off (§9.3 rule 3).
 *
 * The stream's unprocessed events are re-enqueued at the NEW tier's priority,
 * and the watermarks are not touched at all — which is the strongest form of
 * "never move a watermark backwards" available: there is no write to get
 * wrong. The report carries the before/after cursors anyway, because the rule
 * is worth asserting rather than trusting.
 */
export function rescanOnTierChange(
  streamId: string,
  change: { from: Tier | null; to: Tier; now?: number },
): RescanReport {
  const before = readWatermark(streamId);
  const enqueue = enqueueStreamEvents(streamId, { now: change.now, tier: change.to });
  const after = readWatermark(streamId);

  const liveDirection = direction(before?.live_high_ts, after?.live_high_ts);
  const backfillDirection = direction(before?.backfill_low_ts, after?.backfill_low_ts);
  const regressions: string[] = [];
  // The live head only ever moves forward and the backfill floor only ever
  // moves down; anything else is the defect, named.
  if (liveDirection === "down" || liveDirection === "cleared") regressions.push("live_high_ts");
  if (backfillDirection === "up" || backfillDirection === "cleared") regressions.push("backfill_low_ts");

  return {
    streamId,
    from: change.from,
    to: change.to,
    requeued: Object.keys(enqueue.priorities),
    enqueue,
    orphans: enqueue.orphans,
    watermarkBefore: before,
    watermarkAfter: after,
    liveDirection,
    backfillDirection,
    watermarkRegressions: regressions,
  };
}
