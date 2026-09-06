// ===========================================================================
// [CODE] THE definition of "understood" — V6 P1 FIX-C5.
//
// WHAT WENT WRONG. `events.dispatched_at` carried two unrelated meanings and
// every "understood" number in the product was reading the wrong one.
//
//   MEANING 1 (the dispatcher's): "no lane will look at this row again". The
//     consent gate stamps rows OUTSIDE the Understand window with
//     origin='archive' AND dispatched_at = capture_ts precisely so the lane
//     builders — all of which select `dispatched_at IS NULL` — skip them by
//     construction (db/consent-gate.ts). An archive row is therefore
//     "dispatched" without ever having been near a model.
//
//   MEANING 2 (the user's): "the twin has read this".
//
//   freshness/index.ts defined understood_from/to/count as
//   `dispatched_at IS NOT NULL` — meaning 1 — so on the reporting user's live
//   home it counted all 112,041 archive rows as understood: browser
//   understood_count 16,596 against 632 events that actually carry an episode,
//   understood_from 2010-09-27 (an archive row from a browser-history import),
//   and the header chip "Knows you: 2010 → 2h ago". The Library's Storage
//   panel used a SECOND, different wrong definition (origin <> 'archive' —
//   "inside the Understand window", i.e. what we INTEND to understand) and
//   published 12,120. Two surfaces, two fictions, 12x and 26x high, neither
//   measuring understanding, and no way for the user to tell that the pipeline
//   had been hard-stopped for an hour.
//
// THE DEFINITION. An event is understood when it is a member of an episode:
// a row in `episode_events` with `event_id` set (db/v6core.addEpisodeEvents,
// written by the commit path when a pass produced an episode that cites it).
// Not "dispatched" — a dispatched bundle can fail, dead-letter or produce
// nothing, and none of those taught the twin anything. Membership is the one
// fact that cannot be true while the model has said nothing.
//
// Archive rows are excluded explicitly. They cannot have an episode by
// construction, and the belt-and-braces predicate makes the exclusion
// something a test can pin rather than an invariant someone can quietly break.
//
// ONE definition, TWO surfaces: freshness/index.ts (the chip and the Library's
// per-source panel) and library/storage.ts (the Storage bar) both call in
// here, so they can no longer disagree.
//
// Zero model calls. The scan is over `episode_events` — small, and indexed on
// event_id (idx_episode_events_event, 0200) — with primary-key lookups into
// `events`; measured at 0.2 s over the reporting user's 124k-row log.
// ===========================================================================

import { getDb } from "../db/connection.js";

/** One source's understood tier: how much, over what span, at what size. */
export interface UnderstoodTier {
  /** Distinct events that are a member of at least one episode. */
  events: number;
  /** Stored bytes for those rows; 0 unless the caller asked for a byte sum. */
  bytes: number;
  /** Oldest / newest `ts` among them — the real edges of "Knows you". */
  from: string | null;
  to: string | null;
}

export const EMPTY_UNDERSTOOD: Readonly<UnderstoodTier> = Object.freeze({
  events: 0,
  bytes: 0,
  from: null,
  to: null,
});

/**
 * The membership predicate, as SQL, so both call sites share the exact same
 * rows. `m` is the distinct member set, `e` the event, `a` its archive row —
 * a caller passing a byte expression writes it against those aliases.
 */
const UNDERSTOOD_FROM = `
  FROM (SELECT DISTINCT event_id AS id FROM episode_events WHERE event_id IS NOT NULL) m
  JOIN events e ON e.id = m.id
  LEFT JOIN archive a ON a.event_id = e.id
 WHERE COALESCE(e.origin, '') <> 'archive'`;

interface Row {
  source: string;
  events: number;
  bytes: number | null;
  from: string | null;
  to: string | null;
}

/**
 * Every source's understood tier, in one pass.
 *
 * `bytesExpr` is an OPTIONAL SQL expression over the `e` / `a` aliases above
 * (library/storage.ts passes its `rowBytes()` so the Storage bar can size the
 * tier). It is code, never user input — there is no path from a request to
 * this argument. Omit it and the byte sum is skipped entirely.
 */
export function understoodBySource(bytesExpr?: string): Map<string, UnderstoodTier> {
  const bytes = bytesExpr ? `SUM(${bytesExpr})` : `0`;
  const rows = getDb()
    .prepare(
      `SELECT e.source_type AS source,
              COUNT(*) AS events,
              ${bytes} AS bytes,
              MIN(e.ts) AS "from", MAX(e.ts) AS "to"
       ${UNDERSTOOD_FROM}
       GROUP BY e.source_type`,
    )
    .all() as Row[];
  return new Map(rows.map((r) => [r.source, toTier(r)]));
}

/** One source's understood tier. Same predicate, narrowed to the source. */
export function understoodForSource(source: string, bytesExpr?: string): UnderstoodTier {
  const bytes = bytesExpr ? `SUM(${bytesExpr})` : `0`;
  const r = getDb()
    .prepare(
      `SELECT e.source_type AS source,
              COUNT(*) AS events,
              ${bytes} AS bytes,
              MIN(e.ts) AS "from", MAX(e.ts) AS "to"
       ${UNDERSTOOD_FROM}
         AND e.source_type = ?`,
    )
    .get(source) as Row | undefined;
  return r ? toTier(r) : { ...EMPTY_UNDERSTOOD };
}

function toTier(r: Row): UnderstoodTier {
  return { events: r.events ?? 0, bytes: r.bytes ?? 0, from: r.from, to: r.to };
}
