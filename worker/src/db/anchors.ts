// ===========================================================================
// [CODE] Back-pagination anchors: the oldest message this worker holds per chat.
//
// The whatsapp-go paginator walks an in-memory `oldestPerChat` map that is
// filled ONLY from messages flowing through the running daemon process. A
// restarted daemon therefore has zero anchors, and "Extend history" over zero
// anchors is a guaranteed no-op — it paginates nothing and closes.
//
// The daemon cannot rebuild the map itself: its store is whatsmeow's sqlstore,
// which has no message table (whatsmeow_message_secrets carries chat/sender/id
// but no timestamp and no from_me). This DB is the only durable record of what
// was actually ingested, which is exactly what pagination must resume from — so
// the worker seeds them over `seed_anchors` (protocol.Anchor).
//
// An anchor is complete iff all four wire fields are present, because those four
// are precisely what whatsmeow's BuildHistorySyncRequest puts on the wire
// (ChatJID, OldestMsgID, OldestMsgFromMe, OldestMsgTimestampMS). A partial one
// would issue a bad page request, so incomplete rows are dropped here rather
// than sent and skipped daemon-side.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";
import { selfIdentityValue } from "./ingest.js";

/** One chat's oldest-known message, in the daemon's wire shape (snake_case). */
export interface Anchor {
  /** The chat JID the daemon emitted as `channel_ext_id`. */
  chat_jid: string;
  /** The WhatsApp message id — the `<id>` half of external_id, not the whole. */
  msg_id: string;
  from_me: boolean;
  /** ISO-8601; the daemon parses it with RFC3339. */
  ts: string;
}

interface AnchorStatements {
  db: Database.Database;
  oldestPerStream: Database.Statement;
}

let stmts: AnchorStatements | null = null;

function statements(): AnchorStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = {
    db,
    // One row per stream: its oldest event, with the chat's JID and whether the
    // self user sent it. `events` has no from_me column and `actors` has no
    // is_self column — "me" is the actor whose source_ext_id matches the source's
    // persisted self identity (app_state), so the caller passes that in.
    //
    // Reactions are excluded: an anchor is the point history resumes FROM, and a
    // reaction is metadata about another message rather than a position in the
    // conversation.
    oldestPerStream: db.prepare(`
      SELECT chat_jid, external_id, ts, from_me
        FROM (
          SELECT s.external_key AS chat_jid,
                 e.external_id  AS external_id,
                 e.ts           AS ts,
                 CASE
                   WHEN @self <> '' AND a.source_ext_id = @self THEN 1
                   ELSE 0
                 END            AS from_me,
                 ROW_NUMBER() OVER (
                   PARTITION BY e.stream_id
                   ORDER BY e.ts ASC, e.external_id ASC
                 )              AS rn
            FROM events e
            JOIN streams s ON s.id = e.stream_id
            LEFT JOIN actors a ON a.id = e.actor_id
           WHERE e.source_id = @sourceId
             AND e.kind IS NOT 'reaction'
             AND e.external_id IS NOT NULL AND e.external_id <> ''
             AND e.ts IS NOT NULL AND e.ts <> ''
             AND s.external_key IS NOT NULL AND s.external_key <> ''
        )
       WHERE rn = 1
    `),
  };
  return stmts;
}

interface RawAnchorRow {
  chat_jid: string;
  external_id: string;
  ts: string;
  from_me: number;
}

/**
 * The oldest message held for every chat of `sourceId`, ready to send as the
 * `seed_anchors` payload. Rows whose external_id is not the daemon's
 * `<chat>/<id>` shape are dropped — a message id guessed out of an unexpected
 * format would page from somewhere real history never was.
 */
export function readAnchors(sourceId: string): Anchor[] {
  const rows = statements().oldestPerStream.all({
    sourceId,
    // "" when the self actor has not been announced yet: then no row can match
    // and every anchor is sent as from_me:false, which is what the daemon would
    // have inferred from a message it never saw either.
    self: selfIdentityValue(sourceId) ?? "",
  }) as RawAnchorRow[];
  const anchors: Anchor[] = [];
  for (const row of rows) {
    const msgId = messageIdOf(row.external_id, row.chat_jid);
    if (!msgId) continue;
    anchors.push({
      chat_jid: row.chat_jid,
      msg_id: msgId,
      from_me: row.from_me === 1,
      ts: row.ts,
    });
  }
  return anchors;
}

/**
 * Split the daemon's `<chat>/<id>` external_id back into its id half. Matched
 * against the chat JID rather than by splitting on the first "/", because only
 * the prefix the daemon actually built is safe to strip.
 */
export function messageIdOf(externalId: string, chatJid: string): string | null {
  const prefix = `${chatJid}/`;
  if (!externalId.startsWith(prefix)) return null;
  const id = externalId.slice(prefix.length);
  return id.length > 0 ? id : null;
}
