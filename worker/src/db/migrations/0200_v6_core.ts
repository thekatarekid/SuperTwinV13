// ===========================================================================
// 0200_v6_core — V6 P1 S1.1 (Build §4.1, Product_V6 §23.1, backlog T0-9,
// T2-5, T4-1/2, T5-1, T6-8).
//
// The consent-and-archive substrate every Stage-1 lane builds on. Fresh
// installs only (Build §1.1: no data migration), so every table here starts
// empty and nothing is rewritten in place.
//
//   consents         one row per grant. `state` connected|paused|disconnected|
//                    revoked. Two windows per source (Product_V6_Phase1 §3.3):
//                    INDEX (`index_all` or `index_from`) and UNDERSTAND
//                    (`understand_from`), Understand never wider than Index —
//                    enforced by the helper in db/v6core.ts, not by SQL.
//                    `decision_id` points at the decisions row that stores the
//                    confirm-card text verbatim (T4-10). At most ONE unrevoked
//                    row per source (partial unique index).
//
//   archive          layer 1 (Product_V6 §11.4). Narrow: one copy of the text,
//                    zlib-deflated, beside the raw payload as received (also
//                    deflated). `event_id` is the log row it mirrors and
//                    cascades with it, so "delete a source" still cascades to
//                    everything derived (invariant §24.5). Idempotent by
//                    content_hash.
//
//   episode_events   EXPLICIT membership (T2-5). The 0101 table stores message
//                    RANGES and six readers depend on that shape until the S3.1
//                    commit rewrite, so the range columns stay and gain
//                    `event_id`: a membership row is a range of one whose
//                    `event_id` is set. Readers that walk ranges keep working;
//                    readers that want exact membership filter on `event_id`.
//
//   bundle_attempts  attempts · last_attempt_at · dead_letter_at keyed by the
//                    bundle key `(stream_id, min_rowid, max_rowid)` (T0-9).
//                    Three attempts → dead-lettered and shown (invariant §24.4).
//
//   blobs            content-addressed (sha256 of the RAW bytes) store for
//                    screen text (T6-8): near-duplicate heartbeats share one
//                    row. Bytes are zlib-deflated; `size` is the raw length.
//
//   coverage         source × date range × status (Product_V6 §23.4 rule 3):
//                    what exists and what was never captured, so an answer can
//                    say "I only have WhatsApp back to Jan 2024". The V2
//                    progress meter that occupied this name (0022_v2_core:
//                    scope × horizon × total/done units) moves to
//                    `coverage_progress` — its two readers (scheduler/queue.ts,
//                    server/surfaces-routes.ts) follow it.
//
//   events           the envelope gains `consent_id` (which grant admitted the
//                    row) and `tier` (the stream's processing class 1–4 at
//                    capture, Product_V6 glossary "Tier"). `roles` was already
//                    on the row since 0100 (`roles_json`).
//
// Drops: `sources.connected_at` / `sources.enabled` went in 0108 and
// `content_pending` was never a column (a payload marker, deleted in S0.5),
// so there is nothing left to drop; the test pins their absence.
// ===========================================================================

/** The 0200_v6_core migration body. */
export const V6_CORE = /* sql */ `
-- ---- consents (T4-1) ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS consents (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,                  -- 'wa' | 'browser' | 'screen' | 'self'
  state           TEXT NOT NULL DEFAULT 'connected', -- connected|paused|disconnected|revoked
  granted_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  granted_build   TEXT,                           -- BUILT_THROUGH_PHASE + app version at grant
  scope_json      TEXT,                           -- per-source scope (profiles, chats, apps…)
  index_all       INTEGER NOT NULL DEFAULT 1,     -- 1 = INDEX window is everything
  index_from      TEXT,                           -- INDEX window floor (ISO) when index_all = 0
  understand_from TEXT,                           -- UNDERSTAND window floor (ISO); NULL = nothing understood
  decision_id     TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  revoked_at      TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One live grant per source; revoked rows stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_consents_live_source
  ON consents(source) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_consents_source ON consents(source, granted_at);

-- ---- events: envelope gains consent_id + tier (Product_V6 §23.1) -----------

ALTER TABLE events ADD COLUMN consent_id TEXT;     -- consents.id that admitted the row
ALTER TABLE events ADD COLUMN tier       INTEGER;  -- stream processing class 1..4 at capture

CREATE INDEX IF NOT EXISTS idx_events_consent ON events(consent_id);

-- ---- archive (T5-1): narrow, zlib text, raw payload kept --------------------

CREATE TABLE IF NOT EXISTS archive (
  id            TEXT PRIMARY KEY,
  event_id      TEXT UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  stream_key    TEXT,
  ts            TEXT NOT NULL,
  kind          TEXT,
  actor         TEXT,
  consent_id    TEXT,
  tier          INTEGER,
  content_hash  TEXT NOT NULL UNIQUE,
  text_z        BLOB,                             -- zlib(text); NULL when no text
  text_len      INTEGER NOT NULL DEFAULT 0,       -- raw text length (chars)
  payload_z     BLOB NOT NULL,                    -- zlib(payload JSON, as received)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_archive_source_ts ON archive(source, ts);
CREATE INDEX IF NOT EXISTS idx_archive_stream    ON archive(stream_key, ts);

-- ---- episode_events: explicit membership (T2-5) -----------------------------

ALTER TABLE episode_events ADD COLUMN event_id TEXT REFERENCES events(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_events_member
  ON episode_events(episode_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_episode_events_event ON episode_events(event_id);

-- ---- bundle_attempts (T0-9) -------------------------------------------------

CREATE TABLE IF NOT EXISTS bundle_attempts (
  bundle_key      TEXT PRIMARY KEY,               -- '<stream_id>:<min_rowid>-<max_rowid>'
  stream_id       TEXT,
  min_rowid       INTEGER,
  max_rowid       INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,
  dead_letter_at  TEXT,                           -- set on the 3rd failure; never auto-retried
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_bundle_attempts_dead ON bundle_attempts(dead_letter_at) WHERE dead_letter_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bundle_attempts_stream ON bundle_attempts(stream_id);

-- ---- blobs (T6-8): content-addressed --------------------------------------

CREATE TABLE IF NOT EXISTS blobs (
  sha256      TEXT PRIMARY KEY,                   -- hex sha256 of the RAW bytes
  kind        TEXT NOT NULL DEFAULT 'text',       -- 'text' | 'json' | …
  size        INTEGER NOT NULL,                   -- raw byte length
  bytes_z     BLOB NOT NULL,                      -- zlib(raw)
  refs        INTEGER NOT NULL DEFAULT 1,         -- how many puts hit this row
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_ref_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---- coverage: source × date range × status (Product_V6 §23.4) -------------

ALTER TABLE coverage RENAME TO coverage_progress;

CREATE TABLE IF NOT EXISTS coverage (
  source      TEXT NOT NULL,
  range_start TEXT NOT NULL,                      -- YYYY-MM-DD inclusive
  range_end   TEXT NOT NULL,                      -- YYYY-MM-DD inclusive
  status      TEXT NOT NULL,                      -- captured|indexed|understood|missing|excluded
  events      INTEGER NOT NULL DEFAULT 0,         -- rows that exist for the range (0 for missing)
  note        TEXT,                               -- why missing/excluded ("history plateau 90 d")
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (source, range_start, range_end)
);

CREATE INDEX IF NOT EXISTS idx_coverage_source_status ON coverage(source, status, range_start);
`;
