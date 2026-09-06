// ===========================================================================
// [CODE] Library perf corpus — V6 P1 S6d L1 (Library latency root-cause).
//
// A synthetic event log big enough that an unindexed aggregate HURTS. The
// Library's four sub-tabs were measured at 2–14 s on the user's real home
// (36,830 WhatsApp messages, 1.05 GB db, an import in flight); the fix is only
// believable if a test can reproduce the shape at a larger size and hold the
// endpoints to a budget afterwards. So this seeder exists in the tree, not in
// a scratch script: `library-perf.test.ts` is the regression, and the same
// function drives the bigger off-line bench.
//
// Written with raw prepared INSERTs inside ONE transaction, deliberately:
//   - `appendEvents()` content-hashes and dedupes every row, which is the
//     right thing for real capture and about 20x too slow to build 400k rows;
//   - the consent gate would drop most of them;
//   - and the point of the corpus is the SHAPE of the table the read queries
//     see (rows per source, per stream, per day, archive vs understood), not
//     the write path that produced it.
//
// Zero model calls. Never point this at a real home — it writes hundreds of
// thousands of rows.
// ===========================================================================

import { type Database } from "better-sqlite3";

import { getDb } from "../db/connection.js";

export interface CorpusSpec {
  /** WhatsApp messages, spread over `streams` conversations. */
  whatsapp: number;
  /** Distinct WhatsApp conversations. */
  streams: number;
  /** `browser.visit` rows, spread over tab chains of ~15 visits. */
  browserVisits: number;
  /** `browser.bookmark` rows. */
  bookmarks: number;
  /** `screen.snapshot` rows, spread over the last `days`. */
  screen: number;
  /** How far back the log reaches. */
  days: number;
  /**
   * Fraction of rows written as `origin='archive'` — kept and searchable but
   * never sent to the model. These carry a real `archive` row, which is what
   * makes the Storage panel's byte sums expensive.
   */
  archiveFraction: number;
}

/** Roughly 8x the user's real WhatsApp history — the "hundreds of thousands" bar. */
export const BENCH_CORPUS: CorpusSpec = {
  whatsapp: 300_000,
  streams: 900,
  browserVisits: 60_000,
  bookmarks: 500,
  screen: 40_000,
  days: 1_400,
  archiveFraction: 0.45,
};

/** Big enough to expose a full scan, small enough for a unit suite. */
export const TEST_CORPUS: CorpusSpec = {
  whatsapp: 120_000,
  streams: 600,
  browserVisits: 25_000,
  bookmarks: 200,
  screen: 15_000,
  days: 900,
  archiveFraction: 0.45,
};

const EVENT_COLUMNS = [
  "id",
  "source_id",
  "source_type",
  "stream_id",
  "stream_key",
  "actor",
  "actor_id",
  "ts",
  "captured_at",
  "kind",
  "text",
  "payload_json",
  "origin",
  "dispatched_at",
  "external_id",
  "content_hash",
  "created_at",
] as const;

const INSERT_EVENT = `INSERT INTO events (${EVENT_COLUMNS.join(", ")})
   VALUES (${EVENT_COLUMNS.map((c) => `@${camel(c)}`).join(", ")})`;

function camel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Deterministic pseudo-random so a run is reproducible and a diff is readable. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const WORDS =
  "the meeting moved to friday can you send the invoice before eod thanks lets sync tomorrow " +
  "about the launch numbers looked fine but the retention chart is still off i will check " +
  "with design and get back to you by noon call me when you land ";

function body(rand: () => number, minWords: number, maxWords: number): string {
  const words = WORDS.split(" ");
  const n = minWords + Math.floor(rand() * (maxWords - minWords));
  let out = "";
  for (let i = 0; i < n; i++) out += `${words[Math.floor(rand() * words.length)]} `;
  return out.trim();
}

export interface CorpusResult {
  events: number;
  streams: number;
  archiveRows: number;
  ms: number;
}

/**
 * Seed `db` (default: the process handle) with the corpus. Idempotent only in
 * the sense that ids are unique per call — call it once against a fresh file.
 */
export function seedCorpus(spec: CorpusSpec = TEST_CORPUS, db: Database = getDb()): CorpusResult {
  const started = Date.now();
  const rand = lcg(0x5eed_1234);
  const nowMs = Date.now();
  const spanMs = spec.days * 86_400_000;

  const insertEvent = db.prepare(INSERT_EVENT);
  const insertStream = db.prepare(
    `INSERT OR IGNORE INTO streams (id, source_id, external_key, label, stream_kind, tier, category, capture_paused)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const insertSource = db.prepare(
    `INSERT OR IGNORE INTO sources (id, type, name) VALUES (?, ?, ?)`,
  );
  const insertArchive = db.prepare(
    `INSERT INTO archive (id, event_id, source, stream_key, ts, kind, actor, tier, content_hash, text_z, text_len, payload_z)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let events = 0;
  let archiveRows = 0;

  const run = db.transaction(() => {
    for (const [id, type] of [
      ["whatsapp", "whatsapp"],
      ["browser", "browser"],
      ["screen", "screen"],
    ] as const) {
      insertSource.run(id, type, id);
    }

    // ---- WhatsApp: `streams` conversations, newest-weighted like a real inbox.
    const streamIds: string[] = [];
    for (let i = 0; i < spec.streams; i++) {
      const sid = `whatsapp:st:chat${i}`;
      streamIds.push(sid);
      insertStream.run(
        sid,
        "whatsapp",
        `chat${i}@s.whatsapp.net`,
        `Contact ${i}`,
        i % 7 === 0 ? "group" : "dm",
        i % 5 === 0 ? 1 : 3,
        i % 3 === 0 ? "work" : "personal",
      );
    }
    for (let i = 0; i < spec.whatsapp; i++) {
      // Square the uniform draw so recent days hold more rows than old ones.
      const age = rand() * rand() * spanMs;
      const ts = new Date(nowMs - age).toISOString();
      const sIdx = Math.floor(rand() * rand() * spec.streams);
      const streamId = streamIds[sIdx];
      const archive = rand() < spec.archiveFraction;
      const id = `ev_wa_${i}`;
      const text = body(rand, 6, 34);
      const payload = JSON.stringify({
        text,
        from_me: rand() < 0.35,
        chat: `chat${sIdx}@s.whatsapp.net`,
        push_name: `Contact ${sIdx}`,
      });
      insertEvent.run({
        id,
        sourceId: "whatsapp",
        sourceType: "whatsapp",
        streamId,
        streamKey: `chat${sIdx}@s.whatsapp.net`,
        actor: rand() < 0.35 ? "self" : `contact:${sIdx}`,
        actorId: null,
        ts,
        capturedAt: ts,
        kind: "wa.message",
        text,
        payloadJson: payload,
        origin: archive ? "archive" : "live",
        dispatchedAt: ts,
        externalId: `wa_${i}`,
        contentHash: `h_wa_${i}`,
        createdAt: ts,
      });
      events++;
      if (archive) {
        insertArchive.run(
          `ar_wa_${i}`,
          id,
          "whatsapp",
          `chat${sIdx}@s.whatsapp.net`,
          ts,
          "wa.message",
          "self",
          3,
          `h_wa_${i}`,
          Buffer.from(text),
          text.length,
          Buffer.from(payload),
        );
        archiveRows++;
      }
    }

    // ---- Browser: tab chains of ~15 visits.
    const chainSize = 15;
    for (let i = 0; i < spec.browserVisits; i++) {
      const chain = Math.floor(i / chainSize);
      const age = rand() * rand() * spanMs;
      const ts = new Date(nowMs - age).toISOString();
      const domain = `site${chain % 240}.example`;
      const url = `https://${domain}/page/${i % 97}`;
      insertEvent.run({
        id: `ev_br_${i}`,
        sourceId: "browser",
        sourceType: "browser",
        streamId: null,
        streamKey: `chain-${chain}`,
        actor: "self",
        actorId: null,
        ts,
        capturedAt: ts,
        kind: "browser.visit",
        text: `Page ${i}`,
        payloadJson: JSON.stringify({ url, title: `Page ${i} — ${domain}`, domain, dwell_ms: 1_000 + (i % 90_000) }),
        origin: "live",
        dispatchedAt: ts,
        externalId: `br_${i}`,
        contentHash: `h_br_${i}`,
        createdAt: ts,
      });
      events++;
    }
    for (let i = 0; i < spec.bookmarks; i++) {
      const ts = new Date(nowMs - rand() * spanMs).toISOString();
      insertEvent.run({
        id: `ev_bm_${i}`,
        sourceId: "browser",
        sourceType: "browser",
        streamId: null,
        streamKey: `bookmarks`,
        actor: "self",
        actorId: null,
        ts,
        capturedAt: ts,
        kind: "browser.bookmark",
        text: `Bookmark ${i}`,
        payloadJson: JSON.stringify({ url: `https://book${i}.example/`, title: `Bookmark ${i}`, folder: "Bar" }),
        origin: "live",
        dispatchedAt: ts,
        externalId: `bm_${i}`,
        contentHash: `h_bm_${i}`,
        createdAt: ts,
      });
      events++;
    }

    // ---- Screen: snapshots over the whole span, a slice of them today.
    const apps = ["com.apple.Safari", "com.microsoft.VSCode", "com.tinyspeck.slackmacgap", "com.apple.mail"];
    for (let i = 0; i < spec.screen; i++) {
      // A tenth of the captures land today so the day view has real work to do.
      const age = i % 10 === 0 ? rand() * 86_400_000 : rand() * spanMs;
      const ts = new Date(nowMs - age).toISOString();
      const bundle = apps[i % apps.length];
      insertEvent.run({
        id: `ev_sc_${i}`,
        sourceId: "screen",
        sourceType: "screen",
        streamId: null,
        streamKey: `${bundle}¦win${i % 40}`,
        actor: "self",
        actorId: null,
        ts,
        capturedAt: ts,
        kind: "screen.snapshot",
        text: null,
        payloadJson: JSON.stringify({
          bundle_id: bundle,
          app_name: bundle.split(".").pop(),
          window_title: `Document ${i % 40}`,
        }),
        origin: "live",
        dispatchedAt: ts,
        externalId: `sc_${i}`,
        contentHash: `h_sc_${i}`,
        createdAt: ts,
      });
      events++;
    }
  });

  // FTS is 87% of the seeding cost (55 s against 6.9 s for 160k rows) and none
  // of the Library's four sub-tabs reads events_fts — they read counts, spans
  // and per-stream aggregates. Drop the `events` triggers for the insert and
  // put them back verbatim afterwards, so the file that comes out is a normal
  // database with an empty FTS index rather than a specially-shaped one.
  const triggers = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'`)
    .all() as { name: string; sql: string }[];
  for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
  try {
    run();
  } finally {
    for (const t of triggers) {
      if (t.sql) db.exec(t.sql);
    }
  }
  return { events, streams: spec.streams, archiveRows, ms: Date.now() - started };
}
