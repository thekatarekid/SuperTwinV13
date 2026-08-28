// ===========================================================================
// 0107_t3_graduation — build P4.3 (spec §15.3 + the graduation switch).
//
// Two tables:
//
//   graduation_metrics  one row per calendar day: the propose-only gates
//                       (over-creation, false auto-merge) measured from the
//                       decisions ledger. The graduation switch flips to
//                       auto-create only when `gates_ok` has held 14
//                       consecutive days (worker/src/consolidation/
//                       graduation.ts) — tracked here so the Settings pane
//                       can show the streak, not just assert it.
//
//   space_links         T3's cross-space links (spec §15.3): two active
//                       spaces that share enough claim subjects to be worth
//                       showing together. Deterministic, code-derived,
//                       reversible via the decisions row each insert writes.
// ===========================================================================

/** The 0107_t3_graduation migration body. */
export const T3_GRADUATION = /* sql */ `
CREATE TABLE IF NOT EXISTS graduation_metrics (
  day               TEXT PRIMARY KEY,              -- YYYY-MM-DD (UTC)
  proposals         INTEGER NOT NULL DEFAULT 0,    -- spaces proposed that day
  user_rejections   INTEGER NOT NULL DEFAULT 0,    -- proposals the user rejected
  over_creation_pct REAL,                          -- rejections / proposals * 100
  false_auto_merge  INTEGER NOT NULL DEFAULT 0,    -- auto-merges later reversed
  gates_ok          INTEGER NOT NULL DEFAULT 0,    -- 1 = every gate held
  computed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS space_links (
  id           TEXT PRIMARY KEY,
  a_space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  b_space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  shared_json  TEXT,                               -- what they share (subjects)
  created_by   TEXT NOT NULL DEFAULT 't3',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (a_space_id, b_space_id)
);

CREATE INDEX IF NOT EXISTS idx_space_links_a ON space_links(a_space_id);
CREATE INDEX IF NOT EXISTS idx_space_links_b ON space_links(b_space_id);
`;
