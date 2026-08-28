// ===========================================================================
// 0102_decide_consolidation — build P1.4 + P1.5.
//
// P1.4 (spec §6.3.2): the Decide work queue — max ONE queued entry per space;
// new episodes MERGE IN rather than queueing a second row. Plus the holding
// pen for Decide outputs that P1 emits but must not act on (schedules and
// follow-ups arrive in P3 — spec/build "emit but hold as deferred"), and the
// per-space plan the Decide pass maintains (spec §8.4.6).
//
// P1.5 (spec §15.2) consumes the `t2_review_queue` table 0102_content_economy
// created (the Critic's flag_overlap feeds it) — no second flag table here.
// ===========================================================================

/** The 0102_decide_consolidation migration body. */
export const DECIDE_CONSOLIDATION = /* sql */ `
-- ---- decide work queue (spec §6.3.2) --------------------------------------
-- (space_id, pending_episode_ids, priority) with space_id UNIQUE: one pending
-- row per space, merge-in by design. priority: urgent > live > backfill.

CREATE TABLE IF NOT EXISTS decide_queue (
  space_id            TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  pending_episode_ids TEXT NOT NULL DEFAULT '[]',    -- JSON array of episode ids
  priority            TEXT NOT NULL DEFAULT 'live',  -- urgent|live|backfill
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending|running
  enqueued_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_decide_queue_status ON decide_queue(status, priority, enqueued_at);

-- ---- deferred Decide outputs (build P1.4) ---------------------------------
-- Schedules and follow-ups the P1 Decide pass EMITS but HOLDS: they activate
-- in P3, never here. Kept verbatim so activation later replays exactly what
-- the model proposed, with its evidence.

CREATE TABLE IF NOT EXISTS deferred_outputs (
  id           TEXT PRIMARY KEY,
  space_id     TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,                    -- schedule|followup
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'deferred', -- deferred|activated|dismissed
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_deferred_outputs_status ON deferred_outputs(status, kind);

-- ---- per-space plan (spec §8.4.6): goal → chapters → next actions ---------

ALTER TABLE spaces ADD COLUMN plan_json TEXT;
`;
