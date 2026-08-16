// ===========================================================================
// 0026_runs_backfill — the phase-0 log, copied into the V2 accounting table.
//
// `runs` (and with it Settings → Usage, its cache hit rate, cohort pacing and
// estimateImportSpend) had exactly one writer: prompts/runner.ts, the V2
// extraction pipeline. The two paths that actually spend money on an installed
// build — chat and background media reading — both go through db/index.ts
// `logRun`, which wrote `extraction_runs` and nothing else. So a DB holding 23
// real runs and $1.36 of real spend rendered an empty Usage board.
//
// db/index.ts `logRun` now dual-writes going forward. This migration carries
// the history across so the board is not blank on an existing install, and it
// backfills the matching `call` latency marks: recordRun writes a run and its
// mark together, and a backfill that wrote only half would leave the two tables
// at different cardinalities — which is the shape of a bug, not of history.
//
// Idempotent by construction, and safe to run twice:
//   * `runs` rows are keyed `er:<extraction_runs.rowid>` — unique by
//     construction, unlike a provider run id (a retried media row reuses
//     `media-<event id>`) — and inserted with INSERT OR IGNORE;
//   * `latency_marks` has no unique key, so its insert is guarded by NOT EXISTS
//     on the same run id.
//
// Three values are derived rather than copied:
//   * started_at — extraction_runs stamps only completion, so the start is
//     created_at minus the measured duration;
//   * cohort_id — NULL. Chat and on-demand media belong to no import cohort
//     (see RecordRunParams.cohortId for why a sentinel would be worse);
//   * billable_tokens — recomputed at the same weights billableTokens applies,
//     with the whole (unsplit) write half at the 1-hour rate, because that is
//     what these runs were actually charged.
//
// ttft_ms is NULL on every backfilled mark: nothing measured a first-token time
// for these calls, and a 0 would claim they were instantaneous.
// ===========================================================================

/**
 * The role vocabulary the backfill accepts, inlined because migration bodies
 * are SQL strings. Must stay in step with RUN_ROLES in db/run-accounting.ts; a
 * row whose role is outside it is left in `extraction_runs` only, since an
 * invented role would be the unattributable write `runs` exists to prevent.
 */
const ROLES = `('media','entity','episode','arc','extract','triage','done_detect','classify','adjudicate','chat')`;

/** Copied verbatim from BILLABLE_WEIGHTS — see the note above on re-derivation. */
const BILLABLE = /* sql */ `
      er.input_tokens
      + er.cache_creation_5m_input_tokens * 1.25
      + er.cache_creation_1h_input_tokens * 2.0
      + MAX(0, er.cache_creation_input_tokens
               - er.cache_creation_5m_input_tokens
               - er.cache_creation_1h_input_tokens) * 2.0
      + er.cache_read_input_tokens * 0.1
      + er.output_tokens`;

/** `""` is the codebase's "subscription default"; the board needs a label. */
const MODEL = `COALESCE(NULLIF(TRIM(COALESCE(er.model, '')), ''), '(default)')`;

const STARTED_AT = `strftime('%Y-%m-%dT%H:%M:%fZ', er.created_at, '-' || (er.duration_ms / 1000.0) || ' seconds')`;

/** The 0026_runs_backfill migration body. */
export const RUNS_BACKFILL = /* sql */ `
INSERT OR IGNORE INTO runs
  (id, kind, role, model, cohort_id, started_at, ended_at, status,
   input_tokens, cache_create, cache_create_5m, cache_create_1h,
   cache_read, output_tokens, billable_tokens, cost_usd, error_code, error_msg)
SELECT
  'er:' || er.id,
  er.kind,
  COALESCE(er.role, er.kind),
  ${MODEL},
  NULL,
  ${STARTED_AT},
  er.created_at,
  er.status,
  er.input_tokens,
  er.cache_creation_input_tokens,
  er.cache_creation_5m_input_tokens,
  er.cache_creation_1h_input_tokens,
  er.cache_read_input_tokens,
  er.output_tokens,
  CAST(ROUND(${BILLABLE}) AS INTEGER),
  COALESCE(er.cost_usd, 0),
  er.error_code,
  NULL
FROM extraction_runs er
WHERE COALESCE(er.role, er.kind) IN ${ROLES};

INSERT INTO latency_marks
  (kind, name, model, run_id, ttft_ms, total_ms, output_tokens, created_at)
SELECT
  'call',
  er.kind,
  ${MODEL},
  'er:' || er.id,
  NULL,
  er.duration_ms,
  er.output_tokens,
  ${STARTED_AT}
FROM extraction_runs er
WHERE COALESCE(er.role, er.kind) IN ${ROLES}
  AND NOT EXISTS (
    SELECT 1 FROM latency_marks lm
     WHERE lm.kind = 'call' AND lm.run_id = 'er:' || er.id
  );
`;
