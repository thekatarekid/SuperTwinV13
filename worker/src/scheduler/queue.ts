// ===========================================================================
// [CODE] The work queue and the coverage ledger — arch §9.1 rule 3, §9.7 rules
// 3 and 5; build item 1.8.
//
// Two tables, one file, because they are the same guarantee seen from two
// sides: `work_queue` is what is left to do and `coverage` is what has been
// done, and a transition that writes one without the other is a progress bar
// that lies.
//
// FOUR RULES THIS FILE ENFORCES RATHER THAN ASSUMES:
//
//  1. DEQUEUE BY PRIORITY, NEVER BY ROWID (§9.2 rule 5). Backfilled history has
//     the highest rowids and the oldest timestamps, so insertion order is
//     exactly the wrong order. The schema's own index comment says this in
//     capitals; every read below goes `ORDER BY priority DESC`.
//
//  2. RESTART RESUMES, IT DOES NOT RESTART (§9.7 rule 5). `work_queue` lives in
//     the DB, so a kill mid-import leaves rows where the next boot finds them.
//     `resumeQueue` returns rows abandoned in `running` to `ready` and leaves
//     `done` rows alone — resuming at the last COMPLETED stage.
//
//  3. NEVER RE-JUDGE A PERSISTED VERDICT (§9.7 rule 5, gate
//     `sched_restart_no_rejudge`). A stage that already has a verdict row is
//     not re-enqueued, is not re-run, and is not re-asked of a model. The check
//     is a query against the verdict tables, not a memory of having done it.
//
//  4. COVERAGE IS MONOTONIC (§9.7 rule 3, gate `sched_coverage_monotonic`). A
//     write that would lower `done_units` is refused and counted. "A healthy
//     mid-run system that looks like a silent failure is itself a shipped
//     defect" — and a meter that goes backwards is exactly that.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { Horizon } from "./horizons.js";

/** `work_queue.stage` — the lane-entry and lane-body stages of §9.4. */
export const STAGES = [
  "enrich",
  "entity",
  "segment",
  "episode",
  "arc",
  "extract",
  "triage",
  "derive",
  "done",
] as const;
export type Stage = (typeof STAGES)[number];

/** `work_queue.unit_kind`. */
export const UNIT_KINDS = ["event", "session", "episode", "arc", "claim_pair", "loop_batch"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export type WorkState = "ready" | "running" | "done" | "paused" | "quarantined";

export interface WorkItem {
  id: string;
  unitKind: UnitKind;
  unitId: string;
  cohortId: string | null;
  stage: Stage;
  priority: number;
  attempts: number;
  state: WorkState;
  notBeforeAt: string | null;
}

interface WorkRow {
  id: string;
  unit_kind: string;
  unit_id: string;
  cohort_id: string | null;
  stage: string;
  priority: number;
  attempts: number;
  state: string;
  not_before_at: string | null;
}

function toItem(row: WorkRow): WorkItem {
  return {
    id: row.id,
    unitKind: row.unit_kind as UnitKind,
    unitId: row.unit_id,
    cohortId: row.cohort_id,
    stage: row.stage as Stage,
    priority: row.priority,
    attempts: row.attempts,
    state: row.state as WorkState,
    notBeforeAt: row.not_before_at,
  };
}

/** The deterministic row id, so an enqueue is an upsert and never a duplicate. */
export function workId(stage: Stage, unitKind: UnitKind, unitId: string): string {
  return `wq:${stage}:${unitKind}:${unitId}`;
}

// ---------------------------------------------------------------------------
// Verdicts — rule 3
// ---------------------------------------------------------------------------

/**
 * Stages whose output is a PERSISTED VERDICT, and the table it lands in. A
 * stage listed here is never re-run once its verdict exists, however many times
 * the process restarts: §9.7 rule 5, "nothing is re-judged that already has a
 * verdict".
 */
const VERDICT_TABLES: Partial<Record<Stage, { table: string; unitColumn: string }>> = {
  episode: { table: "episode_verdicts", unitColumn: "session_id" },
  arc: { table: "arc_verdicts", unitColumn: "episode_id" },
};

/** True when this stage already has a stored verdict for this unit. */
export function hasVerdict(stage: Stage, unitId: string): boolean {
  const target = VERDICT_TABLES[stage];
  if (!target) return false;
  const row = getDb()
    .prepare(`SELECT 1 AS hit FROM ${target.table} WHERE ${target.unitColumn} = ? LIMIT 1`)
    .get(unitId) as { hit: number } | undefined;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Enqueue / dequeue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  unitKind: UnitKind;
  unitId: string;
  stage: Stage;
  priority: number;
  cohortId?: string | null;
  notBeforeAt?: string | null;
}

export interface EnqueueOutcome {
  id: string;
  action: "inserted" | "repriced" | "skipped_done" | "skipped_verdict";
}

/**
 * Enqueue one unit-stage, or reprice it if it is already queued.
 *
 * A row already `done` is left alone and a stage that already has a verdict is
 * never enqueued at all. Both are the same rule: finished work stays finished.
 * Repricing a `running` row is harmless; resetting one is not, so its state is
 * preserved.
 */
export function enqueueWork(input: EnqueueInput): EnqueueOutcome {
  const id = workId(input.stage, input.unitKind, input.unitId);
  const db = getDb();
  const before = db.prepare(`SELECT state FROM work_queue WHERE id = ?`).get(id) as
    | { state: string }
    | undefined;
  if (before?.state === "done") return { id, action: "skipped_done" };
  if (hasVerdict(input.stage, input.unitId)) return { id, action: "skipped_verdict" };

  db.prepare(
    `INSERT INTO work_queue (id, unit_kind, unit_id, cohort_id, stage, priority, state, not_before_at)
     VALUES (@id, @unitKind, @unitId, @cohortId, @stage, @priority, 'ready', @notBeforeAt)
     ON CONFLICT(id) DO UPDATE SET
       priority      = excluded.priority,
       cohort_id     = COALESCE(excluded.cohort_id, work_queue.cohort_id),
       not_before_at = excluded.not_before_at,
       state = CASE WHEN work_queue.state IN ('done', 'running') THEN work_queue.state ELSE 'ready' END`,
  ).run({
    id,
    unitKind: input.unitKind,
    unitId: input.unitId,
    cohortId: input.cohortId ?? null,
    stage: input.stage,
    priority: input.priority,
    notBeforeAt: input.notBeforeAt ?? null,
  });
  return { id, action: before ? "repriced" : "inserted" };
}

export interface DequeueOptions {
  limit?: number;
  /** Restrict to these stages — how a lane takes only its own work (§9.4). */
  stages?: readonly Stage[];
  /** ISO instant used to honour `not_before_at`. */
  nowIso?: string;
}

/**
 * The next ready units, highest priority first.
 *
 * `ORDER BY priority DESC, id` — the index the schema comment demands, plus a
 * deterministic tiebreak so a replay of the same queue produces the same order.
 * Ties on priority are not rare: a whole cohort shares one recency slot.
 */
export function peekWork(options: DequeueOptions = {}): WorkItem[] {
  const limit = Math.max(1, Math.floor(options.limit ?? 1));
  const nowIso = options.nowIso ?? new Date().toISOString();
  const stages = options.stages ?? STAGES;
  const rows = getDb()
    .prepare(
      `SELECT id, unit_kind, unit_id, cohort_id, stage, priority, attempts, state, not_before_at
         FROM work_queue
        WHERE state = 'ready'
          AND stage IN (${stages.map(() => "?").join(",")})
          AND (not_before_at IS NULL OR not_before_at <= ?)
        ORDER BY priority DESC, id
        LIMIT ?`,
    )
    .all(...stages, nowIso, limit) as WorkRow[];
  return rows.map(toItem);
}

/** Claim the next ready units — `peekWork` plus the state flip, in one write. */
export function claimWork(options: DequeueOptions = {}): WorkItem[] {
  const claimed = peekWork(options);
  if (claimed.length === 0) return [];
  const db = getDb();
  const mark = db.prepare(`UPDATE work_queue SET state = 'running', attempts = attempts + 1 WHERE id = ?`);
  const tx = db.transaction((items: WorkItem[]) => {
    for (const item of items) mark.run(item.id);
  });
  tx(claimed);
  return claimed.map((item) => ({ ...item, state: "running", attempts: item.attempts + 1 }));
}

export function completeWork(id: string): void {
  getDb().prepare(`UPDATE work_queue SET state = 'done' WHERE id = ?`).run(id);
}

/**
 * Record a failure. A REFUSAL (rate limit, quota, auth) pauses the row without
 * spending its retry budget — §4.6, and the reason gate `sched_no_stall`
 * excludes quota pauses from the idle clock. Anything else retries until the
 * caller's ladder is exhausted and is then quarantined so the rest keep moving.
 */
export function failWork(id: string, outcome: { action: "pause" | "retry" | "quarantine"; notBeforeAt?: string }): void {
  const db = getDb();
  if (outcome.action === "pause") {
    // The attempt is refunded: an outage is not the unit's fault.
    db.prepare(`UPDATE work_queue SET state = 'paused', attempts = MAX(0, attempts - 1), not_before_at = ? WHERE id = ?`).run(
      outcome.notBeforeAt ?? null,
      id,
    );
    return;
  }
  if (outcome.action === "quarantine") {
    db.prepare(`UPDATE work_queue SET state = 'quarantined' WHERE id = ?`).run(id);
    return;
  }
  db.prepare(`UPDATE work_queue SET state = 'ready', not_before_at = ? WHERE id = ?`).run(outcome.notBeforeAt ?? null, id);
}

/** Un-pause every paused row whose wait has expired. */
export function resumePaused(nowIso: string): number {
  return getDb()
    .prepare(
      `UPDATE work_queue SET state = 'ready'
        WHERE state = 'paused' AND (not_before_at IS NULL OR not_before_at <= ?)`,
    )
    .run(nowIso).changes;
}

export interface ResumeReport {
  /** Rows found abandoned in `running` and returned to `ready`. */
  requeued: number;
  /** Rows left alone because their stage already holds a verdict. */
  verdictsKept: number;
  /** Unit-stages a restart would have re-judged and did not. */
  rejudged: string[];
}

/**
 * §9.7 rule 5. On restart, in-flight cohorts resume from their last COMPLETED
 * stage — so a row caught mid-flight goes back to `ready`, EXCEPT where its
 * verdict already landed. That row is marked `done` instead: the work happened,
 * the process died before saying so, and re-running it would re-judge.
 *
 * `rejudged` is the gate's number and it must stay empty.
 */
export function resumeQueue(): ResumeReport {
  const db = getDb();
  const running = db
    .prepare(
      `SELECT id, unit_kind, unit_id, cohort_id, stage, priority, attempts, state, not_before_at
         FROM work_queue WHERE state = 'running'`,
    )
    .all() as WorkRow[];

  const report: ResumeReport = { requeued: 0, verdictsKept: 0, rejudged: [] };
  const toDone = db.prepare(`UPDATE work_queue SET state = 'done' WHERE id = ?`);
  const toReady = db.prepare(`UPDATE work_queue SET state = 'ready' WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of running) {
      const item = toItem(row);
      if (hasVerdict(item.stage, item.unitId)) {
        toDone.run(item.id);
        report.verdictsKept += 1;
        continue;
      }
      toReady.run(item.id);
      report.requeued += 1;
    }
  });
  tx();
  return report;
}

/** How many rows sit in each state — what the no-stall check asks about. */
export function queueDepth(): Record<WorkState, number> {
  const rows = getDb().prepare(`SELECT state, COUNT(*) AS n FROM work_queue GROUP BY state`).all() as {
    state: string;
    n: number;
  }[];
  const out: Record<WorkState, number> = { ready: 0, running: 0, done: 0, paused: 0, quarantined: 0 };
  for (const row of rows) {
    if (row.state in out) out[row.state as WorkState] = row.n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage — rule 4
// ---------------------------------------------------------------------------

export type CoverageScope = "global" | "source" | "stream";

export interface CoverageRow {
  scopeKind: CoverageScope;
  scopeId: string;
  horizon: Horizon;
  totalUnits: number;
  doneUnits: number;
  /** done/total, or 0 when nothing is known yet. */
  fraction: number;
}

export interface CoverageWrite {
  scopeKind: CoverageScope;
  scopeId: string;
  horizon: Horizon;
  totalUnits: number;
  doneUnits: number;
}

export interface CoverageOutcome extends CoverageRow {
  /** A write that tried to lower `done_units` or `total_units`. */
  regressionRefused: boolean;
}

/**
 * Write coverage for one `(scope, horizon)`, monotonically.
 *
 * §9.7 rule 3 is unconditional — "progress is monotonic and legible" — so a
 * lower `done_units` is not written; it is clamped to what is already there and
 * the refusal is reported. `total_units` is clamped upward the same way: a
 * later page of history discovering more work must not make the meter jump
 * backwards either, and a total that shrank would do exactly that.
 *
 * Clamping rather than throwing is deliberate. A late, stale transition is a
 * normal event in a concurrent pipeline; killing the import over one would turn
 * a cosmetic race into an outage.
 */
export function writeCoverage(write: CoverageWrite): CoverageOutcome {
  const db = getDb();
  const before = db
    .prepare(
      `SELECT total_units AS total, done_units AS done
         FROM coverage WHERE scope_kind = ? AND scope_id = ? AND horizon = ?`,
    )
    .get(write.scopeKind, write.scopeId, write.horizon) as { total: number; done: number } | undefined;

  const priorTotal = before?.total ?? 0;
  const priorDone = before?.done ?? 0;
  const total = Math.max(priorTotal, Math.max(0, Math.floor(write.totalUnits)));
  // done can never exceed total, and never fall below what was already claimed.
  const done = Math.min(total, Math.max(priorDone, Math.max(0, Math.floor(write.doneUnits))));
  const regressionRefused = write.doneUnits < priorDone || write.totalUnits < priorTotal;

  db.prepare(
    `INSERT INTO coverage (scope_kind, scope_id, horizon, total_units, done_units, updated_at)
     VALUES (@scopeKind, @scopeId, @horizon, @total, @done, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(scope_kind, scope_id, horizon) DO UPDATE SET
       total_units = excluded.total_units,
       done_units  = excluded.done_units,
       updated_at  = excluded.updated_at`,
  ).run({ ...write, total, done });

  return {
    scopeKind: write.scopeKind,
    scopeId: write.scopeId,
    horizon: write.horizon,
    totalUnits: total,
    doneUnits: done,
    fraction: total > 0 ? done / total : 0,
    regressionRefused,
  };
}

export function readCoverage(scopeKind: CoverageScope, scopeId: string): CoverageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT horizon, total_units AS total, done_units AS done
         FROM coverage WHERE scope_kind = ? AND scope_id = ?`,
    )
    .all(scopeKind, scopeId) as { horizon: string; total: number; done: number }[];
  return rows.map((row) => ({
    scopeKind,
    scopeId,
    horizon: row.horizon as Horizon,
    totalUnits: row.total,
    doneUnits: row.done,
    fraction: row.total > 0 ? row.done / row.total : 0,
  }));
}
