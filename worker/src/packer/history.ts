// ===========================================================================
// Thread history, episodes, cross-source episodes (V6 P1 S3.2; Build §6.1;
// Product_V6_Phase1 §7.2; PCK-03, PCK-04).
//
//   thread history  EPISODE-BOUNDED, never a fixed last-N: every event of the
//                   stream's open episode (explicit membership, S3.1) plus a
//                   short run-up before it — or, with no open episode, the
//                   run-up before the bundle. Quoted / replied messages are
//                   ALWAYS fetched explicitly, however old (PCK-04). Bundle
//                   events are never history.
//   episodes        open + recently-dormant episodes of a stream (id, summary,
//                   state, last-active, space link).
//   cross-source    related episodes in OTHER streams reached via shared
//                   bridge keys — the entity half of `[BRIDGED]`.
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
  sourceId: string | null;
  kind: string | null;
  payloadJson: string | null;
  /** true when fetched because a bundle event quotes/replies to it. */
  quoted?: boolean;
  /** true when a member of the stream's open episode. */
  inEpisode?: boolean;
}

/** Run-up events before the open episode (or before the bundle). */
export const HISTORY_RUN_UP = 6;
/** Soft character budget per stream's history block (Product P1 §7.2). */
export const HISTORY_CHARS_PER_STREAM = 1_500;
/** Streams that get a history block. */
export const HISTORY_STREAMS = 5;
/** An open episode longer than this is served from its tail (the budget still rules). */
export const HISTORY_EPISODE_MAX_EVENTS = 200;

const HISTORY_COLUMNS = `rowid, id, ts, actor, text, source_id AS sourceId, kind, payload_json AS payloadJson`;

/** Reply / quote references a bundle event carries, in payload keys and the wire column. */
export function quotedRefs(events: readonly Pick<BundleEvent, "id" | "payloadJson">[]): Set<string> {
  const refs = new Set<string>();
  for (const e of events) {
    try {
      const p = JSON.parse(e.payloadJson ?? "{}") as Record<string, unknown>;
      for (const key of ["quote_id", "quoted_id", "reply_to", "quoted_event_id", "reply_to_external_id"]) {
        const v = p[key];
        if (typeof v === "string" && v.length > 0) refs.add(v);
      }
    } catch {
      /* skip */
    }
  }
  const ids = events.map((e) => e.id).filter((id) => id !== "");
  if (ids.length > 0) {
    const rows = getDb()
      .prepare(
        `SELECT reply_to_external_id AS r FROM events
          WHERE id IN (${ids.map(() => "?").join(",")}) AND reply_to_external_id IS NOT NULL`,
      )
      .all(...ids) as { r: string }[];
    for (const r of rows) if (r.r) refs.add(r.r);
  }
  return refs;
}

/** Resolve reply references (event ids, external ids) to event rows, any age. */
export function fetchQuoted(refs: ReadonlySet<string>): HistoryEvent[] {
  if (refs.size === 0) return [];
  const ids = [...refs];
  const ph = ids.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT ${HISTORY_COLUMNS} FROM events
        WHERE (id IN (${ph}) OR external_id IN (${ph})
               OR json_extract(payload_json, '$.external_id') IN (${ph}))
          AND revoked_at IS NULL
        ORDER BY rowid`,
    )
    .all(...ids, ...ids, ...ids) as HistoryEvent[];
}

/**
 * The stream's history for one pack: the open episode's members + run-up,
 * or the run-up alone, plus every quoted message. Rowid-ordered; the bundle's
 * own events excluded.
 */
export function threadHistory(
  streamId: string,
  bundleEvents: readonly BundleEvent[],
  opts: { runUp?: number; maxEpisodeEvents?: number } = {},
): HistoryEvent[] {
  const db = getDb();
  const runUp = opts.runUp ?? HISTORY_RUN_UP;
  const maxEpisode = opts.maxEpisodeEvents ?? HISTORY_EPISODE_MAX_EVENTS;
  const bundleIds = new Set(bundleEvents.map((e) => e.id));
  const firstBundleRowid = bundleEvents.reduce(
    (lo, e) => Math.min(lo, e.rowid),
    Number.MAX_SAFE_INTEGER,
  );

  // Open episode members (explicit membership; legacy range rows via endpoints).
  const open = db
    .prepare(
      `SELECT id FROM episodes WHERE stream_id = ? AND state = 'open'
        ORDER BY COALESCE(last_ts, updated_at, created_at) DESC, id LIMIT 1`,
    )
    .get(streamId) as { id: string } | undefined;

  let members: HistoryEvent[] = [];
  if (open) {
    members = db
      .prepare(
        `SELECT DISTINCT e.rowid AS rowid, e.id, e.ts, e.actor, e.text, e.source_id AS sourceId, e.kind,
                e.payload_json AS payloadJson
           FROM episode_events ee
           JOIN events e ON e.id = COALESCE(ee.event_id, ee.start_event_id)
                         OR (ee.event_id IS NULL AND e.id = ee.end_event_id)
          WHERE ee.episode_id = ? AND e.revoked_at IS NULL AND e.rowid < ?
          ORDER BY e.rowid`,
      )
      .all(open.id, firstBundleRowid) as HistoryEvent[];
    if (members.length > maxEpisode) members = members.slice(members.length - maxEpisode);
    for (const m of members) m.inEpisode = true;
  }

  // Run-up: the events before the episode's first member (or before the bundle).
  const before = members.length > 0 ? members[0]!.rowid : firstBundleRowid;
  const runUpRows =
    runUp > 0
      ? (db
          .prepare(
            `SELECT ${HISTORY_COLUMNS} FROM events
              WHERE stream_id = ? AND rowid < ? AND revoked_at IS NULL
              ORDER BY rowid DESC LIMIT ?`,
          )
          .all(streamId, before, runUp) as HistoryEvent[])
      : [];
  runUpRows.reverse();

  const have = new Set<string>();
  const out: HistoryEvent[] = [];
  for (const r of [...runUpRows, ...members]) {
    if (bundleIds.has(r.id) || have.has(r.id)) continue;
    have.add(r.id);
    out.push(r);
  }

  // Quoted / replied messages: always, however old.
  for (const q of fetchQuoted(quotedRefs(bundleEvents))) {
    if (bundleIds.has(q.id)) continue;
    if (have.has(q.id)) {
      const row = out.find((r) => r.id === q.id);
      if (row) row.quoted = true;
      continue;
    }
    have.add(q.id);
    out.push({ ...q, quoted: true });
  }
  out.sort((a, b) => a.rowid - b.rowid);
  return out;
}

// ---------------------------------------------------------------------------
// Episodes of a stream
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
  const dormantCutoff = new Date(nowMs - (opts.dormantWithinDays ?? 14) * 86_400_000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT ep.id, ep.state, ep.summary, ep.last_ts, ep.space_id, sp.label AS space_label
         FROM episodes ep LEFT JOIN spaces sp ON sp.id = ep.space_id
        WHERE ep.stream_id = ?
          AND (ep.state = 'open'
               OR (ep.state = 'dormant' AND COALESCE(ep.last_ts, ep.updated_at, ep.created_at) >= ?))
        ORDER BY ep.state = 'open' DESC, ep.last_ts DESC, ep.id
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
// Cross-source related episodes (via bridge keys)
// ---------------------------------------------------------------------------

export function crossSourceEpisodes(
  streamIds: readonly string[],
  bundleEvents: readonly BundleEvent[],
  opts: { limit?: number } = {},
): EpisodeSummary[] {
  const db = getDb();
  const eventIds = bundleEvents.map((e) => e.id);
  if (eventIds.length === 0) return [];
  const ph = eventIds.map(() => "?").join(",");
  const sph = streamIds.length > 0 ? streamIds.map(() => "?").join(",") : "''";
  const rows = db
    .prepare(
      `SELECT DISTINCT ep.id, ep.state, ep.summary, ep.last_ts, ep.space_id,
              sp.label AS space_label, st.external_key AS stream_key
         FROM event_bridge_keys mine
         JOIN event_bridge_keys other
           ON other.kind = mine.kind AND other.value_norm = mine.value_norm
          AND other.event_id NOT IN (${ph})
         JOIN episode_events ee
           ON ee.event_id = other.event_id
           OR ee.start_event_id = other.event_id OR ee.end_event_id = other.event_id
         JOIN episodes ep ON ep.id = ee.episode_id AND ep.stream_id NOT IN (${sph})
         LEFT JOIN spaces sp ON sp.id = ep.space_id
         LEFT JOIN streams st ON st.id = ep.stream_id
        WHERE mine.event_id IN (${ph})
        ORDER BY ep.last_ts DESC, ep.id LIMIT ?`,
    )
    .all(...eventIds, ...streamIds, ...eventIds, opts.limit ?? 4) as {
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
// Stream facts
// ---------------------------------------------------------------------------

export interface StreamFacts {
  streamId: string;
  streamKey: string;
  sourceId: string;
  label: string | null;
  kind: string | null;
  tier: string | null;
  category: string | null;
  participantIds: string[];
}

export function streamFacts(streamId: string): StreamFacts | null {
  const row = getDb()
    .prepare(
      `SELECT id, source_id, external_key, label, stream_kind, tier, category, participant_entity_ids
         FROM streams WHERE id = ?`,
    )
    .get(streamId) as
    | {
        id: string;
        source_id: string;
        external_key: string;
        label: string | null;
        stream_kind: string | null;
        tier: string | null;
        category: string | null;
        participant_entity_ids: string | null;
      }
    | undefined;
  if (!row) return null;
  let participantIds: string[] = [];
  try {
    const parsed = JSON.parse(row.participant_entity_ids ?? "[]");
    if (Array.isArray(parsed)) participantIds = parsed.filter((p): p is string => typeof p === "string");
  } catch {
    /* none */
  }
  return {
    streamId: row.id,
    streamKey: row.external_key,
    sourceId: row.source_id,
    label: row.label,
    kind: row.stream_kind,
    tier: row.tier,
    category: row.category,
    participantIds,
  };
}
