// ===========================================================================
// 0100_v13_core — the V13 substrate (build P0.4, spec §6.1).
//
// V13 keeps the V11 `events` table as the one event log (fresh installs only —
// no data migration) and grows the §6.1 envelope onto it:
//
//   event { id ulid · ts · captured_at · source · kind · origin live|backfill ·
//           age_band · stream_key · actor · roles {sender, audience[],
//           receiver[], mentions[]} · payload (typed per kind) · content_hash ·
//           blob_refs[] }
//
// Column mapping (existing → envelope): `source_type` carries `source`,
// `text` stays the FTS-indexed projection of `payload.text` (the 0022 FTS
// triggers keep events_fts in sync — nothing to re-cut here). New columns
// carry the rest. `dispatched_at` is the dispatcher's per-event processed
// mark (P0.5): NULL = not yet handed to a tick; the orphan scan keys on it.
//
// `streams` grows the V13 dispatch state: category (cat1|cat2), engagement
// stats (ordering signal only, never relationship value — spec §5.2), the
// per-stream dispatch cursor (rowid-based: insertion order, NOT ts, so a
// backfill wave landing with OLDER timestamps still sits ahead of the cursor
// — BND-04), and the low-signal deferral clock. The dual watermark stays in
// the `watermarks` table (live head / backfill floor), unchanged.
//
// `runs` is kept and extended with the V13 pass/trace linkage. `quarantine`
// is kept as-is. `decisions` + `corrections` are new (every derived-object
// change is a decision row; mutations reversible — build convention 1.4).
//
// `traces` is SCHEMA ONLY here: P0.7 owns the traces module (file store under
// ~/SuperTwinV13/traces/ + these index rows). Coordinated by creating the
// table per spec §17 so both lanes agree on the shape.
// ===========================================================================

/** The 0100_v13_core migration body. */
export const V13_CORE = /* sql */ `
-- ---- events: the §6.1 envelope --------------------------------------------

ALTER TABLE events ADD COLUMN captured_at    TEXT;    -- when WE saw it (ts = when it was said)
ALTER TABLE events ADD COLUMN origin         TEXT;    -- 'live' | 'backfill'
ALTER TABLE events ADD COLUMN age_band       TEXT;    -- 'A' | 'B' | 'C' | 'D' (spec §5.3)
ALTER TABLE events ADD COLUMN stream_key     TEXT;    -- source-native key, e.g. '9198xx-1602@g.us'
ALTER TABLE events ADD COLUMN actor          TEXT;    -- envelope actor ref, e.g. 'contact:rohan' | 'self'
ALTER TABLE events ADD COLUMN roles_json     TEXT;    -- {sender, audience[], receiver[], mentions[]}
ALTER TABLE events ADD COLUMN payload_json   TEXT;    -- typed per kind; text is ALSO projected into events.text for FTS
ALTER TABLE events ADD COLUMN content_hash   TEXT;    -- idempotent-append key (single-writer enforces uniqueness)
ALTER TABLE events ADD COLUMN blob_refs_json TEXT;    -- JSON array of blob refs
ALTER TABLE events ADD COLUMN dispatched_at  TEXT;    -- P0.5 processed mark; NULL = awaiting dispatch

-- content_hash is NOT a UNIQUE index: uniqueness is enforced inside the
-- single-writer append (a transactional lookup), so a legacy writer that
-- stamps a colliding hash can never abort mid-transaction. The index is for
-- the idempotency lookup itself.
CREATE INDEX IF NOT EXISTS idx_events_content_hash ON events(content_hash);
CREATE INDEX IF NOT EXISTS idx_events_stream_key   ON events(stream_key, ts);
-- The dispatcher's window query: undispatched envelope events, oldest first.
CREATE INDEX IF NOT EXISTS idx_events_undispatched ON events(dispatched_at) WHERE dispatched_at IS NULL;

-- ---- streams: dispatch state (spec §6.2) ----------------------------------

ALTER TABLE streams ADD COLUMN category           TEXT;                       -- 'cat1' | 'cat2' (spec §5.1)
ALTER TABLE streams ADD COLUMN engagement_score   REAL NOT NULL DEFAULT 0;    -- ordering signal ONLY (spec §5.2)
ALTER TABLE streams ADD COLUMN reply_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE streams ADD COLUMN last_user_reply_ts TEXT;
ALTER TABLE streams ADD COLUMN cursor_rowid       INTEGER NOT NULL DEFAULT 0; -- last DISPATCHED events.rowid
ALTER TABLE streams ADD COLUMN defer_since        TEXT;                       -- low-signal deferral clock; NULL = not deferring

-- ---- runs: kept, extended with the V13 pass/trace linkage ------------------

ALTER TABLE runs ADD COLUMN pass     TEXT;  -- orient|critic|extract|decide|digest|assist|…
ALTER TABLE runs ADD COLUMN origin   TEXT;  -- 'live' | 'backfill' (lane the work came from)
ALTER TABLE runs ADD COLUMN trace_id TEXT;  -- traces.id for this call (P0.7 writes it)

-- ---- decisions: every derived-object change, reversible --------------------

CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  run_id      TEXT,                        -- runs.id that proposed it (NULL for user-made)
  pass        TEXT,                        -- which pass decided
  target_kind TEXT NOT NULL,               -- space|episode|claim|task|entity|stream|…
  target_id   TEXT NOT NULL,
  action      TEXT NOT NULL,               -- create|update|merge|close|link|…
  old_json    TEXT,                        -- state before (NULL on create)
  new_json    TEXT,                        -- state after
  reason      TEXT,
  confidence  REAL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reversed_at TEXT,                        -- set when undone; old_json is the restore payload
  reversed_by TEXT                         -- corrections.id | 'user' | run id
);

CREATE INDEX IF NOT EXISTS idx_decisions_target ON decisions(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_decisions_run    ON decisions(run_id);

-- ---- corrections: user feedback bound to the decision it corrects ----------

CREATE TABLE IF NOT EXISTS corrections (
  id          TEXT PRIMARY KEY,
  decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  instruction TEXT NOT NULL,               -- what the user said / did
  scope       TEXT,                        -- once|stream|space|global
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|applied|rejected
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections(status);

-- ---- traces: index rows for the per-call trace files (schema only — P0.7) --

CREATE TABLE IF NOT EXISTS traces (
  id             TEXT PRIMARY KEY,
  run_id         TEXT,
  pass           TEXT,
  model          TEXT,
  prompt_version TEXT,
  caller         TEXT,                     -- code site that made the call
  day            TEXT,                     -- YYYY-MM-DD; names the jsonl file
  file_path      TEXT,                     -- ~/SuperTwinV13/traces/<day>.jsonl
  system_prompt  TEXT,
  packed_context TEXT,
  raw_output     TEXT,
  parsed_result  TEXT,
  repair_count   INTEGER NOT NULL DEFAULT 0,
  verdicts_json  TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create   INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_traces_run  ON traces(run_id);
CREATE INDEX IF NOT EXISTS idx_traces_day  ON traces(day);
CREATE INDEX IF NOT EXISTS idx_traces_pass ON traces(pass, created_at);
`;
