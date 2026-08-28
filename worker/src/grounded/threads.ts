// ===========================================================================
// [CODE] Bar threads — history as a real surface (build P4.1, spec §14.8.5/6,
// USR-06).
//
// Threads are events like everything else: every bar message (user and twin)
// is appended to the one event log through the single-writer path, under
// source "twin" / kind "bar.message" / stream_key "bar:<thread_id>". That
// makes threads searchable (FTS over events.text), visible on the Timeline
// as first-class rows, reopenable (⌘↑ history reads them back), and food for
// the learning loop — no side store, no goldfish bar.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { appendEvent } from "../db/eventlog.js";

export const BAR_SOURCE = "twin";
export const BAR_KIND = "bar.message";
const STREAM_PREFIX = "bar:";

export interface BarMessage {
  event_id: string;
  thread_id: string;
  role: "user" | "twin";
  text: string;
  ts: string;
  intent: string | null;
  /** Extra structured payload (citations, action outcome) for re-render. */
  meta: Record<string, unknown> | null;
}

export interface BarThreadSummary {
  thread_id: string;
  title: string;
  last_ts: string;
  message_count: number;
}

export function mintThreadId(): string {
  return `th_${randomBytes(9).toString("hex")}`;
}

/** Append one bar message to the event log (single-writer, idempotent). */
export function appendBarMessage(input: {
  threadId: string;
  role: "user" | "twin";
  text: string;
  intent?: string | null;
  meta?: Record<string, unknown> | null;
}): string {
  const ts = new Date().toISOString();
  const { id } = appendEvent({
    ts,
    source: BAR_SOURCE,
    kind: BAR_KIND,
    origin: "live",
    streamKey: `${STREAM_PREFIX}${input.threadId}`,
    actor: input.role === "user" ? "self" : "twin",
    roles: {
      sender: input.role === "user" ? "self" : "twin",
      audience: ["self"],
      receiver: ["self"],
      mentions: [],
    },
    payload: {
      text: input.text,
      role: input.role,
      intent: input.intent ?? null,
      meta: input.meta ?? null,
    },
  });
  return id;
}

/** Past threads, newest first — the ⌘↑ history list. */
export function listThreads(limit = 20): BarThreadSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT stream_key,
              MIN(CASE WHEN json_extract(payload_json, '$.role') = 'user' THEN text END) AS title,
              MAX(ts) AS last_ts,
              COUNT(*) AS message_count
         FROM events
        WHERE kind = ? AND stream_key LIKE ?
        GROUP BY stream_key
        ORDER BY last_ts DESC
        LIMIT ?`,
    )
    .all(BAR_KIND, `${STREAM_PREFIX}%`, limit) as Array<{
    stream_key: string;
    title: string | null;
    last_ts: string;
    message_count: number;
  }>;
  return rows.map((r) => ({
    thread_id: r.stream_key.slice(STREAM_PREFIX.length),
    title: r.title ?? "(untitled)",
    last_ts: r.last_ts,
    message_count: r.message_count,
  }));
}

/** One thread's messages in time order — reopen + continue with context. */
export function readThread(threadId: string): BarMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT id, ts, text, payload_json
         FROM events
        WHERE kind = ? AND stream_key = ?
        ORDER BY ts ASC, rowid ASC`,
    )
    .all(BAR_KIND, `${STREAM_PREFIX}${threadId}`) as Array<{
    id: string;
    ts: string;
    text: string | null;
    payload_json: string | null;
  }>;
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }
    const role = payload.role === "twin" ? "twin" : "user";
    const meta = payload.meta;
    return {
      event_id: r.id,
      thread_id: threadId,
      role,
      text: r.text ?? String(payload.text ?? ""),
      ts: r.ts,
      intent: typeof payload.intent === "string" ? payload.intent : null,
      meta: typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : null,
    };
  });
}
