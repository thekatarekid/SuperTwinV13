// ===========================================================================
// 0206_v6_people — V6 P1 S5.4 (Build §8 lane D, Product_V6_Phase1 §11,
// Product_V6 §11.5 / §11.8).
//
// People and the personal CRM. Two small tables; everything else this lane
// needs already exists (entities + circle, entity_identities, mentions,
// tone_profiles with address_terms_json, person_dates from 0204, tasks.owner):
//
//   role_resolutions  one row per (event, resolution): who a group message was
//                     addressed to, the LADDER RUNG that decided it, and the
//                     confidence. `unknown` is a legitimate outcome (a question
//                     is queued — "unknown beats wrong"). A later confirmation
//                     writes a NEW row with `revised_from` pointing back — the
//                     0.65 decision is never edited in place (ROL-10).
//   person_prefs      per-person learned settings the circle default does not
//                     cover: the follow-up radar lead time (days). Dates keep
//                     their own per-date mode/lead on person_dates (0204).
//
// Additive; fresh installs only in V6.
// ===========================================================================

export const V6_PEOPLE = /* sql */ `
CREATE TABLE IF NOT EXISTS role_resolutions (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,                -- events.id or a fixture alias
  stream_key     TEXT,
  sender         TEXT,                          -- entity id or roster ref
  receiver_json  TEXT NOT NULL,                 -- JSON array of ids; [] when unknown
  third_party_json TEXT,                        -- JSON array of ids named but not in audience
  status         TEXT NOT NULL DEFAULT 'resolved',   -- resolved|unknown|revised
  rung           TEXT NOT NULL,                 -- structural|reply|named|address_term|context|model|broadcast|unknown
  basis          TEXT,                          -- one line, shown under "why?"
  confidence     REAL NOT NULL,
  question_id    TEXT,                          -- questions.id when status = unknown
  revised_from   TEXT REFERENCES role_resolutions(id) ON DELETE SET NULL,
  evidence_json  TEXT,                          -- [{event_ids[], quote}]
  decided_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_role_resolutions_event ON role_resolutions(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_role_resolutions_status ON role_resolutions(status);

CREATE TABLE IF NOT EXISTS person_prefs (
  person_entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  radar_lead_days  INTEGER,                     -- NULL = the circle default
  notes            TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;
