// ===========================================================================
// Retrieval primitives for grounded chat (docs/v6-spec.md §1, §2).
//
// The measured failure was not precision: `"sunday" OR "planned"` returns two
// rows and both are right. It was that ONE flat `SELECT … ORDER BY rank LIMIT 8`
// was the whole of retrieval, so the answer to the question — eight messages
// later in the same chat, quoting the message that asked it — was structurally
// unreachable. These are the reads that make it reachable:
//
//   - searchEventsRanked: bm25 with COLUMN WEIGHTS, and the column that actually
//     matched, so a hit living only in `transcript` is snippetted from
//     `transcript` instead of being emitted as a blank line from column 0.
//   - resolveChannelsByName: a name in the question SELECTS a chat instead of
//     competing as a bm25 token (v7 §6, lever 1).
//   - readChannelWindow: the neighbours of a hit, over idx_events_channel_ts.
//   - readReplyChain: both directions over reply_to_external_id.
//   - readWholeChannel: a whole small chat, with the budget checked BEFORE the
//     rows are read — in RENDERED chars, which is what including it costs.
//
// Query construction (stopwords, expansion, date resolution) belongs to the
// caller: these take an FTS5 MATCH expression and give back rows.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";

// ---- FTS columns ----------------------------------------------------------

/**
 * `events_fts`, in ordinal order (0017_reply_fts). Ordinals are load-bearing —
 * bm25() takes one weight per column in this order and snippet() takes the
 * index — so this list and the migration are one fact in two places, pinned
 * together by a test.
 */
export const EVENTS_FTS_COLUMNS = [
  "text",
  "media_description",
  "link_title",
  "link_description",
  "link_scraped_text",
  "transcript",
  "reply_to_text",
] as const;

export type EventsFtsColumn = (typeof EVENTS_FTS_COLUMNS)[number];

export type FtsColumnWeights = Partial<Record<EventsFtsColumn, number>>;

/**
 * Default bm25 column weights. bm25 normalises by document length, but a 40 KB
 * scraped page still carries every query token somewhere, so an article about
 * lunch would outrank someone saying where lunch is. What the user is asking
 * about is what people TYPED; everything else is context attached to it.
 */
export const DEFAULT_FTS_WEIGHTS: Readonly<Record<EventsFtsColumn, number>> = {
  text: 4,
  media_description: 1,
  link_title: 1.5,
  link_description: 1,
  // A page nobody wrote and nobody read: still a hit, never the best one.
  link_scraped_text: 0.25,
  transcript: 2,
  // The quote IS someone's message — but it is a COPY of a row that is also
  // indexed on its own, so the original outranks the quote of it.
  reply_to_text: 2,
};

/**
 * How much better a row scores for sitting in a chat the question NAMED (v7 §6,
 * lever 1). A multiplier rather than a filter: bm25 is negative, so scaling it
 * pushes the named chat's rows down the ordering without silencing anything
 * else, and a hit four times stronger somewhere else still wins. The weight
 * spread within one row is already 16× (text 4 vs a scraped page 0.25), so this
 * is deliberately smaller than picking a column.
 */
export const DEFAULT_CHANNEL_BOOST = 4;

/**
 * Shortest query token that may name someone. Two letters is noise ("ok", "hi")
 * and would select a chat on a coincidence; every real name measured is longer.
 */
export const NAME_TOKEN_MIN_CHARS = 3;

/** Neighbours per side that recovered 100% of the missing evidence (§1). */
export const DEFAULT_WINDOW = 8;

/**
 * Minutes either side, ORed with the count above (v7 §6, lever 2). DEFAULT_WINDOW
 * was tuned on a sparse chat: on the dense one ±8 messages spans about five
 * minutes, and the cluster that answered the question sits 46 messages but only
 * 27 minutes away. ±45 min sweeps all of it and costs a sparse chat nothing.
 */
export const DEFAULT_WINDOW_MINUTES = 45;

/**
 * Rows one side of a window may return once the time span is in play. The span
 * has no other bound — a chat can say anything in 45 minutes — and 60 is what
 * covers the measured 46-message cluster with room over.
 */
export const DEFAULT_WINDOW_MAX_ROWS = 60;

/**
 * Budget for including a chat wholesale, in the chars it costs ONCE RENDERED
 * (v7 §6, lever 5) — retrievable chars understate that by 3.6× on the measured
 * chat, mostly 51-char event ids repeated per line. The number sits between the
 * two chats that were injected whole and answered their questions (55 events /
 * 3,005 retrievable and 16 / 1,085, about 8.5K and 2.7K rendered) and the one
 * that must NOT be (231 / 8,992 retrievable, 32,666 rendered).
 */
export const DEFAULT_WHOLE_CHANNEL_MAX_CHARS = 12_000;

/** Second guard on the same read: those chars can also be 400 one-word lines. */
export const DEFAULT_WHOLE_CHANNEL_MAX_EVENTS = 120;

/**
 * What the block's renderer frames every line with before any of the message
 * lands on it: the hit marker and its space, "[evt ", "] ", a 16-char local
 * timestamp, " · ", ": ", and the newline the budget counts. The id and the
 * sender's name are measured per row instead, because both vary — and the id
 * alone is 51 chars on a WhatsApp row, which is most of the understatement.
 */
const RENDER_LINE_CHARS = 31;

/** " (the user)" on a message the user sent themselves. */
const RENDER_SELF_CHARS = 11;

/**
 * What each part the renderer may add costs around its content, one space of
 * the join included — `(replying to "…")`, `[deleted for everyone]`,
 * `[attachment description: …]`, `[audio transcript: …]`, `[link …]`, and the
 * ` — `/`: ` that separate a link's title and blurb. A row with no parts at all
 * still prints `[<kind>, no text]`, which is 11 chars around the kind.
 */
const RENDER_QUOTE_CHARS = 17;
const RENDER_REVOKED_CHARS = 23;
const RENDER_DESCRIPTION_CHARS = 27;
const RENDER_TRANSCRIPT_CHARS = 21;
const RENDER_LINK_CHARS = 8;
const RENDER_LINK_TITLE_CHARS = 3;
const RENDER_LINK_BLURB_CHARS = 2;
const RENDER_EMPTY_CHARS = 11;

/**
 * The per-field caps the renderer applies, so one 40 KB scraped page is not
 * counted (or charged) whole. These mirror retrieval/format.ts, which is where
 * the rendering itself lives; a test renders a row both ways to keep the two
 * from drifting.
 */
const RENDER_MAX_TEXT_CHARS = 500;
const RENDER_MAX_TRANSCRIPT_CHARS = 400;
const RENDER_MAX_DESCRIPTION_CHARS = 200;
const RENDER_MAX_LINK_CHARS = 200;
const RENDER_MAX_QUOTE_CHARS = 120;

// ---- Row shapes -----------------------------------------------------------

/** One event as retrieval hands it to the caller building a context block. */
export interface ContextEventRow {
  id: string;
  externalId: string | null;
  channelId: string | null;
  channelName: string | null;
  ts: string | null;
  kind: string | null;
  actorName: string | null;
  /** The sender is the user themselves (actors.source_ext_id = self JID). */
  fromMe: boolean;
  text: string | null;
  /** What the media reader saw in the attachment, or null. */
  mediaDescription: string | null;
  /** What whisper heard in the voice note or the video's audio, or null. */
  transcript: string | null;
  linkUrl: string | null;
  linkTitle: string | null;
  linkDescription: string | null;
  /** The message this one quotes, and the quoted snippet WhatsApp carried. */
  replyToExternalId: string | null;
  replyToText: string | null;
  /** Deleted-for-everyone: the body is gone, the row is a tombstone. */
  revokedAt: string | null;
}

export interface RankedEventHit extends ContextEventRow {
  /**
   * Weighted bm25, times the channel boost when one applied. SQLite's
   * convention: MORE NEGATIVE is a better match. This is the number the rows
   * were ordered by, so a caller blending it with its own signals blends the
   * same ranking it was handed.
   */
  score: number;
  /**
   * The row sits in a chat the caller named, so `score` carries the boost.
   * Optional because a row that reached the caller some other way (a vector
   * hit, say) never went through bm25 at all, and absent reads as not boosted.
   */
  channelBoosted?: boolean;
  /** The FTS column this row actually matched in — snippet it, not column 0. */
  matchedColumn: EventsFtsColumn;
  matchedColumnIndex: number;
  /** Cut from `matchedColumn`. Never empty (that was the bug). */
  snippet: string;
}

export interface ReplyChainRow extends ContextEventRow {
  /**
   * Distance from the anchor along reply_to_external_id: negative for a message
   * the anchor (transitively) quotes, 0 for the anchor, positive for a reply to
   * it.
   */
  depth: number;
}

export interface WholeChannelRead {
  channelId: string;
  channelName: string | null;
  /** Non-reaction events in the chat — what `events` would hold if it fits. */
  eventCount: number;
  /** Chars of retrievable text across them. */
  charCount: number;
  /**
   * What including the chat actually costs: the same text as the renderer would
   * cut it, plus the id, sender, timestamp and brackets on every line. This is
   * what the budget is checked against — `charCount` understated it 3.6× on the
   * measured chat (v7 §6, lever 5).
   */
  renderedCharCount: number;
  withinBudget: boolean;
  /** Empty when the chat does not fit: the guard is checked before the read. */
  events: ContextEventRow[];
}

/**
 * A chat that a name in the question picked out (v7 §6, lever 1). Either the
 * chat is called that, or someone who speaks in it is.
 */
export interface ChannelNameMatch {
  channelId: string;
  channelName: string | null;
  /** The query token that matched, normalised. */
  token: string;
  via: "channel" | "actor";
  /** The person whose display name matched, when `via` is "actor". */
  actorId: string | null;
  actorName: string | null;
  /** The name IS the token, rather than carrying it as one of its words. */
  exact: boolean;
  /**
   * What backs the match: the chat's own non-reaction event count for a chat
   * name, and that person's messages in it for a person's name. Either way it
   * is how much this chat would have to say, so a name that resolves to an
   * empty chat sorts last instead of selecting it.
   */
  eventCount: number;
}

// ---- Internal snake_case rows ---------------------------------------------

interface RawContextRow {
  id: string;
  external_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  ts: string | null;
  kind: string | null;
  actor_name: string | null;
  from_me: number | null;
  text: string | null;
  media_description: string | null;
  transcript: string | null;
  link_url: string | null;
  link_title: string | null;
  link_description: string | null;
  reply_to_external_id: string | null;
  reply_to_text: string | null;
  revoked_at: string | null;
}

interface RawRankedRow extends RawContextRow {
  score: number;
  channel_boosted: number | null;
  [scored: string]: unknown;
}

interface RawAnchorRow {
  id: string;
  source_id: string | null;
  channel_id: string | null;
  external_id: string | null;
  ts: string | null;
}

// ---------------------------------------------------------------------------
// SQL fragments. Everything interpolated below comes from the module constants
// above — never from a caller — so the statements stay static and prepared once.
// ---------------------------------------------------------------------------

/**
 * How "me" appears in the source that owns the joined row, so a row can say
 * whether the user sent it. Correlated on `e.source_id` and keyed
 * `source.<id>.self_identity` (arch §3.3 leak 3) — one query, every source.
 */
const SELF_JID = /* sql */ `(SELECT value FROM app_state WHERE key = 'source.' || e.source_id || '.self_identity')`;

const CONTEXT_COLUMNS = /* sql */ `
  e.id                   AS id,
  e.external_id          AS external_id,
  e.channel_id           AS channel_id,
  ch.name                AS channel_name,
  e.ts                   AS ts,
  e.kind                 AS kind,
  a.display_name         AS actor_name,
  (a.source_ext_id IS NOT NULL AND a.source_ext_id = ${SELF_JID})
                         AS from_me,
  e.text                 AS text,
  e.media_description    AS media_description,
  e.transcript           AS transcript,
  e.link_url             AS link_url,
  e.link_title           AS link_title,
  e.link_description     AS link_description,
  e.reply_to_external_id AS reply_to_external_id,
  e.reply_to_text        AS reply_to_text,
  e.revoked_at           AS revoked_at
`;

const CONTEXT_JOINS = /* sql */ `
  FROM events e
  LEFT JOIN actors a    ON a.id = e.actor_id
  LEFT JOIN channels ch ON ch.id = e.channel_id
`;

/** The text a whole-channel read would actually inject, per row. */
const RETRIEVABLE_CHARS = /* sql */ `
  LENGTH(COALESCE(e.text, ''))
  + LENGTH(COALESCE(e.media_description, ''))
  + LENGTH(COALESCE(e.transcript, ''))
  + LENGTH(COALESCE(e.link_title, ''))
  + LENGTH(COALESCE(e.link_description, ''))
  + LENGTH(COALESCE(e.reply_to_text, ''))
`;

/**
 * The same row as the block would print it. Every part is charged with its
 * brackets and capped where the renderer caps it, because what the budget is
 * spending is LINES, not columns: 8,992 retrievable chars of one chat render to
 * 32,666 (v7 §6, lever 5).
 *
 * Deliberately a slight over-estimate — LENGTH() counts the whitespace the
 * renderer collapses, and each part is charged its joining space even when it
 * is the last one. A budget that guesses high excludes a borderline chat; one
 * that guesses low blows the context block it was supposed to be protecting.
 * The two things that count SHORT are both bounded and tiny beside the 31-char
 * frame: an ellipsis per truncated field, and one char per astral codepoint,
 * which SQLite counts once and JavaScript twice.
 */
const RENDERED_CHARS = /* sql */ `
  ${RENDER_LINE_CHARS}
  + LENGTH(e.id)
  + LENGTH(COALESCE(NULLIF(TRIM(a.display_name), ''), 'unknown'))
  + CASE WHEN a.source_ext_id IS NOT NULL AND a.source_ext_id = ${SELF_JID}
      THEN ${RENDER_SELF_CHARS} ELSE 0 END
  + CASE WHEN NULLIF(e.reply_to_text, '') IS NULL THEN 0
      ELSE ${RENDER_QUOTE_CHARS} + MIN(LENGTH(e.reply_to_text), ${RENDER_MAX_QUOTE_CHARS}) END
  + CASE WHEN e.revoked_at IS NULL THEN 0 ELSE ${RENDER_REVOKED_CHARS} END
  + CASE WHEN NULLIF(TRIM(e.text), '') IS NULL THEN 0
      ELSE 1 + MIN(LENGTH(TRIM(e.text)), ${RENDER_MAX_TEXT_CHARS}) END
  + CASE WHEN NULLIF(e.media_description, '') IS NULL THEN 0
      ELSE ${RENDER_DESCRIPTION_CHARS} + MIN(LENGTH(e.media_description), ${RENDER_MAX_DESCRIPTION_CHARS}) END
  + CASE WHEN NULLIF(e.transcript, '') IS NULL THEN 0
      ELSE ${RENDER_TRANSCRIPT_CHARS} + MIN(LENGTH(e.transcript), ${RENDER_MAX_TRANSCRIPT_CHARS}) END
  + CASE WHEN e.link_url IS NULL AND NULLIF(e.link_title, '') IS NULL THEN 0
      ELSE ${RENDER_LINK_CHARS} + LENGTH(COALESCE(e.link_url, ''))
           + CASE WHEN NULLIF(e.link_title, '') IS NULL THEN 0
               ELSE ${RENDER_LINK_TITLE_CHARS} + MIN(LENGTH(e.link_title), ${RENDER_MAX_LINK_CHARS}) END
           + CASE WHEN NULLIF(e.link_description, '') IS NULL THEN 0
               ELSE ${RENDER_LINK_BLURB_CHARS} + MIN(LENGTH(e.link_description), ${RENDER_MAX_LINK_CHARS}) END
      END
  + CASE WHEN NULLIF(TRIM(e.text), '') IS NULL
          AND NULLIF(e.reply_to_text, '') IS NULL
          AND NULLIF(e.media_description, '') IS NULL
          AND NULLIF(e.transcript, '') IS NULL
          AND e.link_url IS NULL AND NULLIF(e.link_title, '') IS NULL
          AND e.revoked_at IS NULL
      THEN ${RENDER_EMPTY_CHARS} + LENGTH(COALESCE(e.kind, 'message')) ELSE 0 END
`;

/** `bm25(events_fts, @w0, @w1, …)` — the caller's weights, one per column. */
const WEIGHTED_BM25 = `bm25(events_fts, ${EVENTS_FTS_COLUMNS.map(
  (_, i) => `@w${i}`,
).join(", ")})`;

/**
 * One bm25 per column, isolated by a unit weight on that column and zero on the
 * rest. A column that contributed nothing scores exactly 0, which is what makes
 * this a match TEST as well as a strength: FTS5 has no matchinfo, so there is no
 * other way to ask which column a hit came from.
 */
const PER_COLUMN_BM25 = EVENTS_FTS_COLUMNS.map(
  (_, i) =>
    `bm25(events_fts, ${EVENTS_FTS_COLUMNS.map((__, j) => (i === j ? "1.0" : "0")).join(
      ", ",
    )}) AS m${i}`,
).join(",\n      ");

/** A snippet per column, so the winner can be picked without a second query. */
const PER_COLUMN_SNIPPET = EVENTS_FTS_COLUMNS.map(
  (_, i) => `snippet(events_fts, ${i}, '', '', '…', @snippetTokens) AS s${i}`,
).join(",\n      ");

// ---------------------------------------------------------------------------
// Prepared-statement cache (same pattern as ingest.ts): rebuilt when the handle
// changes, which tests do by swapping SUPERTWIN_DB_PATH.
// ---------------------------------------------------------------------------

interface RetrievalStatements {
  db: Database.Database;
  searchRanked: Database.Statement;
  anchor: Database.Statement;
  windowBefore: Database.Statement;
  windowAfter: Database.Statement;
  byId: Database.Statement;
  byIds: Database.Statement;
  byExternalId: Database.Statement;
  repliesTo: Database.Statement;
  channelSize: Database.Statement;
  channelEvents: Database.Statement;
  channelsByName: Database.Statement;
  actorsByName: Database.Statement;
  channelEventCounts: Database.Statement;
  actorChannels: Database.Statement;
  searchInChannel: Database.Statement;
  channelEventIds: Database.Statement;
}

let stmts: RetrievalStatements | null = null;

function statements(): RetrievalStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;

  stmts = {
    db,
    // Reactions are excluded everywhere in here for the same reason they are in
    // the inbox: an emoji is not evidence.
    // The channel boost (v7 §6, lever 1) is a bound multiplier over an id list
    // carried as JSON, so naming a chat costs neither a second statement nor a
    // rebuilt query. An empty list matches nothing and every row scores × 1.
    searchRanked: db.prepare(`
      SELECT
        ${CONTEXT_COLUMNS},
        (e.channel_id IN (SELECT value FROM json_each(@boostChannels))) AS channel_boosted,
        CASE WHEN e.channel_id IN (SELECT value FROM json_each(@boostChannels))
          THEN @channelBoost ELSE 1.0
        END * ${WEIGHTED_BM25} AS score,
        ${PER_COLUMN_BM25},
        ${PER_COLUMN_SNIPPET}
      FROM events_fts f
      JOIN events e ON e.rowid = f.rowid
      LEFT JOIN actors a    ON a.id = e.actor_id
      LEFT JOIN channels ch ON ch.id = e.channel_id
      WHERE events_fts MATCH @match
        AND e.kind IS NOT 'reaction'
      ORDER BY score
      LIMIT @limit
    `),
    anchor: db.prepare(`
      SELECT id, source_id, channel_id, external_id, ts FROM events WHERE id = ?
    `),
    // (ts, id) is the same total order the inbox pages on, so a window is
    // exactly the neighbours the user would have scrolled past. Both halves ride
    // idx_events_channel_ts.
    windowBefore: db.prepare(`
      SELECT ${CONTEXT_COLUMNS}
      ${CONTEXT_JOINS}
      WHERE e.channel_id = @channelId
        AND e.kind IS NOT 'reaction'
        AND (e.ts < @ts OR (e.ts = @ts AND e.id < @id))
      ORDER BY e.ts DESC, e.id DESC
      LIMIT @limit
    `),
    windowAfter: db.prepare(`
      SELECT ${CONTEXT_COLUMNS}
      ${CONTEXT_JOINS}
      WHERE e.channel_id = @channelId
        AND e.kind IS NOT 'reaction'
        AND (e.ts > @ts OR (e.ts = @ts AND e.id > @id))
      ORDER BY e.ts ASC, e.id ASC
      LIMIT @limit
    `),
    byId: db.prepare(`
      SELECT ${CONTEXT_COLUMNS}
      ${CONTEXT_JOINS}
      WHERE e.id = @id
    `),
    // json_each keeps this ONE prepared statement whatever the id count is.
    byIds: db.prepare(`
      SELECT ${CONTEXT_COLUMNS}
      FROM events e
      JOIN json_each(@ids) j ON j.value = e.id
      LEFT JOIN actors a    ON a.id = e.actor_id
      LEFT JOIN channels ch ON ch.id = e.channel_id
    `),
    // external_id is only unique per source, so both halves of the key travel.
    byExternalId: db.prepare(`
      SELECT ${CONTEXT_COLUMNS}
      ${CONTEXT_JOINS}
      WHERE e.source_id IS @sourceId AND e.external_id = @externalId
    `),
    repliesTo: db.prepare(`
      SELECT ${CONTEXT_COLUMNS}
      ${CONTEXT_JOINS}
      WHERE e.reply_to_external_id = @externalId
        AND e.source_id IS @sourceId
        AND e.kind IS NOT 'reaction'
      ORDER BY e.ts ASC, e.id ASC
      LIMIT @limit
    `),
    // Measured before the rows are read: the point of the guard is NOT loading a
    // chat that cannot be included. The actors join is what lets the rendered
    // cost carry the sender's name, which is on every line.
    channelSize: db.prepare(`
      SELECT
        ch.name                       AS channel_name,
        COUNT(e.id)                   AS event_count,
        COALESCE(SUM(${RETRIEVABLE_CHARS}), 0) AS char_count,
        COALESCE(SUM(${RENDERED_CHARS}), 0)    AS rendered_chars
      FROM channels ch
      LEFT JOIN events e
        ON e.channel_id = ch.id AND e.kind IS NOT 'reaction'
      LEFT JOIN actors a ON a.id = e.actor_id
      WHERE ch.id = @channelId
    `),
    channelEvents: db.prepare(`
      SELECT ${CONTEXT_COLUMNS}
      ${CONTEXT_JOINS}
      WHERE e.channel_id = @channelId
        AND e.kind IS NOT 'reaction'
      ORDER BY e.ts ASC, e.id ASC
    `),
    // Name resolution (v7 §6, lever 1). LIKE is only a NARROWING pass — it says
    // which names are worth looking at, and the caller decides whether the token
    // is a whole word in one, because SQL has no word boundary and "raj" must
    // not select "Bharadwaj". Both tables are small; the scan is the cheap half.
    channelsByName: db.prepare(`
      SELECT ch.id AS id, ch.name AS name, j.value AS token
      FROM json_each(@tokens) j
      JOIN channels ch ON lower(ch.name) LIKE '%' || j.value || '%'
      WHERE ch.name IS NOT NULL
    `),
    actorsByName: db.prepare(`
      SELECT a.id AS id, a.display_name AS name, j.value AS token
      FROM json_each(@tokens) j
      JOIN actors a ON lower(a.display_name) LIKE '%' || j.value || '%'
      WHERE a.display_name IS NOT NULL
    `),
    channelEventCounts: db.prepare(`
      SELECT e.channel_id AS channel_id, COUNT(*) AS n
      FROM json_each(@ids) j
      JOIN events e ON e.channel_id = j.value
      WHERE e.kind IS NOT 'reaction'
      GROUP BY e.channel_id
    `),
    // Which chats a person actually speaks in, and how much — an actor is tied
    // to a channel only through the events they sent, over idx_events_actor.
    actorChannels: db.prepare(`
      SELECT
        e.actor_id   AS actor_id,
        e.channel_id AS channel_id,
        ch.name      AS channel_name,
        COUNT(*)     AS n
      FROM json_each(@ids) j
      JOIN events e ON e.actor_id = j.value
      LEFT JOIN channels ch ON ch.id = e.channel_id
      WHERE e.channel_id IS NOT NULL
        AND e.kind IS NOT 'reaction'
      GROUP BY e.actor_id, e.channel_id
    `),
    // The within-chat pass (retrieval/focus.ts). No channel boost and no
    // corpus-wide LIMIT to survive: once the chat is known, every message in it
    // is a candidate and bm25 only has to order them against each other.
    searchInChannel: db.prepare(`
      SELECT
        ${CONTEXT_COLUMNS},
        ${WEIGHTED_BM25} AS score,
        ${PER_COLUMN_BM25},
        ${PER_COLUMN_SNIPPET}
      FROM events_fts f
      JOIN events e ON e.rowid = f.rowid
      LEFT JOIN actors a    ON a.id = e.actor_id
      LEFT JOIN channels ch ON ch.id = e.channel_id
      WHERE events_fts MATCH @match
        AND e.channel_id = @channelId
        AND e.kind IS NOT 'reaction'
      ORDER BY score
      LIMIT @limit
    `),
    channelEventIds: db.prepare(`
      SELECT e.id AS id
      FROM events e
      JOIN json_each(@channelIds) j ON j.value = e.channel_id
      WHERE e.kind IS NOT 'reaction'
    `),
  };
  return stmts;
}

// ---- Ranked FTS search ----------------------------------------------------

export interface RankedSearchOptions {
  /**
   * An FTS5 MATCH expression, already built by the caller (stopword filtering
   * and query expansion are retrieval POLICY and live with the grounding layer).
   * An expression FTS5 cannot parse throws — a caller taking free text from a
   * user is the one that knows how it wants to degrade.
   */
  match: string;
  limit?: number;
  /** Per-column bm25 weights; anything omitted keeps its DEFAULT_FTS_WEIGHTS value. */
  weights?: FtsColumnWeights;
  /** Snippet width in tokens (FTS5 caps it at 64). */
  snippetTokens?: number;
  /**
   * Chats a name in the question resolved to (resolveChannelsByName). Rows in
   * them are scored `channelBoost` times better, which is how a name SELECTS a
   * conversation instead of competing with it as a token nothing indexes.
   */
  boostChannelIds?: readonly string[];
  /** Multiplier for those rows (default DEFAULT_CHANNEL_BOOST). */
  channelBoost?: number;
}

/**
 * Ranked FTS hits, best first, each carrying the column it matched in and a
 * snippet cut from THAT column.
 *
 * Both halves are the same bug: `MATCH` searches all seven columns while
 * `snippet(events_fts, 0, …)` extracts from the message text, so a row that
 * matched only in `transcript` was injected into the prompt as a blank line and
 * spent one of the eight slots on nothing.
 */
export function searchEventsRanked(opts: RankedSearchOptions): RankedEventHit[] {
  const match = opts.match.trim();
  if (match.length === 0) return [];

  const weights = EVENTS_FTS_COLUMNS.map((col) => {
    const w = opts.weights?.[col];
    return Number.isFinite(w) ? (w as number) : DEFAULT_FTS_WEIGHTS[col];
  });
  const boost = Number(opts.channelBoost);
  const params: Record<string, unknown> = {
    match,
    limit: clampCount(opts.limit, 24, 200),
    snippetTokens: clampCount(opts.snippetTokens, 18, 64),
    boostChannels: JSON.stringify([
      ...new Set((opts.boostChannelIds ?? []).filter((id) => typeof id === "string" && id !== "")),
    ]),
    channelBoost: Number.isFinite(boost) && boost > 0 ? boost : DEFAULT_CHANNEL_BOOST,
  };
  weights.forEach((w, i) => {
    params[`w${i}`] = w;
  });

  const rows = statements().searchRanked.all(params) as RawRankedRow[];
  return rows.map((row) => {
    const index = matchedColumnIndex(row, weights);
    return {
      ...toContextRow(row),
      score: row.score,
      channelBoosted: Boolean(row.channel_boosted),
      matchedColumn: EVENTS_FTS_COLUMNS[index],
      matchedColumnIndex: index,
      snippet: pickSnippet(row, index),
    };
  });
}

/**
 * The column whose own bm25, weighted as the caller asked, contributed most.
 * Columns that contributed nothing score exactly 0, so this only ever picks a
 * column the row genuinely matched in.
 */
function matchedColumnIndex(row: RawRankedRow, weights: number[]): number {
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < EVENTS_FTS_COLUMNS.length; i++) {
    const raw = Number(row[`m${i}`]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const weighted = raw * weights[i];
    if (weighted < bestScore) {
      bestScore = weighted;
      best = i;
    }
  }
  // Every column at zero means every weight was zero, not that nothing matched;
  // column 0 is then as good an answer as any.
  return best;
}

/**
 * The snippet for the matched column, falling back through the others rather
 * than ever returning "". An empty hit is worse than a slightly-off one: it
 * tells the model a message exists and says nothing about it.
 */
function pickSnippet(row: RawRankedRow, index: number): string {
  const at = (i: number): string => String(row[`s${i}`] ?? "").trim();
  const chosen = at(index);
  if (chosen.length > 0) return chosen;
  for (let i = 0; i < EVENTS_FTS_COLUMNS.length; i++) {
    const s = at(i);
    if (s.length > 0) return s;
  }
  return "";
}

export interface ChannelSearchOptions {
  channelId: string;
  /** An FTS5 MATCH expression, built by the caller exactly as above. */
  match: string;
  limit?: number;
  weights?: FtsColumnWeights;
  snippetTokens?: number;
}

/**
 * Ranked hits from ONE chat's whole history.
 *
 * The corpus-wide search answers "which messages anywhere match", and a window
 * around those answers "what was being said at the time". Neither can answer
 * "which messages in THIS chat are about this", which is what a question about a
 * person is: the evidence is spread over days, so it is neither near a hit nor
 * near itself. Once name resolution has picked the chat, the chat is the
 * candidate pool and distance stops being the right question.
 */
export function searchChannelRanked(opts: ChannelSearchOptions): RankedEventHit[] {
  const match = opts.match.trim();
  if (match.length === 0 || !opts.channelId) return [];

  const weights = EVENTS_FTS_COLUMNS.map((col) => {
    const w = opts.weights?.[col];
    return Number.isFinite(w) ? (w as number) : DEFAULT_FTS_WEIGHTS[col];
  });
  const params: Record<string, unknown> = {
    match,
    channelId: opts.channelId,
    limit: clampCount(opts.limit, 40, 500),
    snippetTokens: clampCount(opts.snippetTokens, 18, 64),
  };
  weights.forEach((w, i) => {
    params[`w${i}`] = w;
  });

  const rows = statements().searchInChannel.all(params) as RawRankedRow[];
  return rows.map((row) => {
    const index = matchedColumnIndex(row, weights);
    return {
      ...toContextRow(row),
      score: row.score,
      channelBoosted: true,
      matchedColumn: EVENTS_FTS_COLUMNS[index],
      matchedColumnIndex: index,
      snippet: pickSnippet(row, index),
    };
  });
}

/**
 * Every non-reaction event id in the given chats. The candidate pool the
 * semantic tier recalibrates against when a question has named a chat — a
 * corpus-wide mean and deviation describe a different population.
 */
export function readChannelEventIds(channelIds: readonly string[]): string[] {
  const wanted = [
    ...new Set(channelIds.filter((id) => typeof id === "string" && id !== "")),
  ];
  if (wanted.length === 0) return [];
  const rows = statements().channelEventIds.all({
    channelIds: JSON.stringify(wanted),
  }) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Hydrate event ids into the same rows the other primitives return, in the
 * order they were ASKED for — a similarity ranking is the one ordering the
 * caller cannot recover from the row itself (`ts` it can). Ids with no row are
 * simply absent; duplicates come back once.
 *
 * This is how the semantic tier joins the rest: vector search gives ids and
 * nothing else.
 */
export function readEventsByIds(ids: readonly string[]): ContextEventRow[] {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
  if (wanted.length === 0) return [];
  const rows = statements().byIds.all({ ids: JSON.stringify(wanted) }) as RawContextRow[];
  const byId = new Map(rows.map((r) => [r.id, toContextRow(r)]));
  return wanted.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

// ---- Channel window -------------------------------------------------------

export interface ChannelWindowOptions {
  /** The hit to read around. */
  eventId: string;
  /** Messages before it (default 8) and after it (default 8). */
  before?: number;
  after?: number;
  /**
   * Minutes either side, ORed with the counts above (default 45). A side asked
   * for 0 messages stays empty whatever the span says — asking for none means
   * none, which is what pages a chat one direction at a time.
   */
  beforeMinutes?: number;
  afterMinutes?: number;
  /** Rows one side may return once a span is in play (default 60). */
  maxRows?: number;
}

/**
 * The messages around one event in its own chat, oldest → newest, anchor
 * included: the UNION of "the nearest N" and "everything within M minutes".
 *
 * Both halves are prefixes of the SAME order — nearest first — so their union
 * is simply the longer prefix, which is why one read per side still answers it.
 * The count alone was tuned on a sparse chat (§1, ±8 recovered 100% of what
 * ranking left out); on a dense one it spans five minutes, and the cluster that
 * answered the question sat 46 messages but 27 minutes away (v7 §6, lever 2).
 *
 * Empty when the event is unknown; just the anchor when it belongs to no
 * channel, or when the anchor has no timestamp to measure a span from.
 */
export function readChannelWindow(opts: ChannelWindowOptions): ContextEventRow[] {
  const s = statements();
  const anchor = s.anchor.get(opts.eventId) as RawAnchorRow | undefined;
  if (!anchor) return [];

  const self = s.byId.get({ id: anchor.id }) as RawContextRow | undefined;
  if (!anchor.channel_id) return self ? [toContextRow(self)] : [];

  const key = {
    channelId: anchor.channel_id,
    ts: anchor.ts,
    id: anchor.id,
  };
  const at = Date.parse(anchor.ts ?? "");
  const maxRows = clampCount(opts.maxRows, DEFAULT_WINDOW_MAX_ROWS, 500);
  const side = (
    count: number | undefined,
    minutes: number | undefined,
  ): { count: number; spanMs: number; limit: number } => {
    const n = clampCount(count, DEFAULT_WINDOW, 200);
    const span = Number.isFinite(at)
      ? clampCount(minutes, DEFAULT_WINDOW_MINUTES, 24 * 60) * 60_000
      : 0;
    return { count: n, spanMs: span, limit: n === 0 ? 0 : Math.max(n, span > 0 ? maxRows : 0) };
  };

  const behind = side(opts.before, opts.beforeMinutes);
  const ahead = side(opts.after, opts.afterMinutes);
  const before = trimToWindow(
    s.windowBefore.all({ ...key, limit: behind.limit }) as RawContextRow[],
    behind,
    at,
  );
  const after = trimToWindow(
    s.windowAfter.all({ ...key, limit: ahead.limit }) as RawContextRow[],
    ahead,
    at,
  );

  // `before` came back newest-first so the LIMIT took the NEAREST neighbours.
  before.reverse();
  return [...before, ...(self ? [self] : []), ...after].map(toContextRow);
}

/**
 * Keep the nearest `count` rows and everything inside `spanMs`. The rows arrive
 * nearest-first, so this is the union of the two prefixes; a row with no usable
 * timestamp cannot be placed in the span and so only survives on the count.
 */
function trimToWindow(
  rows: RawContextRow[],
  side: { count: number; spanMs: number },
  anchorAt: number,
): RawContextRow[] {
  if (side.spanMs === 0 || rows.length <= side.count) return rows.slice(0, side.count);
  return rows.filter((row, i) => {
    if (i < side.count) return true;
    const at = Date.parse(row.ts ?? "");
    return Number.isFinite(at) && Math.abs(at - anchorAt) <= side.spanMs;
  });
}

// ---- Reply chain ----------------------------------------------------------

export interface ReplyChainOptions {
  eventId: string;
  /** Hops followed in each direction (default 4). */
  maxDepth?: number;
  /** Total rows, anchor included (default 40). */
  limit?: number;
}

/**
 * The quoted-reply thread around one event, both directions, oldest → newest.
 * 96 edges are populated and idx_events_reply_to exists for exactly this walk;
 * nothing traversed it. Upwards is a chain (a message quotes at most one
 * message), downwards fans out (many messages may quote the same one).
 *
 * Reactions are skipped on the way down: they carry a reply_to_external_id too,
 * and a thread of emoji is not a thread.
 */
export function readReplyChain(opts: ReplyChainOptions): ReplyChainRow[] {
  const s = statements();
  const anchor = s.anchor.get(opts.eventId) as RawAnchorRow | undefined;
  if (!anchor) return [];
  const self = s.byId.get({ id: anchor.id }) as RawContextRow | undefined;
  if (!self) return [];

  const maxDepth = clampCount(opts.maxDepth, 4, 32);
  const limit = clampCount(opts.limit, 40, 500);
  const sourceId = anchor.source_id;
  const seen = new Set<string>([anchor.id]);
  const out: ReplyChainRow[] = [{ ...toContextRow(self), depth: 0 }];

  // Up: follow what each row quotes. A malformed chain that points back at
  // itself is a loop, so `seen` is a stop condition, not an optimisation.
  let cursor: RawContextRow = self;
  for (let depth = 1; depth <= maxDepth && out.length < limit; depth++) {
    const parentExternalId = cursor.reply_to_external_id;
    if (!parentExternalId) break;
    const parent = s.byExternalId.get({
      sourceId,
      externalId: parentExternalId,
    }) as RawContextRow | undefined;
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    out.push({ ...toContextRow(parent), depth: -depth });
    cursor = parent;
  }

  // Down: breadth-first, so the direct replies arrive before the replies to
  // them and a truncating `limit` cuts the least relevant end.
  let frontier: RawContextRow[] = [self];
  for (let depth = 1; depth <= maxDepth && out.length < limit; depth++) {
    const next: RawContextRow[] = [];
    for (const row of frontier) {
      if (!row.external_id) continue;
      const replies = s.repliesTo.all({
        sourceId,
        externalId: row.external_id,
        limit,
      }) as RawContextRow[];
      for (const reply of replies) {
        if (seen.has(reply.id) || out.length >= limit) continue;
        seen.add(reply.id);
        out.push({ ...toContextRow(reply), depth });
        next.push(reply);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return out.sort(byTimeThenId);
}

function byTimeThenId(a: ContextEventRow, b: ContextEventRow): number {
  const at = a.ts ?? "";
  const bt = b.ts ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---- Whole-channel read ---------------------------------------------------

export interface WholeChannelOptions {
  channelId: string;
  /** RENDERED chars the chat may cost (default 12,000). */
  maxChars?: number;
  /** Events it may carry (default 120). */
  maxEvents?: number;
}

/**
 * A whole chat when it is small enough to include, with the size reported
 * either way. The repro chat is 18 events / 864 chars — five times under the
 * budget the retrieval it defeated was already spending, so it could simply
 * have been handed over whole.
 *
 * The budget is spent in the chars the block will actually carry, not in the
 * chars the columns hold: the same 8,992 that read as a quarter of the budget
 * arrive as 32,666 once every line has an id, a time and a sender on it, and
 * deciding on the smaller number is how the wrong chat gets injected whole.
 *
 * The size is measured first and the rows are read only if they fit, so asking
 * about a 20 MB chat costs one aggregate.
 */
export function readWholeChannel(opts: WholeChannelOptions): WholeChannelRead {
  const s = statements();
  const size = s.channelSize.get({ channelId: opts.channelId }) as
    | {
        channel_name: string | null;
        event_count: number;
        char_count: number;
        rendered_chars: number;
      }
    | undefined;

  const maxChars = clampCount(opts.maxChars, DEFAULT_WHOLE_CHANNEL_MAX_CHARS, 200_000);
  const maxEvents = clampCount(opts.maxEvents, DEFAULT_WHOLE_CHANNEL_MAX_EVENTS, 2000);

  const eventCount = size?.event_count ?? 0;
  const charCount = size?.char_count ?? 0;
  const renderedCharCount = size?.rendered_chars ?? 0;
  // An unknown channel and an empty one are both "nothing to include", and
  // neither is over budget.
  const withinBudget =
    eventCount > 0 && eventCount <= maxEvents && renderedCharCount <= maxChars;

  return {
    channelId: opts.channelId,
    channelName: size?.channel_name ?? null,
    eventCount,
    charCount,
    renderedCharCount,
    withinBudget,
    events: withinBudget
      ? (s.channelEvents.all({ channelId: opts.channelId }) as RawContextRow[]).map(
          toContextRow,
        )
      : [],
  };
}

// ---- Name resolution ------------------------------------------------------

/**
 * The chats a question's names point at (v7 §6, lever 1).
 *
 * Retrieval had no concept of WHO: `events_fts` indexes seven columns and
 * neither the chat name nor the sender name is among them, so "how is
 * pranjali's health" degraded to a bare topic search — `pranjali` appears in
 * exactly ONE indexed row in the whole database, an unrelated selfie's
 * description. A lookup rather than an eighth FTS column, deliberately:
 *
 *   - a name is not evidence, it is a SELECTOR. Indexing it would put it back
 *     in the bm25 pool it was already losing in, and every row of a chat would
 *     carry the chat's name whether or not anyone said it.
 *   - `channels.name` / `actors.display_name` live on their own rows and change
 *     under the user's hands (a contact rename, a group retitle). An FTS column
 *     over them is a denormalised copy per event that has to be re-synced;
 *     these two statements always read the current name.
 *
 * The result feeds `searchEventsRanked({ boostChannelIds })`. Matching is
 * whole-word and case-insensitive: a name IS the token or CARRIES it as a word,
 * never as a fragment. Case folding on non-ASCII names is SQLite's, i.e. none,
 * so a name is matched in the case it is stored in.
 */
export function resolveChannelsByName(
  tokens: readonly string[],
  opts?: { limit?: number },
): ChannelNameMatch[] {
  const wanted = normaliseNameTokens(tokens);
  if (wanted.length === 0) return [];
  const s = statements();
  const args = { tokens: JSON.stringify(wanted) };

  const out: ChannelNameMatch[] = [];

  const channelRows = (s.channelsByName.all(args) as NameRow[]).filter((r) =>
    nameMatch(r.name, r.token),
  );
  const counts = channelEventCounts(channelRows.map((r) => r.id));
  for (const row of channelRows) {
    out.push({
      channelId: row.id,
      channelName: row.name,
      token: row.token,
      via: "channel",
      actorId: null,
      actorName: null,
      exact: isExactName(row.name, row.token),
      eventCount: counts.get(row.id) ?? 0,
    });
  }

  const actorRows = (s.actorsByName.all(args) as NameRow[]).filter((r) =>
    nameMatch(r.name, r.token),
  );
  if (actorRows.length > 0) {
    const byActor = new Map(actorRows.map((r) => [r.id, r]));
    const rows = s.actorChannels.all({
      ids: JSON.stringify([...byActor.keys()]),
    }) as {
      actor_id: string;
      channel_id: string;
      channel_name: string | null;
      n: number;
    }[];
    for (const row of rows) {
      const actor = byActor.get(row.actor_id)!;
      out.push({
        channelId: row.channel_id,
        channelName: row.channel_name,
        token: actor.token,
        via: "actor",
        actorId: row.actor_id,
        actorName: actor.name,
        exact: isExactName(actor.name, actor.token),
        eventCount: row.n,
      });
    }
  }

  // Best evidence first: the chat literally called that, then the one with the
  // most from the person called that. A caller taking the top match alone gets
  // the one it would have picked anyway.
  out.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.eventCount - a.eventCount ||
      (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0),
  );
  return out.slice(0, clampCount(opts?.limit, 8, 100));
}

interface NameRow {
  id: string;
  name: string | null;
  token: string;
}

function channelEventCounts(ids: readonly string[]): Map<string, number> {
  const wanted = [...new Set(ids)];
  const counts = new Map<string, number>();
  if (wanted.length === 0) return counts;
  const rows = statements().channelEventCounts.all({
    ids: JSON.stringify(wanted),
  }) as { channel_id: string; n: number }[];
  for (const row of rows) counts.set(row.channel_id, row.n);
  return counts;
}

/**
 * Lowercase, stripped of the punctuation a query drags along, deduped, and
 * short tokens dropped. `%` and `_` survive as themselves only inside a longer
 * token — they widen the LIKE narrowing pass, never the word check that
 * follows, so the worst they cost is a few extra names to look at.
 */
function normaliseNameTokens(tokens: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of tokens) {
    if (typeof raw !== "string") continue;
    const token = raw
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[^\p{L}\p{N}]+$/u, "");
    if (token.length >= NAME_TOKEN_MIN_CHARS) out.add(token);
  }
  return [...out];
}

function isExactName(name: string | null, token: string): boolean {
  return (name ?? "").trim().toLowerCase() === token;
}

/** The token is the whole name, or one of its words — never part of a word. */
function nameMatch(name: string | null, token: string): boolean {
  const value = (name ?? "").trim().toLowerCase();
  if (value === token) return true;
  const boundary = "[^\\p{L}\\p{N}]";
  return new RegExp(`(^|${boundary})${escapeRegExp(token)}(${boundary}|$)`, "u").test(
    value,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Shared mapping / utilities -------------------------------------------

function toContextRow(r: RawContextRow): ContextEventRow {
  return {
    id: r.id,
    externalId: r.external_id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    ts: r.ts,
    kind: r.kind,
    actorName: r.actor_name,
    fromMe: Boolean(r.from_me),
    text: r.text,
    mediaDescription: r.media_description,
    transcript: r.transcript,
    linkUrl: r.link_url,
    linkTitle: r.link_title,
    linkDescription: r.link_description,
    replyToExternalId: r.reply_to_external_id,
    replyToText: r.reply_to_text,
    revokedAt: r.revoked_at,
  };
}

function clampCount(raw: number | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}
