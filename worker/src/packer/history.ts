// ===========================================================================
// Thread history, episodes, roster, cross-source blocks (build P1.2, spec §6.4).
//
//   thread history  the last ~20–40 events of the SAME stream from the log,
//                   regardless of bundle/processing boundaries; ELASTIC — it
//                   extends to cover the open episode's last exchange; quoted/
//                   replied messages are ALWAYS fetched explicitly even when
//                   they fall outside the window.
//   episodes here   open + recently-dormant episodes of this stream (id,
//                   summary, last-active, space links).
//   roster          resolved identities + circles + engagement stats + tier —
//                   the packer half of the §7.2 resolution ladder.
//   cross-source    related episodes in OTHER streams reached via shared
//                   bridge keys (url/phone/email/order-id) and entities.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { BundleEvent } from "../scheduler/dispatch.js";

// ---------------------------------------------------------------------------
// Thread history
// ---------------------------------------------------------------------------

export interface HistoryEvent {
  rowid: number;
  id: string;
  ts: string | null;
  actor: string | null;
  text: string | null;
  /** true when fetched because a bundle event quotes/replies to it. */
  quoted?: boolean;
}

export const THREAD_HISTORY_MIN = 20;
export const THREAD_HISTORY_MAX = 40;

/**
 * The last ~20–40 stream events BEFORE the bundle, elastic to reach the open
 * episode's last exchange, plus every quoted/replied message the bundle
 * references (fetched explicitly, flagged `quoted`).
 */
export function threadHistory(
  streamId: string,
  bundleEvents: BundleEvent[],
  opts: { min?: number; max?: number } = {},
): HistoryEvent[] {
  const db = getDb();
  const min = opts.min ?? THREAD_HISTORY_MIN;
  const max = opts.max ?? THREAD_HISTORY_MAX;
  const firstBundleRowid = bundleEvents.reduce(
    (lo, e) => Math.min(lo, e.rowid),
    Number.MAX_SAFE_INTEGER,
  );

  // Elastic target: reach back to the open episode's last exchange when that
  // is further than `min` events, capped at `max`.
  let reachRowid = 0;
  const open = db
    .prepare(
      `SELECT ee.end_rowid AS r
         FROM episodes ep JOIN episode_events ee ON ee.episode_id = ep.id
        WHERE ep.stream_id = ? AND ep.state = 'open'
        ORDER BY ee.end_rowid DESC LIMIT 1`,
    )
    .get(streamId) as { r: number | null } | undefined;
  if (open && typeof open.r === "number") reachRowid = open.r;

  const rows = db
    .prepare(
      `SELECT rowid, id, ts, actor, text FROM events
        WHERE stream_id = ? AND rowid < ? AND revoked_at IS NULL
        ORDER BY rowid DESC LIMIT ?`,
    )
    .all(streamId, firstBundleRowid, max) as HistoryEvent[];
  rows.reverse();

  // Elastic trim: keep at least `min`, extend toward the open episode.
  let out = rows;
  if (rows.length > min) {
    const fromIdx = rows.findIndex((r) => r.rowid >= reachRowid);
    const start = Math.min(Math.max(0, fromIdx), rows.length - min);
    out = rows.slice(reachRowid > 0 ? start : rows.length - min);
  }

  // Quoted/replied messages: always fetched explicitly (spec §6.4.2). Reply
  // markers live both in the payload and in events.reply_to_external_id.
  const have = new Set(out.map((r) => r.id));
  const quotedIds = new Set<string>();
  for (const e of bundleEvents) {
    try {
      const p = JSON.parse(e.payloadJson ?? "{}") as Record<string, unknown>;
      for (const key of ["quote_id", "quoted_id", "reply_to", "quoted_event_id"]) {
        const v = p[key];
        if (typeof v === "string" && v.length > 0) quotedIds.add(v);
      }
    } catch {
      /* skip */
    }
  }
  if (bundleEvents.length > 0) {
    const bph = bundleEvents.map(() => "?").join(",");
    const replies = db
      .prepare(
        `SELECT reply_to_external_id AS r FROM events
          WHERE id IN (${bph}) AND reply_to_external_id IS NOT NULL`,
      )
      .all(...bundleEvents.map((e) => e.id)) as { r: string }[];
    for (const r of replies) if (r.r) quotedIds.add(r.r);
  }
  if (quotedIds.size > 0) {
    const ids = [...quotedIds];
    const ph = ids.map(() => "?").join(",");
    const quoted = db
      .prepare(
        `SELECT rowid, id, ts, actor, text FROM events
          WHERE (id IN (${ph})
                 OR json_extract(payload_json, '$.external_id') IN (${ph})
                 OR external_id IN (${ph}))
            AND revoked_at IS NULL`,
      )
      .all(...ids, ...ids, ...ids) as HistoryEvent[];
    for (const q of quoted) {
      if (!have.has(q.id)) {
        have.add(q.id);
        out.push({ ...q, quoted: true });
      }
    }
    out.sort((a, b) => a.rowid - b.rowid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Episodes of this stream
// ---------------------------------------------------------------------------

export interface EpisodeSummary {
  id: string;
  state: string;
  summary: string | null;
  lastTs: string | null;
  spaceId: string | null;
  spaceLabel: string | null;
  streamKey?: string | null;
}

export function streamEpisodes(
  streamId: string,
  opts: { limit?: number; dormantWithinDays?: number; nowMs?: number } = {},
): EpisodeSummary[] {
  const nowMs = opts.nowMs ?? Date.now();
  const dormantCutoff = new Date(
    nowMs - (opts.dormantWithinDays ?? 14) * 86_400_000,
  ).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT ep.id, ep.state, ep.summary, ep.last_ts, ep.space_id, sp.label AS space_label
         FROM episodes ep LEFT JOIN spaces sp ON sp.id = ep.space_id
        WHERE ep.stream_id = ?
          AND (ep.state = 'open'
               OR (ep.state = 'dormant' AND COALESCE(ep.last_ts, ep.updated_at, ep.created_at) >= ?))
        ORDER BY ep.state = 'open' DESC, ep.last_ts DESC
        LIMIT ?`,
    )
    .all(streamId, dormantCutoff, opts.limit ?? 6) as {
    id: string;
    state: string;
    summary: string | null;
    last_ts: string | null;
    space_id: string | null;
    space_label: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    summary: r.summary,
    lastTs: r.last_ts,
    spaceId: r.space_id,
    spaceLabel: r.space_label,
  }));
}

// ---------------------------------------------------------------------------
// Cross-source related episodes (via bridges + entities)
// ---------------------------------------------------------------------------

export function crossSourceEpisodes(
  streamId: string,
  bundleEvents: BundleEvent[],
  opts: { limit?: number } = {},
): EpisodeSummary[] {
  const db = getDb();
  const eventIds = bundleEvents.map((e) => e.id);
  if (eventIds.length === 0) return [];
  const ph = eventIds.map(() => "?").join(",");
  // Bundle bridge keys -> other events holding the same key -> their episodes.
  const rows = db
    .prepare(
      `SELECT DISTINCT ep.id, ep.state, ep.summary, ep.last_ts, ep.space_id,
              sp.label AS space_label, st.external_key AS stream_key
         FROM event_bridge_keys mine
         JOIN event_bridge_keys other
           ON other.kind = mine.kind AND other.value_norm = mine.value_norm
          AND other.event_id NOT IN (${ph})
         JOIN episode_events ee
           ON ee.start_event_id = other.event_id OR ee.end_event_id = other.event_id
         JOIN episodes ep ON ep.id = ee.episode_id AND ep.stream_id != ?
         LEFT JOIN spaces sp ON sp.id = ep.space_id
         LEFT JOIN streams st ON st.id = ep.stream_id
        WHERE mine.event_id IN (${ph})
        ORDER BY ep.last_ts DESC LIMIT ?`,
    )
    .all(...eventIds, streamId, ...eventIds, opts.limit ?? 4) as {
    id: string;
    state: string;
    summary: string | null;
    last_ts: string | null;
    space_id: string | null;
    space_label: string | null;
    stream_key: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    summary: r.summary,
    lastTs: r.last_ts,
    spaceId: r.space_id,
    spaceLabel: r.space_label,
    streamKey: r.stream_key,
  }));
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface RosterEntry {
  ref: string;
  name: string;
  circle: string | null;
  provisional: boolean;
}

export interface StreamContext {
  streamId: string;
  streamKey: string;
  label: string | null;
  kind: string | null;
  tier: string | null;
  category: string | null;
  engagementScore: number;
  replyCount: number;
  roster: RosterEntry[];
}

/** Roster + stream facts (identities, circles, engagement stats, tier). */
export function streamContext(streamId: string): StreamContext | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, external_key, label, stream_kind, tier, category,
              engagement_score, reply_count, participant_entity_ids
         FROM streams WHERE id = ?`,
    )
    .get(streamId) as
    | {
        id: string;
        external_key: string;
        label: string | null;
        stream_kind: string | null;
        tier: string | null;
        category: string | null;
        engagement_score: number;
        reply_count: number;
        participant_entity_ids: string | null;
      }
    | undefined;
  if (!row) return null;

  let participantIds: string[] = [];
  try {
    const parsed = JSON.parse(row.participant_entity_ids ?? "[]");
    if (Array.isArray(parsed)) {
      participantIds = parsed.filter((p): p is string => typeof p === "string");
    }
  } catch {
    /* none */
  }

  let roster: RosterEntry[] = [];
  if (participantIds.length > 0) {
    const ph = participantIds.map(() => "?").join(",");
    const entities = db
      .prepare(
        `SELECT id, canonical, circle, provisional FROM entities
          WHERE id IN (${ph}) AND merged_into IS NULL`,
      )
      .all(...participantIds) as {
      id: string;
      canonical: string;
      circle: string | null;
      provisional: number;
    }[];
    roster = entities.map((e) => ({
      ref: e.id,
      name: e.canonical,
      circle: e.circle,
      provisional: e.provisional === 1,
    }));
  }

  return {
    streamId: row.id,
    streamKey: row.external_key,
    label: row.label,
    kind: row.stream_kind,
    tier: row.tier,
    category: row.category,
    engagementScore: row.engagement_score,
    replyCount: row.reply_count,
    roster,
  };
}
