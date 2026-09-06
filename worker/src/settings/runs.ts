// ===========================================================================
// [CODE] Settings › Runs — the run-level half of the trace viewer
// (Product_V6 §25 "Runs: trace viewer, filters, diff runs, quarantine, undo a
// run, cost dashboards"; V6 P1 S5.6).
//
// The 13.4 pane was TRACE-level: filter traces, open one, diff two packed
// contexts, undo the run a trace belonged to. Everything below is the level
// above it — the unit the product doc actually names:
//
//   listRuns()    the index. One row per `runs` row, with the counts that make
//                 a run legible without opening it: how many traces it spent,
//                 how many decisions it wrote, how many of those are already
//                 reversed, and whether it is quarantined.
//   runDetail()   one run: its row, its traces, its decisions, and the UNDO
//                 PREVIEW (consolidation/run-undo.ts) so the blast radius is
//                 readable before anything is clicked.
//   diffRuns()    two runs side by side: the header fields that explain a
//                 behaviour change (pass, model, prompt version, status, cost,
//                 tokens, latency) and the decision diff — what A wrote that B
//                 did not, what B wrote that A did not, and the targets both
//                 touched with a different action. That last set is the one
//                 worth having: it is what "the new model decided differently"
//                 looks like in the ledger.
//   setRunQuarantine()  flag a run's output as not-to-be-trusted, or release
//                 it. Quarantine is a `decisions` row (target_kind 'run'), not
//                 a new column: it is auditable, reversible and needs no
//                 migration, and the pane can filter on it. It is deliberately
//                 NOT an undo — undo reverts, quarantine marks. A run can be
//                 quarantined first (fast, safe, reversible) and undone after
//                 the human has read the preview.
//
// Nothing here writes to a derived object. The only write is the quarantine
// marker, and it goes through the one decisions writer like everything else.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { decisionsForRun, runUndoPreview, type RunUndoPreview } from "../consolidation/run-undo.js";
import { ensureTracesSchema } from "../traces/store.js";

/** `decisions.target_kind` the quarantine marker uses. */
export const RUN_TARGET_KIND = "run";
export const QUARANTINE_ACTION = "quarantine";
export const RELEASE_ACTION = "release";

export interface RunQuarantine {
  quarantined: boolean;
  at: string;
  reason: string | null;
}

export interface RunRow {
  id: string;
  kind: string | null;
  role: string | null;
  pass: string | null;
  origin: string | null;
  model: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number;
  input_tokens: number;
  cache_read: number;
  output_tokens: number;
  error_code: string | null;
  /** How many traces this run spent. */
  traces: number;
  /** How many decisions it wrote, and how many of those are already reversed. */
  decisions: number;
  reversed: number;
  quarantine: RunQuarantine | null;
}

export interface RunTraceRow {
  id: string;
  pass: string | null;
  caller: string | null;
  model: string | null;
  prompt_version: string | null;
  repair_count: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  status: string | null;
  day: string | null;
  created_at: string | null;
}

export interface RunDecisionRow {
  id: string;
  pass: string | null;
  target_kind: string;
  target_id: string;
  action: string;
  reason: string | null;
  created_at: string;
  reversed_at: string | null;
}

// ---- quarantine ------------------------------------------------------------

/**
 * The latest quarantine verdict for a run, or null when it was never marked.
 * `rowid` orders same-millisecond rows the way decisionsFor() does.
 */
export function runQuarantine(runId: string): RunQuarantine | null {
  const row = getDb()
    .prepare(
      `SELECT action, reason, created_at FROM decisions
        WHERE target_kind = ? AND target_id = ? AND action IN (?, ?)
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(RUN_TARGET_KIND, runId, QUARANTINE_ACTION, RELEASE_ACTION) as
    | { action: string; reason: string | null; created_at: string }
    | undefined;
  if (!row) return null;
  return { quarantined: row.action === QUARANTINE_ACTION, at: row.created_at, reason: row.reason };
}

/** Quarantine (or release) one run. Returns the new verdict; unknown run → null. */
export function setRunQuarantine(
  runId: string,
  quarantined: boolean,
  reason: string | null = null,
): RunQuarantine | null {
  const exists = getDb().prepare(`SELECT id FROM runs WHERE id = ?`).get(runId) as { id: string } | undefined;
  if (!exists) return null;
  writeDecision({
    pass: "user",
    targetKind: RUN_TARGET_KIND,
    targetId: runId,
    action: quarantined ? QUARANTINE_ACTION : RELEASE_ACTION,
    old: runQuarantine(runId),
    new: { quarantined },
    reason:
      reason ??
      (quarantined
        ? "quarantined from Settings › Runs — this run's output is not to be trusted"
        : "released from quarantine in Settings › Runs"),
  });
  return runQuarantine(runId);
}

// ---- the index --------------------------------------------------------------

export interface RunFilter {
  pass?: string | null;
  day?: string | null;
  status?: string | null;
  origin?: string | null;
  /** true = only quarantined, false = only clean, null/undefined = both. */
  quarantined?: boolean | null;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 500;

function clampLimit(n: unknown, dflt: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(Math.max(Math.floor(v), 1), MAX_LIMIT);
}

export interface RunIndex {
  runs: RunRow[];
  /** Per-pass cost rollup over the SAME filter — one read, so the list and the dashboard agree. */
  costs: { pass: string; runs: number; cost_usd: number }[];
  total: number;
}

/**
 * The run index. Quarantined runs are LISTED by default and flagged — hiding
 * them would hide real spend from the cost dashboard, which is the one number
 * the pane must never soften. `quarantined` filters when the human asks.
 */
export function listRuns(f: RunFilter = {}): RunIndex {
  const db = getDb();
  ensureTracesSchema(db);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.pass) {
    where.push("r.pass = ?");
    args.push(f.pass);
  }
  if (f.status) {
    where.push("r.status = ?");
    args.push(f.status);
  }
  if (f.origin) {
    where.push("r.origin = ?");
    args.push(f.origin);
  }
  if (f.day) {
    where.push("substr(COALESCE(r.started_at, ''), 1, 10) = ?");
    args.push(f.day);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = clampLimit(f.limit, 100);
  const offset = Math.max(Number(f.offset ?? 0) || 0, 0);

  const rows = db
    .prepare(
      `SELECT r.id, r.kind, r.role, r.pass, r.origin, r.model, r.status,
              r.started_at, r.ended_at, r.cost_usd, r.input_tokens, r.cache_read,
              r.output_tokens, r.error_code,
              (SELECT COUNT(*) FROM traces t WHERE t.run_id = r.id) AS traces,
              (SELECT COUNT(*) FROM decisions d
                WHERE d.run_id = r.id AND d.target_kind <> '${RUN_TARGET_KIND}') AS decisions,
              (SELECT COUNT(*) FROM decisions d
                WHERE d.run_id = r.id AND d.target_kind <> '${RUN_TARGET_KIND}'
                  AND d.reversed_at IS NOT NULL) AS reversed
         FROM runs r ${clause}
        ORDER BY COALESCE(r.started_at, '') DESC, r.rowid DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as Record<string, unknown>[];

  let runs: RunRow[] = rows.map((r) => ({
    id: String(r.id),
    kind: (r.kind as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    pass: (r.pass as string | null) ?? null,
    origin: (r.origin as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    started_at: (r.started_at as string | null) ?? null,
    ended_at: (r.ended_at as string | null) ?? null,
    cost_usd: Number(r.cost_usd ?? 0),
    input_tokens: Number(r.input_tokens ?? 0),
    cache_read: Number(r.cache_read ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    error_code: (r.error_code as string | null) ?? null,
    traces: Number(r.traces ?? 0),
    decisions: Number(r.decisions ?? 0),
    reversed: Number(r.reversed ?? 0),
    quarantine: runQuarantine(String(r.id)),
  }));
  if (f.quarantined === true) runs = runs.filter((r) => r.quarantine?.quarantined === true);
  if (f.quarantined === false) runs = runs.filter((r) => r.quarantine?.quarantined !== true);

  const costs = db
    .prepare(
      `SELECT COALESCE(r.pass, '(none)') AS pass, COUNT(*) AS runs,
              COALESCE(SUM(r.cost_usd), 0) AS cost_usd
         FROM runs r ${clause} GROUP BY r.pass ORDER BY cost_usd DESC`,
    )
    .all(...args) as { pass: string; runs: number; cost_usd: number }[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM runs r ${clause}`).get(...args) as { n: number }).n;
  return { runs, costs, total };
}

// ---- one run ----------------------------------------------------------------

export interface RunDetail {
  run: RunRow;
  traces: RunTraceRow[];
  decisions: RunDecisionRow[];
  /** What an undo WOULD revert — read before the write (ops-routes owns the write). */
  undo: RunUndoPreview;
}

function tracesForRun(runId: string): RunTraceRow[] {
  const db = getDb();
  ensureTracesSchema(db);
  return db
    .prepare(
      `SELECT id, pass, caller, model, prompt_version, repair_count, cost_usd,
              latency_ms, status, day, created_at
         FROM traces WHERE run_id = ? ORDER BY created_at, id`,
    )
    .all(runId) as RunTraceRow[];
}

export function runDetail(runId: string): RunDetail | null {
  const db = getDb();
  ensureTracesSchema(db);
  const r = db
    .prepare(
      `SELECT r.id, r.kind, r.role, r.pass, r.origin, r.model, r.status,
              r.started_at, r.ended_at, r.cost_usd, r.input_tokens, r.cache_read,
              r.output_tokens, r.error_code,
              (SELECT COUNT(*) FROM traces t WHERE t.run_id = r.id) AS traces,
              (SELECT COUNT(*) FROM decisions d
                WHERE d.run_id = r.id AND d.target_kind <> '${RUN_TARGET_KIND}') AS decisions,
              (SELECT COUNT(*) FROM decisions d
                WHERE d.run_id = r.id AND d.target_kind <> '${RUN_TARGET_KIND}'
                  AND d.reversed_at IS NOT NULL) AS reversed
         FROM runs r WHERE r.id = ?`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  if (!r) return null;
  const run: RunRow = {
    id: String(r.id),
    kind: (r.kind as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    pass: (r.pass as string | null) ?? null,
    origin: (r.origin as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    started_at: (r.started_at as string | null) ?? null,
    ended_at: (r.ended_at as string | null) ?? null,
    cost_usd: Number(r.cost_usd ?? 0),
    input_tokens: Number(r.input_tokens ?? 0),
    cache_read: Number(r.cache_read ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    error_code: (r.error_code as string | null) ?? null,
    traces: Number(r.traces ?? 0),
    decisions: Number(r.decisions ?? 0),
    reversed: Number(r.reversed ?? 0),
    quarantine: runQuarantine(runId),
  };
  const decisions: RunDecisionRow[] = decisionsForRun(runId)
    .filter((d) => d.targetKind !== RUN_TARGET_KIND)
    .map((d) => ({
      id: d.id,
      pass: d.pass,
      target_kind: d.targetKind,
      target_id: d.targetId,
      action: d.action,
      reason: d.reason,
      created_at: d.createdAt,
      reversed_at: d.reversedAt,
    }));
  return { run, traces: tracesForRun(runId), decisions, undo: runUndoPreview(runId) };
}

// ---- diff -------------------------------------------------------------------

export interface RunDiffField {
  field: string;
  a: string | number | null;
  b: string | number | null;
  same: boolean;
}

export interface RunDiffTarget {
  target_kind: string;
  target_id: string;
  a_action: string | null;
  b_action: string | null;
}

export interface RunDiff {
  a: RunRow;
  b: RunRow;
  /** The header fields that explain a behaviour change, marked same / different. */
  fields: RunDiffField[];
  /** Prompt versions each run's traces actually ran, deduped in order. */
  prompt_versions: { a: string[]; b: string[] };
  decisions: {
    only_a: RunDiffTarget[];
    only_b: RunDiffTarget[];
    /** Same target, different action — the interesting set. */
    changed: RunDiffTarget[];
    /** Same target, same action. */
    same: number;
  };
}

function field(name: string, a: string | number | null, b: string | number | null): RunDiffField {
  return { field: name, a, b, same: a === b };
}

interface TargetAction {
  targetKind: string;
  targetId: string;
  action: string;
}

/** Latest action per target for a run — a run that touched one target twice diffs on its last word. */
function actionsByTarget(runId: string): Map<string, TargetAction> {
  const out = new Map<string, TargetAction>();
  for (const d of decisionsForRun(runId)) {
    if (d.targetKind === RUN_TARGET_KIND) continue;
    const key = `${d.targetKind} ${d.targetId}`;
    // decisionsForRun is newest first: the first row we see is the latest word.
    if (!out.has(key)) out.set(key, { targetKind: d.targetKind, targetId: d.targetId, action: d.action });
  }
  return out;
}

export function diffRuns(aId: string, bId: string): RunDiff | null {
  const a = runDetail(aId);
  const b = runDetail(bId);
  if (!a || !b) return null;
  const versions = (d: RunDetail): string[] => [...new Set(d.traces.map((t) => t.prompt_version).filter((v): v is string => !!v))];

  const fields: RunDiffField[] = [
    field("pass", a.run.pass, b.run.pass),
    field("kind", a.run.kind, b.run.kind),
    field("origin", a.run.origin, b.run.origin),
    field("model", a.run.model, b.run.model),
    field("prompt_version", versions(a).join(",") || null, versions(b).join(",") || null),
    field("status", a.run.status, b.run.status),
    field("error_code", a.run.error_code, b.run.error_code),
    field("traces", a.run.traces, b.run.traces),
    field("decisions", a.run.decisions, b.run.decisions),
    field("cost_usd", a.run.cost_usd, b.run.cost_usd),
    field("input_tokens", a.run.input_tokens, b.run.input_tokens),
    field("cache_read", a.run.cache_read, b.run.cache_read),
    field("output_tokens", a.run.output_tokens, b.run.output_tokens),
  ];

  const ma = actionsByTarget(aId);
  const mb = actionsByTarget(bId);
  const onlyA: RunDiffTarget[] = [];
  const onlyB: RunDiffTarget[] = [];
  const changed: RunDiffTarget[] = [];
  let same = 0;
  for (const [key, ta] of ma) {
    const tb = mb.get(key);
    if (!tb) {
      onlyA.push({ target_kind: ta.targetKind, target_id: ta.targetId, a_action: ta.action, b_action: null });
      continue;
    }
    if (ta.action === tb.action) same += 1;
    else changed.push({ target_kind: ta.targetKind, target_id: ta.targetId, a_action: ta.action, b_action: tb.action });
  }
  for (const [key, tb] of mb) {
    if (!ma.has(key)) onlyB.push({ target_kind: tb.targetKind, target_id: tb.targetId, a_action: null, b_action: tb.action });
  }
  return {
    a: a.run,
    b: b.run,
    fields,
    prompt_versions: { a: versions(a), b: versions(b) },
    decisions: { only_a: onlyA, only_b: onlyB, changed, same },
  };
}
