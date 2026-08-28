// ===========================================================================
// 0106_library_freshness — build P2.4 (spec §14.3.2).
//
// One column: a per-stream capture pause. The Library's ⏸ toggle is a CAPTURE
// control — a paused stream's events are dropped at the single-writer ingest
// funnels (db/eventlog.appendEvents + db/ingest.insertEvent), not hidden at
// read time. Source-level pause already exists as a settings key
// (db/ingest.pausedKey); this is the per-stream refinement the Library rows
// need. Every flip writes a decision row (library/pause.ts), so the control
// is auditable and reversible like any other derived-state change.
// ===========================================================================

/** The 0106_library_freshness migration body. */
export const LIBRARY_FRESHNESS = /* sql */ `
ALTER TABLE streams ADD COLUMN capture_paused INTEGER NOT NULL DEFAULT 0;
`;
