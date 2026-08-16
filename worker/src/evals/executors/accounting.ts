// ===========================================================================
// [CODE] Category U executor — the real V2 token accounting (db/run-accounting).
//
// Category U is `[CODE]`, so `frozen_response` is not a model verdict: it is a
// frozen SCENARIO, one record per line, in the same spirit as the harness
// format. Every line drives production code — `recordRun`, `usageByRole`,
// `usageTotals`, `cacheReality`, `billableTokens`, `estimateImportSpend` — over
// a throwaway SQLite file that is migrated from scratch per case. Nothing about
// the four-way identity or the billable weighting is re-implemented here; if
// the product drifts, these cases go red.
//
//   cohort|id=c1|events=1200|mode=bootstrap|state=running
//   run|role=extract|model=claude-haiku-4|cohort=c1|input=1000|create=200|read=500|output=300|cost=0.012
//   run|...|status=error            a run that did not succeed
//   badrun|role=|cohort=c1|...      a run the writer MUST refuse
//   estimate|events=5000            pre-flight projection
//   progress|mode=bootstrap         spend-to-date + projection
//
// Every scenario ends by reading the aggregates back over ONE filter, which is
// the whole point of §4.4.4.3: the cost line and the token table can never
// describe different row sets.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import {
  cacheReality,
  estimateImportSpend,
  importProgress,
  isRunRole,
  recordRun,
  runCounts,
  usageByRole,
  usageSummary,
  usageTotals,
  type RunRole,
} from "../../db/runs.js";
import { ResourcePool } from "../../providers/pool.js";
import { billableTokens, totalInputTokens } from "../../providers/usage.js";
import type { Executor, Produced } from "../runner.js";

interface ScenarioLine {
  tag: string;
  fields: Record<string, string>;
}

/** `run|role=extract|input=1000` → `{tag:"run", fields:{role:"extract", …}}`. */
export function parseScenario(text: string): ScenarioLine[] {
  const out: ScenarioLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`accounting scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, fields });
  }
  return out;
}

function num(fields: Record<string, string>, key: string, fallback = 0): number {
  const raw = fields[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`accounting scenario: ${key}=${raw} is not a number`);
  return n;
}

function usageOf(fields: Record<string, string>) {
  return {
    inputTokens: num(fields, "input"),
    cacheCreationInputTokens: num(fields, "create"),
    cacheReadInputTokens: num(fields, "read"),
    outputTokens: num(fields, "output"),
    costUsd: fields.cost === undefined ? undefined : num(fields, "cost"),
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Run the batch through the REAL pool and report the interleaving. With
 * warm_first on, task 0 must have returned before any other task starts; with
 * it off the fan-out is simultaneous and every call is a cache miss that also
 * pays the write premium.
 */
async function measureFanout(tasks: number, warmFirst: boolean): Promise<Record<string, unknown>> {
  // firstPaint gives the understanding lane the whole ceiling, so the only
  // thing pacing this batch is warm_first itself.
  const pool = new ResourcePool({ warmFirst, firstPaint: true, limits: { llm: tasks } });
  let started = 0;
  let firstDone = false;
  let startedBeforeWarmReturned = 0;
  const order: number[] = [];
  await pool.runBatch(
    "llm",
    Array.from({ length: tasks }, (_, i) => async () => {
      started += 1;
      if (i !== 0 && !firstDone) startedBeforeWarmReturned += 1;
      order.push(i);
      await Promise.resolve();
      if (i === 0) firstDone = true;
      return i;
    }),
  );
  return {
    tasks,
    warm_first: warmFirst,
    started,
    // The gate: with warm_first on this must be 0 — nothing fans out until the
    // warming call has returned and its prefix is cacheable. The boolean is
    // what the warm_first=off case asserts, because HOW MANY calls get away
    // before the warm one returns is a scheduling detail, not a contract.
    started_before_warm_returned: startedBeforeWarmReturned,
    fanned_out_before_warm: startedBeforeWarmReturned > 0,
    warm_call_first: order[0] === 0,
  };
}

export const accountingExecutor: Executor = async ({ response }) => {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-acct-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return await runScenario(response);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

async function runScenario(response: string): Promise<Produced> {
  runMigrations();
  const db = getDb();

  const output: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  const metrics: Record<string, number> = {};
  /** Writes the schema refused. A refusal is the assertion, not a failure. */
  const refused: string[] = [];
  let pendingFanout: { tasks: number; warmFirst: boolean } | null = null;

  for (const { tag, fields } of parseScenario(response)) {
    switch (tag) {
      case "cohort": {
        db.prepare(
          `INSERT INTO cohorts (id, mode, horizon, event_count, state)
           VALUES (?, ?, 'live', ?, ?)`,
        ).run(
          fields.id,
          fields.mode ?? "bootstrap",
          num(fields, "events"),
          fields.state ?? "planned",
        );
        break;
      }
      case "run": {
        recordRun({
          role: fields.role as RunRole,
          model: fields.model ?? "claude-haiku-4",
          cohortId: fields.cohort ?? "c1",
          kind: fields.kind ?? null,
          status: fields.status ?? "ok",
          startedAt: fields.at ?? "2026-08-01T10:00:00.000Z",
          endedAt: fields.at ?? "2026-08-01T10:00:01.000Z",
          usage: usageOf(fields),
        });
        break;
      }
      case "badrun": {
        // §4.4.4.4: a run with no role or no cohort cannot be aggregated
        // honestly, so the writer throws instead of writing a NULL.
        try {
          recordRun({
            role: fields.role as RunRole,
            model: fields.model ?? "claude-haiku-4",
            cohortId: fields.cohort ?? "",
            usage: usageOf(fields),
          });
          refused.push("");
        } catch (err) {
          refused.push((err as Error).message);
        }
        break;
      }
      case "estimate": {
        // §4.4.4.6 — projected from MEASURED tokens/event, or it says "none".
        const estimate = estimateImportSpend(num(fields, "events"));
        state.estimate = {
          events: estimate.eventCount,
          basis: estimate.basis,
          tokens_per_event: Math.round(estimate.tokensPerEvent),
          projected_usd: round6(estimate.projectedUsd),
        };
        break;
      }
      case "progress": {
        const progress = importProgress(fields.mode ?? "bootstrap");
        state.progress = {
          events: progress.events,
          events_done: progress.eventsDone,
          spent_usd: round6(progress.spend.spentUsd),
          fraction_complete: round6(progress.spend.fractionComplete),
          projected_total_usd:
            progress.spend.projectedTotalUsd === null ? null : round6(progress.spend.projectedTotalUsd),
        };
        break;
      }
      case "fanout": {
        // §4.4.3.1 warm-then-fan-out, driven through the real ResourcePool.
        pendingFanout = {
          tasks: Math.max(1, Math.floor(num(fields, "tasks", 8))),
          warmFirst: (fields.warm_first ?? "on") !== "off",
        };
        break;
      }
      default:
        throw new Error(`accounting scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  if (pendingFanout) {
    // Flat keys, so a case may assert on the one property it is about rather
    // than having to restate the whole reading.
    const reading = await measureFanout(pendingFanout.tasks, pendingFanout.warmFirst);
    for (const [key, value] of Object.entries(reading)) state[`fanout_${key}`] = value;
  }

  // ---- read the aggregates back, over ONE filter ---------------------------
  const totals = usageTotals();
  const byRole = usageByRole();
  const summary = usageSummary();
  const cache = cacheReality();
  const counts = runCounts();

  output.roles = byRole.map((r) => ({
    role: r.role,
    model: r.model,
    input_tokens: r.inputTokens,
    cache_creation_tokens: r.cacheCreationTokens,
    cache_read_tokens: r.cacheReadTokens,
    total_input_tokens: r.totalInputTokens,
    output_tokens: r.outputTokens,
    billable_tokens: r.billableTokens,
    cost_usd: r.costUsd,
    run_count: r.runCount,
    cache_expected_zero: r.cacheExpectedZero,
    cache_minimum_tokens: r.cacheMinimumTokens,
  }));

  // THE identity (§4.4.4.1): total_input == read + create + input, on every row
  // AND on the total. Checked here rather than asserted per-fixture so a case
  // that forgets to look still cannot pass while it is broken.
  const identityHolds =
    totals.totalInputTokens === totals.cacheReadTokens + totals.cacheCreationTokens + totals.inputTokens &&
    byRole.every(
      (r) => r.totalInputTokens === r.cacheReadTokens + r.cacheCreationTokens + r.inputTokens,
    );

  state.identity_holds = identityHolds;
  state.total_input_tokens = totals.totalInputTokens;
  state.input_tokens = totals.inputTokens;
  state.cache_read_tokens = totals.cacheReadTokens;
  state.cache_creation_tokens = totals.cacheCreationTokens;
  state.output_tokens = totals.outputTokens;
  state.billable_tokens = totals.billableTokens;
  state.cost_usd = totals.costUsd;
  state.run_count = totals.runCount;

  // `input_tokens` is the POST-breakpoint remainder, never the total input. If
  // a surface rendered it as the total it would under-report a cached call by
  // exactly the cached share — the bug this row exists for.
  state.input_is_not_total =
    totals.runCount === 0 ? false : totals.inputTokens !== totals.totalInputTokens;

  // The same tokens must never be presented twice: `input` and `cache_read` are
  // disjoint PARTS of `total_input`, not two spends to add up.
  state.parts_are_disjoint =
    totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens === totals.totalInputTokens;

  // §4.4.4.3 — cost and tokens come off the same row set. A cost that renders
  // when tokens do (and vice versa) is the "$0.69 renders as —" regression.
  const grouped = byRole.reduce(
    (acc, r) => ({ cost: acc.cost + r.costUsd, billable: acc.billable + r.billableTokens, runs: acc.runs + r.runCount }),
    { cost: 0, billable: 0, runs: 0 },
  );
  state.same_filter =
    Math.abs(grouped.cost - totals.costUsd) < 1e-9 &&
    grouped.billable === totals.billableTokens &&
    grouped.runs === totals.runCount &&
    Math.abs(summary.totals.costUsd - totals.costUsd) < 1e-9;

  // Attribution is mandatory: every row that made it in carries both.
  const unattributed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE role IS NULL OR TRIM(role) = '' OR cohort_id IS NULL OR TRIM(cohort_id) = ''`,
    )
    .get() as { n: number };
  state.unattributed_runs = unattributed.n;
  state.writes_refused = refused.length;
  state.refusal_reasons = refused.map((r) => (r === "" ? "ACCEPTED" : r.split(" —")[0].split(" is required")[0]));

  // Quota is gated on billable tokens, never a raw sum (§4.4.4.5).
  const rawSum =
    totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens + totals.outputTokens;
  state.raw_token_sum = rawSum;
  state.billable_matches_weights =
    totals.billableTokens ===
    byRole.reduce(
      (sum, r) =>
        sum +
        billableTokens({
          inputTokens: r.inputTokens,
          cacheCreationInputTokens: r.cacheCreationTokens,
          cacheReadInputTokens: r.cacheReadTokens,
          outputTokens: r.outputTokens,
        }),
      0,
    );
  state.billable_differs_from_raw = totals.runCount > 0 && totals.billableTokens !== rawSum;

  // Cache reality is MEASURED, never assumed.
  state.cache_hit_rate_measured = cache.hitRate !== null;
  state.cache_hit_rate = cache.hitRate === null ? null : Math.round(cache.hitRate * 1000) / 1000;
  state.cache_below_minimum_models = cache.belowMinimumModels;
  state.cache_minimum_tokens = cache.minimumTokens;
  state.cache_expected_zero_roles = byRole.filter((r) => r.cacheExpectedZero).map((r) => r.role);

  // Completeness: every run carries 4-way tokens + cost + model + role.
  const incomplete = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE input_tokens IS NULL OR cache_create IS NULL OR cache_read IS NULL
          OR output_tokens IS NULL OR cost_usd IS NULL
          OR model IS NULL OR TRIM(model) = '' OR role IS NULL OR TRIM(role) = ''`,
    )
    .get() as { n: number };
  state.incomplete_runs = incomplete.n;
  state.status_counts = { ok: counts.ok, error: counts.error, total: counts.total };
  state.roles_valid = byRole.every((r) => isRunRole(r.role));

  metrics.runs = totals.runCount;
  metrics.total_input_tokens = totals.totalInputTokens;
  metrics.billable_tokens = totals.billableTokens;
  metrics.cost_usd = totals.costUsd;
  metrics.identity_total_input = totalInputTokens({
    inputTokens: totals.inputTokens,
    cacheCreationInputTokens: totals.cacheCreationTokens,
    cacheReadInputTokens: totals.cacheReadTokens,
    outputTokens: totals.outputTokens,
  });

  return { output, state, metrics };
}
