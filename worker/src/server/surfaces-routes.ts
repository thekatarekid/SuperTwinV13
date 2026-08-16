// ===========================================================================
// [CODE] The coverage meter's endpoint — arch §14.0, "on every surface".
//
//   GET /api/coverage   mode + per-horizon rows + pause label + ETA
//
// Item 1.8 built `<CoverageMeter>` as a pure component and `<SurfaceCoverage>`
// polls exactly one path for all eight surfaces, so this is the single place
// the meter's numbers come from. Nothing here is computed twice: the rows are
// `scheduler/queue`'s coverage ledger verbatim, the mode is `cohorts.mode`, the
// pause wording is `scheduler/lanes.pauseState` and the ETA is
// `scheduler/horizons.remainingMinutes`. A surface that recomposed any of them
// could disagree with the scheduler about what the pipeline is doing, and §9.7
// rule 3 does not allow the meter and the run to tell different stories.
//
// The scope is `global`/`all` — the same rows /api/ops/import reads, because
// the meter on a surface and the meter on the ops screen are the same meter.
//
// An empty database is a normal state, not an error: before the first import
// there is no coverage, no cohort and no pause, and the answer is a well-formed
// zeroed snapshot (`rows: []`, mode `bootstrap`) rather than a 500. The meter
// renders every horizon as queued from that, which is the truth.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import { isMode, remainingMinutes, type SchedulerMode } from "../scheduler/horizons.js";
import { pauseState } from "../scheduler/lanes.js";
import { readCoverage, type CoverageRow } from "../scheduler/queue.js";
import { resourcePool } from "../providers/pool.js";
import { OPS_LANES } from "./ops-routes.js";

/** The meter is global: one scope, the same one the ops surface reads. */
const COVERAGE_SCOPE = { kind: "global", id: "all" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** §14.0's snapshot, exactly as `src/lib/surfaces-client.ts` declares it. */
export interface CoverageSnapshotView {
  mode: SchedulerMode;
  /** A superset of the client's `CoverageRow` — the extra scope fields are inert. */
  rows: CoverageRow[];
  pausedLabel: string | null;
  remainingMinutes: number | null;
}

/**
 * Which mode the pipeline is in, read off the cohort ladder rather than kept as
 * a second copy of the scheduler's state.
 *
 * `pendingCohorts()` answers this too, but it materialises every pending cohort
 * and this runs on a 5 s poll from every open surface, so the query below reads
 * one row. With nothing in flight the corpus is settled — `steady` — except on
 * a database that has never had a cohort at all, where nothing has started yet
 * and `bootstrap` is what the meter should say.
 */
function currentMode(): SchedulerMode {
  const db = getDb();
  const inFlight = db
    .prepare(
      `SELECT mode FROM cohorts
        WHERE state NOT IN ('done', 'quarantined')
        ORDER BY priority DESC, id LIMIT 1`,
    )
    .get() as { mode: string } | undefined;
  if (inFlight && isMode(inFlight.mode)) return inFlight.mode;
  const anyCohort = db.prepare(`SELECT 1 AS one FROM cohorts LIMIT 1`).get() as
    | { one: number }
    | undefined;
  return anyCohort ? "steady" : "bootstrap";
}

/**
 * The paused-lane line, §14.0 rule 2 — "a healthy mid-run system that looks
 * like a silent failure is itself a shipped defect". The longest-paused lane
 * wins: the meter is one line for the whole pipeline, and the lane that resumes
 * last is the one the countdown has to survive to.
 *
 * `pauseState` owns the wording. The pool stores only each lane's deadline, not
 * which refusal set it, so the window is reported as `quota` — the rate-limit
 * wording — rather than inventing a second phrasing here for the unknown case.
 */
function pausedLabel(): string | null {
  let longestMs = 0;
  for (const lane of OPS_LANES) longestMs = Math.max(longestMs, resourcePool.pausedForMs(lane));
  if (longestMs <= 0) return null;
  const state = pauseState({ fromMs: 0, toMs: longestMs, reason: "quota" }, 0);
  return state.paused ? state.label : null;
}

/**
 * "~14 min remaining", measured rather than assumed.
 *
 * `remainingMinutes` needs a rate and nothing in the pipeline records one, so
 * it is taken from the coverage ledger's own clock: the units already done over
 * the span the ledger has been moving for. `readCoverage` drops `updated_at`,
 * hence the query here. Before two distinct writes there is no span, the rate
 * is 0 and `remainingMinutes` returns null — §9.7 rule 2 prefers no estimate to
 * a made-up one.
 */
function estimateRemainingMinutes(): number | null {
  const row = getDb()
    .prepare(
      `SELECT SUM(done_units) AS done, SUM(total_units) AS total,
              MIN(updated_at) AS first_at, MAX(updated_at) AS last_at
         FROM coverage WHERE scope_kind = ? AND scope_id = ?`,
    )
    .get(COVERAGE_SCOPE.kind, COVERAGE_SCOPE.id) as
    | { done: number | null; total: number | null; first_at: string | null; last_at: string | null }
    | undefined;

  const done = row?.done ?? 0;
  const total = row?.total ?? 0;
  const fromMs = row?.first_at ? Date.parse(row.first_at) : NaN;
  const toMs = row?.last_at ? Date.parse(row.last_at) : NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;

  const elapsedMinutes = (toMs - fromMs) / 60_000;
  const unitsPerMinute = elapsedMinutes > 0 ? done / elapsedMinutes : 0;
  return remainingMinutes(done, total, unitsPerMinute);
}

/** The snapshot every surface's meter renders. Safe on an empty database. */
export function coverageSnapshot(): CoverageSnapshotView {
  return {
    mode: currentMode(),
    rows: readCoverage(COVERAGE_SCOPE.kind, COVERAGE_SCOPE.id),
    pausedLabel: pausedLabel(),
    remainingMinutes: estimateRemainingMinutes(),
  };
}

/** Handle a surfaces request. Returns true when this module owns the path. */
export async function handleSurfacesRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path !== "/api/coverage") return false;

  // ---- GET /api/coverage --------------------------------------------------
  if (method === "GET") {
    sendJson(res, 200, coverageSnapshot());
    return true;
  }

  sendJson(res, 404, { error: "unknown coverage route" });
  return true;
}
