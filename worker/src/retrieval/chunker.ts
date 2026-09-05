// ===========================================================================
// The chunker — what gets a vector (V6 P1 S2.2; Build §5.1, Product_V6 §23.4
// "The index", backlog T5-3 "embed chunks, not events").
//
// One vector per EVENT was the wrong unit twice over: 63.7% of real messages
// are 1–39 chars and carry no meaning of their own for a vector to hold, and
// 730 K of them is 730 K vectors. A length filter is the wrong fix — the short
// ones carry the identity ("yes, book it" IS the confirmation). So the unit is
// the CHUNK, and this module cuts them:
//
//   chat      rolling ~2,000-char window per stream, in ts order, every line
//             prefixed with who said it. A short message is found through the
//             window that contains it (RET-03). Sealed windows are never re-cut;
//             the trailing open window is rewritten as messages arrive.
//   screen    ~2,000-char windows of the RECONSTRUCTED document per stream
//             (doc_key): the diffs the snapshots carry, concatenated in ts
//             order. Recomputed whenever the stream gains a snapshot (the
//             re-anchor): unchanged windows keep their row and vector (same
//             hash → same chunk), changed ones are replaced.
//   browser   one per visit — title plus the URL stripped of query and
//             fragment — deduped by content hash within the host (the same
//             page visited ten times is one vector).
//   cards     episode summaries, space cards (label · goal · status), the
//             active version of every claim, people cards (name · kind ·
//             circle). One chunk per card, replaced when its text changes.
//
// Everything here is SQLite-only and synchronous: no model, no network. The
// embedding half (chunk-index.ts) picks up whatever this leaves without a
// vector. Per-stream progress lives in app_state so a pass costs the streams
// that changed, never the whole log.
// ===========================================================================

import { getDb } from "../db/connection.js";
import {
  chunkHash,
  chunksFor,
  upsertChunk,
  type ChunkKind,
} from "../db/v6graph.js";
import { SELF_ENTITY_ID } from "../db/migrations/0201_v6_graph.js";

/** Target size of a rolling window (T5-3: ~2,000 chars). */
export const CHUNK_TARGET_CHARS = 2_000;

/** One event's line is clipped here so a pasted essay does not become one window of one message. */
export const MAX_LINE_CHARS = 1_200;

/** Sources whose events are cut as documents / visits rather than as chat. */
export const SCREEN_SOURCE = "screen";
export const BROWSER_SOURCE = "browser";

const WATERMARK_PREFIX = "chunker.chat.";

export interface ChunkerReport {
  chatStreams: number;
  chatChunks: number;
  screenStreams: number;
  screenChunks: number;
  browserChunks: number;
  cardChunks: number;
}

interface EventRow {
  rowid: number;
  id: string;
  source: string | null;
  kind: string | null;
  stream_key: string | null;
  ts: string | null;
  actor: string | null;
  actor_name: string | null;
  text: string | null;
  transcript: string | null;
  media_description: string | null;
  link_title: string | null;
  payload_json: string | null;
  tier: number | null;
  consent_id: string | null;
}

// Every chunkable row reads through this one projection. `stream_key` falls
// back to the legacy stream/channel id so rows written by db/ingest.ts before
// the envelope carried a key still group by conversation.
const EVENT_SELECT = /* sql */ `
  SELECT e.rowid AS rowid, e.id AS id,
         COALESCE(e.source_id, e.source_type) AS source,
         e.kind AS kind,
         COALESCE(e.stream_key, e.stream_id, e.channel_id) AS stream_key,
         e.ts AS ts, e.actor AS actor, a.display_name AS actor_name,
         e.text AS text, e.transcript AS transcript, e.media_description AS media_description,
         e.link_title AS link_title, e.payload_json AS payload_json,
         e.tier AS tier, e.consent_id AS consent_id
    FROM events e
    LEFT JOIN actors a ON a.id = e.actor_id
`;

const CHAT_WHERE = /* sql */ `
  e.revoked_at IS NULL
  AND e.kind IS NOT 'reaction'
  AND COALESCE(e.source_id, e.source_type, '') NOT IN ('${SCREEN_SOURCE}', '${BROWSER_SOURCE}')
`;

// ---- Text -------------------------------------------------------------------

function squash(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** "contact:rohan" → "rohan"; "self" → "me"; a display name wins when there is one. */
export function actorLabel(row: { actor: string | null; actor_name: string | null }): string {
  if (row.actor_name && row.actor_name.trim()) return row.actor_name.trim();
  const a = (row.actor ?? "").trim();
  if (!a) return "?";
  if (a === "self") return "me";
  const i = a.indexOf(":");
  return i >= 0 ? a.slice(i + 1) || a : a;
}

/** The text one chat event contributes to its window. Empty when it has none. */
export function chatLine(row: EventRow): string {
  const body = [row.text, row.transcript, row.media_description, row.link_title]
    .map(squash)
    .filter((p) => p.length > 0)
    .join(" · ");
  if (!body) return "";
  const line = `${actorLabel(row)}: ${body}`;
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

/**
 * Cut lines into windows of at most `target` chars (a single oversize line is
 * its own window). Returns the windows with the indexes of the lines each one
 * covers. Pure, so a re-cut over the same lines is the same cut.
 */
export function cutWindows(
  lines: readonly string[],
  target = CHUNK_TARGET_CHARS,
): { text: string; from: number; to: number }[] {
  const out: { text: string; from: number; to: number }[] = [];
  let buf: string[] = [];
  let len = 0;
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = line.length + (buf.length ? 1 : 0);
    if (buf.length > 0 && len + add > target) {
      out.push({ text: buf.join("\n"), from, to: i - 1 });
      buf = [];
      len = 0;
      from = i;
    }
    buf.push(line);
    len += buf.length === 1 ? line.length : line.length + 1;
  }
  if (buf.length > 0) out.push({ text: buf.join("\n"), from, to: lines.length - 1 });
  return out;
}

/** URL without scheme, query, fragment or trailing slash — what a visit is "about". */
export function stripUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const cut = u.search(/[?#]/);
  if (cut >= 0) u = u.slice(0, cut);
  u = u.replace(/^www\./i, "").replace(/\/+$/, "");
  return u;
}

function hostOf(url: string): string {
  const stripped = stripUrl(url);
  const slash = stripped.indexOf("/");
  return (slash >= 0 ? stripped.slice(0, slash) : stripped).toLowerCase();
}

// ---- Watermarks ---------------------------------------------------------------

interface ChatMark {
  /** Highest events.rowid inside a SEALED window. */
  sealedRowid: number;
  /** Highest events.rowid the pass has seen at all (open window included). */
  seenRowid: number;
  /** Ordinal of the next window to write. */
  nextSeq: number;
  /** Chunk id of the trailing open window, if one is written. */
  openId: number | null;
}

function markKey(source: string, streamKey: string): string {
  return `${WATERMARK_PREFIX}${source}¦${streamKey}`;
}

function readMark(source: string, streamKey: string): ChatMark {
  const row = getDb()
    .prepare(`SELECT value FROM app_state WHERE key = ?`)
    .get(markKey(source, streamKey)) as { value: string | null } | undefined;
  if (row?.value) {
    try {
      const p = JSON.parse(row.value) as Partial<ChatMark>;
      return {
        sealedRowid: Number(p.sealedRowid ?? 0),
        seenRowid: Number(p.seenRowid ?? p.sealedRowid ?? 0),
        nextSeq: Number(p.nextSeq ?? 0),
        openId: typeof p.openId === "number" ? p.openId : null,
      };
    } catch {
      /* fall through to a fresh mark */
    }
  }
  return { sealedRowid: 0, seenRowid: 0, nextSeq: 0, openId: null };
}

function writeMark(source: string, streamKey: string, mark: ChatMark): void {
  getDb()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(markKey(source, streamKey), JSON.stringify(mark));
}

/** Test hook / full rebuild: forget every stream's progress. Chunks stay. */
export function resetChunkerMarks(): void {
  getDb().prepare(`DELETE FROM app_state WHERE key LIKE ?`).run(`${WATERMARK_PREFIX}%`);
}

// ---- Chat -----------------------------------------------------------------------

function chatStreamsWithNews(): { source: string; stream_key: string }[] {
  // Streams whose newest row is past their sealed watermark (or that have no
  // mark yet). Cheap: one GROUP BY over the log, compared against app_state.
  return getDb()
    .prepare(
      `SELECT s.source, s.stream_key
         FROM (SELECT COALESCE(e.source_id, e.source_type) AS source,
                      COALESCE(e.stream_key, e.stream_id, e.channel_id) AS stream_key,
                      MAX(e.rowid) AS max_rowid
                 FROM events e
                WHERE ${CHAT_WHERE}
                GROUP BY 1, 2) s
         LEFT JOIN app_state m ON m.key = '${WATERMARK_PREFIX}' || s.source || '¦' || s.stream_key
        WHERE s.source IS NOT NULL AND s.stream_key IS NOT NULL
          AND (m.value IS NULL OR s.max_rowid > COALESCE(json_extract(m.value, '$.seenRowid'), 0))`,
    )
    .all() as { source: string; stream_key: string }[];
}

function unsealedEvents(source: string, streamKey: string, afterRowid: number): EventRow[] {
  return getDb()
    .prepare(
      `${EVENT_SELECT}
        WHERE ${CHAT_WHERE}
          AND COALESCE(e.source_id, e.source_type) = ?
          AND COALESCE(e.stream_key, e.stream_id, e.channel_id) = ?
          AND e.rowid > ?
        ORDER BY e.ts, e.rowid`,
    )
    .all(source, streamKey, afterRowid) as EventRow[];
}

function writeWindow(
  kind: ChunkKind,
  source: string,
  streamKey: string,
  seq: number,
  text: string,
  rows: readonly EventRow[],
): number {
  const tiers = rows.map((r) => r.tier).filter((t): t is number => typeof t === "number");
  return upsertChunk({
    kind,
    source,
    streamKey,
    seq,
    text,
    tsStart: rows[0]?.ts ?? null,
    tsEnd: rows[rows.length - 1]?.ts ?? null,
    eventIds: rows.map((r) => r.id),
    tier: tiers.length ? Math.max(...tiers) : null,
    consentId: rows[rows.length - 1]?.consent_id ?? null,
  }).id;
}

/**
 * One stream's pass: cut everything after the sealed watermark, seal every
 * window but the last, rewrite the open one. Returns chunks written.
 */
function chunkChatStream(source: string, streamKey: string): number {
  const db = getDb();
  return db.transaction(() => {
    const mark = readMark(source, streamKey);
    const rows = unsealedEvents(source, streamKey, mark.sealedRowid);
    const seenRowid = rows.reduce((m, r) => Math.max(m, r.rowid), mark.seenRowid);
    const lined = rows.map((r) => ({ row: r, line: chatLine(r) })).filter((x) => x.line.length > 0);
    if (lined.length === 0) {
      writeMark(source, streamKey, { ...mark, seenRowid });
      return 0;
    }

    const windows = cutWindows(lined.map((x) => x.line));
    let written = 0;
    let seq = mark.nextSeq;
    let sealedRowid = mark.sealedRowid;
    let openId = mark.openId;

    for (let w = 0; w < windows.length; w++) {
      const win = windows[w];
      const covered = lined.slice(win.from, win.to + 1).map((x) => x.row);
      const isLast = w === windows.length - 1;
      if (isLast) {
        // The open window: replace the previous open chunk unless it is the
        // same text (same hash → upsert is a no-op and the vector survives).
        if (openId !== null) {
          const prev = db.prepare(`SELECT content_hash FROM chunks WHERE id = ?`).get(openId) as
            | { content_hash: string }
            | undefined;
          if (prev && prev.content_hash !== chunkHash(win.text)) {
            db.prepare(`DELETE FROM chunks WHERE id = ?`).run(openId);
            openId = null;
          } else if (prev) {
            // Unchanged open window — refresh its ids/ts only.
            writeWindow("chat", source, streamKey, seq, win.text, covered);
            break;
          } else {
            openId = null;
          }
        }
        openId = writeWindow("chat", source, streamKey, seq, win.text, covered);
        written++;
      } else {
        const id = writeWindow("chat", source, streamKey, seq, win.text, covered);
        if (openId !== null && openId !== id) {
          // What used to be the open window is now sealed content cut
          // differently: the old open row goes. Same text → same row, and its
          // vector survives the sealing.
          db.prepare(`DELETE FROM chunks WHERE id = ?`).run(openId);
        }
        openId = null;
        written++;
        seq++;
        sealedRowid = Math.max(sealedRowid, ...covered.map((r) => r.rowid));
      }
    }
    writeMark(source, streamKey, { sealedRowid, seenRowid, nextSeq: seq, openId });
    return written;
  })();
}

export function chunkChatStreams(): { streams: number; chunks: number } {
  let chunks = 0;
  const streams = chatStreamsWithNews();
  for (const s of streams) chunks += chunkChatStream(s.source, s.stream_key);
  return { streams: streams.length, chunks };
}

// ---- Screen ---------------------------------------------------------------------

const SCREEN_MARK_PREFIX = "chunker.screen.";

function screenStreamsWithNews(): { stream_key: string; max_rowid: number }[] {
  return getDb()
    .prepare(
      `SELECT s.stream_key, s.max_rowid
         FROM (SELECT COALESCE(e.stream_key, e.stream_id, e.channel_id) AS stream_key, MAX(e.rowid) AS max_rowid
                 FROM events e
                WHERE COALESCE(e.source_id, e.source_type) = '${SCREEN_SOURCE}' AND e.revoked_at IS NULL
                GROUP BY 1) s
         LEFT JOIN app_state m ON m.key = '${SCREEN_MARK_PREFIX}' || s.stream_key
        WHERE s.stream_key IS NOT NULL
          AND (m.value IS NULL OR s.max_rowid > CAST(m.value AS INTEGER))`,
    )
    .all() as { stream_key: string; max_rowid: number }[];
}

/**
 * The reconstructed document of one screen stream: the snapshots' diffs in ts
 * order. The first snapshot of a stream carries the full text and each later
 * one the new characters, so the concatenation is everything the user saw in
 * that document, in the order it appeared.
 */
export function reconstructScreenDocument(streamKey: string): {
  text: string;
  rows: EventRow[];
} {
  const rows = getDb()
    .prepare(
      `${EVENT_SELECT}
        WHERE COALESCE(e.source_id, e.source_type) = '${SCREEN_SOURCE}' AND e.revoked_at IS NULL
          AND COALESCE(e.stream_key, e.stream_id, e.channel_id) = ?
        ORDER BY e.ts, e.rowid`,
    )
    .all(streamKey) as EventRow[];
  const parts: string[] = [];
  for (const r of rows) {
    const t = squash(r.text);
    if (t) parts.push(t);
  }
  return { text: parts.join("\n"), rows };
}

/** Split a document into ≤ target windows on whitespace where possible. */
export function cutDocument(text: string, target = CHUNK_TARGET_CHARS): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > target) {
    let cut = rest.lastIndexOf(" ", target);
    const nl = rest.lastIndexOf("\n", target);
    cut = Math.max(cut, nl);
    if (cut < target * 0.5) cut = target;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out.filter((w) => w.length > 0);
}

function chunkScreenStream(streamKey: string, maxRowid: number): number {
  const db = getDb();
  return db.transaction(() => {
    const doc = reconstructScreenDocument(streamKey);
    const windows = cutDocument(doc.text);
    const keep = new Set<string>();
    let written = 0;
    const first = doc.rows[0];
    const last = doc.rows[doc.rows.length - 1];
    const tiers = doc.rows.map((r) => r.tier).filter((t): t is number => typeof t === "number");
    let title: string | null = null;
    if (last?.payload_json) {
      try {
        const p = JSON.parse(last.payload_json) as { window_title?: string; app_name?: string };
        title = [p.app_name, p.window_title].map(squash).filter(Boolean).join(" — ") || null;
      } catch {
        title = null;
      }
    }
    windows.forEach((w, i) => {
      const text = title && i === 0 ? `${title}\n${w}` : w;
      keep.add(chunkHash(text));
      const r = upsertChunk({
        kind: "screen",
        source: SCREEN_SOURCE,
        streamKey,
        seq: i,
        text,
        tsStart: first?.ts ?? null,
        tsEnd: last?.ts ?? null,
        eventIds: doc.rows.map((x) => x.id),
        tier: tiers.length ? Math.max(...tiers) : null,
        consentId: last?.consent_id ?? null,
      });
      if (r.inserted) written++;
    });
    // Windows the re-anchor no longer produces go, with their vectors.
    for (const c of chunksFor("screen", { streamKey })) {
      if (!keep.has(c.contentHash)) db.prepare(`DELETE FROM chunks WHERE id = ?`).run(c.id);
    }
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(`${SCREEN_MARK_PREFIX}${streamKey}`, String(maxRowid));
    return written;
  })();
}

export function chunkScreenStreams(): { streams: number; chunks: number } {
  let chunks = 0;
  const streams = screenStreamsWithNews();
  for (const s of streams) chunks += chunkScreenStream(s.stream_key, s.max_rowid);
  return { streams: streams.length, chunks };
}

// ---- Browser ---------------------------------------------------------------------

const BROWSER_MARK_KEY = "chunker.browser.rowid";

/** What a visit is embedded as: the page title, then the URL without noise. */
export function browserVisitText(payload: { url?: unknown; title?: unknown } | null, fallbackText: string | null): string {
  const title = squash(typeof payload?.title === "string" ? payload.title : "");
  const url = typeof payload?.url === "string" ? stripUrl(payload.url) : "";
  const parts = [title, url].filter(Boolean);
  if (parts.length === 0) return squash(fallbackText);
  return parts.join(" · ");
}

export function chunkBrowserVisits(): number {
  const db = getDb();
  const mark = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(BROWSER_MARK_KEY) as
    | { value: string | null }
    | undefined;
  const after = Number(mark?.value ?? 0) || 0;
  const rows = db
    .prepare(
      `${EVENT_SELECT}
        WHERE COALESCE(e.source_id, e.source_type) = '${BROWSER_SOURCE}' AND e.revoked_at IS NULL
          AND e.rowid > ?
        ORDER BY e.rowid
        LIMIT 5000`,
    )
    .all(after) as EventRow[];
  if (rows.length === 0) return 0;
  return db.transaction(() => {
    let written = 0;
    let maxRowid = after;
    for (const r of rows) {
      maxRowid = Math.max(maxRowid, r.rowid);
      let payload: { url?: unknown; title?: unknown } | null = null;
      if (r.payload_json) {
        try {
          payload = JSON.parse(r.payload_json) as { url?: unknown; title?: unknown };
        } catch {
          payload = null;
        }
      }
      const text = browserVisitText(payload, r.text);
      if (!text) continue;
      const host = typeof payload?.url === "string" ? hostOf(payload.url) : (r.stream_key ?? "browser");
      const res = upsertChunk({
        kind: "browser",
        source: BROWSER_SOURCE,
        streamKey: host || "browser",
        refId: r.id,
        seq: 0,
        text,
        tsStart: r.ts,
        tsEnd: r.ts,
        eventIds: [r.id],
        tier: r.tier,
        consentId: r.consent_id,
      });
      if (res.inserted) written++;
    }
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(BROWSER_MARK_KEY, String(maxRowid));
    return written;
  })();
}

// ---- Cards -------------------------------------------------------------------------

interface Card {
  kind: ChunkKind;
  refId: string;
  text: string;
  ts?: string | null;
}

function tableExists(name: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name);
}

function episodeCards(): Card[] {
  if (!tableExists("episodes")) return [];
  const rows = getDb()
    .prepare(`SELECT id, summary, last_ts FROM episodes WHERE summary IS NOT NULL AND TRIM(summary) <> ''`)
    .all() as { id: string; summary: string; last_ts: string | null }[];
  return rows.map((r) => ({ kind: "episode", refId: r.id, text: squash(r.summary), ts: r.last_ts }));
}

function spaceCards(): Card[] {
  if (!tableExists("spaces")) return [];
  const cols = new Set(
    (getDb().prepare(`PRAGMA table_info(spaces)`).all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has("label")) return [];
  const rows = getDb()
    .prepare(`SELECT id, label, ${cols.has("goal") ? "goal" : "NULL AS goal"}, ${cols.has("status") ? "status" : "NULL AS status"},
                     ${cols.has("life_area") ? "life_area" : "NULL AS life_area"}, ${cols.has("updated_at") ? "updated_at" : "NULL AS updated_at"}
                FROM spaces WHERE label IS NOT NULL ${cols.has("archived_at") ? "AND archived_at IS NULL" : ""}`)
    .all() as { id: string; label: string; goal: string | null; status: string | null; life_area: string | null; updated_at: string | null }[];
  return rows
    .map((r) => {
      const parts = [squash(r.label), squash(r.goal), [r.life_area, r.status].map(squash).filter(Boolean).join(" · ")].filter(Boolean);
      return { kind: "space" as ChunkKind, refId: r.id, text: parts.join("\n"), ts: r.updated_at };
    })
    .filter((c) => c.text.length > 0);
}

function claimCards(): Card[] {
  if (!tableExists("claims") || !tableExists("claim_versions")) return [];
  const rows = getDb()
    .prepare(
      `SELECT c.claim_key AS claim_key, v.text AS text, c.last_stated_at AS ts
         FROM claims c JOIN claim_versions v ON v.id = c.active_version_id
        WHERE c.status = 'active' AND v.text IS NOT NULL AND TRIM(v.text) <> ''`,
    )
    .all() as { claim_key: string; text: string; ts: string | null }[];
  return rows.map((r) => ({ kind: "claim", refId: r.claim_key, text: squash(r.text), ts: r.ts }));
}

function peopleCards(): Card[] {
  if (!tableExists("entities")) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, canonical, subtype, circle, last_seen_at
         FROM entities
        WHERE type = 'person' AND merged_into IS NULL AND id <> ? AND canonical IS NOT NULL AND TRIM(canonical) <> ''`,
    )
    .all(SELF_ENTITY_ID) as { id: string; canonical: string; subtype: string | null; circle: string | null; last_seen_at: string | null }[];
  return rows.map((r) => ({
    kind: "person",
    refId: r.id,
    text: [squash(r.canonical), [r.subtype, r.circle].map(squash).filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
    ts: r.last_seen_at,
  }));
}

/** Write every card whose text changed; drop the card chunks of refs that vanished. */
export function chunkCards(): number {
  const db = getDb();
  const cards = [...episodeCards(), ...spaceCards(), ...claimCards(), ...peopleCards()];
  return db.transaction(() => {
    let written = 0;
    const live = new Map<string, Set<string>>();
    for (const c of cards) {
      const set = live.get(c.kind) ?? new Set<string>();
      set.add(c.refId);
      live.set(c.kind, set);
      const hash = chunkHash(c.text);
      const existing = chunksFor(c.kind, { refId: c.refId });
      if (existing.some((e) => e.contentHash === hash)) {
        for (const e of existing) if (e.contentHash !== hash) db.prepare(`DELETE FROM chunks WHERE id = ?`).run(e.id);
        continue;
      }
      for (const e of existing) db.prepare(`DELETE FROM chunks WHERE id = ?`).run(e.id);
      const r = upsertChunk({ kind: c.kind, source: null, streamKey: c.kind, refId: c.refId, seq: 0, text: c.text, tsStart: c.ts ?? null, tsEnd: c.ts ?? null });
      if (r.inserted) written++;
    }
    for (const kind of ["episode", "space", "claim", "person"] as ChunkKind[]) {
      const keep = live.get(kind) ?? new Set<string>();
      const rows = db.prepare(`SELECT id, ref_id FROM chunks WHERE kind = ?`).all(kind) as { id: number; ref_id: string | null }[];
      for (const r of rows) if (!r.ref_id || !keep.has(r.ref_id)) db.prepare(`DELETE FROM chunks WHERE id = ?`).run(r.id);
    }
    return written;
  })();
}

// ---- One pass -----------------------------------------------------------------------

/** Cut everything new since the last pass. Synchronous; SQLite only. */
export function runChunker(): ChunkerReport {
  const chat = chunkChatStreams();
  const screen = chunkScreenStreams();
  const browser = chunkBrowserVisits();
  const cards = chunkCards();
  return {
    chatStreams: chat.streams,
    chatChunks: chat.chunks,
    screenStreams: screen.streams,
    screenChunks: screen.chunks,
    browserChunks: browser,
    cardChunks: cards,
  };
}
