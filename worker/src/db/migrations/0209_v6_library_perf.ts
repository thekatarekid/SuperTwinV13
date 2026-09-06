// ===========================================================================
// 0209_v6_library_perf — V6 P1 S6d L1 (Library latency root-cause).
//
// Every one of the Library's four sub-tabs asked a question of `events` that
// no index could answer, so each one full-scanned the log:
//
//   "how many events has this source ever landed?"   COUNT(*) WHERE source_type=?
//   "which domains today?"                           WHERE source_type=? AND kind=? AND ts>=?
//   "which chains are the most recent 8?"            GROUP BY stream_key over ALL visits
//   "what does this source cost on disk?"            3 aggregate scans PER SOURCE
//
// Measured on the user's real home (36,830 WhatsApp messages, a 1.05 GB db,
// an import in flight): /api/library/chats 14.0 s, /api/sources/browser/discover
// 9.8 s, /api/library/browser 7.0 s, /api/library/storage 3.4 s. Reproduced on
// a 400,500-event scratch corpus at 2.7 / 3.2 / 3.1 s with no import at all —
// so the scans, not the import, are the floor.
//
// Three indexes, all additive, no table rewrite:
//
//   idx_events_source_type_ts     (source_type, ts) — every per-source count,
//     span and day window becomes an index range scan, and COUNT/MIN/MAX over
//     it never touch a table row.
//   idx_events_source_kind_ts     (source_type, kind, ts) — the browser view's
//     visits-today, its newest-first chain walk, and its bookmark shelf.
//   idx_events_stream_dispatched  partial (stream_id, ts) WHERE dispatched_at
//     IS NOT NULL — the chat list's per-stream "knows you from" floor, which
//     otherwise needs a row fetch for every event of every stream.
//
// `archive(event_id)` already has a UNIQUE index from its column constraint
// (0200_v6_core), so the storage join is covered.
//
// CREATE INDEX on a large existing table costs one pass at first boot after
// the update; that is paid once, inside the migration transaction, and every
// Library read afterwards is bounded.
// ===========================================================================

export const V6_LIBRARY_PERF = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_events_source_type_ts    ON events(source_type, ts);
CREATE INDEX IF NOT EXISTS idx_events_source_kind_ts    ON events(source_type, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_stream_dispatched ON events(stream_id, ts)
  WHERE dispatched_at IS NOT NULL;
`;
