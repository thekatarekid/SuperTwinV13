// ===========================================================================
// 0202_v6_fts_projection — V6 P1 S2.3 (Build §5.2 lane A, Product_V6 §23.4
// "Lexical (BM25)", Product_V6_Phase1 §20.1/§20.3).
//
// Two things the lexical method needed and did not have:
//
//   events.app / window_title / doc_key
//                    A screen event's `text` is the DIFF of the window (the
//                    `new_chars` the sidecar sent), and the diff of a listings
//                    page rarely repeats the page's name. What names the thing
//                    the user was looking at is the WINDOW TITLE ("Villas in
//                    Goa – Airbnb") and the app it was in — neither of which was
//                    anywhere FTS could see (RET-06). They lived only inside
//                    payload_json. The single writer (db/eventlog.ts) now
//                    projects them into three plain columns, the way it already
//                    projects payload.text into events.text, and events_fts is
//                    rebuilt over ten columns with the three appended LAST:
//                    ordinals 0–6 keep their meaning, so every bm25() weight
//                    vector and snippet() index already in the tree still
//                    points at the same column (db/retrieval.ts
//                    EVENTS_FTS_COLUMNS mirrors the order and a test pins it).
//                    Browser visits project their tab title into window_title
//                    and their URL into doc_key — a tab is a window, and the
//                    URL is what identifies the document.
//
//   chunks_fts       BM25 over `chunks` — the same unit the vector index
//                    embeds (0201). One external-content FTS5 table over
//                    chunks.text keyed by the chunks rowid, kept in sync by
//                    triggers. This is what puts episode summaries, space
//                    cards, claims and people cards (kind ∈ episode|space|
//                    claim|person) under lexical search alongside the chat /
//                    screen / browser windows: cards are chunks, so one index
//                    covers both. Rank fusion (S2.4) takes the ranked chunk
//                    ids from here and the vector ids from chunk-index.ts and
//                    fuses them by position.
//
// Fresh installs only (Build §1.1): `events` is empty when this runs on every
// install that matters, so the 'rebuild' is a formality — but it is still
// issued, so a dev DB migrated across the boundary is consistent.
// ===========================================================================

export const V6_FTS_PROJECTION = /* sql */ `
-- ---- events: the projected screen/browser identity columns -----------------

ALTER TABLE events ADD COLUMN app          TEXT;   -- screen: app_name ('Safari', 'Notes')
ALTER TABLE events ADD COLUMN window_title TEXT;   -- screen: window title; browser: tab title
ALTER TABLE events ADD COLUMN doc_key      TEXT;   -- screen: doc_key; browser: url

CREATE INDEX IF NOT EXISTS idx_events_doc_key ON events(doc_key) WHERE doc_key IS NOT NULL;

-- ---- events_fts rebuilt over ten columns: the seven of 0017 + app,
-- ---- window_title, doc_key appended -----------------------------------------

DROP TRIGGER IF EXISTS events_ai;
DROP TRIGGER IF EXISTS events_ad;
DROP TRIGGER IF EXISTS events_au;
DROP TABLE IF EXISTS events_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text,
  media_description,
  link_title,
  link_description,
  link_scraped_text,
  transcript,
  reply_to_text,
  app,
  window_title,
  doc_key,
  content='events',
  content_rowid='rowid'
);

INSERT INTO events_fts(events_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text, app, window_title, doc_key)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript, new.reply_to_text, new.app, new.window_title, new.doc_key);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text, app, window_title, doc_key)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript, old.reply_to_text, old.app, old.window_title, old.doc_key);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text, app, window_title, doc_key)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript, old.reply_to_text, old.app, old.window_title, old.doc_key);
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text, app, window_title, doc_key)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript, new.reply_to_text, new.app, new.window_title, new.doc_key);
END;

-- ---- chunks_fts: BM25 over chunks and cards (external content, rowid = chunks.id)

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id'
);

INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
`;
