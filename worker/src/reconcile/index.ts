// ===========================================================================
// [CODE] The reconcile JOB — one entry point, three callers. §12 step 28,
// §8.1, §11.2, item 2.6.
//
// Item 2.5 built the reconcile PASS (`arcs/reconcile.ts`): dedupe provisionals,
// rebind `arc_key`, age, honour user walls, compact entity redirects. This file
// is the thing that decides WHEN that pass runs and guarantees the properties
// the product promises about it. The split matters: the pass is a pure-ish
// transform over the arc tables, the job is the control plane around it.
//
// THREE CALLERS, ONE FUNCTION. §8.1 gives reconcile a different cadence per
// mode — bootstrap reconciles "at every cohort boundary + nightly", steady "on
// change + nightly" — and §12 step 28 adds the manual route. Three cadences is
// not three code paths: `onCohortBoundary`, `onArcChange`, `runNightly` and
// `POST /api/reconcile/run` all funnel into {@link runReconcile}. A second
// entry point is how the "undo that reconcile" story dies, because two entry
// points mint two run ids for what the user experienced as one event.
//
// ONE RUN ID. Every mutation the job writes carries the same `run_id`, across
// every registered step, so "undo run X" stays a reverse replay over one id
// (§11.2 ⑥). The id is minted here, once, and threaded down.
//
// IDEMPOTENT. Running the job twice changes nothing the second time. The pass
// is already convergent — a committed arc keys to the same `arc_key`, so it
// rebinds to the same id and the clock only moves forward — and the job proves
// it by counting the `mutations` rows written under its own run id. Zero rows
// is the second run's expected answer, and the report says so out loud rather
// than leaving a caller to diff the database.
//
// OUTPUT GROWS MONOTONICALLY. "First output ≤120 s; grows monotonically"
// (§12 step 30) is a promise about the SURFACE, and reconcile is the one pass
// with the power to break it: it is the only thing that rewrites arc identity
// after the user has already seen an arc. So the job snapshots what is showing,
// runs the steps inside one transaction, and if an arc vanished, lost episodes,
// or a coverage meter went backwards, it ROLLS THE WHOLE RUN BACK and reports
// the retraction. Aging is not a retraction: an archived arc is "retrievable,
// not surfaced" (§11.3), it keeps its id, its episodes and its history, and the
// transition is one logged, reversible mutation.
//
// THE BUDGET IS A GATE, NOT A COMMENT. Global acceptance row 21 caps a quiet
// day at 12 model calls. Reconcile itself is `[CODE]` and costs zero, but the
// step registry exists so later items (space status, goal emergence) can hook
// in, and a step that wants model calls declares them. The runner reads the
// day's spend off `runs` and SKIPS a step it cannot afford rather than
// overrunning the budget — a deferred step is a slower answer, an overrun is a
// bill. `onArcChange` coalesces for the same reason: steady state fires "on
// change" on every live pass, and an uncoalesced trigger would run the pass
// hundreds of times a day for one day's worth of information.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { arcEpisodeIds, readArcs } from "../arcs/provisional.js";
import { reconcile, type ReconcileResult } from "../arcs/reconcile.js";
import { getDb } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { type TransitionResult } from "../scheduler/cohorts.js";
import { type SchedulerMode } from "../scheduler/horizons.js";
import { readCoverage, type CoverageRow } from "../scheduler/queue.js";

/** The actor on every mutation the job writes. Matches the pass. */
export const RECONCILE_ACTOR = "reconcile";

/** Global acceptance row 21 — steady-state model calls on a quiet day. */
export const STEADY_CALL_BUDGET = 12;

/** Step 28 is `[CODE]`. The built-in arc step costs exactly this many calls. */
export const ARC_STEP_MODEL_CALLS = 0;

/** Nightly means "not again within a day", not "at 03:00 sharp". */
export const NIGHTLY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Steady state's "on change" trigger, coalesced to at most one run a minute. */
export const CHANGE_COALESCE_MS = 60_000;

export const LAST_NIGHTLY_KEY = "reconcile.last_nightly_at";
export const LAST_RUN_KEY = "reconcile.last_run";

/** Where a run came from. Recorded so the surface can say why an arc moved. */
export type ReconcileTrigger = "cohort_boundary" | "change" | "nightly" | "manual";

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

export interface ReconcileStepContext {
  /** The one run id every mutation in this job must carry. */
  runId: string;
  now: number;
  trigger: ReconcileTrigger;
  mode: SchedulerMode;
  /** One cohort boundary's provisionals, or null for the whole table. */
  batchId: string | null;
  /** Model calls this step may still spend today. */
  callsRemaining: number;
}

export interface ReconcileStepOutcome {
  /** Anything the surface wants to render. Never used for control flow. */
  detail?: Record<string, unknown>;
}

export interface ReconcileStep {
  name: string;
  /** Model calls one execution costs. `[CODE]` steps declare 0. */
  modelCalls: number;
  run(ctx: ReconcileStepContext): ReconcileStepOutcome;
}

/**
 * ① ② ③ ④ ⑤ ⑥ — the arc pass, the only step that ships with the job.
 * Later items register alongside it; §12 step 28 names space status and the
 * goal-emergence pass as the next two.
 */
export const arcReconcileStep: ReconcileStep = {
  name: "arcs",
  modelCalls: ARC_STEP_MODEL_CALLS,
  run(ctx) {
    const result: ReconcileResult = reconcile({
      now: ctx.now,
      runId: ctx.runId,
      ...(ctx.batchId === null ? {} : { batchId: ctx.batchId }),
    });
    return {
      detail: {
        groups: result.groups.length,
        merged: result.merged,
        minted: result.minted,
        rebound: result.rebound,
        aged: result.aged.length,
        walls: result.walls.length,
        redirects: result.redirects.length,
      },
    };
  },
};

const steps = new Map<string, ReconcileStep>([[arcReconcileStep.name, arcReconcileStep]]);

/** Register (or replace) a step. Later items hook in here, in insertion order. */
export function registerReconcileStep(step: ReconcileStep): void {
  steps.set(step.name, step);
}

export function reconcileSteps(): ReconcileStep[] {
  return [...steps.values()];
}

/** Back to the shipped registry. For tests and for `reset source`. */
export function resetReconcileSteps(): void {
  steps.clear();
  steps.set(arcReconcileStep.name, arcReconcileStep);
}

// ---------------------------------------------------------------------------
// Budget (global acceptance row 21)
// ---------------------------------------------------------------------------

/** Midnight UTC before `now`, as the ISO stamp `runs.started_at` is written in. */
export function startOfUtcDay(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Model calls already made today, read off `runs` rather than an in-memory
 * counter: a counter resets on restart and the budget would silently double.
 */
export function modelCallsToday(now: number = Date.now()): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?`)
    .get(startOfUtcDay(now)) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Monotonicity guard
// ---------------------------------------------------------------------------

export interface Retraction {
  kind: "arc_vanished" | "episodes_lost" | "coverage_regressed";
  targetId: string;
  detail: string;
}

/** What the user can already see. Exported so {@link retractions} is testable. */
export interface Surface {
  arcs: Map<string, number>;
  coverage: Map<string, { total: number; done: number }>;
}

/** What is on the surface right now: arc ids, their episode counts, the meters. */
function readSurface(): Surface {
  const arcs = new Map<string, number>();
  for (const arc of readArcs()) arcs.set(arc.id, arcEpisodeIds(arc.id).length);
  const coverage = new Map<string, { total: number; done: number }>();
  for (const row of coverageRows()) {
    coverage.set(`${row.scopeKind}/${row.scopeId}/${row.horizon}`, {
      total: row.totalUnits,
      done: row.doneUnits,
    });
  }
  return { arcs, coverage };
}

function coverageRows(): CoverageRow[] {
  const scopes = getDb()
    .prepare(`SELECT DISTINCT scope_kind AS kind, scope_id AS id FROM coverage`)
    .all() as { kind: string; id: string }[];
  return scopes.flatMap((s) => readCoverage(s.kind as CoverageRow["scopeKind"], s.id));
}

/**
 * Everything the run took away. Aging is deliberately absent: an arc that went
 * dormant kept its id, its episodes and its place in history, and §11.3 calls
 * archived arcs "retrievable, not surfaced". Losing the arc is the retraction.
 */
export function retractions(before: Surface, after: Surface): Retraction[] {
  const out: Retraction[] = [];
  for (const [id, episodes] of before.arcs) {
    const now = after.arcs.get(id);
    if (now === undefined) {
      out.push({ kind: "arc_vanished", targetId: id, detail: "an arc the user could already see no longer exists" });
      continue;
    }
    if (now < episodes) {
      out.push({
        kind: "episodes_lost",
        targetId: id,
        detail: `arc dropped from ${episodes} to ${now} episode(s)`,
      });
    }
  }
  for (const [key, was] of before.coverage) {
    const now = after.coverage.get(key);
    if (now === undefined || now.done < was.done || now.total < was.total) {
      out.push({ kind: "coverage_regressed", targetId: key, detail: "a coverage meter moved backwards" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export interface ReconcileRunOptions {
  trigger?: ReconcileTrigger;
  /** One cohort boundary's provisionals. Omit for the nightly whole-table pass. */
  batchId?: string;
  now?: number;
  /** Reuse a run id so several reconciles undo as one. */
  runId?: string;
  mode?: SchedulerMode;
  /** Model calls allowed today. Defaults to {@link STEADY_CALL_BUDGET}. */
  callBudget?: number;
}

export interface ReconcileStepReport {
  name: string;
  modelCalls: number;
  ran: boolean;
  skipReason: string | null;
  detail: Record<string, unknown>;
}

export interface ReconcileRunReport {
  runId: string;
  trigger: ReconcileTrigger;
  mode: SchedulerMode;
  batchId: string | null;
  startedAt: string;
  endedAt: string;
  /** `mutations` rows written under this run id. Zero means nothing changed. */
  changes: number;
  /** True when a second identical run wrote nothing — the idempotence claim. */
  noop: boolean;
  modelCalls: number;
  budget: { limit: number; spentBefore: number; remaining: number };
  steps: ReconcileStepReport[];
  /** Non-empty means the run was rolled back. Always empty on a healthy run. */
  retracted: Retraction[];
  rolledBack: boolean;
}

/** Thrown inside the transaction to roll a retracting run back. Never escapes. */
class RetractionRollback extends Error {
  constructor(readonly found: Retraction[]) {
    super("reconcile retracted output and was rolled back");
  }
}

/** Guards against a trigger firing while a run is in flight. */
let inFlight = false;

/**
 * Run reconcile. The only way to reconcile anything.
 *
 * The whole job is one transaction so that the run is atomic in both
 * directions: a step that throws leaves no half-reconciled arcs, and a run that
 * would retract surfaced output is undone before anyone reads it.
 */
export function runReconcile(options: ReconcileRunOptions = {}): ReconcileRunReport {
  const now = options.now ?? Date.now();
  const trigger = options.trigger ?? "manual";
  const mode = options.mode ?? "steady";
  const batchId = options.batchId ?? null;
  const runId = options.runId ?? `rec_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const startedAt = new Date(now).toISOString();
  const limit = options.callBudget ?? STEADY_CALL_BUDGET;
  const spentBefore = modelCallsToday(now);

  if (inFlight) {
    // Not an error: three cadences share one entry point, so overlap is normal.
    return {
      runId,
      trigger,
      mode,
      batchId,
      startedAt,
      endedAt: startedAt,
      changes: 0,
      noop: true,
      modelCalls: 0,
      budget: { limit, spentBefore, remaining: Math.max(0, limit - spentBefore) },
      steps: reconcileSteps().map((s) => ({
        name: s.name,
        modelCalls: 0,
        ran: false,
        skipReason: "a reconcile run is already in flight",
        detail: {},
      })),
      retracted: [],
      rolledBack: false,
    };
  }

  const db = getDb();
  const before = readSurface();
  const stepReports: ReconcileStepReport[] = [];
  let spent = spentBefore;
  let retracted: Retraction[] = [];
  let rolledBack = false;

  inFlight = true;
  try {
    const tx = db.transaction(() => {
      for (const step of reconcileSteps()) {
        const remaining = Math.max(0, limit - spent);
        if (step.modelCalls > remaining) {
          stepReports.push({
            name: step.name,
            modelCalls: 0,
            ran: false,
            skipReason: `needs ${step.modelCalls} model call(s), ${remaining} left in today's budget of ${limit}`,
            detail: {},
          });
          continue;
        }
        const outcome = step.run({
          runId,
          now,
          trigger,
          mode,
          batchId,
          callsRemaining: remaining,
        });
        spent += step.modelCalls;
        stepReports.push({
          name: step.name,
          modelCalls: step.modelCalls,
          ran: true,
          skipReason: null,
          detail: outcome.detail ?? {},
        });
      }
      const found = retractions(before, readSurface());
      if (found.length > 0) throw new RetractionRollback(found);
    });
    tx();
  } catch (err) {
    if (err instanceof RetractionRollback) {
      retracted = err.found;
      rolledBack = true;
      for (const report of stepReports) {
        report.ran = false;
        report.skipReason = "rolled back: the run would have retracted surfaced output";
        report.modelCalls = 0;
      }
      spent = spentBefore;
    } else {
      throw err;
    }
  } finally {
    inFlight = false;
  }

  const changes = rolledBack ? 0 : mutationsForRun(runId);
  const report: ReconcileRunReport = {
    runId,
    trigger,
    mode,
    batchId,
    startedAt,
    endedAt: new Date(Date.now()).toISOString(),
    changes,
    noop: changes === 0,
    modelCalls: spent - spentBefore,
    budget: { limit, spentBefore, remaining: Math.max(0, limit - spent) },
    steps: stepReports,
    retracted,
    rolledBack,
  };
  appStateSet(LAST_RUN_KEY, JSON.stringify(report));
  return report;
}

/** How many rows this run wrote. The idempotence claim is `=== 0` on run two. */
export function mutationsForRun(runId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM mutations WHERE run_id = ?`).get(runId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** The last run's report, or null before the job has ever run. */
export function lastReconcileRun(): ReconcileRunReport | null {
  const raw = appStateGet(LAST_RUN_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ReconcileRunReport;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scheduling — the three cadences of §8.1
// ---------------------------------------------------------------------------

let lastChangeRunAt = 0;

/** Test seam: forget the coalescing window. */
export function resetReconcileSchedule(): void {
  lastChangeRunAt = 0;
  inFlight = false;
}

export interface TriggerOptions {
  now?: number;
  mode?: SchedulerMode;
  /** Ignore the coalescing window / the nightly clock. */
  force?: boolean;
}

/**
 * A cohort finished. BOOTSTRAP reconciles at every boundary (§8.1) because
 * cohorts run in parallel there and the twins of one trip are only comparable
 * once both cohorts land. In steady the same event is just "a change", so it
 * goes through the coalescing path instead of running the pass per cohort.
 */
export function onCohortBoundary(cohortId: string, options: TriggerOptions = {}): ReconcileRunReport | null {
  const mode = options.mode ?? "bootstrap";
  const now = options.now ?? Date.now();
  if (mode === "bootstrap") {
    return runReconcile({ trigger: "cohort_boundary", batchId: cohortId, now, mode });
  }
  return onArcChange({ ...options, now, mode });
}

/**
 * The seam onto item 1.8's cohort scheduler. `advanceCohort` returns a
 * {@link TransitionResult}; hand it straight here and the boundary reconciles
 * itself. Taking the result rather than calling out of `advanceCohort` keeps
 * the scheduler free of a dependency on the understanding layer — and keeps a
 * REFUSED transition (a stale one arriving late, which the scheduler treats as
 * ordinary) from triggering a pass over work that already reconciled.
 *
 * Only `done` is a boundary. A cohort part-way up the ladder has arcs still
 * being minted; reconciling then would commit half a cohort's provisionals and
 * hand the other half to the next run, which is exactly the sequential
 * comparison §11.2 says cannot see the duplicates.
 */
export function reconcileAfterTransition(
  transition: TransitionResult,
  options: TriggerOptions = {},
): ReconcileRunReport | null {
  if (transition.refused) return null;
  if (transition.to !== "done") return null;
  return onCohortBoundary(transition.cohort.id, options);
}

/** Provisional arcs waiting for a pass. Zero means "on change" has nothing to do. */
export function pendingProvisionalCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM provisional_arcs`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Steady state's "on change" trigger, coalesced. Live passes fire every ~30 s
 * (§8.1); running the pass on each one would spend a day's worth of work on a
 * minute's worth of news, so a run inside the window is dropped and the next
 * one picks up everything that accumulated. Nothing pending → nothing to do.
 */
export function onArcChange(options: TriggerOptions = {}): ReconcileRunReport | null {
  const now = options.now ?? Date.now();
  if (options.force !== true) {
    if (now - lastChangeRunAt < CHANGE_COALESCE_MS && lastChangeRunAt !== 0) return null;
    if (pendingProvisionalCount() === 0) return null;
  }
  lastChangeRunAt = now;
  return runReconcile({ trigger: "change", now, mode: options.mode ?? "steady" });
}

/** When the nightly pass last ran, or null if it never has. */
export function lastNightlyAt(): string | null {
  return appStateGet(LAST_NIGHTLY_KEY);
}

/**
 * Nightly is due a day after the last one — read from the DB, not a timer, so a
 * machine that was asleep at 03:00 still reconciles when it wakes up.
 */
export function nightlyDue(now: number = Date.now()): boolean {
  const last = lastNightlyAt();
  if (last === null) return true;
  const at = Date.parse(last);
  if (!Number.isFinite(at)) return true;
  return now - at >= NIGHTLY_INTERVAL_MS;
}

/** The nightly whole-table pass. Runs in BOTH modes (§8.1). */
export function runNightly(options: TriggerOptions = {}): ReconcileRunReport | null {
  const now = options.now ?? Date.now();
  if (options.force !== true && !nightlyDue(now)) return null;
  const report = runReconcile({ trigger: "nightly", now, mode: options.mode ?? "steady" });
  // Stamped even on a no-op run: "we looked" is what stops the tick from
  // re-running the whole table every interval for the rest of the day.
  appStateSet(LAST_NIGHTLY_KEY, new Date(now).toISOString());
  return report;
}

export interface ReconcileTimer {
  stop(): void;
}

/**
 * The nightly timer. It ticks often and asks {@link nightlyDue} rather than
 * sleeping until 03:00, because a desktop app is asleep at 03:00 more nights
 * than not. `unref` so a pending tick never holds the process open.
 */
export function startNightlyTimer(options: { intervalMs?: number; mode?: SchedulerMode } = {}): ReconcileTimer {
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  const handle = setInterval(() => {
    try {
      runNightly({ mode: options.mode ?? "steady" });
    } catch {
      /* a failed nightly is retried on the next tick, never fatal */
    }
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
