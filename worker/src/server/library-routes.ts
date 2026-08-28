// ===========================================================================
// [CODE] Freshness + Library routes — build P2.4 (spec §5.4, §14.3.2).
//
//   GET  /api/freshness                    per-source "Knows you: X → Y" +
//                                          the cross-source header chip
//   GET  /api/library/chats                streams: label, tier badge,
//                                          category, per-chat knows-from,
//                                          today count, pause state
//   GET  /api/library/browser              today's domains, recent visit
//                                          chains (dwell + filing chips),
//                                          bookmark shelf
//   GET  /api/library/screen?day=YYYY-MM-DD day strip (hour buckets) +
//                                          session cards for that day
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
}

function libraryChats(sourceId: string): ChatRow[] {
  return getDb()
    .prepare(
      `SELECT s.id, s.label, s.external_key, s.stream_kind, s.tier, s.category,
              s.capture_paused,
              MIN(CASE WHEN e.dispatched_at IS NOT NULL THEN e.ts END) AS knows_from,
              MAX(e.ts) AS last_ts,
              SUM(CASE WHEN e.ts >= strftime('%Y-%m-%dT00:00:00.000Z','now') THEN 1 ELSE 0 END)
                AS today_count,
              COUNT(e.id) AS event_count
         FROM streams s
         LEFT JOIN events e ON e.stream_id = s.id
        WHERE s.source_id = ?
        GROUP BY s.id
        ORDER BY (last_ts IS NULL), last_ts DESC`,
    )
    .all(sourceId) as ChatRow[];
}

interface VisitRow {
  id: string;
  ts: string;
  stream_key: string;
  payload_json: string | null;
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
} {
  const db = getDb();
  const domains = db
    .prepare(
      `SELECT COALESCE(json_extract(payload_json,'$.domain'),'?') AS domain, COUNT(*) AS visits
         FROM events
        WHERE source_type = 'browser' AND kind = 'browser.visit'
          AND ts >= strftime('%Y-%m-%dT00:00:00.000Z','now')
        GROUP BY domain ORDER BY visits DESC LIMIT 12`,
    )
    .all() as { domain: string; visits: number }[];

  // Recent chains: the last 8 tab-chain stream keys, each with its visits.
  const keys = db
    .prepare(
      `SELECT stream_key, MAX(ts) AS last_ts FROM events
        WHERE source_type = 'browser' AND kind = 'browser.visit'
        GROUP BY stream_key ORDER BY last_ts DESC LIMIT 8`,
    )
    .all() as { stream_key: string }[];
  const visitStmt = db.prepare(
    `SELECT id, ts, stream_key, payload_json FROM events
      WHERE source_type = 'browser' AND kind = 'browser.visit' AND stream_key = ?
      ORDER BY ts ASC LIMIT 50`,
  );
  const spaceStmt = db.prepare(
    `SELECT sp.label AS label
       FROM episodes ep JOIN spaces sp ON sp.id = ep.space_id
      WHERE ep.stream_id = (SELECT stream_id FROM events WHERE stream_key = ? AND source_type='browser' LIMIT 1)
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

  return { domains_today: domains, chains, bookmarks };
}

export interface ScreenSession {
  stream_key: string;
  app: string;
  started_at: string;
  ended_at: string;
  minutes: number;
  event_count: number;
}

/** Group one day's screen events into session cards (gap/app split). */
export function screenSessions(rows: VisitRow[]): ScreenSession[] {
  const sessions: ScreenSession[] = [];
  let current: (ScreenSession & { lastMs: number }) | null = null;
  for (const r of rows) {
    const ms = new Date(r.ts).getTime();
    const p = r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : {};
    const app =
      (typeof p.app === "string" && p.app) ||
      (typeof p.title === "string" && p.title) ||
      r.stream_key;
    if (!current || current.stream_key !== r.stream_key || ms - current.lastMs > SCREEN_SESSION_GAP_MS) {
      if (current) sessions.push(stripSession(current));
      current = {
        stream_key: r.stream_key,
        app,
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
    started_at: s.started_at,
    ended_at: s.ended_at,
    minutes,
    event_count: s.event_count,
  };
}

function libraryScreen(day: string): {
  day: string;
  hours: number[];
  sessions: ScreenSession[];
  paused: boolean;
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
  return { day, hours, sessions: screenSessions(rows), paused };
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

  if (req.method === "GET" && path === "/api/library/chats") {
    const source = url.searchParams.get("source") ?? "whatsapp";
    sendJson(res, 200, { streams: libraryChats(source) });
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
