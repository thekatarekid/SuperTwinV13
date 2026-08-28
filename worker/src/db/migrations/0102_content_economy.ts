// ===========================================================================
// 0102_content_economy — packer substrate (build P1.2, spec §4.5) plus the
// T2 review queue the Critic's flag_overlap verdict feeds (build P1.3,
// spec §8.2, §15).
//
//   content_digests     one digest line per unique content_hash. The haiku
//                       digest call is paid ONCE per hash, then cached forever
//                       (spec §4.5.1). digest_json is the structured line:
//                       {title, domain, doc_type, key_entities, gist,
//                        token_count, content_ref}.
//   context_escalations every L1/L2 escalation a consumer requested beyond the
//                       L0 default (spec §4.5.2: L2 is rare and LOGGED). The
//                       escalation-rate metric reads this against
//                       run_context_stats.
//   run_context_stats   per-run ledger of how many events were served at each
//                       fidelity level (spec §4.5.4: token accounting per
//                       level; a rising L1/L2 rate means digests too lossy).
//   t2_review_queue     Critic flag_overlap(space_id) verdicts and any other
//                       tier-2 review work: flags never block a commit, they
//                       queue a review immediately (spec §8.2; consumed by
//                       P1.5's T2 job).
// ===========================================================================

/** The 0102_content_economy migration body. */
export const CONTENT_ECONOMY = /* sql */ `
CREATE TABLE IF NOT EXISTS content_digests (
  content_hash TEXT PRIMARY KEY,
  digest_json  TEXT NOT NULL,
  model        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS context_escalations (
  id           TEXT PRIMARY KEY,
  run_id       TEXT,
  content_hash TEXT,
  event_id     TEXT,
  level        TEXT NOT NULL,               -- 'L1' | 'L2'
  consumer     TEXT NOT NULL,               -- packer|assist|grounded|executor|...
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_context_escalations_run
  ON context_escalations(run_id);
CREATE INDEX IF NOT EXISTS idx_context_escalations_level
  ON context_escalations(level, created_at);

CREATE TABLE IF NOT EXISTS run_context_stats (
  run_id     TEXT PRIMARY KEY,
  l0_count   INTEGER NOT NULL DEFAULT 0,
  l1_count   INTEGER NOT NULL DEFAULT 0,
  l2_count   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS t2_review_queue (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,               -- 'flag_overlap' | ...
  episode_id   TEXT,
  space_id     TEXT,
  overlap_space_id TEXT,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|done|dismissed
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_t2_review_queue_status
  ON t2_review_queue(status, created_at);
`;
