// ===========================================================================
// [CODE] Freshness + Library routes — build P2.4 (spec §5.4, §14.3.2).
//
//   GET  /api/freshness                    per-source "Knows you: X → Y" +
//                                          the cross-source header chip
//   GET  /api/library/chats                streams: label, tier badge,
//                                          category, per-chat knows-from,
//                                          today count, pause state, and the
//                                          last-message preview the chat-inbox
//                                          list renders
//   GET  /api/library/browser              today's domains, recent visit
//                                          chains (dwell + filing chips),
//                                          bookmark shelf
//   GET  /api/library/screen?day=YYYY-MM-DD day strip (hour buckets) +
//                                          session cards for that day, grouped
//                                          BY APP (bundle_id) and then by the
//                                          document/window inside each app
//   POST /api/library/streams/:id/pause    {paused} → capture pause flip
//                                          (decision row; ingest drops)
//   POST /api/library/screen/delete        {start_ts, end_ts, stream_key?}
//                                          → honest cascading hard delete
//
// Reads are plain SQL over the log + world model; the two writes go through
// the single-writer modules (library/pause.ts, library/delete-cascade.ts).
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import { pausedKey } from "../db/ingest.js";
import { freshnessOverview } from "../freshness/index.js";
import { deleteScreenSpan } from "../library/delete-cascade.js";
import { setStreamCapturePaused } from "../library/pause.js";
import { sourceStatus } from "../library/source-status.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

const SCREEN_SESSION_GAP_MS = 15 * 60 * 1000;

interface ChatRow {
  id: string;
  label: string | null;
  external_key: string;
  stream_kind: string | null;
  tier: string | null;
  category: string | null;
  capture_paused: number;
  knows_from: string | null;
  last_ts: string | null;
  today_count: number;
  event_count: number;
  /** Last message preview — what the chat-inbox list shows under the name. */
  last_text: string | null;
  last_kind: string | null;
  last_from_me: number | null;
}

/**
 * One row per stream of a source, ordered newest-first — the conversation list
 * of the Library's chat inbox.
 *
 * V6 P1 S6d L1. This used to be ONE statement: a LEFT JOIN of `streams` against
 * every event of the source, grouped per stream, carrying three correlated
 * sub-selects for the preview line. On the user's real home that answered in
 * 14.0 seconds. The join is not the problem — the ROW FETCHES are: `knows_from`
 * reads `dispatched_at` off the table for every event of every stream, and the
 * three sub-selects each re-seek the same last row.
 *
 * Split into three passes, each of which the indexes can serve without touching
 * a table row until the very end:
 *
 *   1. `streams` metadata for the source (a few hundred rows, indexed).
 *   2. per-stream MAX(ts) / COUNT / today, index-only over (stream_id, ts).
 *   3. per-stream MIN(ts) among DISPATCHED events, index-only over the partial
 *      (stream_id, ts) WHERE dispatched_at IS NOT NULL index (0209).
 *
 * The preview line is then one seek per RETURNED stream — the newest row read
 * once instead of three times, and only for the page the caller asked for. A
 * media-only message has no text, so the UI turns `last_kind` into a
 * "📷 Photo"-style label rather than a blank.
 */
function libraryChats(sourceId: string, limit?: number, offset = 0): ChatRow[] {
  const db = getDb();
  const meta = db
    .prepare(
      `SELECT s.id, s.label, s.external_key, s.stream_kind, s.tier, s.category, s.capture_paused
         FROM streams s WHERE s.source_id = ?`,
    )
    .all(sourceId) as Omit<
    ChatRow,
    "knows_from" | "last_ts" | "today_count" | "event_count" | "last_text" | "last_kind" | "last_from_me"
  >[];
  if (meta.length === 0) return [];

  // Both aggregates run WITHOUT a join to `streams`: joining makes SQLite drive
  // the loop from `streams` and re-seek the event index once per stream, which
  // measured 131 ms / 720 ms on the 400k corpus. Scanning the covering index
  // straight through, in stream_id order, measures 51 ms / 63 ms — and the
  // extra streams from other sources are dropped by the `meta` map below.
  const stats = new Map<string, { last_ts: string | null; today_count: number; event_count: number }>();
  for (const r of db
    .prepare(
      `SELECT stream_id AS id, MAX(ts) AS last_ts, COUNT(*) AS event_count,
              SUM(CASE WHEN ts >= strftime('%Y-%m-%dT00:00:00.000Z','now') THEN 1 ELSE 0 END) AS today_count
         FROM events WHERE stream_id IS NOT NULL GROUP BY stream_id`,
    )
    .all() as { id: string; last_ts: string | null; event_count: number; today_count: number }[]) {
    stats.set(r.id, { last_ts: r.last_ts, today_count: r.today_count, event_count: r.event_count });
  }

  const knows = new Map<string, string | null>();
  for (const r of db
    .prepare(
      `SELECT stream_id AS id, MIN(ts) AS knows_from
         FROM events WHERE dispatched_at IS NOT NULL AND stream_id IS NOT NULL
        GROUP BY stream_id`,
    )
    .all() as { id: string; knows_from: string | null }[]) {
    knows.set(r.id, r.knows_from);
  }

  const ordered = meta
    .map((m) => ({
      ...m,
      knows_from: knows.get(m.id) ?? null,
      last_ts: stats.get(m.id)?.last_ts ?? null,
      today_count: stats.get(m.id)?.today_count ?? 0,
      event_count: stats.get(m.id)?.event_count ?? 0,
      last_text: null as string | null,
      last_kind: null as string | null,
      last_from_me: null as number | null,
    }))
    .sort((a, b) => {
      if (a.last_ts === b.last_ts) return 0;
      if (a.last_ts === null) return 1;
      if (b.last_ts === null) return -1;
      return b.last_ts.localeCompare(a.last_ts);
    });

  const page =
    limit === undefined ? ordered.slice(offset) : ordered.slice(offset, offset + Math.max(0, limit));
  // The preview seeks the stream's LAST ts, which pass 2 already knows, instead
  // of ordering the stream's whole history: `ORDER BY ts DESC, id DESC` cannot
  // be answered from (stream_id, ts) alone, so SQLite built a temp b-tree over
  // every event in the stream — 1.5 ms per chat, 900 chats, 1.3 s of the 2.7.
  // Seeking (stream_id, ts) and tie-breaking on id inside that one timestamp is
  // the same answer in 20 microseconds.
  const previewStmt = db.prepare(
    `SELECT text, kind, actor FROM events WHERE stream_id = ? AND ts = ? ORDER BY id DESC LIMIT 1`,
  );
  for (const row of page) {
    if (row.last_ts === null) continue;
    const p = previewStmt.get(row.id, row.last_ts) as
      | { text: string | null; kind: string | null; actor: string | null }
      | undefined;
    if (!p) continue;
    row.last_text = p.text;
    row.last_kind = p.kind;
    row.last_from_me = p.actor === "self" ? 1 : 0;
  }
  return page as ChatRow[];
}

/** Conversations a source has, whether or not this page returned them. */
function streamCount(sourceId: string): number {
  return (
    (
      getDb().prepare(`SELECT COUNT(*) AS n FROM streams WHERE source_id = ?`).get(sourceId) as
        | { n: number }
        | undefined
    )?.n ?? 0
  );
}

/**
 * Total events a source has ever landed — "is anything flowing at all?".
 * Index-only over `idx_events_source_type_ts` (0209); before that index this
 * was a full scan of the whole log, once per Library sub-tab open.
 */
function sourceEventCount(sourceType: string): number {
  return (
    (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE source_type = ?`)
        .get(sourceType) as { n: number } | undefined
    )?.n ?? 0
  );
}

interface VisitRow {
  id: string;
  ts: string;
  stream_key: string;
  payload_json: string | null;
}

/** Hostname of a URL, without `www.`; null when it isn't parseable. */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function libraryBrowser(): {
  domains_today: { domain: string; visits: number }[];
  chains: {
    stream_key: string;
    started_at: string;
    ended_at: string;
    visits: { ts: string; url: string; title: string | null; dwell_ms: number }[];
    space_label: string | null;
  }[];
  bookmarks: { ts: string; url: string; title: string | null; folder: string | null }[];
  event_count: number;
} {
  const db = getDb();
  // Today's domains. A visit whose payload carries no `domain` still has a URL,
  // and a host read off the URL beats bucketing every such visit under "?".
  const todayVisits = db
    .prepare(
      `SELECT json_extract(payload_json,'$.domain') AS domain,
              json_extract(payload_json,'$.url')    AS url
         FROM events
        WHERE source_type = 'browser' AND kind = 'browser.visit'
          AND ts >= strftime('%Y-%m-%dT00:00:00.000Z','now')
        LIMIT 20000`,
    )
    .all() as { domain: string | null; url: string | null }[];
  const domainCounts = new Map<string, number>();
  for (const v of todayVisits) {
    const key = v.domain?.trim() || hostOf(v.url) || "?";
    domainCounts.set(key, (domainCounts.get(key) ?? 0) + 1);
  }
  const domains = [...domainCounts.entries()]
    .map(([domain, visits]) => ({ domain, visits }))
    .sort((a, b) => b.visits - a.visits || a.domain.localeCompare(b.domain))
    .slice(0, 12);

  // Recent chains: the last 8 tab-chain stream keys.
  //
  // V6 P1 S6d L1. This was `GROUP BY stream_key` over EVERY browser visit ever
  // captured, ordered by MAX(ts) — an unbounded aggregate whose cost grows with
  // the whole history to answer a question about the last few hours. Walk the
  // (source_type, kind, ts) index newest-first instead and stop as soon as
  // eight distinct keys have shown up; CHAIN_SCAN_CAP bounds the walk for a log
  // where one chain dominates the recent tail.
  const CHAIN_SCAN_CAP = 4_000;
  const seen = new Set<string>();
  const keys: { stream_key: string }[] = [];
  for (const r of db
    .prepare(
      `SELECT stream_key FROM events
        WHERE source_type = 'browser' AND kind = 'browser.visit'
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(CHAIN_SCAN_CAP) as { stream_key: string }[]) {
    if (!r.stream_key || seen.has(r.stream_key)) continue;
    seen.add(r.stream_key);
    keys.push({ stream_key: r.stream_key });
    if (keys.length === 8) break;
  }
  // INDEXED BY, deliberately: with (source_type, kind, ts) also available the
  // planner picked THAT and then filtered on stream_key, scanning every browser
  // visit ever captured once per chain — 200 ms x 8. (stream_key, ts) answers
  // the same question, in order, in 0.1 ms.
  const visitStmt = db.prepare(
    `SELECT id, ts, stream_key, payload_json FROM events INDEXED BY idx_events_stream_key
      WHERE stream_key = ? AND source_type = 'browser' AND kind = 'browser.visit'
      ORDER BY ts ASC LIMIT 50`,
  );
  const spaceStmt = db.prepare(
    `SELECT sp.label AS label
       FROM episodes ep JOIN spaces sp ON sp.id = ep.space_id
      WHERE ep.stream_id = (SELECT stream_id FROM events INDEXED BY idx_events_stream_key
              WHERE stream_key = ? AND source_type='browser' LIMIT 1)
      ORDER BY ep.last_ts DESC LIMIT 1`,
  );
  const chains = keys.map((k) => {
    const visits = (visitStmt.all(k.stream_key) as VisitRow[]).map((v) => {
      const p = v.payload_json ? (JSON.parse(v.payload_json) as Record<string, unknown>) : {};
      return {
        ts: v.ts,
        url: typeof p.url === "string" ? p.url : "",
        title: typeof p.title === "string" ? p.title : null,
        dwell_ms: typeof p.dwell_ms === "number" ? p.dwell_ms : 0,
      };
    });
    const space = spaceStmt.get(k.stream_key) as { label: string } | undefined;
    return {
      stream_key: k.stream_key,
      started_at: visits[0]?.ts ?? "",
      ended_at: visits[visits.length - 1]?.ts ?? "",
      visits,
      space_label: space?.label ?? null,
    };
  });

  const bookmarks = (
    db
      .prepare(
        `SELECT ts, payload_json FROM events
          WHERE source_type = 'browser' AND kind = 'browser.bookmark'
          ORDER BY ts DESC LIMIT 20`,
      )
      .all() as { ts: string; payload_json: string | null }[]
  ).map((b) => {
    const p = b.payload_json ? (JSON.parse(b.payload_json) as Record<string, unknown>) : {};
    return {
      ts: b.ts,
      url: typeof p.url === "string" ? p.url : "",
      title: typeof p.title === "string" ? p.title : null,
      folder: typeof p.folder === "string" ? p.folder : null,
    };
  });

  return {
    domains_today: domains,
    chains,
    bookmarks,
    event_count: sourceEventCount("browser"),
  };
}

export interface ScreenSession {
  stream_key: string;
  app: string;
  /** The app's bundle id — the identity the Screen view groups on. */
  bundle_id: string;
  /** Document / window inside the app, when the capture named one. */
  doc: string | null;
  started_at: string;
  ended_at: string;
  minutes: number;
  event_count: number;
}

/** One document (window/tab) inside an app, with the sessions that touched it. */
export interface ScreenDocGroup {
  doc: string | null;
  minutes: number;
  event_count: number;
  sessions: ScreenSession[];
}

/** One app's whole day: minutes, captures, and its documents. */
export interface ScreenAppGroup {
  bundle_id: string;
  app: string;
  minutes: number;
  event_count: number;
  session_count: number;
  docs: ScreenDocGroup[];
}

/**
 * How a screen capture names the app it came from. The sidecar's snapshot
 * payload (adapters/screen/envelope.ts) spells these `app_name` / `bundle_id` /
 * `window_title` / `doc_key`; `app` and `title` are the older/fixture spelling
 * and stay supported so a mixed log still renders names instead of stream keys.
 */
function screenIdentity(r: VisitRow): { app: string; bundleId: string; doc: string | null } {
  const p = r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : {};
  const bundleId =
    (typeof p.bundle_id === "string" && p.bundle_id) || r.stream_key.split("¦")[0] || r.stream_key;
  const app =
    (typeof p.app_name === "string" && p.app_name) ||
    (typeof p.app === "string" && p.app) ||
    (typeof p.title === "string" && p.title) ||
    bundleId;
  const doc =
    (typeof p.window_title === "string" && p.window_title) ||
    (typeof p.doc_key === "string" && p.doc_key) ||
    null;
  return { app, bundleId, doc };
}

/** Group one day's screen events into session cards (gap/stream split). */
export function screenSessions(rows: VisitRow[]): ScreenSession[] {
  const sessions: ScreenSession[] = [];
  let current: (ScreenSession & { lastMs: number }) | null = null;
  for (const r of rows) {
    const ms = new Date(r.ts).getTime();
    const { app, bundleId, doc } = screenIdentity(r);
    if (!current || current.stream_key !== r.stream_key || ms - current.lastMs > SCREEN_SESSION_GAP_MS) {
      if (current) sessions.push(stripSession(current));
      current = {
        stream_key: r.stream_key,
        app,
        bundle_id: bundleId,
        doc,
        started_at: r.ts,
        ended_at: r.ts,
        minutes: 0,
        event_count: 1,
        lastMs: ms,
      };
    } else {
      current.ended_at = r.ts;
      current.event_count++;
      current.lastMs = ms;
    }
  }
  if (current) sessions.push(stripSession(current));
  return sessions;
}

function stripSession(s: ScreenSession & { lastMs: number }): ScreenSession {
  const minutes = Math.max(
    1,
    Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60_000),
  );
  return {
    stream_key: s.stream_key,
    app: s.app,
    bundle_id: s.bundle_id,
    doc: s.doc,
    started_at: s.started_at,
    ended_at: s.ended_at,
    minutes,
    event_count: s.event_count,
  };
}

/**
 * Roll session cards up BY APP, then by document inside the app — the shape the
 * Library's Screen view renders (an app is what a person remembers doing; a
 * flat list of 40 four-minute sessions is not). Apps sort by time spent, docs
 * and sessions newest-first inside them.
 */
export function groupScreenSessionsByApp(sessions: ScreenSession[]): ScreenAppGroup[] {
  const apps = new Map<string, ScreenAppGroup>();
  for (const s of sessions) {
    let app = apps.get(s.bundle_id);
    if (!app) {
      app = {
        bundle_id: s.bundle_id,
        app: s.app,
        minutes: 0,
        event_count: 0,
        session_count: 0,
        docs: [],
      };
      apps.set(s.bundle_id, app);
    }
    app.minutes += s.minutes;
    app.event_count += s.event_count;
    app.session_count++;
    let doc = app.docs.find((d) => d.doc === s.doc);
    if (!doc) {
      doc = { doc: s.doc, minutes: 0, event_count: 0, sessions: [] };
      app.docs.push(doc);
    }
    doc.minutes += s.minutes;
    doc.event_count += s.event_count;
    doc.sessions.push(s);
  }
  const byNewest = (a: ScreenSession, b: ScreenSession): number =>
    b.started_at.localeCompare(a.started_at);
  for (const app of apps.values()) {
    for (const doc of app.docs) doc.sessions.sort(byNewest);
    app.docs.sort((a, b) => b.minutes - a.minutes);
  }
  return [...apps.values()].sort((a, b) => b.minutes - a.minutes || b.event_count - a.event_count);
}

function libraryScreen(day: string): {
  day: string;
  hours: number[];
  sessions: ScreenSession[];
  apps: ScreenAppGroup[];
  paused: boolean;
  event_count: number;
} {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, ts, stream_key, payload_json FROM events
        WHERE source_type = 'screen' AND ts >= ? AND ts < ?
        ORDER BY ts ASC`,
    )
    .all(`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`) as VisitRow[];
  const hours = new Array<number>(24).fill(0);
  for (const r of rows) {
    const h = new Date(r.ts).getUTCHours();
    hours[h]++;
  }
  const paused =
    (
      db
        .prepare(`SELECT value FROM app_state WHERE key = ?`)
        .get(pausedKey("screen")) as { value: string } | undefined
    )?.value === "1";
  const sessions = screenSessions(rows);
  return {
    day,
    hours,
    sessions,
    apps: groupScreenSessionsByApp(sessions),
    paused,
    // Across the WHOLE log, not just this day: a source with captures from
    // yesterday is connected even when today's strip is empty.
    event_count: sourceEventCount("screen"),
  };
}

/**
 * Handle one freshness/library route. Returns false for any path it does not
 * claim (the server's shared handler contract).
 */
export async function handleLibraryRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/freshness") {
    sendJson(res, 200, freshnessOverview());
    return true;
  }

  // V6 P1 S6d L6: ONE source's own status — connection, the window in force,
  // its own coverage range, its own import backlog. The Library sub-tab reads
  // this instead of picking its row out of the cross-source overview, so the
  // panel can never show another source's number.
  if (req.method === "GET" && path === "/api/library/source-status") {
    const source = url.searchParams.get("source");
    if (!source) {
      sendJson(res, 400, { error: "source required" });
      return true;
    }
    sendJson(res, 200, sourceStatus(source));
    return true;
  }

  if (req.method === "GET" && path === "/api/library/chats") {
    const source = url.searchParams.get("source") ?? "whatsapp";
    // V6 P1 S6d L1: `limit` / `offset` are OPTIONAL and unbounded by default,
    // so an existing client keeps the whole inbox; a client that wants the
    // first screenful and nothing else can now ask for it, and `total` tells it
    // how many conversations the source has.
    const rawLimit = Number(url.searchParams.get("limit"));
    const rawOffset = Number(url.searchParams.get("offset"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const streams = libraryChats(source, limit, offset);
    sendJson(res, 200, {
      source_id: source,
      streams,
      total: streamCount(source),
      event_count: sourceEventCount(source),
    });
    return true;
  }

  if (req.method === "GET" && path === "/api/library/browser") {
    sendJson(res, 200, libraryBrowser());
    return true;
  }

  if (req.method === "GET" && path === "/api/library/screen") {
    const day = url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "day must be YYYY-MM-DD" });
      return true;
    }
    sendJson(res, 200, libraryScreen(day));
    return true;
  }

  const pauseMatch = path.match(/^\/api\/library\/streams\/([^/]+)\/pause$/);
  if (req.method === "POST" && pauseMatch) {
    const body = (await readBody(req)) as { paused?: unknown } | undefined;
    if (!body || typeof body.paused !== "boolean") {
      sendJson(res, 400, { error: "paused (boolean) required" });
      return true;
    }
    const streamId = decodeURIComponent(pauseMatch[1]);
    const exists = getDb().prepare(`SELECT 1 FROM streams WHERE id = ?`).get(streamId);
    if (!exists) {
      sendJson(res, 404, { error: "stream not found" });
      return true;
    }
    const decisionId = setStreamCapturePaused(streamId, body.paused);
    sendJson(res, 200, { stream_id: streamId, paused: body.paused, decision_id: decisionId });
    return true;
  }

  if (req.method === "POST" && path === "/api/library/screen/delete") {
    const body = (await readBody(req)) as
      | { start_ts?: unknown; end_ts?: unknown; stream_key?: unknown }
      | undefined;
    if (!body || typeof body.start_ts !== "string" || typeof body.end_ts !== "string") {
      sendJson(res, 400, { error: "start_ts and end_ts required" });
      return true;
    }
    const report = deleteScreenSpan({
      startTs: body.start_ts,
      endTs: body.end_ts,
      streamKey: typeof body.stream_key === "string" ? body.stream_key : null,
    });
    sendJson(res, 200, { report });
    return true;
  }

  return false;
}
