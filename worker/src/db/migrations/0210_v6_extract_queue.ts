// ===========================================================================
// 0210_v6_extract_queue — V6 P1 E1 (the memory half of the reduce step).
//
// WHY. `runExtractPass` shipped at S3.6 with every code rail the spec asks
// for and NO production caller: `brain/reduce.runReduce` was its only caller
// and nothing called `runReduce`. The consolidation job drained the Decide
// queue and nothing drained anything for Extract, because there was no
// Extract queue. The consequence is measurable: on the user's own home, 435
// episodes and 948 person entities beside ZERO claims. "Who I am", the
// People circles and the follow-up radar read claims, so all three were
// empty by construction.
//
// The reason it was left unwired is real and is designed around here, not
// worked around: `runReduce` grouped by STREAM and called Extract once per
// group, so one history-day bundle spanning ~15 streams cost ~15 extra calls
// — the exact runaway shape the budget latch exists to stop. So Extract gets
// what Decide has — a queue with a cadence and a ceiling:
//
//   extract_queue    one row per EPISODE (episode_id is the PRIMARY KEY, so
//                    an episode is queued at most once and a re-commit merges
//                    into the same row, the same rule decide_queue keeps per
//                    space). `attempts` walks the three-strike ladder; the
//                    third failure dead-letters the row (status 'failed')
//                    instead of re-spending on it forever.
//   episodes.extracted_at
//                    the watermark that makes "has this episode ever been
//                    through the memory pass?" a lookup. Stamped when a pass
//                    finishes for that episode, whatever it wrote — an
//                    episode with nothing durable in it is still extracted.
//                    It is also what lets the backlog seeder be idempotent:
//                    it only ever queues episodes this column says are new.
//   idx_episodes_unextracted
//                    partial index over the un-extracted episodes only, so
//                    the seeder's "what is left?" question stays O(what is
//                    left) and SHRINKS as the backlog is worked off.
//
// Additive: one new table, one new column, two indexes. No table rewrite.
// ===========================================================================

export const V6_EXTRACT_QUEUE = /* sql */ `
-- ---- extract work queue (V6 P1 E1) ----------------------------------------
-- (episode_id, priority, status, attempts). episode_id is the PK: one row per
-- episode, merge-in by design. priority: urgent > live > backfill.

CREATE TABLE IF NOT EXISTS extract_queue (
  episode_id  TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  stream_id   TEXT,
  priority    TEXT NOT NULL DEFAULT 'live',     -- urgent|live|backfill
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_extract_queue_status
  ON extract_queue(status, priority, enqueued_at);

-- ---- the watermark --------------------------------------------------------
-- NULL = this episode has never been through Extract. Stamped on a finished
-- pass even when the pass wrote nothing durable.

ALTER TABLE episodes ADD COLUMN extracted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_episodes_unextracted
  ON episodes(last_ts) WHERE extracted_at IS NULL;
`;
