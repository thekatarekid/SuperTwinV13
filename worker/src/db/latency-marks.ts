// ===========================================================================
// [CODE] Persisted latency marks — arch §9.5.3 rule 4, build item 4.2.
//
// "Instrument TTFT and tokens/sec per model per call type, and gate on
// per-call latency, not only end-to-end. Every figure in this section needs
// measurement; a regression should surface at the call that caused it, not as
// a mysterious end-to-end failure."
//
// scheduler/paint.ts's TimingLog is the same instrument in memory, for the
// eval. This module is the durable half: every model call writes a `call` mark
// beside its `runs` row (db/run-accounting.recordRun), and every measured
// global-acceptance number writes a `milestone` mark. The ops surface
// (GET /api/latency) reads both back through `latencySnapshot`.
//
// Three rules, mirrored from TimingLog so the two instruments cannot disagree:
//   * the key is (model, call type) — a per-model-only average would hide a
//     P-CL1 regression behind a fast P-TR1;
//   * summaries report the WORST value, never the mean — one breach is a
//     breach;
//   * tokens/sec is derived at read time from output_tokens and total_ms,
//     never stored — a stored rate and its stored inputs can drift apart.
//
// TTFT is NULL, not 0, when the provider never streamed a token: an errored
// call has no first token, and a zero would claim it was instantaneous. The
// `ttftCoverage` figure exists so "per-call TTFT recorded" (gate
// `latency_ttft_recorded`) is measurable on the running system too.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";

// ---- The milestones — the global-acceptance numbers, by name ---------------

/**
 * The five budget names, identical to scheduler/live-budgets' BudgetCheck
 * names so a milestone row and a budget check are the same vocabulary. The
 * list is closed: an unknown milestone is a typo, and a typo'd milestone is a
 * metric nobody will ever find again.
 */
export const MILESTONE_NAMES = [
  "first_claim",
  "spaces_tasks",
  "silent_gap",
  "steady_calls",
  "live_visibility",
] as const;
export type MilestoneName = (typeof MILESTONE_NAMES)[number];

const MILESTONE_SET: ReadonlySet<string> = new Set(MILESTONE_NAMES);

export function isMilestoneName(v: unknown): v is MilestoneName {
  return typeof v === "string" && MILESTONE_SET.has(v);
}

// ---- Row shapes ------------------------------------------------------------

export interface CallMarkParams {
  /** Call type — P-CL1, media, chat. Names the row the regression surfaces at. */
  name: string;
  model: string;
  /** The `runs` row this call also wrote, when it wrote one. */
  runId?: string | null;
  /** Time to first streamed token, ms. null = no token ever streamed. */
  ttftMs: number | null;
  /** Dispatch → done, ms. null when the call died before its end was seen. */
  totalMs: number | null;
  outputTokens: number;
  /** Injectable clock for tests; defaults to now. */
  createdAt?: string;
}

export interface MilestoneMarkParams {
  name: MilestoneName;
  /** The measured number (ms for the time budgets, calls for steady_calls). */
  value: number;
  /** The budget it was measured against, stored so history is not re-graded. */
  budget: number;
  unit: "ms" | "calls";
  createdAt?: string;
}

/** One (model, call type) line of the ops surface. Worst values, never means. */
export interface CallLatencySummary {
  model: string;
  callType: string;
  calls: number;
  /** Calls that recorded a TTFT — the `latency_ttft_recorded` numerator. */
  callsWithTtft: number;
  worstTtftMs: number | null;
  worstTotalMs: number | null;
  /** Slowest observed rate, derived from the worst-rate call, 1 decimal. */
  minTokensPerSecond: number | null;
  lastAt: string | null;
}

export interface MilestoneRow {
  name: MilestoneName;
  value: number;
  budget: number;
  unit: "ms" | "calls";
  met: boolean;
  at: string;
}

export interface LatencySnapshot {
  calls: CallLatencySummary[];
  /** Latest mark per milestone; a milestone never measured is simply absent. */
  milestones: MilestoneRow[];
  /** Share of calls that recorded a TTFT. null when no calls exist yet. */
  ttftCoverage: number | null;
}

// ---- Prepared statements (same handle-keyed cache as the other db modules) --

interface Stmts {
  db: Database.Database;
  insertCall: Database.Statement;
  insertMilestone: Database.Statement;
  callSummary: Database.Statement;
  latestMilestones: Database.Statement;
  coverage: Database.Statement;
}

let stmts: Stmts | null = null;

function s(): Stmts {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = {
    db,
    insertCall: db.prepare(`
      INSERT INTO latency_marks (kind, name, model, run_id, ttft_ms, total_ms, output_tokens, created_at)
      VALUES ('call', @name, @model, @runId, @ttftMs, @totalMs, @outputTokens, @createdAt)
    `),
    insertMilestone: db.prepare(`
      INSERT INTO latency_marks (kind, name, value, budget, unit, created_at)
      VALUES ('milestone', @name, @value, @budget, @unit, @createdAt)
    `),
    // Worst = MAX for both time columns. tokens/sec is derived from the single
    // worst-rate call (MIN over the per-row rate), not from summed columns —
    // a sum would let one huge fast call hide one tiny slow one.
    callSummary: db.prepare(`
      SELECT model,
             name                                        AS call_type,
             COUNT(*)                                    AS calls,
             COUNT(ttft_ms)                              AS calls_with_ttft,
             MAX(ttft_ms)                                AS worst_ttft_ms,
             MAX(total_ms)                               AS worst_total_ms,
             MIN(CASE WHEN total_ms > 0
                      THEN output_tokens * 1000.0 / total_ms END) AS min_tps,
             MAX(created_at)                             AS last_at
      FROM latency_marks
      WHERE kind = 'call'
      GROUP BY model, name
      ORDER BY model, name
    `),
    latestMilestones: db.prepare(`
      SELECT name, value, budget, unit, created_at
      FROM latency_marks m
      WHERE kind = 'milestone'
        AND id = (SELECT MAX(id) FROM latency_marks
                   WHERE kind = 'milestone' AND name = m.name)
      ORDER BY name
    `),
    coverage: db.prepare(`
      SELECT COUNT(*) AS calls, COUNT(ttft_ms) AS with_ttft
      FROM latency_marks WHERE kind = 'call'
    `),
  };
  return stmts;
}

// ---- Writes ----------------------------------------------------------------

/**
 * One model call's latency, persisted. Called from recordRun for every run
 * row, so the two tables have the same cardinality and a run without a mark
 * is a bug, not a configuration.
 */
export function recordCallMark(p: CallMarkParams): void {
  if (typeof p.name !== "string" || p.name.trim() === "") {
    throw new Error("latency_marks.name is required — a nameless mark cannot surface a regression");
  }
  const ttft = p.ttftMs;
  if (ttft !== null && (!Number.isFinite(ttft) || ttft < 0)) {
    throw new Error(`latency_marks.ttft_ms must be a non-negative number or null — got ${String(ttft)}`);
  }
  const total = p.totalMs;
  if (total !== null && (!Number.isFinite(total) || total < 0)) {
    throw new Error(`latency_marks.total_ms must be a non-negative number or null — got ${String(total)}`);
  }
  s().insertCall.run({
    name: p.name,
    model: p.model,
    runId: p.runId ?? null,
    ttftMs: ttft === null ? null : Math.round(ttft),
    totalMs: total === null ? null : Math.round(total),
    outputTokens: p.outputTokens,
    createdAt: p.createdAt ?? new Date().toISOString(),
  });
}

/**
 * One measured global-acceptance number, persisted with the budget it was
 * measured against. Unknown names are rejected — see MILESTONE_NAMES.
 */
export function recordMilestoneMark(p: MilestoneMarkParams): void {
  if (!isMilestoneName(p.name)) {
    throw new Error(`unknown latency milestone ${String(p.name)} — must be one of ${MILESTONE_NAMES.join("|")}`);
  }
  if (!Number.isFinite(p.value) || p.value < 0) {
    throw new Error(`latency milestone value must be a non-negative number — got ${String(p.value)}`);
  }
  s().insertMilestone.run({
    name: p.name,
    value: p.value,
    budget: p.budget,
    unit: p.unit,
    createdAt: p.createdAt ?? new Date().toISOString(),
  });
}

// ---- Reads -----------------------------------------------------------------

/** Per (model, call type): worst TTFT, worst total, slowest tokens/sec. */
export function callLatencySummary(): CallLatencySummary[] {
  const rows = s().callSummary.all() as {
    model: string | null;
    call_type: string;
    calls: number;
    calls_with_ttft: number;
    worst_ttft_ms: number | null;
    worst_total_ms: number | null;
    min_tps: number | null;
    last_at: string | null;
  }[];
  return rows.map((r) => ({
    model: r.model ?? "",
    callType: r.call_type,
    calls: r.calls,
    callsWithTtft: r.calls_with_ttft,
    worstTtftMs: r.worst_ttft_ms,
    worstTotalMs: r.worst_total_ms,
    minTokensPerSecond: r.min_tps === null ? null : Math.round(r.min_tps * 10) / 10,
    lastAt: r.last_at,
  }));
}

/** The latest mark per milestone. `met` is value <= the budget OF THAT MARK. */
export function latestMilestones(): MilestoneRow[] {
  const rows = s().latestMilestones.all() as {
    name: string;
    value: number;
    budget: number;
    unit: string;
    created_at: string;
  }[];
  return rows
    .filter((r): r is typeof r & { name: MilestoneName } => isMilestoneName(r.name))
    .map((r) => ({
      name: r.name,
      value: r.value,
      budget: r.budget,
      unit: r.unit === "calls" ? ("calls" as const) : ("ms" as const),
      met: r.value <= r.budget,
      at: r.created_at,
    }));
}

/** Everything GET /api/latency serves — one query set, one shape. */
export function latencySnapshot(): LatencySnapshot {
  const cov = s().coverage.get() as { calls: number; with_ttft: number };
  return {
    calls: callLatencySummary(),
    milestones: latestMilestones(),
    ttftCoverage: cov.calls > 0 ? cov.with_ttft / cov.calls : null,
  };
}
