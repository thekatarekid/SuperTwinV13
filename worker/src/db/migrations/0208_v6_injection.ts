// ===========================================================================
// 0208_v6_injection — V6 P1 S4.7 (Build §7.2 lane G, Product_V6_Phase1 §24.9,
// GoldenEvals V6 P1 §5.15 INJ-01..04). Authored at R3 (eval hygiene).
//
// `injection_flags` was created by `safety/injection.ts` itself, with a
// module-scope CREATE TABLE IF NOT EXISTS behind a per-connection cache: S4.7
// landed while four other lanes were authoring numbered migrations, and the
// module took the `approvals/tokens.ts` shortcut rather than collide with
// them. That is over — the table is now declared here like every other table
// in the tree, so schema_migrations describes the whole schema, a fresh
// install has the table before any code path touches it, and the `db()`
// wrapper in that module is a plain getDb() again.
//
// One row per (event, family) the detector flags — see the module header for
// the three families. `acted_at` exists so §10's `injection_acted = 0` gate
// has a column to read; no code path in the tree ever sets it. The event FK
// cascades, so an honest delete of a source takes the flags with it (§24.5,
// `orphan_rows_after_delete = 0`).
//
// Additive; new table only. IF NOT EXISTS keeps it a no-op on a database that
// already grew the table under the old module-owned path.
// ===========================================================================

export const V6_INJECTION = /* sql */ `
CREATE TABLE IF NOT EXISTS injection_flags (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,              -- instruction_override | assistant_directive | fake_authority
  pattern     TEXT NOT NULL,              -- the detector rule that matched
  quote       TEXT NOT NULL,              -- the verbatim directive text, for the card
  source      TEXT,                       -- wa | browser | screen | …
  stream_key  TEXT,
  actor       TEXT,
  artifact_id TEXT,                       -- the ONE card raised for this event
  detected_by TEXT NOT NULL DEFAULT 'code:injection',
  acted_at    TEXT,                       -- never written; the gate reads it
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (event_id, category)
);

CREATE INDEX IF NOT EXISTS idx_injection_flags_event ON injection_flags(event_id);
`;
