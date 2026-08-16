// ===========================================================================
// 0024_latency_marks — persisted latency instrumentation (arch §9.5.3 rule 4,
// build item 4.2).
//
// "Instrument TTFT and tokens/sec per model per call type, and gate on
// per-call latency, not only end-to-end." The in-memory TimingLog in
// scheduler/paint.ts is the eval's instrument; THIS table is the running
// system's. Two kinds of row share it:
//
//   kind='call'       one row per model call, written alongside its `runs` row
//                     by db/run-accounting.recordRun: ttft_ms (NULL when the
//                     provider never streamed a token — an errored call has no
//                     TTFT and NULL says so; 0 would claim it was instant),
//                     total_ms, output_tokens. tokens/sec is DERIVED at read
//                     time, never stored — a stored rate and its stored inputs
//                     can drift apart, a derived one cannot.
//
//   kind='milestone'  one row per measured global-acceptance number:
//                     first_claim / spaces_tasks / silent_gap / steady_calls /
//                     live_visibility, each with the measured value and the
//                     budget it was measured AGAINST at the time. Budgets are
//                     stored on the row so a later change to the budget cannot
//                     silently re-grade history.
//
// [CODE] Fresh install only. No data migration.
// ===========================================================================

/** The 0024_latency_marks migration body. */
export const LATENCY_MARKS = /* sql */ `
CREATE TABLE IF NOT EXISTS latency_marks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('call', 'milestone')),
  -- call: the call type (P-CL1, media, chat) · milestone: the budget's name.
  name          TEXT NOT NULL,
  model         TEXT,
  run_id        TEXT,
  ttft_ms       INTEGER,
  total_ms      INTEGER,
  output_tokens INTEGER,
  value         REAL,
  budget        REAL,
  unit          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_latency_marks_kind_name ON latency_marks(kind, name);
CREATE INDEX IF NOT EXISTS idx_latency_marks_created   ON latency_marks(created_at);
`;
