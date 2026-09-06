// ===========================================================================
// Ordered SQL migrations for supertwinv13.db (see docs/PHASE0_ARCHITECTURE.md §6).
//
// Each migration has a stable `id` (also the ordering key) and a body of SQL.
// The migration runner records applied ids in `schema_migrations` and only runs
// ids that are not yet recorded, so running the full set twice is a no-op the
// second time (idempotent + re-runnable).
//
// The `0001_init` body creates the FULL operational schema now (this is the
// spec's "SQLite init"), even though Phase 0 only exercises the chat / session /
// extraction_runs / quota parts. IDs are TEXT throughout (uuids or app-assigned
// keys) with created_at defaults; foreign keys are declared and enforced (the
// connection enables `PRAGMA foreign_keys = ON`).
// ===========================================================================

import { V2_CORE } from "./migrations/0020_v2_core.js";
import { STREAM_TIERS } from "./migrations/0023_stream_tiers.js";
import { LATENCY_MARKS } from "./migrations/0024_latency_marks.js";
import { CACHE_WRITE_SPLIT } from "./migrations/0025_cache_write_split.js";
import { RUNS_BACKFILL } from "./migrations/0026_runs_backfill.js";
import { V13_CORE } from "./migrations/0100_v13_core.js";
import { WORLD_MODEL } from "./migrations/0101_world_model.js";
import { DECIDE_CONSOLIDATION } from "./migrations/0104_decide_consolidation.js";
import { ASSIST } from "./migrations/0105_assist.js";
import { LIBRARY_FRESHNESS } from "./migrations/0106_library_freshness.js";
import { CONTENT_ECONOMY } from "./migrations/0102_content_economy.js";
import { ENRICHMENT_BUNDLES } from "./migrations/0103_enrichment_bundles.js";
import { T3_GRADUATION } from "./migrations/0107_t3_graduation.js";
import { PRUNE_SOURCES } from "./migrations/0108_prune_sources.js";
import { V6_CORE } from "./migrations/0200_v6_core.js";
import { V6_GRAPH } from "./migrations/0201_v6_graph.js";
import { V6_FTS_PROJECTION } from "./migrations/0202_v6_fts_projection.js";
import { V6_SPACE_CARD } from "./migrations/0203_v6_space_card.js";
import { V6_CALENDAR } from "./migrations/0204_v6_calendar.js";
import { V6_SPACES } from "./migrations/0205_v6_spaces.js";
import { V6_PEOPLE } from "./migrations/0206_v6_people.js";
import { V6_BRIEF } from "./migrations/0207_v6_brief.js";

export interface Migration {
  id: string;
  sql: string;
}

// ---------------------------------------------------------------------------
// 0001_init — full operational schema + chat/session/extraction_runs/quota +
// FTS5 over events.text (with sync triggers).
// ---------------------------------------------------------------------------
const INIT = /* sql */ `
-- ---- Operational: sources / channels / actors / people --------------------

CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT,
  config_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  name        TEXT,
  kind        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS people (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  handle      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS actors (
  id          TEXT PRIMARY KEY,
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  person_id   TEXT REFERENCES people(id) ON DELETE SET NULL,
  display_name TEXT,
  handle      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---- Operational: events (the raw firehose) -------------------------------

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  source_type TEXT,
  channel_id  TEXT REFERENCES channels(id) ON DELETE SET NULL,
  actor_id    TEXT REFERENCES actors(id) ON DELETE SET NULL,
  ts          TEXT,
  kind        TEXT,
  text        TEXT,
  media_path  TEXT,
  raw_json    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel_id);
CREATE INDEX IF NOT EXISTS idx_events_actor   ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);

-- ---- Operational: spaces / goals / milestones / tasks ---------------------

CREATE TABLE IF NOT EXISTS spaces (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  type            TEXT,
  permanence      TEXT,
  status          TEXT,
  latest_update   TEXT,
  latest_update_ts TEXT,
  ends_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  space_id    TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  name        TEXT,
  recurring   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_goals_space ON goals(space_id);

CREATE TABLE IF NOT EXISTS milestones (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT REFERENCES goals(id) ON DELETE CASCADE,
  name        TEXT,
  status      TEXT,
  due_at      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  space_id    TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  goal_id     TEXT REFERENCES goals(id) ON DELETE SET NULL,
  origin      TEXT,
  status      TEXT,
  execute_at  TEXT,
  recurrence  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space_id);
CREATE INDEX IF NOT EXISTS idx_tasks_goal  ON tasks(goal_id);

-- join: which events belong to which space
CREATE TABLE IF NOT EXISTS space_events (
  space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (space_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_space_events_event ON space_events(event_id);

-- ---- FTS5 over events.text (external-content, synced via triggers) ---------

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text,
  content='events',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- ---- extraction_runs (spec non-negotiable: every Claude call logged) -------

CREATE TABLE IF NOT EXISTS extraction_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,
  session_id    TEXT,
  run_id        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  prompt_chars  INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  error_code    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_run     ON extraction_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_created ON extraction_runs(created_at);

-- ---- Phase-0 chat / session tables ----------------------------------------

CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id         TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  cwd                TEXT NOT NULL,
  prompt_bundle_hash TEXT NOT NULL,
  title              TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','poisoned')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content     TEXT NOT NULL,
  run_id      TEXT,
  usage_json  TEXT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);

-- ---- Quota usage (rolling window; getQuota sums rows within the window) ----

CREATE TABLE IF NOT EXISTS quota_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  run_count     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_start ON quota_usage(window_start);
`;

// ---------------------------------------------------------------------------
// 0002_phase1 — WhatsApp / source-agnostic ingestion (docs/PHASE1_CONTRACT §5).
//
//   - events.external_id + UNIQUE(source_id, external_id): the dedupe key for
//     idempotent ingestion (same message twice / restart re-emit / range-extend
//     overlap all collapse to one row via INSERT ... ON CONFLICT DO NOTHING).
//   - idx_events_channel_ts: inbox message paging (channel_id, ts).
//   - channels.source_ext_id / actors.source_ext_id + UNIQUE(source_id, ...):
//     stable external identity so upserts are idempotent per source.
//   - app_state: tiny key/value store (kill-switch flag, import status cursors).
//
// The `ALTER TABLE ... ADD COLUMN` statements are NOT guarded by IF NOT EXISTS
// (SQLite has no such clause). They are safe here because the migration runner
// records applied ids and skips this migration on a second run. As extra armor
// for hand-mangled dev DBs, runMigrationsOn() detects "duplicate column name"
// and treats it as already-applied (see connection.ts).
// ---------------------------------------------------------------------------
const PHASE1 = /* sql */ `
-- Dedupe key for source-agnostic ingestion
ALTER TABLE events   ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_external ON events(source_id, external_id);
CREATE INDEX IF NOT EXISTS idx_events_channel_ts ON events(channel_id, ts);

-- Stable external identity for channels/actors (source-scoped)
ALTER TABLE channels ADD COLUMN source_ext_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_source_ext ON channels(source_id, source_ext_id);
ALTER TABLE actors   ADD COLUMN source_ext_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_source_ext   ON actors(source_id, source_ext_id);

-- Small key/value app state (kill-switch, import status, last-seen cursors)
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// ---------------------------------------------------------------------------
// 0003_phase1_threads — reactions + quoted replies (docs/PHASE1_CONTRACT §R5.3,
// §R5.4).
//
//   - events.reply_to_external_id: for a `reaction` row this is the TARGET
//     message's external_id; for a quoted reply it is the quoted message's
//     external_id. Indexed so getChannelMessages can attach reactions/replies
//     to their target by external_id within a channel.
//   - events.reply_to_text: the quoted snippet text carried on a reply row (for
//     reactions this stays null — the emoji lives in `events.text`).
//
// Same ALTER-ADD-COLUMN robustness as 0002_phase1: these adds are NOT guarded by
// IF NOT EXISTS (SQLite has no such clause), but the migration runner records
// applied ids and skips this migration on a second run, and runMigrationsOn()
// tolerates a hand-added "duplicate column name" on ADD COLUMN (see
// connection.ts) so a partially-applied dev DB upgrades cleanly.
// ---------------------------------------------------------------------------
const PHASE1_THREADS = /* sql */ `
-- Threading: quoted-reply / reaction target reference + quoted snippet.
ALTER TABLE events ADD COLUMN reply_to_external_id TEXT;
ALTER TABLE events ADD COLUMN reply_to_text TEXT;
CREATE INDEX IF NOT EXISTS idx_events_reply_to ON events(reply_to_external_id);
`;

// ---------------------------------------------------------------------------
// 0004_phase2, 0005_grounded_chat and 0006_phase34 are RETIRED (V2 §3.2).
//
// Between them they carried the spaces/goals/milestones/tasks ontology — the
// `space_people` and `patterns` and `task_runs` tables, and a dozen `tasks`
// columns — which nothing reads and which encodes a model this build rejects.
// The three live things they also carried (the `evaluations` table, grounded
// chat's two columns, and `extraction_runs.model`/`role`) moved into
// `0021_v2_prep` below, so a fresh DB still gets exactly them and nothing else.
//
// The ids are burned, per the note on MIGRATIONS: an install that recorded them
// keeps its orphan tables untouched and simply takes 0021 on top, where the
// duplicate ADD COLUMNs are absorbed by runMigrationsOn's duplicate-column
// fallback.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 0008_media — rich media ingestion (docs/rich-media-spec.md §4).
//
//   - events gains the media metadata the daemon already sends and the worker
//     used to throw away (mime/filename/size/sha256/thumb path/duration), plus
//     media_meta_json for the low-traffic rest (width/height/pages/voice/
//     animated/caption) so a new proto field never needs a column.
//   - media_desc_* is the media-reading queue + its result: status is
//     pending|done|skipped|unsupported|error, indexed with ts so the reader can
//     claim the newest pending rows first.
//   - edited_at / revoked_at / is_forwarded: an edit updates its target row and
//     a revoke tombstones it (§5), so both need a marker ON the original row.
//
// events_fts is rebuilt as a two-column external-content table over
// (text, media_description) — a described image must be findable by grounded
// chat. Column 0 stays `text` so existing snippet(events_fts, 0, …) callers are
// unaffected. The three sync triggers are recreated to carry both columns;
// events_au has no `OF` clause, so it fires on a media_description update too
// (that is how a late description reaches the index).
//
// Same ALTER-ADD-COLUMN robustness notes as 0002–0006 apply.
// ---------------------------------------------------------------------------
const MEDIA = /* sql */ `
-- events: media metadata the daemon already sends
ALTER TABLE events ADD COLUMN media_mime TEXT;
ALTER TABLE events ADD COLUMN media_filename TEXT;
ALTER TABLE events ADD COLUMN media_size INTEGER;
ALTER TABLE events ADD COLUMN media_sha256 TEXT;
ALTER TABLE events ADD COLUMN media_thumb_path TEXT;
ALTER TABLE events ADD COLUMN media_seconds INTEGER;
ALTER TABLE events ADD COLUMN media_meta_json TEXT;   -- width/height/pages/voice/animated/caption

-- events: media-reading queue + result
ALTER TABLE events ADD COLUMN media_description TEXT;
ALTER TABLE events ADD COLUMN media_desc_status TEXT; -- pending|done|skipped|unsupported|error
ALTER TABLE events ADD COLUMN media_desc_model TEXT;
ALTER TABLE events ADD COLUMN media_desc_ts TEXT;
ALTER TABLE events ADD COLUMN media_desc_error TEXT;

-- events: edit / revoke / forward markers (§5)
ALTER TABLE events ADD COLUMN edited_at TEXT;
ALTER TABLE events ADD COLUMN revoked_at TEXT;
ALTER TABLE events ADD COLUMN is_forwarded INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_events_desc_status ON events(media_desc_status, ts);

-- ---- events_fts rebuilt over (text, media_description) ---------------------

DROP TRIGGER IF EXISTS events_ai;
DROP TRIGGER IF EXISTS events_ad;
DROP TRIGGER IF EXISTS events_au;
DROP TABLE IF EXISTS events_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text,
  media_description,
  content='events',
  content_rowid='rowid'
);

INSERT INTO events_fts(events_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, media_description)
  VALUES (new.rowid, new.text, new.media_description);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description)
  VALUES ('delete', old.rowid, old.text, old.media_description);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description)
  VALUES ('delete', old.rowid, old.text, old.media_description);
  INSERT INTO events_fts(rowid, text, media_description)
  VALUES (new.rowid, new.text, new.media_description);
END;
`;

// ---------------------------------------------------------------------------
// 0009_media_backfill — seed media_desc_status on rows that predate 0008_media.
//
// 0008 added the column; insertEvent only derives the status for rows written
// AFTER it. Everything already stored keeps media_desc_status = NULL, and
// claimPendingMedia matches on = 'pending', so every attachment ingested before
// the upgrade is permanently invisible to the media reader.
//
// Those rows also have no media_mime, no media_thumb_path and no
// media_meta_json — the pre-0.2.0 worker discarded that metadata, which is the
// bug this release fixes — so the status is derived from the only two signals
// they still carry: `kind` and the media_path extension. That mirrors
// insertEvent's mediaDescStatusFor()/isReadableDocument() degraded to those two
// inputs: a video with no thumbnail has no frame to read, and a document is
// readable only when its extension is one the reader accepts.
//
// The NULL guard in the WHERE clause is what makes this idempotent and what
// keeps a row already carrying a status (including one already described) from
// being reset. A revoked row lost its media_path in applyRevoke, so it is left
// alone too.
// ---------------------------------------------------------------------------
const MEDIA_BACKFILL = /* sql */ `
UPDATE events
   SET media_desc_status = CASE
     WHEN kind IN ('image', 'sticker') THEN 'pending'
     WHEN kind = 'video' AND media_thumb_path IS NOT NULL THEN 'pending'
     WHEN kind = 'document' AND (
            lower(media_path) LIKE '%.pdf'
         OR lower(media_path) LIKE '%.txt'
         OR lower(media_path) LIKE '%.md'
         OR lower(media_path) LIKE '%.csv'
         OR lower(media_path) LIKE '%.json'
          ) THEN 'pending'
     ELSE 'unsupported'
   END
 WHERE media_path IS NOT NULL
   AND media_desc_status IS NULL;
`;

// ---------------------------------------------------------------------------
// 0010_token_truth — record all four token counts, not just the uncached delta
// (docs/v3-spec.md §1).
//
// `input_tokens` alone is a measured ~0.03% of what a media call actually costs:
// the bulk arrives as cache creation + cache read, which nothing ever stored.
// Both tables gain the two missing counters so the runs viewer and the quota
// window stop under-reporting by three orders of magnitude.
//
// quota_usage also gains `billable_tokens`, the weighted equivalent the chat
// gate compares against (cache reads bill at ~10%, cache writes at 125%).
// Summing the raw four would trip the gate ~10x sooner than today and lock the
// user out of chat for spend that never happened. Rows written before this
// migration carry no cache numbers at all, so their billable equivalent IS
// input+output — seeded here so the gate does not read them as free.
// ---------------------------------------------------------------------------
const TOKEN_TRUTH = /* sql */ `
ALTER TABLE extraction_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE extraction_runs ADD COLUMN cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_usage     ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_usage     ADD COLUMN cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_usage     ADD COLUMN billable_tokens             INTEGER NOT NULL DEFAULT 0;

UPDATE quota_usage
   SET billable_tokens = input_tokens + output_tokens
 WHERE billable_tokens = 0;
`;

// ---------------------------------------------------------------------------
// 0011_links — link previews + the link-scrape lifecycle (docs/v3-spec.md §3).
//
//   - link_url/title/description/thumb_path/preview_type mirror the daemon's
//     `Link` wire struct: the preview WhatsApp already attaches to a message and
//     the worker threw away. A plain-text URL arrives with only link_url set.
//   - link_scraped_text + link_scrape_status/error give scraping the same
//     lifecycle media reading has: status is pending|done|skipped|unsupported|
//     error, stamped once at insert from what is READABLE (scheme), never from
//     whether the switch is on — a switch flipped on later must still be able to
//     reach the row.
//
// events_fts is rebuilt again, now over five columns, so a link is findable by
// its title, its preview blurb and the page text behind it. Column 0 stays
// `text` (chat-grounding.ts calls snippet(events_fts, 0, …)) and column 1 stays
// `media_description`, so nothing that reads the index by ordinal moves.
//
// No backfill: rows stored before this release carry no link_url because the
// daemon never sent one, and a URL cannot be pulled out of `text` in SQL. They
// gain previews on re-import.
// ---------------------------------------------------------------------------
const LINKS = /* sql */ `
-- events: the link preview the daemon now sends
ALTER TABLE events ADD COLUMN link_url TEXT;
ALTER TABLE events ADD COLUMN link_title TEXT;
ALTER TABLE events ADD COLUMN link_description TEXT;
ALTER TABLE events ADD COLUMN link_thumb_path TEXT;
ALTER TABLE events ADD COLUMN link_preview_type TEXT;

-- events: link-scraping queue + result
ALTER TABLE events ADD COLUMN link_scraped_text TEXT;
ALTER TABLE events ADD COLUMN link_scrape_status TEXT; -- pending|done|skipped|unsupported|error
ALTER TABLE events ADD COLUMN link_scrape_error TEXT;

CREATE INDEX IF NOT EXISTS idx_events_link_status ON events(link_scrape_status, ts);

-- ---- events_fts rebuilt over (text, media_description, link_*) -------------

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
  content='events',
  content_rowid='rowid'
);

INSERT INTO events_fts(events_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text);
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text);
END;
`;

// ---------------------------------------------------------------------------
// 0012_business_channel — mark business / official-account chats
// (docs/v3-spec.md §2, §5).
//
// `media.business_enabled` gates media reading on business chats, and there was
// no way to express "this chat is a business": verifiedName /
// officialAccountName were consumed only to build a display name. The daemon now
// sets the flag on the channel line; claimPendingMedia filters on it.
//
// Existing channels default to 0 and are re-flagged the next time the daemon
// re-emits them, which it does on every connect.
// ---------------------------------------------------------------------------
const BUSINESS_CHANNEL = /* sql */ `
ALTER TABLE channels ADD COLUMN is_business INTEGER NOT NULL DEFAULT 0;
`;

// ---------------------------------------------------------------------------
// 0013_albums — the album grouping the protocol does not carry
// (docs/v4-spec.md §5).
//
// WhatsApp sends no grouping key: AssociatedChildMessage is an opaque
// FutureProofMessage, the children carry an empty StanzaID, and the header's
// AlbumMessage says only how many members to expect. The daemon therefore
// groups heuristically and stamps the HEADER's external_id on the header and on
// the members that followed it — so the container is the row whose album_id is
// its own external_id, album_count sits on the header alone, and a run the
// heuristic could not line up exactly carries neither column.
//
// Both columns are dropped again by 0019_drop_albums; this body stays as it was
// applied, because a DB in the wild recorded this id and never revisits it.
//
// Same ALTER-ADD-COLUMN robustness notes as 0002–0012 apply.
// ---------------------------------------------------------------------------
const ALBUMS = /* sql */ `
ALTER TABLE events ADD COLUMN album_id TEXT;
ALTER TABLE events ADD COLUMN album_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_events_album ON events(album_id);
`;

// ---------------------------------------------------------------------------
// 0014_history_flag — tell a history-sync row apart from a live arrival
// (docs/v4-spec.md §4b).
//
// `onEvent` is the single path for both, so every row of an import counted as
// live and the media queue read the whole backlog one item at a time. The daemon
// now says which it is, and claimPendingMedia orders live rows first so only a
// genuine arrival jumps the backlog.
//
// Rows written before the flag existed read as live (0). Nothing re-queues them
// — live priority is decided when the row is claimed, from a set the daemon
// fills at insert — so the only effect is the claim's ordering, where ts DESC
// already separates them from anything arriving now.
// ---------------------------------------------------------------------------
const HISTORY_FLAG = /* sql */ `
ALTER TABLE events ADD COLUMN is_historical INTEGER NOT NULL DEFAULT 0;
`;

// ---------------------------------------------------------------------------
// 0015_video_frames — the frames sampled out of a video (docs/v5-spec.md §2).
//
// One JSON array on the video's own row, `[{"path":…,"seconds":…}, …]`, rather
// than a child table: the frames are meaningless apart from their video, they
// are always read as a whole sequence (the spec describes them in ONE call so
// the model can say what changes), and the count is capped at
// media.video_frame_max.
//
// The paths are also the only record that those files exist. Nothing else on
// disk says a `.frameN.jpg` belongs to a live row, so clearing this column is
// what marks the files unreferenced — which is how a revoke and a re-scan get
// them deleted (§2), via listMediaFramePaths() and a sweep.
//
// Same ALTER-ADD-COLUMN robustness notes as 0002–0014 apply.
// ---------------------------------------------------------------------------
const VIDEO_FRAMES = /* sql */ `
ALTER TABLE events ADD COLUMN media_frames_json TEXT;  -- [{path, seconds}, …]
`;

// ---------------------------------------------------------------------------
// 0016_transcripts — local whisper transcription (docs/v5-spec.md §3).
//
// transcript / transcript_status / transcript_model / transcript_ts /
// transcript_error mirror the media-description lifecycle column for column,
// and the status vocabulary IS MediaDescStatus (pending|done|skipped|
// unsupported|error) — a second, subtly-different vocabulary for the same
// lifecycle is how the two queues would drift apart.
//
// The backfill mirrors 0009_media_backfill and exists for the same reason: the
// column is stamped by insertEvent only for rows written AFTER this migration,
// so without it every voice note already on disk would be permanently invisible
// to the transcriber — and transcription ships off, so the whole point is that
// switching it on later reaches the backlog. Derived from `kind` alone: whether
// a video actually carries an audio track is only knowable by probing the file,
// which the transcriber does. Revoked rows lost their media_path in applyRevoke,
// so they are left alone; the NULL guard keeps the body idempotent.
//
// events_fts is rebuilt over six columns so a voice note is findable by what was
// said in it. Column 0 stays `text` (chat-grounding.ts calls
// snippet(events_fts, 0, …)) and 1–4 keep their order, so nothing that reads the
// index by ordinal moves; `transcript` is appended last. events_au still has no
// `OF` clause, so it fires on a transcript update too — that is how a transcript
// finished minutes after ingestion reaches the index.
//
// Same ALTER-ADD-COLUMN robustness notes as 0002–0015 apply.
// ---------------------------------------------------------------------------
const TRANSCRIPTS = /* sql */ `
ALTER TABLE events ADD COLUMN transcript TEXT;
ALTER TABLE events ADD COLUMN transcript_status TEXT; -- pending|done|skipped|unsupported|error
ALTER TABLE events ADD COLUMN transcript_model TEXT;
ALTER TABLE events ADD COLUMN transcript_ts TEXT;
ALTER TABLE events ADD COLUMN transcript_error TEXT;

CREATE INDEX IF NOT EXISTS idx_events_transcript_status ON events(transcript_status, ts);

UPDATE events
   SET transcript_status = CASE
     WHEN kind IN ('audio', 'video') THEN 'pending'
     ELSE 'unsupported'
   END
 WHERE media_path IS NOT NULL
   AND transcript_status IS NULL;

-- ---- events_fts rebuilt over (text, media_description, link_*, transcript) --

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
  content='events',
  content_rowid='rowid'
);

INSERT INTO events_fts(events_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript);
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript);
END;
`;

// ---------------------------------------------------------------------------
// 0017_reply_fts — index the quoted-reply snippet (docs/v6-spec.md §1).
//
// 96 rows carry a `reply_to_external_id` and 80 of them a `reply_to_text`, and
// none of that text was searchable. A reply is usually the shortest line in the
// chat ("Can do. Place?") and carries none of the question's words — what it
// carries is the QUOTE of the message that does, so leaving the quote out of the
// index is what makes the answer to a question unreachable from the question.
//
// events_fts is rebuilt over seven columns. Column 0 stays `text` and 1–5 keep
// their order, so nothing that reads the index by ordinal moves — bm25() takes
// one weight per column in this order and snippet() takes the index, which is
// what db/retrieval.ts's EVENTS_FTS_COLUMNS mirrors. `reply_to_text` is appended
// last. events_au still has no `OF` clause, so it fires on a reply_to_text
// rewrite the same way it does on a late transcript or description.
// ---------------------------------------------------------------------------
const REPLY_FTS = /* sql */ `
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
  content='events',
  content_rowid='rowid'
);

INSERT INTO events_fts(events_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript, new.reply_to_text);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript, old.reply_to_text);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES ('delete', old.rowid, old.text, old.media_description, old.link_title, old.link_description, old.link_scraped_text, old.transcript, old.reply_to_text);
  INSERT INTO events_fts(rowid, text, media_description, link_title, link_description, link_scraped_text, transcript, reply_to_text)
  VALUES (new.rowid, new.text, new.media_description, new.link_title, new.link_description, new.link_scraped_text, new.transcript, new.reply_to_text);
END;
`;

// ---------------------------------------------------------------------------
// 0018_semantic_index — storage for the embedding tier (docs/v6-spec.md §1,
// tier 3).
//
// One vector per event, in its own table rather than a column on `events`: the
// index is derived data that a model change throws away wholesale, and a BLOB
// per row on the hot table would be read by every inbox page that never wants
// it. ON DELETE CASCADE keeps it honest — a reset or a revoke-and-delete takes
// the vectors with it.
//
// `model` + `dim` are recorded ON EACH ROW, not once in app_state, because that
// is what makes a model change invalidate rather than silently mix two embedding
// spaces: every read filters on the pair, so rows still carrying the old model
// are invisible to the new model's search AND come back from the "not embedded
// yet" claim, which re-embeds them incrementally instead of demanding one big
// re-index before search works again.
// ---------------------------------------------------------------------------
const SEMANTIC_INDEX = /* sql */ `
CREATE TABLE IF NOT EXISTS event_embeddings (
  event_id   TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,   -- dim little-endian float32s
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_event_embeddings_model ON event_embeddings(model, dim);
`;

// ---------------------------------------------------------------------------
// 0019_drop_albums — albums are gone, columns included (docs/v7-spec.md §1).
//
// WhatsApp carries no grouping key, so `album_id` only ever held a guess made
// at map time, and every row the heuristic could not line up exactly carried
// nothing at all. Leaving the columns behind would leave the next reader to
// invent a meaning for a column nothing writes; photos are ordinary messages
// again.
//
// `ALTER TABLE … DROP COLUMN` (SQLite 3.35+; 3.53 is bundled) IS the rebuild,
// done by the engine: it rewrites every row without the column while keeping
// that row's rowid, and leaves the rest of the schema — every other column,
// every index, all three FTS triggers, and the foreign keys space_events and
// event_embeddings hold ON events — exactly where it found them. The hand-rolled
// twelve-step rebuild would have to DROP `events` for a moment, and with
// `foreign_keys = ON` (connection.ts) that implicit delete cascades into both
// child tables; the pragma that turns them off is a no-op inside the runner's
// transaction. Keeping the rowids is what keeps the FTS contract: events_fts is
// external-content over events.rowid, so a rebuild that renumbers them points
// every indexed row at a different message without erroring.
//
// The index goes first — DROP COLUMN refuses a column an index still names.
// ---------------------------------------------------------------------------
const DROP_ALBUMS = /* sql */ `
DROP INDEX IF EXISTS idx_events_album;

ALTER TABLE events DROP COLUMN album_id;
ALTER TABLE events DROP COLUMN album_count;
`;

// ---------------------------------------------------------------------------
// 0020_video_posters — let a video without a WhatsApp thumbnail be looked at
// (docs/v7-spec.md §3).
//
// A thumbnail is only ever written from the protobuf's JPEGThumbnail, and
// history-synced videos often carry none — 10 of the 18 videos measured. Both
// the insert path and 0009_media_backfill read "no thumbnail" as "nothing to
// read" and stamped `unsupported`, which is a PERMANENT verdict: the claim
// matches on 'pending', so those rows could never be described, and a poster
// can be sampled out of the mp4 that is sitting on disk with the ffmpeg that is
// already bundled.
//
// Only rows nothing ever actually looked at are re-opened: `media_desc_ts` is
// stamped by every recorded attempt, so a NULL there is the difference between
// a verdict derived at insert and one the reader reached after opening the
// file. That guard is also what makes this idempotent.
// ---------------------------------------------------------------------------
const VIDEO_POSTERS = /* sql */ `
UPDATE events
   SET media_desc_status = 'pending'
 WHERE kind = 'video'
   AND media_path IS NOT NULL
   AND media_desc_status = 'unsupported'
   AND media_desc_ts IS NULL
   AND revoked_at IS NULL;
`;

// ---------------------------------------------------------------------------
// 0021_v2_prep — what 0004/0005/0006 carried that something still reads (V2
// §3.2). Those three were retired for the spaces/tasks ontology around it; the
// three live pieces are re-declared here so a fresh DB grows exactly them:
//
//   - evaluations: the 👍/👎 rows POST /api/evaluations writes and
//     GET /api/evaluations/summary reads (db/runs.ts).
//   - chat_sessions.grounded / chat_messages.citations_json: grounded chat's
//     session flag and the parsed CITATIONS array stored with a message
//     (db/index.ts createSession / appendMessage).
//   - extraction_runs.model / role: what the runs viewer attributes each call
//     to, read as COALESCE(role, kind) / COALESCE(model, '').
//
// On an install that already recorded 0004–0006 the three ADD COLUMNs are
// duplicates; runMigrationsOn() re-runs the body statement-by-statement and
// swallows exactly "duplicate column name" on ADD COLUMN, so it converges.
// ---------------------------------------------------------------------------
const V2_PREP = /* sql */ `
-- Human eval on any surfaced output (👍/👎 + optional note), kept forever.
CREATE TABLE IF NOT EXISTS evaluations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  output_type TEXT NOT NULL,
  output_id   TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('up','down')),
  note        TEXT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_evaluations_type ON evaluations(output_type);

-- Grounded chat: the session flag + the citations parsed off the reply.
ALTER TABLE chat_sessions ADD COLUMN grounded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN citations_json TEXT;

-- extraction_runs: which model + which process produced the run.
ALTER TABLE extraction_runs ADD COLUMN model TEXT;
ALTER TABLE extraction_runs ADD COLUMN role  TEXT;
`;

/**
 * Ordered list of migrations. Append new migrations with the next id
 * (`0002_...`); never rename or reorder existing ones — the id is the recorded
 * key in `schema_migrations`.
 *
 * An id may be RETIRED once no live SQL names anything it created. The runner
 * only ever walks this array, so an id an installed DB already recorded is
 * never revisited: that DB keeps the tables as untouched orphans while a fresh
 * DB simply never grows them. The retired id is burned — reusing it would make
 * the new body skip every DB that recorded the old one.
 */
export const MIGRATIONS: Migration[] = [
  { id: "0001_init", sql: INIT },
  { id: "0002_phase1", sql: PHASE1 },
  { id: "0003_phase1_threads", sql: PHASE1_THREADS },
  // 0004_phase2, 0005_grounded_chat and 0006_phase34 are retired: the
  // spaces/tasks ontology they carried has no readers left, and what did have
  // readers moved to 0021_v2_prep.
  // 0007_phase5 is retired: nightly_runs, quality_snapshots and
  // task_runs.session_id have no readers left.
  { id: "0008_media", sql: MEDIA },
  { id: "0009_media_backfill", sql: MEDIA_BACKFILL },
  { id: "0010_token_truth", sql: TOKEN_TRUTH },
  { id: "0011_links", sql: LINKS },
  { id: "0012_business_channel", sql: BUSINESS_CHANNEL },
  { id: "0013_albums", sql: ALBUMS },
  { id: "0014_history_flag", sql: HISTORY_FLAG },
  { id: "0015_video_frames", sql: VIDEO_FRAMES },
  { id: "0016_transcripts", sql: TRANSCRIPTS },
  { id: "0017_reply_fts", sql: REPLY_FTS },
  { id: "0018_semantic_index", sql: SEMANTIC_INDEX },
  { id: "0019_drop_albums", sql: DROP_ALBUMS },
  { id: "0020_video_posters", sql: VIDEO_POSTERS },
  { id: "0021_v2_prep", sql: V2_PREP },
  // The V2 ontology (arch §6). Body: ./migrations/0020_v2_core.sql, the name the
  // build doc gives the file, mirrored into ./migrations/0020_v2_core.ts for the
  // bundle. The recorded id is `0022_v2_core`, not `0020_...`: 0020 and 0021
  // were already shipped, and these ids must sort in the order they apply (the
  // array is the apply order, and this one has to be LAST — it rebuilds `events`
  // and drops the legacy ontology the ids above created).
  { id: "0022_v2_core", sql: V2_CORE },
  // streams.tier + its provenance (arch §9.3, build item 1.2). After
  // 0022_v2_core because that is the migration that creates `streams`.
  { id: "0023_stream_tiers", sql: STREAM_TIERS },
  // Persisted TTFT / tokens-per-second marks and the global-acceptance
  // milestones (arch §9.5.3 rule 4, build item 4.2).
  { id: "0024_latency_marks", sql: LATENCY_MARKS },
  // The cache-write half split by TTL: 5-minute writes bill at 1.25x a fresh
  // input token, 1-hour writes at 2.0x, and this build writes 1-hour entries.
  { id: "0025_cache_write_split", sql: CACHE_WRITE_SPLIT },
  // History from `extraction_runs` copied into `runs` + `latency_marks`, so an
  // installed build's Usage and Latency panels are not blank over spend that
  // really happened. After 0025, whose columns it writes.
  { id: "0026_runs_backfill", sql: RUNS_BACKFILL },
  // The V13 substrate (build P0.4, spec §6.1): the roles envelope on `events`,
  // dispatch state on `streams`, decisions/corrections, the traces index
  // (schema only — P0.7 owns the module) and the extended `runs`.
  { id: "0100_v13_core", sql: V13_CORE },
  // The V13 world model (build P1.1, spec §7.3/§9/§11.1): spaces, chapters,
  // stream-scoped episodes (+ message-range membership), tasks, the claims
  // header over the kept claim_versions, tone_profiles, entities.circle +
  // the `people` view, unsorted, second_look, and space_index (FTS +
  // embedding + entity + bridge keys) plus event_bridge_keys for ingest.
  { id: "0101_world_model", sql: WORLD_MODEL },
  // The packer's content economy (build P1.2, spec §4.5): cached digest lines
  // per content_hash, L1/L2 escalation log + per-run level stats, and the T2
  // review queue the Critic's flag_overlap verdict feeds (build P1.3).
  { id: "0102_content_economy", sql: CONTENT_ECONOMY },
  // Enrichment bundle countdowns (build P1.8, spec §4.4 rule 2): pending
  // attachments per dispatched bundle; zero → one scoped re-understand job,
  // or a full re-dispatch when a placeholder forced an episode to unsorted.
  { id: "0103_enrichment_bundles", sql: ENRICHMENT_BUNDLES },
  // The Decide work queue (one pending row per space, merge-in), the deferred
  // holding pen for P1-emitted schedules/follow-ups, and spaces.plan_json
  // (build P1.4/P1.5, spec §6.3.2 / §8.4).
  { id: "0104_decide_consolidation", sql: DECIDE_CONSOLIDATION },
  // The assist lane's durable state (build P2.2, spec §10): artifacts +
  // graded reconcile signals, the per-topic novelty/cooldown/suppression
  // accumulator the code trigger gate keeps, and the watcher's tail cursor.
  { id: "0105_assist", sql: ASSIST },
  // Per-stream capture pause for the Library's ⏸ toggle (build P2.4, spec
  // §14.3.2): honored at the single-writer ingest funnels, flipped via a
  // decision row.
  { id: "0106_library_freshness", sql: LIBRARY_FRESHNESS },
  // Graduation metric ledger (gates per day, 14-day streak → auto-create)
  // and T3's cross-space links (build P4.3, spec §15.3 + §14.9).
  { id: "0107_t3_graduation", sql: T3_GRADUATION },
  // V6 P1 S0.5 (Build §2.3, T4-13): drop the dead consent-shaped columns
  // sources.connected_at / sources.enabled — zero readers, zero writers.
  { id: "0108_prune_sources", sql: PRUNE_SOURCES },
  // V6 P1 S1.1 (Build §4.1, Product_V6 §23.1): consents, the narrow zlib
  // archive, explicit episode membership, bundle attempts / dead letter,
  // content-addressed blobs, coverage as source × date range × status (the
  // V2 progress meter moves to `coverage_progress`), and the envelope's
  // `consent_id` + `tier` columns on `events`.
  { id: "0200_v6_core", sql: V6_CORE },
  // V6 P1 S2.1 (Build §5.1, Product_V6 §23.4/§23.5, T5-2/3): walk indexes on
  // entity_edges / edge_evidence, typed-field columns on `claims`, `chunks` +
  // int8 rowid-keyed `chunk_embeddings`, `hub_nodes` with `self` seeded, and
  // the fixed self entity row.
  { id: "0201_v6_graph", sql: V6_GRAPH },
  // V6 P1 S2.3 (Build §5.2 lane A, Product_V6 §23.4 lexical): events gain the
  // projected `app` / `window_title` / `doc_key` columns and events_fts is
  // rebuilt over ten columns (the three appended LAST — ordinals 0–6 keep
  // their meaning); `chunks_fts` puts BM25 over chunks and cards.
  { id: "0202_v6_fts_projection", sql: V6_FTS_PROJECTION },
  // V6 P1 S3.7 (Build §6.2 lane C, Product_V6_Phase1 §13.1): the space card's
  // `summary` / `latest` / `latest_ts`, written by decide.v9. Milestones stay
  // chapters rows (status done|active|todo); plan stays plan_json.
  { id: "0203_v6_space_card", sql: V6_SPACE_CARD },
  // V6 P1 S5.3 (Build §8 lane C, Product_V6_Phase1 §12/§16): the derived
  // calendar — chat-derived events (tentative until confirmed), recurrence
  // rules (always a confirm suggestion), people's dates and their lead-time
  // plans. Tasks and the twin's steps are read from `tasks`, not copied.
  { id: "0204_v6_calendar", sql: V6_CALENDAR },
  // V6 P1 S5.1 (Build §8 lane A, Product_V6_Phase1 §13): how a space was born
  // (inferred | asked | woken), the evidence that justified it, the bar thread
  // an asked-for space came from, the dormancy clock, and the enrichment
  // ledger (content hash per fetch target — the model sees a change only).
  { id: "0205_v6_spaces", sql: V6_SPACES },
  // V6 P1 S5.4 (Build §8 lane D, Product_V6 §11.5 / §11.8): role_resolutions
  // (the ladder's per-event verdict, revisable by a new row) and person_prefs
  // (learned follow-up radar lead time).
  { id: "0206_v6_people", sql: V6_PEOPLE },
  // V6 P1 S4.6 (Build §7.2 lane B, Product_V6 §14.4 item 7): `briefs` — one
  // row per fired set time, holding the ledger code composed and the prose
  // one brief.v2 call wrote. New table only; a skipped slot writes nothing.
  { id: "0207_v6_brief", sql: V6_BRIEF },
];
