// ===========================================================================
// 0205_v6_spaces — V6 P1 S5.1 (Build §8 lane A, Product_V6_Phase1 §13).
//
// What a space remembers about its own birth, and the enrichment ledger:
//
//   spaces.born_via             'inferred' | 'asked' | 'woken' — which of the
//                               three birth paths made the row (§13.3). Null on
//                               rows older than this migration.
//   spaces.birth_evidence_json  [{quote, event_ids, thread_id?}] — the
//                               utterance or messages that justified the birth.
//                               For an asked-for space this IS the bar sentence
//                               (SPC-05: "why?" cites it and opens the thread).
//   spaces.bar_thread_id        the bar thread an asked-for space came from.
//   spaces.dormant_at / woken_at  the dormancy clock a WOKEN birth reads.
//
//   space_enrichments           one row per (space, kind, url) fetch target:
//                               the last content hash + when it last CHANGED.
//                               Refreshes are fetches compared by hash in code;
//                               the model sees an enrichment only when the hash
//                               moved (SPC-08). Additive; fresh installs only.
// ===========================================================================

export const V6_SPACES = /* sql */ `
ALTER TABLE spaces ADD COLUMN born_via TEXT;
ALTER TABLE spaces ADD COLUMN birth_evidence_json TEXT;
ALTER TABLE spaces ADD COLUMN bar_thread_id TEXT;
ALTER TABLE spaces ADD COLUMN dormant_at TEXT;
ALTER TABLE spaces ADD COLUMN woken_at TEXT;

CREATE TABLE IF NOT EXISTS space_enrichments (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                 -- fare | availability | hours | price | weather | ...
  url           TEXT NOT NULL,
  content_hash  TEXT NOT NULL,                 -- sha256 of the fetched content
  summary       TEXT,                          -- the snapshot shown to the model when it changed
  fetched_at    TEXT NOT NULL,
  changed_at    TEXT NOT NULL,                 -- last time content_hash moved
  fetch_count   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (space_id, kind, url)
);

CREATE INDEX IF NOT EXISTS idx_space_enrichments_space ON space_enrichments(space_id, changed_at);
`;
