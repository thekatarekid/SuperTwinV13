// ===========================================================================
// [CODE] Pass-liveness check — TRC-03 (build P0.9).
//
// The V11 failure this guards against: 6 of 11 prompts never ran in production
// while CI stayed green. TRC-03 says: every registered pass must show
// PRODUCTION runs inside the window (default 48h); a pass with tests but zero
// runs fails the check loudly.
//
// `assessLiveness` is the pure check; `collectRunCounts` reads the production
// `extraction_runs` table (every model call records a row there — role is the
// pass name). The CLI exposes it as `npm run eval -- --liveness`, which is the
// liveness check job.
// ===========================================================================

import type BetterSqlite3 from "better-sqlite3";

/**
 * The V13 pass roster TRC-03 names: "Orient, Critic, Extract, Decide,
 * Digest-if-backfill, Assist-eval". A pass joins this list when its P1.x task
 * lands it in production; the check then demands runs from it.
 */
export const V13_PASSES: readonly string[] = [
  "orient",
  "critic",
  "extract",
  "decide",
  "digest",
  "assist",
];

export const DEFAULT_WINDOW_HOURS = 48;

export interface LivenessEntry {
  pass: string;
  runs: number;
  ok: boolean;
}

export interface LivenessReport {
  windowHours: number;
  entries: LivenessEntry[];
  /** pass_liveness — the hard gate: live passes / registered passes. */
  liveness: number;
  ok: boolean;
}

/** The pure TRC-03 check: every registered pass must have ≥1 run in window. */
export function assessLiveness(
  runCounts: Record<string, number>,
  passes: readonly string[] = V13_PASSES,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): LivenessReport {
  const entries = passes.map((pass) => {
    const runs = runCounts[pass] ?? 0;
    return { pass, runs, ok: runs > 0 };
  });
  const live = entries.filter((e) => e.ok).length;
  return {
    windowHours,
    entries,
    liveness: passes.length > 0 ? live / passes.length : 1,
    ok: entries.every((e) => e.ok),
  };
}

/**
 * Per-pass production run counts from `extraction_runs` inside the window.
 * `role` is the pass attribution (falls back to `kind` for legacy rows) —
 * eval and judge runs are excluded so the harness can never keep itself alive.
 */
export function collectRunCounts(db: BetterSqlite3.Database, windowHours: number = DEFAULT_WINDOW_HOURS): Record<string, number> {
  const sinceMs = Date.now() - windowHours * 3_600_000;
  const since = new Date(sinceMs).toISOString();
  const rows = db
    .prepare(
      `SELECT COALESCE(role, kind) AS pass, COUNT(*) AS n
         FROM extraction_runs
        WHERE created_at >= ?
          AND COALESCE(role, kind) NOT LIKE 'eval%'
        GROUP BY COALESCE(role, kind)`,
    )
    .all(since) as { pass: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.pass] = row.n;
  return counts;
}

export function renderLiveness(report: LivenessReport): string {
  const lines = [
    `pass liveness (TRC-03) — last ${report.windowHours}h`,
    ...report.entries.map(
      (e) => `  ${e.ok ? "LIVE" : "DEAD"}  ${e.pass.padEnd(12)} ${e.runs} run(s)`,
    ),
    `  pass_liveness = ${(report.liveness * 100).toFixed(0)}% ${report.ok ? "(pass)" : "(FAIL — dead-code-green)"}`,
  ];
  return lines.join("\n");
}
