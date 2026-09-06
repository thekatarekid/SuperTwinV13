// ===========================================================================
// 0207_v6_brief — V6 P1 S4.6 (Build §7.2 lane B, Product_V6 §14.4 item 7,
// Product_V6_Phase1 §18.6).
//
// The brief is its OWN surface, not a nudge: one card at each time set in
// Settings › General, holding needs-you / today / what-moved. It therefore
// gets its own table rather than an `artifacts` row — an artifact would join
// the router's pending set and be delivered as one of the six nudge kinds,
// which the brief is not.
//
// One row per fired slot (`slot` is UNIQUE: yyyy-mm-dd HH:MM in the user's
// zone), carrying the ledger CODE composed and the prose one brief.v2 call
// wrote from it. `since` is the previous brief's instant — the window "what
// moved" was measured over — so the delta is auditable after the fact and a
// skipped slot (nothing changed → no call, no card) leaves no row at all.
//
// Additive; new table only.
// ===========================================================================

export const V6_BRIEF = /* sql */ `
CREATE TABLE IF NOT EXISTS briefs (
  id           TEXT PRIMARY KEY,
  slot         TEXT NOT NULL,               -- yyyy-mm-dd HH:MM in the tz column
  tz           TEXT NOT NULL,
  composed_at  TEXT NOT NULL,               -- the instant the brief was written
  since        TEXT,                        -- previous brief's composed_at (NULL on the first)
  delta_rows   INTEGER NOT NULL DEFAULT 0,  -- world-model rows changed in the window
  ledger_json  TEXT NOT NULL,               -- what code composed (the why-panel)
  text         TEXT NOT NULL,               -- brief.v2's prose
  model_calls  INTEGER NOT NULL DEFAULT 0,
  run_id       TEXT,
  seen_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_slot     ON briefs(slot);
CREATE INDEX IF NOT EXISTS        idx_briefs_composed ON briefs(composed_at);
`;
