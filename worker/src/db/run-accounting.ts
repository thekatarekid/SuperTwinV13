// ===========================================================================
// [CODE] V2 token accounting over the `runs` table (arch §4.4.3 / §4.4.4).
//
// `extraction_runs` (db/runs.ts) is the phase-0 log and stays as it is. Everything V2
// bills, gates or renders reads THIS table, because it is the only one that
// carries the two facts the old log could not attribute a call by: `role` and
// `cohort_id`. A block labelled "Chat" that is really background extraction is
// a truthfulness defect, so attribution is mandatory at the write.
//
// Three invariants this section exists to hold:
//   1. total_input = cache_read + cache_create + input_tokens — computed, never
//      read off `input_tokens` alone (that field is post-breakpoint only).
//   2. billable = input + 1.25·create + 0.1·read + output, and the quota gate
//      sees nothing else.
//   3. cost_usd is the CLI's own number, stored verbatim. Cost and tokens are
//      aggregated by ONE query builder over ONE filter, so a real $0.69 can
//      never render as "—" because the two halves disagreed on the row set.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { getDb } from "./connection.js";
import { recordCallMark } from "./latency-marks.js";
import {
  billableTokens,
  cacheBelowMinimum,
  cacheMinimumTokens,
  estimateSpend,
  projectSpend,
  totalInputTokens,
  type SpendEstimate,
  type SpendProjection,
} from "../providers/usage.js";
import type { Usage } from "../providers/types.js";

/** Roles a run may be attributed to (§4.4.4.4). Unknown roles are rejected. */
export const RUN_ROLES = [
  "media",
  "entity",
  "episode",
  "arc",
  "extract",
  "triage",
  "done_detect",
  "classify",
  "adjudicate",
  "chat",
] as const;

export type RunRole = (typeof RUN_ROLES)[number];

const RUN_ROLE_SET: ReadonlySet<string> = new Set(RUN_ROLES);

export function isRunRole(v: unknown): v is RunRole {
  return typeof v === "string" && RUN_ROLE_SET.has(v);
}

export interface RecordRunParams {
  /** Optional caller-supplied id; a uuid is minted when absent. */
  id?: string;
  role: RunRole;
  model: string;
  cohortId: string;
  kind?: string | null;
  status?: string;
  startedAt?: string;
  endedAt?: string | null;
  /** The provider's four-way accounting plus the CLI's reported cost. */
  usage: Usage;
  errorCode?: string | null;
  errorMsg?: string | null;
  /**
   * Time to first streamed token, ms (item 4.2, arch §9.5.3 rule 4). null or
   * absent = the call never streamed one; a latency mark is still written so
   * `ttftCoverage` can count the gap instead of hiding it.
   */
  ttftMs?: number | null;
}

/**
 * Write one model call. Throws rather than writing an unattributable row: a run
 * with no role or no cohort cannot be aggregated honestly later, and a silent
 * NULL here is exactly how "Chat: $2.10" ends up being background extraction.
 */
export function recordRun(p: RecordRunParams): string {
  if (!isRunRole(p.role)) {
    throw new Error(
      `runs.role is required and must be one of ${RUN_ROLES.join("|")} — got ${String(p.role)}`,
    );
  }
  if (typeof p.cohortId !== "string" || p.cohortId.trim() === "") {
    throw new Error("runs.cohort_id is required — every run is attributed to a cohort");
  }
  if (typeof p.model !== "string" || p.model.trim() === "") {
    throw new Error("runs.model is required — accounting is per (role, model)");
  }
  const id = p.id ?? randomUUID();
  a().insertRun.run({
    id,
    kind: p.kind ?? null,
    role: p.role,
    model: p.model,
    cohortId: p.cohortId,
    startedAt: p.startedAt ?? new Date().toISOString(),
    endedAt: p.endedAt ?? null,
    status: p.status ?? "ok",
    inputTokens: p.usage.inputTokens,
    cacheCreate: p.usage.cacheCreationInputTokens,
    cacheRead: p.usage.cacheReadInputTokens,
    outputTokens: p.usage.outputTokens,
    // Derived once, here, so the gate and the UI can never disagree about it.
    billableTokens: billableTokens(p.usage),
    // Verbatim. Absent means the call reported none, which is 0 spend recorded,
    // never a locally recomputed price.
    costUsd: p.usage.costUsd ?? 0,
    errorCode: p.errorCode ?? null,
    errorMsg: p.errorMsg ?? null,
  });
  // Item 4.2: every run also writes its latency mark, in the same call so the
  // two tables keep the same cardinality. The mark's name is the CALL TYPE
  // (kind — P-CL1, P-EP1…) falling back to the role, per "per model per call
  // type": a per-model-only key would hide a P-CL1 regression behind P-TR1.
  const startedAtIso = p.startedAt ?? new Date().toISOString();
  const startedMs = Date.parse(startedAtIso);
  const endedMs = p.endedAt ? Date.parse(p.endedAt) : NaN;
  const totalMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs ? endedMs - startedMs : null;
  recordCallMark({
    name: p.kind ?? p.role,
    model: p.model,
    runId: id,
    ttftMs: typeof p.ttftMs === "number" && Number.isFinite(p.ttftMs) && p.ttftMs >= 0 ? p.ttftMs : null,
    totalMs,
    outputTokens: p.usage.outputTokens,
    createdAt: startedAtIso,
  });
  return id;
}

// ---- Filter → one WHERE clause, shared by every aggregate ------------------

export interface UsageFilter {
  /** ISO instant; keeps rows with started_at >= since. */
  since?: string;
  role?: RunRole;
  cohortId?: string;
  /** Restrict to the cohorts of one import mode (bootstrap = "this import"). */
  importMode?: string;
}

/**
 * The single source of the row set. Both `usageByRole` and `usageTotals` build
 * their WHERE here — that is the whole fix for the "$0.69 renders as —" bug.
 */
function whereFor(f: UsageFilter): { sql: string; params: unknown[] } {
  const parts: string[] = ["1=1"];
  const params: unknown[] = [];
  if (f.since) {
    parts.push("started_at >= ?");
    params.push(f.since);
  }
  if (f.role) {
    parts.push("role = ?");
    params.push(f.role);
  }
  if (f.cohortId) {
    parts.push("cohort_id = ?");
    params.push(f.cohortId);
  }
  if (f.importMode) {
    parts.push("cohort_id IN (SELECT id FROM cohorts WHERE mode = ?)");
    params.push(f.importMode);
  }
  return { sql: parts.join(" AND "), params };
}

/** The columns every aggregate selects — identical between grouped and total. */
const USAGE_COLS = `
  COALESCE(SUM(input_tokens), 0)    AS input_tokens,
  COALESCE(SUM(cache_create), 0)    AS cache_create,
  COALESCE(SUM(cache_read), 0)      AS cache_read,
  COALESCE(SUM(output_tokens), 0)   AS output_tokens,
  COALESCE(SUM(billable_tokens), 0) AS billable_tokens,
  COALESCE(SUM(cost_usd), 0)        AS cost_usd,
  COUNT(*)                          AS run_count`;

interface UsageAggRow {
  role?: string;
  model?: string;
  input_tokens: number;
  cache_create: number;
  cache_read: number;
  output_tokens: number;
  billable_tokens: number;
  cost_usd: number;
  run_count: number;
}

/** Tokens + cost for one row set. `totalInput` is always the computed sum. */
export interface UsageTotals {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** cacheRead + cacheCreation + input. Rendered next to its three parts. */
  totalInputTokens: number;
  outputTokens: number;
  billableTokens: number;
  /** The CLI's own figure, summed. Never recomputed from a price table. */
  costUsd: number;
  runCount: number;
}

export interface RoleUsageRow extends UsageTotals {
  role: string;
  model: string;
  /** Minimum cacheable prefix for this model, or null for an unknown family. */
  cacheMinimumTokens: number | null;
  /** True when 0 cache tokens is the documented outcome, not a broken cache. */
  cacheExpectedZero: boolean;
}

function toTotals(r: UsageAggRow): UsageTotals {
  const usage: Usage = {
    inputTokens: r.input_tokens,
    cacheCreationInputTokens: r.cache_create,
    cacheReadInputTokens: r.cache_read,
    outputTokens: r.output_tokens,
  };
  return {
    inputTokens: r.input_tokens,
    cacheCreationTokens: r.cache_create,
    cacheReadTokens: r.cache_read,
    totalInputTokens: totalInputTokens(usage),
    outputTokens: r.output_tokens,
    billableTokens: r.billable_tokens,
    costUsd: r.cost_usd,
    runCount: r.run_count,
  };
}

/** Per (role, model) tokens AND cost — one row per block the UI renders. */
export function usageByRole(f: UsageFilter = {}): RoleUsageRow[] {
  const w = whereFor(f);
  const rows = a()
    .db.prepare(
      `SELECT COALESCE(role, '') AS role, COALESCE(model, '') AS model, ${USAGE_COLS}
       FROM runs WHERE ${w.sql}
       GROUP BY role, model
       ORDER BY billable_tokens DESC, role ASC`,
    )
    .all(...w.params) as UsageAggRow[];
  return rows.map((r) => {
    const totals = toTotals(r);
    const model = r.model ?? "";
    return {
      ...totals,
      role: r.role ?? "",
      model,
      cacheMinimumTokens: cacheMinimumTokens(model),
      // Zero cache on a family with a high floor is the §4.4.3.1 case: the
      // prompt is under the minimum and cannot cache. Nothing is wrong.
      cacheExpectedZero:
        totals.cacheReadTokens === 0 &&
        totals.cacheCreationTokens === 0 &&
        cacheBelowMinimum(model, avgPromptTokens(totals)),
    };
  });
}

/** Mean total-input per run — what a per-call prompt size looks like. */
function avgPromptTokens(t: UsageTotals): number {
  return t.runCount > 0 ? t.totalInputTokens / t.runCount : 0;
}

/** The same rows as {@link usageByRole}, ungrouped. Same filter, same set. */
export function usageTotals(f: UsageFilter = {}): UsageTotals {
  const w = whereFor(f);
  const row = a()
    .db.prepare(`SELECT ${USAGE_COLS} FROM runs WHERE ${w.sql}`)
    .get(...w.params) as UsageAggRow;
  return toTotals(row);
}

/** Run outcomes over the same filter — "1,284 ok · 6 retried · 2 quarantined". */
export interface RunStatusCounts {
  ok: number;
  retried: number;
  quarantined: number;
  error: number;
  other: number;
  total: number;
}

export function runCounts(f: UsageFilter = {}): RunStatusCounts {
  const w = whereFor(f);
  const rows = a()
    .db.prepare(
      `SELECT COALESCE(status, '') AS status, COUNT(*) AS n
       FROM runs WHERE ${w.sql} GROUP BY status`,
    )
    .all(...w.params) as { status: string; n: number }[];
  const out: RunStatusCounts = {
    ok: 0,
    retried: 0,
    quarantined: 0,
    error: 0,
    other: 0,
    total: 0,
  };
  for (const r of rows) {
    out.total += r.n;
    if (r.status === "ok") out.ok += r.n;
    else if (r.status === "retried") out.retried += r.n;
    else if (r.status === "quarantined") out.quarantined += r.n;
    else if (r.status === "error") out.error += r.n;
    else out.other += r.n;
  }
  return out;
}

// ---- Cache reality ---------------------------------------------------------

export interface CacheReality {
  /** Measured share of total input served from cache; null when nothing ran. */
  hitRate: number | null;
  /** Models whose 0 cache is expected because the prompt is under the floor. */
  belowMinimumModels: string[];
  /** The floor those models are under (4,096 for haiku). */
  minimumTokens: number | null;
}

export function cacheReality(f: UsageFilter = {}): CacheReality {
  const totals = usageTotals(f);
  const below = usageByRole(f).filter((r) => r.cacheExpectedZero);
  const models = [...new Set(below.map((r) => r.model))].sort();
  return {
    hitRate:
      totals.totalInputTokens > 0
        ? totals.cacheReadTokens / totals.totalInputTokens
        : null,
    belowMinimumModels: models,
    minimumTokens: models.length > 0 ? cacheMinimumTokens(models[0]) : null,
  };
}

// ---- This import: spend to date and a projection ---------------------------

export interface ImportProgress {
  mode: string;
  cohorts: number;
  cohortsDone: number;
  events: number;
  eventsDone: number;
  spend: SpendProjection;
  runCount: number;
}

/**
 * Live progress of the running import: how far it is and what it has cost so
 * far, extrapolated to a total. The spend half is the same one-filter read as
 * the rest of this module, scoped to the import's cohorts.
 */
export function importProgress(mode = "bootstrap"): ImportProgress {
  const c = a()
    .db.prepare(
      `SELECT COUNT(*) AS cohorts,
              COALESCE(SUM(event_count), 0) AS events,
              COALESCE(SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END), 0) AS cohorts_done,
              COALESCE(SUM(CASE WHEN state = 'done' THEN event_count ELSE 0 END), 0) AS events_done
       FROM cohorts WHERE mode = ?`,
    )
    .get(mode) as {
    cohorts: number;
    events: number;
    cohorts_done: number;
    events_done: number;
  };
  const totals = usageTotals({ importMode: mode });
  return {
    mode,
    cohorts: c.cohorts,
    cohortsDone: c.cohorts_done,
    events: c.events,
    eventsDone: c.events_done,
    spend: projectSpend({
      spentUsd: totals.costUsd,
      unitsDone: c.events_done,
      unitsTotal: c.events,
    }),
    runCount: totals.runCount,
  };
}

/**
 * Pre-flight estimate for a bootstrap of `eventCount` events, from what
 * already-completed cohorts measured. Cost per event comes from CLI-reported
 * dollars divided by events, so it is still never a local price table.
 */
export function estimateImportSpend(eventCount: number): SpendEstimate {
  const prior = a()
    .db.prepare(
      `SELECT COALESCE(SUM(event_count), 0) AS events
       FROM cohorts WHERE state = 'done'`,
    )
    .get() as { events: number };
  const spent = a()
    .db.prepare(
      `SELECT COALESCE(SUM(billable_tokens), 0) AS billable,
              COALESCE(SUM(cost_usd), 0)        AS cost
       FROM runs
       WHERE cohort_id IN (SELECT id FROM cohorts WHERE state = 'done')`,
    )
    .get() as { billable: number; cost: number };
  return estimateSpend({
    eventCount,
    priorEvents: prior.events,
    priorBillableTokens: spent.billable,
    priorCostUsd: spent.cost,
  });
}

// ---- The whole Settings → Usage payload, from one filter -------------------

export interface UsageSummary {
  since: string | null;
  importMode: string | null;
  byRole: RoleUsageRow[];
  totals: UsageTotals;
  cache: CacheReality;
  runs: RunStatusCounts;
  thisImport: ImportProgress;
}

/**
 * Everything Settings → Usage renders, built over ONE filter so the cost line
 * and the token table can never describe different row sets (§4.4.4.3).
 */
export function usageSummary(f: UsageFilter = {}): UsageSummary {
  return {
    since: f.since ?? null,
    importMode: f.importMode ?? null,
    byRole: usageByRole(f),
    totals: usageTotals(f),
    cache: cacheReality(f),
    runs: runCounts(f),
    thisImport: importProgress(),
  };
}

// ---- Prepared statements for the accounting writes -------------------------

interface AcctStmts {
  db: Database.Database;
  insertRun: Database.Statement;
}

let acct: AcctStmts | null = null;

function a(): AcctStmts {
  const db = getDb();
  if (acct && acct.db === db) return acct;
  acct = {
    db,
    insertRun: db.prepare(`
      INSERT INTO runs
        (id, kind, role, model, cohort_id, started_at, ended_at, status,
         input_tokens, cache_create, cache_read, output_tokens,
         billable_tokens, cost_usd, error_code, error_msg)
      VALUES
        (@id, @kind, @role, @model, @cohortId, @startedAt, @endedAt, @status,
         @inputTokens, @cacheCreate, @cacheRead, @outputTokens,
         @billableTokens, @costUsd, @errorCode, @errorMsg)
    `),
  };
  return acct;
}
