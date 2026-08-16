// ===========================================================================
// 0020_v2_core — the V2 ontology (arch doc §6 "Data model — complete"), as the
// migration runner sees it.
//
// The body below is the VERBATIM text of ./0020_v2_core.sql, which is the file
// the build doc names and the one to edit. It is inlined here instead of being
// read from disk at runtime because the shipped worker is a single esbuild
// bundle with no .sql files beside it, and a migration that only applies in the
// repo is worse than no migration at all. 0020_v2_core.test.ts fails the moment
// the two drift, so the copy cannot rot silently. To re-sync after editing the
// .sql (from worker/):
//
//   node -e 'const f=require("fs"),p="src/db/migrations/0020_v2_core";\
//     const s=f.readFileSync(p+".sql","utf8"),t=f.readFileSync(p+".ts","utf8");\
//     f.writeFileSync(p+".ts", t.split("export const V2_CORE = /* sql */ `")[0]\
//       + "export const V2_CORE = /* sql */ `\\n" + s.replace(/\\n+$/,"\\n") + "`;\\n")'
//
// The .sql must contain no backtick and no ${ — it lives in a template literal.
// ===========================================================================

/** The 0020_v2_core migration body — byte-for-byte ./0020_v2_core.sql. */
export const V2_CORE = /* sql */ `
-- ===========================================================================
-- 0020_v2_core — the V2 ontology, complete (arch doc §6 "Data model").
--
-- The file keeps the name the build doc gives it. The id it is REGISTERED under
-- in schema.ts is '0022_v2_core': 0020 and 0021 already shipped, and the
-- recorded ids have to sort in the order they apply.
--
-- [CODE] Fresh install only. There is NO data migration and no upgrade path:
-- the old DB is deleted on first run, so nothing here copies, backfills or
-- reshapes existing rows. What it does do is grow every table §6 names, on top
-- of what 0001–0021 already built. 'events' keeps its V11 media/link/transcript
-- lifecycle columns and its FTS index; it is rebuilt once (see L1 below) only
-- because a renamed column drags its old FOREIGN KEY along, and the rebuild
-- carries the rowids across by hand — events_fts is external-content over
-- events.rowid, so renumbering them would silently repoint every indexed row.
--
-- ⚠ TEMPORAL PRECEDENCE — read before touching anything with a timestamp:
--     events.ts               = when it was SAID
--     claim_versions.stated_at = when it was SAID  (= the source event's ts)
--     valid_from / valid_to    = when the fact was true OF THE WORLD
--     ingested_at              = when the row was WRITTEN
--   PRECEDENCE NEVER USES ingested_at. Not here, not in a query, not in a
--   view, not in code. ingested_at is audit/debug only. This is the whole
--   reason the graph is confluent: a message that arrives late lands as a
--   PREDECESSOR of what is already known, ordered by when it was said, and
--   cannot dislodge a newer truth just by showing up second.
--
-- ⚠ NO 'spaces' TABLE. A "space" is an arc with promoted = 1. Promotion is a
--   derived field flip on 'arcs' (promoted, promotion_reason, archetype,
--   archetype_source, status, ends_at, cadence, user_label), never the
--   creation of a second object — so the arc id IS the space id and there are
--   no two rows to desynchronise. The legacy spaces/goals/milestones/tasks
--   ontology 0001_init grew is dropped below.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Legacy ontology teardown. Children first so no FK is left dangling; the
-- pragma is ON inside the runner's transaction, so order is load-bearing.
-- 'goals' is dropped and re-created further down with its §6 shape.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_tasks_space;
DROP INDEX IF EXISTS idx_tasks_goal;
DROP INDEX IF EXISTS idx_milestones_goal;
DROP INDEX IF EXISTS idx_goals_space;
DROP TABLE IF EXISTS space_events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS milestones;
DROP TABLE IF EXISTS goals;
DROP TABLE IF EXISTS spaces;

-- ═══ L0 registry ═══════════════════════════════════════════════════════════

-- sources: 0001_init already created (id, type, name, config_json, created_at).
-- §6 adds the manifest-driven columns. 'type'/'name' stay for the V11 readers
-- until the adapter registry (item 1.1) retires them.
-- mode: bootstrap | steady
ALTER TABLE sources ADD COLUMN display_name  TEXT;
ALTER TABLE sources ADD COLUMN actor_model   TEXT;
ALTER TABLE sources ADD COLUMN manifest_json TEXT;
ALTER TABLE sources ADD COLUMN enabled       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN mode          TEXT NOT NULL DEFAULT 'bootstrap';
ALTER TABLE sources ADD COLUMN connected_at  TEXT;

-- streams: one conversational lane inside a source (a WhatsApp chat, a feed, a
-- calendar). Replaces 'channels', which stays until item 1.1 rewrites its
-- readers.  stream_kind: dm | group | broadcast | feed | log | calendar
CREATE TABLE IF NOT EXISTS streams (
  id                         TEXT PRIMARY KEY,
  source_id                  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_key               TEXT NOT NULL,
  label                      TEXT,
  stream_kind                TEXT,
  participant_entity_ids     TEXT,             -- JSON array of entity ids
  tz                         TEXT,             -- IANA zone the lane is lived in
  segmentation_override_json TEXT,             -- per-stream boundary params
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source_id, external_key)
);

-- watermarks: the live head moves FORWARD, the backfill floor moves BACKWARD.
-- Two independent cursors per stream; neither is ever rewound by the other.
CREATE TABLE IF NOT EXISTS watermarks (
  stream_id             TEXT PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
  live_high_ts          TEXT,
  live_high_external_id TEXT,
  backfill_low_ts       TEXT,
  backfill_complete     INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ═══ L2 entity graph ═══════════════════════════════════════════════════════
-- Created BEFORE the events ALTERs: events.actor_entity_id references it.

-- type: person|group|org|place|product|service|media_work|document
--     | app_site|occasion|topic|pet|vehicle|account|health_item|food_item
CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,             -- minted, never a name string
  type          TEXT NOT NULL,
  subtype       TEXT,
  canonical     TEXT,
  provisional   INTEGER NOT NULL DEFAULT 1,
  merged_into   TEXT REFERENCES entities(id) ON DELETE SET NULL,
  user_pinned   INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_type   ON entities(type, subtype);
CREATE INDEX IF NOT EXISTS idx_entities_merged ON entities(merged_into);

-- kind: jid|phone|email|handle|account_id|device_id|profile_url|alias
CREATE TABLE IF NOT EXISTS entity_identities (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_id  TEXT,
  kind       TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  confidence REAL,
  decided_by TEXT,
  decided_at TEXT,
  UNIQUE (source_id, kind, value_norm)
);

CREATE INDEX IF NOT EXISTS idx_entity_identities_entity ON entity_identities(entity_id);

-- kind: family_of|social_of|works_with|works_at|provides_care|member_of
--     | owns|pet_of|subscribes_to|lives_at|located_in|part_of|created
--     | provides|about|participant_in        status: active|superseded|rejected
CREATE TABLE IF NOT EXISTS entity_edges (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  subtype       TEXT,
  src_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence    REAL,
  decided_by    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  valid_from    TEXT,
  valid_to      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- §6 declares UNIQUE(kind, subtype, src, dst). A bare UNIQUE would let a NULL
-- subtype repeat forever (NULLs are distinct in SQLite), which is exactly the
-- duplicate the constraint exists to stop, so the uniqueness is expressed over
-- COALESCE(subtype,'') instead.
CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_edges_kind_pair
  ON entity_edges(kind, COALESCE(subtype, ''), src_entity_id, dst_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_edges_src ON entity_edges(src_entity_id, kind);
CREATE INDEX IF NOT EXISTS idx_entity_edges_dst ON entity_edges(dst_entity_id, kind);

CREATE TABLE IF NOT EXISTS edge_evidence (
  edge_id  TEXT NOT NULL REFERENCES entity_edges(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  quote    TEXT NOT NULL,                     -- verbatim. no evidence, no write
  PRIMARY KEY (edge_id, event_id)
);

CREATE TABLE IF NOT EXISTS mentions (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  span_start      INTEGER,
  span_end        INTEGER,
  surface_text    TEXT,
  entity_id       TEXT REFERENCES entities(id) ON DELETE SET NULL,
  new_entity_json TEXT,
  entity_hint     TEXT,                       -- a name string is NEVER an id
  confidence      REAL,
  decided_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_mentions_event  ON mentions(event_id);
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_id);

CREATE TABLE IF NOT EXISTS resolution_decisions (
  id         TEXT PRIMARY KEY,
  left_id    TEXT NOT NULL,
  right_id   TEXT NOT NULL,
  verdict    TEXT NOT NULL,                   -- same | different | unsure
  decided_by TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (left_id, right_id)
);

CREATE TABLE IF NOT EXISTS entity_embeddings (
  entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  vec       BLOB NOT NULL,                    -- dim little-endian float32s
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL
);

-- The measured floor for a (model, use_case) pair. A similarity threshold is
-- calibrated, never guessed in a prompt.
CREATE TABLE IF NOT EXISTS embedder_calib (
  model       TEXT NOT NULL,
  use_case    TEXT NOT NULL,
  floor       REAL NOT NULL,
  measured_at TEXT,
  n_pairs     INTEGER,
  PRIMARY KEY (model, use_case)
);

-- ═══ L1 events ═════════════════════════════════════════════════════════════
-- channel_id → stream_id, plus every §6 column, done as a REBUILD instead of
-- ALTER TABLE RENAME COLUMN. The rename on its own drags the old FOREIGN KEY
-- along with the name: stream_id would still reference channels(id), so the
-- first V2 writer to file an event against a real streams row gets
-- "FOREIGN KEY constraint failed" and nothing in a schema diff says why.
-- SQLite has no ALTER for a constraint, so the table is rebuilt once, here,
-- while it is empty on every install that matters (fresh DB, no upgrade path).
--
-- stream_id deliberately carries NO REFERENCES yet: until item 1.1 folds
-- 'channels' into 'streams', what lands in it is still a legacy channel id.
-- Item 1.1 adds REFERENCES streams(id) when there is one id space left.
--
-- Two things the rebuild must not lose, neither of them visible in a schema
-- diff:
--   1. rowids — events_fts is external-content over events.rowid, so renumbered
--      rows would point every indexed row at a different message, silently.
--      They are copied across explicitly.
--   2. the rows of every child table that holds ON DELETE CASCADE on events.
--      DROP TABLE runs an implicit DELETE FROM, and PRAGMA foreign_keys = OFF
--      is a no-op inside the runner's transaction, so event_embeddings is
--      staged out and put back. (space_events, the only other such child, went
--      with the legacy ontology above; every V2 table that references events is
--      created below this point and is empty.)
-- kind: message|post|comment|reaction|edit|revoke|view|play|save|order
--     | visit|frame|utterance|appointment|file_change|reminder|clip
-- enrichment_state: none_needed | pending | ready | failed | skipped
-- ⚠ ts = when it was SAID → the ONLY basis for precedence.
--   ingested_at = when the row was written → audit/debug ONLY, never precedence.
CREATE TABLE events_v2_rebuild (
  id                   TEXT PRIMARY KEY,
  source_id            TEXT REFERENCES sources(id) ON DELETE CASCADE,
  source_type          TEXT,
  stream_id            TEXT,                  -- was channel_id
  actor_id             TEXT REFERENCES actors(id) ON DELETE SET NULL,
  ts                   TEXT,                  -- when it was SAID
  kind                 TEXT,
  text                 TEXT,
  media_path           TEXT,
  raw_json             TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  external_id          TEXT,
  reply_to_external_id TEXT,
  reply_to_text        TEXT,
  -- V11 media lifecycle
  media_mime           TEXT,
  media_filename       TEXT,
  media_size           INTEGER,
  media_sha256         TEXT,
  media_thumb_path     TEXT,
  media_seconds        INTEGER,
  media_meta_json      TEXT,
  media_description    TEXT,
  media_desc_status    TEXT,
  media_desc_model     TEXT,
  media_desc_ts        TEXT,
  media_desc_error     TEXT,
  edited_at            TEXT,
  revoked_at           TEXT,
  is_forwarded         INTEGER NOT NULL DEFAULT 0,
  -- V11 link lifecycle
  link_url             TEXT,
  link_title           TEXT,
  link_description     TEXT,
  link_thumb_path      TEXT,
  link_preview_type    TEXT,
  link_scraped_text    TEXT,
  link_scrape_status   TEXT,
  link_scrape_error    TEXT,
  is_historical        INTEGER NOT NULL DEFAULT 0,
  media_frames_json    TEXT,
  -- V11 transcript lifecycle
  transcript           TEXT,
  transcript_status    TEXT,
  transcript_model     TEXT,
  transcript_ts        TEXT,
  transcript_error     TEXT,
  -- V2 (§6)
  tz                   TEXT,
  ts_end               TEXT,
  ingested_at          TEXT,                  -- ⚠ audit/debug ONLY
  salience             REAL,
  enrichment_state     TEXT NOT NULL DEFAULT 'none_needed',
  enriched_at          TEXT,
  enrich_salient       INTEGER,
  actor_entity_id      TEXT REFERENCES entities(id) ON DELETE SET NULL,
  actor_raw            TEXT,                  -- a name string is NEVER an id
  is_self              INTEGER NOT NULL DEFAULT 0,
  is_business          INTEGER NOT NULL DEFAULT 0,
  structured_json      TEXT,
  revision_of          TEXT,
  -- TEMPORARY BRIDGE — owned by item 1.1 ('channels' → 'streams'), dies with it.
  -- The rename is real: stream_id is the column V2 writes and reads. But every
  -- V11 reader still says channel_id and this item may not edit them, so the
  -- old name survives as a mirror kept equal to stream_id on insert. Nothing
  -- new may read it. It carries no REFERENCES for the same reason stream_id
  -- carries none: the two id spaces are not one yet, and a mirror that enforced
  -- channels(id) would reject every V2 stream id written to stream_id. The one
  -- caller that deleted channels out from under events (resetWhatsappData)
  -- deletes the events first, so nothing relied on the ON DELETE SET NULL.
  channel_id           TEXT
);

INSERT INTO events_v2_rebuild (
  rowid, id, source_id, source_type, stream_id, actor_id, ts, kind, text,
  media_path, raw_json, created_at, external_id, reply_to_external_id,
  reply_to_text, media_mime, media_filename, media_size, media_sha256,
  media_thumb_path, media_seconds, media_meta_json, media_description,
  media_desc_status, media_desc_model, media_desc_ts, media_desc_error,
  edited_at, revoked_at, is_forwarded, link_url, link_title, link_description,
  link_thumb_path, link_preview_type, link_scraped_text, link_scrape_status,
  link_scrape_error, is_historical, media_frames_json, transcript,
  transcript_status, transcript_model, transcript_ts, transcript_error,
  channel_id
)
SELECT
  rowid, id, source_id, source_type, channel_id, actor_id, ts, kind, text,
  media_path, raw_json, created_at, external_id, reply_to_external_id,
  reply_to_text, media_mime, media_filename, media_size, media_sha256,
  media_thumb_path, media_seconds, media_meta_json, media_description,
  media_desc_status, media_desc_model, media_desc_ts, media_desc_error,
  edited_at, revoked_at, is_forwarded, link_url, link_title, link_description,
  link_thumb_path, link_preview_type, link_scraped_text, link_scrape_status,
  link_scrape_error, is_historical, media_frames_json, transcript,
  transcript_status, transcript_model, transcript_ts, transcript_error,
  channel_id
FROM events;

CREATE TABLE event_embeddings_rebuild_stash AS SELECT * FROM event_embeddings;

DROP TABLE events;
ALTER TABLE events_v2_rebuild RENAME TO events;

INSERT INTO event_embeddings SELECT * FROM event_embeddings_rebuild_stash;
DROP TABLE event_embeddings_rebuild_stash;

-- Every index the old table carried, re-cut on the new one. The two channel
-- indices come back under the column's real name; the bridge column keeps one
-- of its own so the V11 readers keep their query plan until item 1.1.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_external   ON events(source_id, external_id);
CREATE INDEX IF NOT EXISTS idx_events_stream                   ON events(stream_id);
CREATE INDEX IF NOT EXISTS idx_events_stream_ts                ON events(stream_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_channel_compat           ON events(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_actor                    ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_ts                       ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_reply_to                 ON events(reply_to_external_id);
CREATE INDEX IF NOT EXISTS idx_events_desc_status              ON events(media_desc_status, ts);
CREATE INDEX IF NOT EXISTS idx_events_link_status              ON events(link_scrape_status, ts);
CREATE INDEX IF NOT EXISTS idx_events_transcript_status        ON events(transcript_status, ts);
CREATE INDEX IF NOT EXISTS idx_events_actor_entity             ON events(actor_entity_id);
CREATE INDEX IF NOT EXISTS idx_events_enrichment               ON events(enrichment_state, ts);

-- DROP TABLE took the FTS triggers with it. events_ai and events_ad come back
-- verbatim from 0017_reply_fts; events_au comes back with a WHEN clause, for
-- two reasons. It reindexes on EVERY update today, including the media / link /
-- transcript status updates that touch no indexed column — wasted work — and
-- unguarded it is unsafe next to the compat trigger below: two AFTER INSERT
-- triggers fire in an order SQLite does not define, so the 'delete' command can
-- reach events_fts before the row was ever indexed, which corrupts the index
-- (SQLITE_CORRUPT_VTAB). Same name, same body, fired only when an indexed
-- column actually changed.
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript, new.reply_to_text);
END;

CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript, old.reply_to_text);
END;

CREATE TRIGGER events_au AFTER UPDATE ON events
WHEN old.text              IS NOT new.text
  OR old.media_description IS NOT new.media_description
  OR old.link_title        IS NOT new.link_title
  OR old.link_description  IS NOT new.link_description
  OR old.link_scraped_text IS NOT new.link_scraped_text
  OR old.transcript        IS NOT new.transcript
  OR old.reply_to_text     IS NOT new.reply_to_text
BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript, old.reply_to_text);
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript, new.reply_to_text);
END;

-- The bridge, in both directions: a V11 writer files channel_id and V2 reads
-- stream_id; a V2 writer files stream_id and the V11 readers still find it.
-- Dies with the channel_id column in item 1.1.
CREATE TRIGGER events_stream_compat_ai
AFTER INSERT ON events
WHEN (NEW.stream_id IS NULL AND NEW.channel_id IS NOT NULL)
  OR (NEW.channel_id IS NULL AND NEW.stream_id IS NOT NULL)
BEGIN
  UPDATE events
     SET stream_id  = COALESCE(NEW.stream_id, NEW.channel_id),
         channel_id = COALESCE(NEW.channel_id, NEW.stream_id)
   WHERE id = NEW.id;
END;

-- event_embeddings already exists (0018_semantic_index) as
-- (event_id PK, model, dim, vector BLOB, indexed_at) — §6's (vec, model, dim)
-- under the older column name. Left alone: renaming 'vector' would break the
-- live indexer for nothing.

-- ═══ SCHEDULER ═════════════════════════════════════════════════════════════

-- mode: bootstrap | steady | reprocess
-- horizon: live | h24 | d7 | d30 | d90 | y1 | older
-- state: planned|enriching|ready|understanding|done|paused|quarantined
CREATE TABLE IF NOT EXISTS cohorts (
  id             TEXT PRIMARY KEY,
  source_id      TEXT REFERENCES sources(id) ON DELETE SET NULL,
  mode           TEXT NOT NULL,
  horizon        TEXT NOT NULL,
  seq            INTEGER NOT NULL DEFAULT 0,
  ts_hi          TEXT,
  ts_lo          TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  session_ids    TEXT,                        -- JSON array
  event_count    INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'planned',
  opened_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  enriched_at    TEXT,
  understood_at  TEXT,
  surfaced_at    TEXT,
  reason         TEXT
);

CREATE INDEX IF NOT EXISTS idx_cohorts_state ON cohorts(state, priority DESC);

-- unit_kind: event|session|episode|arc|claim_pair|loop_batch
-- stage: enrich|entity|segment|episode|arc|extract|triage|done|derive
-- ⚠ Work is dequeued by priority DESC — never by rowid, never by insertion
--   order. The index below is the one the dequeue must use.
CREATE TABLE IF NOT EXISTS work_queue (
  id            TEXT PRIMARY KEY,
  unit_kind     TEXT NOT NULL,
  unit_id       TEXT NOT NULL,
  cohort_id     TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
  stage         TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  not_before_at TEXT,
  state         TEXT NOT NULL DEFAULT 'ready',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_work_queue_priority ON work_queue(priority DESC, state);
CREATE INDEX IF NOT EXISTS idx_work_queue_unit     ON work_queue(unit_kind, unit_id, stage);

-- scope_kind: global | source | stream
CREATE TABLE IF NOT EXISTS coverage (
  scope_kind  TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  horizon     TEXT NOT NULL,
  total_units INTEGER NOT NULL DEFAULT 0,
  done_units  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope_kind, scope_id, horizon)
);

-- ═══ L3 sessions ═══════════════════════════════════════════════════════════
-- boundary_reason: gap|participant_shift|reply_break|size_cap|day_boundary
--                | context_shift|record_bounded|ceiling|debounce|stream_start
-- seal_mode: immediate | debounce | ceiling      status: open | sealed
-- A sealed session is IMMUTABLE IN MEMBERSHIP. Enrichment may move
-- content_hash; it never changes which events belong.
CREATE TABLE IF NOT EXISTS sessions (
  id                       TEXT PRIMARY KEY,
  stream_id                TEXT REFERENCES streams(id) ON DELETE CASCADE,
  source_id                TEXT,
  started_at               TEXT,
  ended_at                 TEXT,
  tz                       TEXT,
  event_ids                TEXT,              -- JSON array
  participant_entity_ids   TEXT,              -- JSON array
  boundary_reason_start    TEXT,
  boundary_reason_end      TEXT,
  boundary_params_json     TEXT,              -- the MEASURED params, not a guess
  seal_mode                TEXT,
  content_hash             TEXT,
  superseded_hash          TEXT,
  hash_version             TEXT,
  status                   TEXT NOT NULL DEFAULT 'open',
  sealed_at                TEXT,
  late_arrival             INTEGER NOT NULL DEFAULT 0,
  overlap_of               TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  pending_enrichment_count INTEGER NOT NULL DEFAULT 0,
  reprocess_count          INTEGER NOT NULL DEFAULT 0,
  last_delta_at            TEXT,
  delta_pass_count         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_stream ON sessions(stream_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, ended_at);

-- ═══ L4 episodes ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS episodes (
  id          TEXT PRIMARY KEY,
  stream_id   TEXT REFERENCES streams(id) ON DELETE SET NULL,
  source_id   TEXT,
  topic_label TEXT,
  label_source TEXT,                          -- model | user | derived
  session_ids TEXT,                           -- JSON array
  event_ids   TEXT,                           -- JSON array
  entity_ids  TEXT,                           -- JSON array
  arc_state   TEXT,
  outcome     TEXT,
  started_at  TEXT,
  ended_at    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_stream ON episodes(stream_id, started_at);

CREATE TABLE IF NOT EXISTS episode_sessions (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  added_by   TEXT,
  verdict_id TEXT,
  PRIMARY KEY (episode_id, session_id)
);

-- Every episode persists its verdict: replay REUSES it and never re-judges.
CREATE TABLE IF NOT EXISTS episode_verdicts (
  id              TEXT PRIMARY KEY,
  episode_id      TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id          TEXT,
  decision        TEXT,
  candidates_json TEXT,
  output_json     TEXT,
  model           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_episode_verdicts_session ON episode_verdicts(session_id);

CREATE TABLE IF NOT EXISTS episode_embeddings (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  vec        BLOB NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL
);

-- ═══ L5 arcs (a promoted arc IS a space) ═══════════════════════════════════
-- state:  live|dormant|archived   — the THREAD's own aging
-- status: active|dormant|archived — the SPACE's, derived from member loops
-- promotion_reason: cmt | ref | rec | usr
-- archetype: prj|evt|rhy|adm|hld|mat|pur|wch      archetype_source: model|user
-- state/status are CODE-WRITTEN ONLY. No prompt sets them.
CREATE TABLE IF NOT EXISTS arcs (
  id                TEXT PRIMARY KEY,
  arc_key           TEXT NOT NULL UNIQUE,
  label             TEXT,
  label_source      TEXT,
  anchor_entity_ids TEXT,                     -- JSON array
  source_ids        TEXT,                     -- JSON array
  state             TEXT NOT NULL DEFAULT 'live',
  started_at        TEXT,
  last_evidence_at  TEXT,
  promoted          INTEGER NOT NULL DEFAULT 0,
  promotion_reason  TEXT,
  archetype         TEXT,
  archetype_source  TEXT,
  status            TEXT,
  ends_at           TEXT,
  cadence           TEXT,
  user_pinned       INTEGER NOT NULL DEFAULT 0,
  user_label        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_arcs_promoted ON arcs(promoted, status);
CREATE INDEX IF NOT EXISTS idx_arcs_state    ON arcs(state, last_evidence_at);

CREATE TABLE IF NOT EXISTS arc_episodes (
  arc_id             TEXT NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
  episode_id         TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  added_by           TEXT,
  signal             TEXT,
  signal_detail_json TEXT,
  PRIMARY KEY (arc_id, episode_id)
);

CREATE TABLE IF NOT EXISTS arc_verdicts (
  id              TEXT PRIMARY KEY,
  arc_id          TEXT REFERENCES arcs(id) ON DELETE SET NULL,
  episode_id      TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  run_id          TEXT,
  decision        TEXT,
  candidates_json TEXT,
  output_json     TEXT,
  model           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_arc_verdicts_episode ON arc_verdicts(episode_id);

-- A bridge is a shared literal (an order id, a flight number, a URL) that ties
-- two objects together without a model call.
CREATE TABLE IF NOT EXISTS bridges (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  left_kind  TEXT,
  left_id    TEXT NOT NULL,
  right_kind TEXT,
  right_id   TEXT NOT NULL,
  confidence REAL,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (kind, value_norm, left_id, right_id)
);

CREATE INDEX IF NOT EXISTS idx_bridges_value ON bridges(kind, value_norm);

CREATE TABLE IF NOT EXISTS provisional_arcs (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT,
  arc_key_candidate TEXT,
  episode_ids       TEXT,                     -- JSON array
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_provisional_arcs_batch ON provisional_arcs(batch_id);

-- ═══ L6 claims + loops ═════════════════════════════════════════════════════
-- ALL versions of a claim_key live here and NOTHING is ever deleted. Which
-- version is ACTIVE is DERIVED (see the claims_active view), never stored.
-- party_pair is DERIVED BY CODE (§4.5): ss|so|st|os|oo|ot|ts|to|tt.
-- ⚠ stated_at (when it was SAID) is the ONLY basis for precedence.
--   ingested_at is written for audit and is never compared for precedence.
CREATE TABLE IF NOT EXISTS claim_versions (
  id            TEXT PRIMARY KEY,
  claim_key     TEXT NOT NULL,
  kind          TEXT,
  subject_id    TEXT REFERENCES entities(id) ON DELETE SET NULL,
  subject_hint  TEXT,                         -- a name string is NEVER an id
  predicate     TEXT,
  object        TEXT,
  text          TEXT,
  speaker_id    TEXT REFERENCES entities(id) ON DELETE SET NULL,
  addressee_id  TEXT REFERENCES entities(id) ON DELETE SET NULL,
  attribution   TEXT,
  party_pair    TEXT,
  confidence    REAL,
  stated_at     TEXT NOT NULL,                -- when it was SAID → precedence
  valid_from    TEXT,
  valid_to      TEXT,
  ingested_at   TEXT,                         -- ⚠ audit/debug ONLY
  closed_by     TEXT,
  closed_reason TEXT,
  decided_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_claim_versions_key     ON claim_versions(claim_key, stated_at DESC);
CREATE INDEX IF NOT EXISTS idx_claim_versions_subject ON claim_versions(subject_id, kind);
CREATE INDEX IF NOT EXISTS idx_claim_versions_speaker ON claim_versions(speaker_id);

-- claims_active — a VIEW, not a table. Recomputed as a function of the version
-- set on every read, so an older claim arriving late lands as a PREDECESSOR
-- and cannot dislodge the current truth, and a newer one takes over with no
-- write at all.
--   for each claim_key: the version with the greatest stated_at that has
--   closed_by IS NULL and (valid_to IS NULL OR valid_to > now).
-- The id tiebreak makes "exactly one row per claim_key" true even when two
-- versions were said at the same instant. ORDER BY NEVER MENTIONS ingested_at.
CREATE VIEW IF NOT EXISTS claims_active AS
SELECT cv.*
  FROM claim_versions cv
 WHERE cv.closed_by IS NULL
   AND (cv.valid_to IS NULL OR cv.valid_to > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   AND cv.id = (
         SELECT c2.id
           FROM claim_versions c2
          WHERE c2.claim_key = cv.claim_key
            AND c2.closed_by IS NULL
            AND (c2.valid_to IS NULL OR c2.valid_to > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ORDER BY c2.stated_at DESC, c2.id DESC
          LIMIT 1
       );

-- loops.state is DERIVED from (due_utc, next_occurrence_utc, resolution
-- evidence, recency of reinforcement) and recomputed whenever any changes.
-- state and triage are CODE-WRITTEN ONLY.
CREATE TABLE IF NOT EXISTS loops (
  id                            TEXT PRIMARY KEY,
  loop_key                      TEXT NOT NULL,
  intent                        TEXT,
  origin                        TEXT,
  owner_id                      TEXT REFERENCES entities(id) ON DELETE SET NULL,
  counterparty_id               TEXT REFERENCES entities(id) ON DELETE SET NULL,
  party_pair                    TEXT,         -- DERIVED by code (§4.5)
  direction                     TEXT,
  stake                         TEXT,
  horizon                       TEXT,
  due_utc                       TEXT,
  due_tz                        TEXT,
  recurrence                    TEXT,
  next_occurrence_utc           TEXT,         -- projected from recurrence
  state                         TEXT,
  state_reason                  TEXT,
  triage                        TEXT,
  urgency                       REAL,
  resolution_evidence_event_id  TEXT REFERENCES events(id) ON DELETE SET NULL,
  arc_id                        TEXT REFERENCES arcs(id) ON DELETE SET NULL,
  confidence                    REAL,
  stated_at                     TEXT,         -- when it was SAID → precedence
  ingested_at                   TEXT,         -- ⚠ audit/debug ONLY
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_loops_key   ON loops(loop_key, stated_at DESC);
CREATE INDEX IF NOT EXISTS idx_loops_state ON loops(state, due_utc);
CREATE INDEX IF NOT EXISTS idx_loops_arc   ON loops(arc_id);

CREATE TABLE IF NOT EXISTS claim_embeddings (
  claim_id TEXT PRIMARY KEY REFERENCES claim_versions(id) ON DELETE CASCADE,
  vec      BLOB NOT NULL,
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loop_embeddings (
  loop_id TEXT PRIMARY KEY REFERENCES loops(id) ON DELETE CASCADE,
  vec     BLOB NOT NULL,
  model   TEXT NOT NULL,
  dim     INTEGER NOT NULL
);

-- ═══ L7 goals (spaces are arcs — see the header) ═══════════════════════════
-- Goals are NEVER created by extraction. They are the user's, or they emerged
-- and were confirmed; nothing a model reads writes this table on its own.
CREATE TABLE IF NOT EXISTS goals (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  kind              TEXT,
  owner_id          TEXT REFERENCES entities(id) ON DELETE SET NULL,
  emerged_from_json TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- space_id is an ARC id: the promoted arc IS the space.
CREATE TABLE IF NOT EXISTS goal_spaces (
  goal_id  TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
  PRIMARY KEY (goal_id, space_id)
);

-- ═══ shared ════════════════════════════════════════════════════════════════
-- Every claim, loop and text edge needs at least one evidence row carrying a
-- VERBATIM quote. No evidence → no write.
CREATE TABLE IF NOT EXISTS evidence (
  subject_kind TEXT NOT NULL,                 -- claim|loop|edge|arc|episode
  subject_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  episode_id   TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  quote        TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_event ON evidence(event_id);

CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  kind        TEXT,
  target_kind TEXT,
  target_id   TEXT,
  question    TEXT NOT NULL,
  options_json TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  answer_json TEXT,
  asked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status, asked_at);

-- Every write emits a mutation row. "Undo run X" is reverse-replay over this.
CREATE TABLE IF NOT EXISTS mutations (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor       TEXT,
  run_id      TEXT,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  field       TEXT,
  old_json    TEXT,
  new_json    TEXT,
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_mutations_target ON mutations(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_mutations_run    ON mutations(run_id);

-- One row per model call. Token counts are the API's, never re-estimated.
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  kind            TEXT,
  role            TEXT,
  model           TEXT,
  cohort_id       TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
  started_at      TEXT,
  ended_at        TEXT,
  status          TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_create    INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  billable_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  error_code      TEXT,
  error_msg       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_runs_cohort  ON runs(cohort_id);

-- A unit that failed its stage: parked here with its error, replayable.
CREATE TABLE IF NOT EXISTS quarantine (
  id          TEXT PRIMARY KEY,
  unit_kind   TEXT NOT NULL,
  unit_id     TEXT NOT NULL,
  cohort_id   TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
  run_id      TEXT,
  error_code  TEXT,
  last_error  TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  replayed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_quarantine_unit ON quarantine(unit_kind, unit_id);
`;
