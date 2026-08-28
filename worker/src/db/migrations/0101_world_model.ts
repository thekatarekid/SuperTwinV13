// ===========================================================================
// 0101_world_model — the V13 world model (build P1.1, spec §7.3, §9, §11.1).
//
// What the understanding lane writes INTO: spaces → chapters → tasks, with
// episodes as the stream-scoped evidence layer beneath, claims global with
// per-space refs, unsorted + second_look as the honesty valves, and
// space_index (FTS + embedding + entity + bridge keys) as the four retrieval
// lanes the packer draws candidate spaces from.
//
// The V11 derivation middle (sessions → episodes → arcs) was pruned in P0.3;
// its EPISODE/ARC tables are dead weight with a shape V13 does not want
// (arcs-as-spaces, session-membership). Fresh installs only (build §0.4), so
// the dead tables are dropped and `episodes` is recreated with the V13 shape
// under the same name — `evidence.episode_id`'s FK resolves by name at DML
// time, so the kept `evidence` table keeps working against the new episodes.
//
// KEPT AND GROWN, not replaced:
//   - `entities` / `entity_identities` / `entity_edges` (0020): + `circle`
//     (spec §7.3.2) — provisional people already exist (`provisional` column).
//   - `claim_versions` + the `claims_active` view (0020): that IS the ported
//     V11 claims table design (append-only versions, active = derived).
//     Grown with evidence/episode linkage, plus a `claims` header table
//     (one row per claim_key, maintained by worker/src/claims/store.ts in the
//     same transaction as each version write) and `tone_profiles` (§7.3.3).
//   - `people` is a VIEW over entities: person-typed, merge-resolved, with
//     circle + provisional riding along.
// ===========================================================================

/** The 0101_world_model migration body. */
export const WORLD_MODEL = /* sql */ `
-- ---- prune the dead V11 derivation tables (children first) ----------------

DROP TABLE IF EXISTS arc_verdicts;
DROP TABLE IF EXISTS arc_episodes;
DROP TABLE IF EXISTS goal_spaces;        -- referenced arcs; goals itself stays
DROP TABLE IF EXISTS provisional_arcs;
DROP TABLE IF EXISTS arcs;
DROP TABLE IF EXISTS loop_embeddings;
DROP TABLE IF EXISTS loops;              -- V13 tasks replace loops (§11.1)
DROP TABLE IF EXISTS episode_verdicts;
DROP TABLE IF EXISTS episode_sessions;
DROP TABLE IF EXISTS episode_embeddings;
DROP TABLE IF EXISTS episodes;

-- ---- spaces (spec §9) ------------------------------------------------------
-- status carries the propose-only mode: 'proposed' until approved (or user-
-- created, which is born 'active'). Types are the §9 axes, one column each.

CREATE TABLE IF NOT EXISTS spaces (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,             -- 4-8 specific words
  life_area      TEXT,                      -- Travel | Money | Health | ...
  goal           TEXT,
  status         TEXT NOT NULL DEFAULT 'proposed',  -- proposed|active|dormant|archived|rejected
  horizon        TEXT,                      -- 'short' | 'long'
  permanence     TEXT,                      -- 'permanent' | 'ephemeral'
  cadence        TEXT,                      -- 'one-time' | 'recurring'
  is_private     INTEGER NOT NULL DEFAULT 0,   -- V1 flag (spec §9)
  is_solo        INTEGER NOT NULL DEFAULT 0,   -- V1 flag (spec §9)
  exemplars_json TEXT,                      -- 2-3 exemplar episode summaries
  created_by     TEXT,                      -- 'user' | run id | pass name
  confidence     REAL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT,
  archived_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status, updated_at);

-- ---- chapters (spec §9): cross-stream sub-goals; dated = milestones --------

CREATE TABLE IF NOT EXISTS chapters (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- active|done|dropped
  target_date TEXT,                             -- set => this chapter IS a milestone
  summary     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_chapters_space ON chapters(space_id, status);

-- ---- episodes (spec §9, §8.1): stream-scoped bursts, the evidence layer ----
-- Recreated with the V13 shape (the V11 table was dropped above). An episode
-- lives in ONE stream; space/chapter attachment is optional; chain_prev links
-- "same topic after a long break = new episode chained to the old" (§8.1).

CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT PRIMARY KEY,
  stream_id     TEXT REFERENCES streams(id) ON DELETE SET NULL,
  space_id      TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  chapter_id    TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  state         TEXT NOT NULL DEFAULT 'open',    -- open|dormant|closed
  summary       TEXT,
  chain_prev_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  confidence    REAL,
  first_ts      TEXT,                            -- ts of the earliest member event
  last_ts       TEXT,                            -- ts of the latest member event
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_stream  ON episodes(stream_id, last_ts);
CREATE INDEX IF NOT EXISTS idx_episodes_space   ON episodes(space_id, state);
CREATE INDEX IF NOT EXISTS idx_episodes_chapter ON episodes(chapter_id);

-- ---- episode_events: message RANGES (build P1.1) ---------------------------
-- Orient emits events as ids and ranges ("e1", "e4-e11"); a range row stores
-- both endpoints. A single event is a range of one (start = end). Rowids give
-- the in-stream ordering the range spans (events.rowid = insertion order).

CREATE TABLE IF NOT EXISTS episode_events (
  id             TEXT PRIMARY KEY,
  episode_id     TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  start_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  end_event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  start_rowid    INTEGER,
  end_rowid      INTEGER,
  added_by       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (episode_id, start_event_id, end_event_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_events_episode ON episode_events(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_events_start   ON episode_events(start_event_id);

-- ---- tasks (spec §11.1) ----------------------------------------------------
-- schedule_json: { fire_at|recurrence, mode auto|confirm,
--                  source inferred|user, polling {interval,until,max} }
-- decisions[] live in the decisions table (target_kind='task'); evidence is
-- inline JSON quotes ({event_ids[], quote}) like every pass output.

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  space_id        TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  chapter_id      TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'implicit',  -- explicit|implicit|suggested
  category        TEXT,   -- communication|transaction|research|scheduling|filing|creation|monitoring|errand
  risk_class      TEXT NOT NULL DEFAULT 'advise-only',  -- auto|approve-final|approve-first|advise-only
  owner_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  owner           TEXT,                    -- 'self' | roster ref when unresolved to an entity row
  due             TEXT,                    -- absolute ISO-8601 (resolved at extraction, §7.4)
  status          TEXT NOT NULL DEFAULT 'open',
    -- open|scheduled|executing|needs_input|needs_approval|done|cancelled|dismissed (all reopenable)
  schedule_json   TEXT,
  evidence_json   TEXT,
  plan_ref        TEXT,
  result_ref      TEXT,
  created_by      TEXT,
  confidence      REAL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT,
  closed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_space  ON tasks(space_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due);
CREATE INDEX IF NOT EXISTS idx_tasks_owner  ON tasks(owner_entity_id);

-- ---- claims (spec §8.3): header over the kept claim_versions ---------------
-- claim_versions (0020) is the ported V11 design: append-only versions,
-- active = derived (claims_active view). V13 adds a code-maintained header
-- row per claim_key (worker/src/claims/store.ts writes both in one tx), plus
-- evidence/episode linkage on versions, and per-space refs (claims live
-- globally; spaces hold refs — spec §9).

ALTER TABLE claim_versions ADD COLUMN evidence_json TEXT;  -- [{event_ids[], quote}]
ALTER TABLE claim_versions ADD COLUMN episode_id    TEXT;  -- source episode (v13 episodes)

CREATE TABLE IF NOT EXISTS claims (
  claim_key         TEXT PRIMARY KEY,
  kind              TEXT,       -- fact|preference|belief|opinion|interest|habit|recommendation|workflow|relationship
  subject_id        TEXT REFERENCES entities(id) ON DELETE SET NULL,
  subject_hint      TEXT,
  status            TEXT NOT NULL DEFAULT 'active',   -- active|closed
  active_version_id TEXT,                             -- claim_versions.id (maintained by code)
  version_count     INTEGER NOT NULL DEFAULT 0,
  first_stated_at   TEXT,
  last_stated_at    TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject_id, kind);
CREATE INDEX IF NOT EXISTS idx_claims_status  ON claims(status, last_stated_at);

CREATE TABLE IF NOT EXISTS space_claims (
  space_id  TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  claim_key TEXT NOT NULL REFERENCES claims(claim_key) ON DELETE CASCADE,
  added_by  TEXT,
  PRIMARY KEY (space_id, claim_key)
);

-- ---- tone_profiles (spec §7.3.3): drafting voice, never identity -----------
-- Per person AND/OR per stream (group). Generic address terms feed HERE, and
-- never become relationship claims. NULLs are distinct in SQLite, so the
-- uniqueness runs over COALESCE'd keys.

CREATE TABLE IF NOT EXISTS tone_profiles (
  id                 TEXT PRIMARY KEY,
  person_entity_id   TEXT REFERENCES entities(id) ON DELETE CASCADE,
  stream_id          TEXT REFERENCES streams(id) ON DELETE CASCADE,
  register           TEXT,                  -- formal|casual|playful|terse|...
  language_mix       TEXT,                  -- e.g. 'Hinglish', 'en', 'hi+en'
  emoji_habits       TEXT,                  -- e.g. 'heavy 🔥/😂', 'none'
  address_terms_json TEXT,                  -- [{term, class: 'discriminating'|'generic', count}]
  notes              TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tone_profiles_scope
  ON tone_profiles(COALESCE(person_entity_id, ''), COALESCE(stream_id, ''));

-- ---- entities grow a circle (spec §7.3.2); people is a VIEW ----------------

ALTER TABLE entities ADD COLUMN circle TEXT;
  -- partner|family|close_friends|friends|coworkers|important_services
  -- |old_batchmates|acquaintances|businesses  (NULL = unassigned)

CREATE INDEX IF NOT EXISTS idx_entities_circle ON entities(circle);

-- The V0 placeholder people TABLE (0001) still backs actors.person_id, but
-- the NAME belongs to the world model now: spec §7.3 says People is a view
-- over entities + circles + the provisional flag. The legacy table moves
-- aside (RENAME rewrites the actors FK to follow), and db/ingest.ts writes
-- legacy_people from here on.
ALTER TABLE people RENAME TO legacy_people;

CREATE VIEW IF NOT EXISTS people AS
SELECT e.id,
       e.canonical      AS name,
       e.subtype,
       e.circle,
       e.provisional,
       e.user_pinned,
       e.first_seen_at,
       e.last_seen_at,
       e.created_at
  FROM entities e
 WHERE e.type = 'person'
   AND e.merged_into IS NULL;

-- ---- unsorted (spec §9): episodes with no space yet, a GOOD answer ---------

CREATE TABLE IF NOT EXISTS unsorted (
  id                  TEXT PRIMARY KEY,
  episode_id          TEXT NOT NULL UNIQUE REFERENCES episodes(id) ON DELETE CASCADE,
  reason              TEXT,                 -- why filing declined (low conf, no goal evidence, ...)
  confidence          REAL,
  status              TEXT NOT NULL DEFAULT 'open',   -- open|claimed|archived (30d unclaimed → archived)
  claimed_by_space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_unsorted_status ON unsorted(status, created_at);

-- ---- second_look (spec §9.5): 0.60-0.75 attaches re-verified at T2 ---------

CREATE TABLE IF NOT EXISTS second_look (
  id                TEXT PRIMARY KEY,
  episode_id        TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  space_id          TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  attach_confidence REAL NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|detached
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at       TEXT,
  UNIQUE (episode_id, space_id)
);

CREATE INDEX IF NOT EXISTS idx_second_look_status ON second_look(status, created_at);

-- ---- space_index: the four candidate-retrieval lanes (spec §6.4.4) ---------
-- FTS · embeddings · entity overlap · bridge exact-match.

CREATE VIRTUAL TABLE IF NOT EXISTS spaces_fts USING fts5(
  space_id UNINDEXED,
  label,
  goal,
  exemplars,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS spaces_fts_ai AFTER INSERT ON spaces BEGIN
  INSERT INTO spaces_fts (space_id, label, goal, exemplars)
  VALUES (new.id, new.label, COALESCE(new.goal, ''), COALESCE(new.exemplars_json, ''));
END;

CREATE TRIGGER IF NOT EXISTS spaces_fts_ad AFTER DELETE ON spaces BEGIN
  DELETE FROM spaces_fts WHERE space_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS spaces_fts_au AFTER UPDATE OF label, goal, exemplars_json ON spaces BEGIN
  DELETE FROM spaces_fts WHERE space_id = old.id;
  INSERT INTO spaces_fts (space_id, label, goal, exemplars)
  VALUES (new.id, new.label, COALESCE(new.goal, ''), COALESCE(new.exemplars_json, ''));
END;

CREATE TABLE IF NOT EXISTS space_embeddings (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  vec      BLOB NOT NULL,                   -- dim little-endian float32s
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_entities (
  space_id  TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  weight    REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (space_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_space_entities_entity ON space_entities(entity_id);

CREATE TABLE IF NOT EXISTS space_bridge_keys (
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                 -- url|phone|email|order_id|file_id|...
  value_norm TEXT NOT NULL,
  PRIMARY KEY (space_id, kind, value_norm)
);

CREATE INDEX IF NOT EXISTS idx_space_bridge_keys_value ON space_bridge_keys(kind, value_norm);

-- ---- event_bridge_keys: per-event literals, written at ingest (P1.1) -------
-- The bridge extractor runs inside event ingest; every normalised literal an
-- event carries lands here, so a NEW event pairs against PAST holders of the
-- same (kind, value_norm) with one indexed lookup instead of a rescan.

CREATE TABLE IF NOT EXISTS event_bridge_keys (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  PRIMARY KEY (event_id, kind, value_norm)
);

CREATE INDEX IF NOT EXISTS idx_event_bridge_keys_value ON event_bridge_keys(kind, value_norm);
`;
