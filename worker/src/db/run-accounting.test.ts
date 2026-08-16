// ===========================================================================
// [CODE] V2 token accounting (arch §4.4.4, evals U). Every assertion here maps
// to a bug the prior build actually shipped:
//
//   - `input_tokens` rendered as the total input (a 59,700-token call read 17);
//   - "Input 21,849 · Cache 21,846" — the same tokens presented twice;
//   - cost summed from one table with a different WHERE than the tokens, so a
//     real $0.69 rendered as "—";
//   - runs with no role, making a "Chat" block that was really extraction.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "./connection.js";
import { logRun, runMigrations } from "./index.js";
import { latencySnapshot } from "./latency-marks.js";
import { RUNS_BACKFILL } from "./migrations/0026_runs_backfill.js";
import {
  cacheReality,
  DEFAULT_MODEL_LABEL,
  estimateImportSpend,
  importProgress,
  isRunRole,
  recordRun,
  runCounts,
  usageByRole,
  usageSummary,
  usageTotals,
  type RunRole,
} from "./runs.js";
import { billableTokens } from "../providers/usage.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-acct-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function cohort(id: string, opts: { events?: number; state?: string; mode?: string } = {}): string {
  getDb()
    .prepare(
      `INSERT INTO cohorts (id, mode, horizon, event_count, state)
       VALUES (?, ?, 'live', ?, ?)`,
    )
    .run(id, opts.mode ?? "bootstrap", opts.events ?? 0, opts.state ?? "planned");
  return id;
}

interface Seed {
  role: RunRole;
  model: string;
  cohortId: string;
  input?: number;
  create?: number;
  read?: number;
  output?: number;
  costUsd?: number;
  status?: string;
  startedAt?: string;
}

function seed(s: Seed): string {
  return recordRun({
    role: s.role,
    model: s.model,
    cohortId: s.cohortId,
    status: s.status,
    startedAt: s.startedAt,
    usage: {
      inputTokens: s.input ?? 0,
      cacheCreationInputTokens: s.create ?? 0,
      cacheReadInputTokens: s.read ?? 0,
      outputTokens: s.output ?? 0,
      costUsd: s.costUsd,
    },
  });
}

// ---------------------------------------------------------------------------
// U-005 / U-015 — attribution is mandatory at the write.
// ---------------------------------------------------------------------------

describe("recordRun attribution", () => {
  it("refuses a run with no role — an unattributable row cannot be billed honestly", () => {
    cohort("c1");
    expect(() =>
      // @ts-expect-error deliberately omitting the role the type demands
      recordRun({ model: "claude-haiku-4.5", cohortId: "c1", usage: { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 } }),
    ).toThrow(/role is required/);
  });

  it("refuses an unknown role rather than inventing a block for it", () => {
    cohort("c1");
    expect(() =>
      seed({ role: "gossip" as RunRole, model: "m", cohortId: "c1" }),
    ).toThrow(/role is required/);
  });

  it("refuses a BLANK cohort_id — an empty id is a dropped value", () => {
    expect(() => seed({ role: "extract", model: "m", cohortId: "" })).toThrow(
      /cohort_id/,
    );
  });

  it("accepts an EXPLICIT null cohort — chat and media belong to no cohort", () => {
    const id = recordRun({
      role: "chat",
      model: "claude-haiku-4.5",
      cohortId: null,
      usage: { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 },
    });
    const row = getDb().prepare(`SELECT cohort_id FROM runs WHERE id = ?`).get(id) as {
      cohort_id: string | null;
    };
    expect(row.cohort_id).toBeNull();
    // Out of every cohort-scoped read, still in the unfiltered totals — which
    // is the whole point: that is where the money is.
    expect(usageTotals({ importMode: "bootstrap" }).runCount).toBe(0);
    expect(usageTotals().runCount).toBe(1);
  });

  it("refuses a run with no model — accounting is per (role, model)", () => {
    cohort("c1");
    expect(() => seed({ role: "extract", model: "", cohortId: "c1" })).toThrow(
      /model is required/,
    );
  });

  it("isRunRole accepts every documented role and nothing else", () => {
    expect(isRunRole("done_detect")).toBe(true);
    expect(isRunRole("adjudicate")).toBe(true);
    expect(isRunRole("Chat")).toBe(false);
    expect(isRunRole(undefined)).toBe(false);
  });

  it("U-015: a recorded run carries 4-way tokens, cost, model and role", () => {
    cohort("c1");
    seed({
      role: "extract",
      model: "claude-sonnet-5",
      cohortId: "c1",
      input: 18,
      create: 10_651,
      read: 48_000,
      output: 206,
      costUsd: 0.02715,
    });
    const row = getDb().prepare(`SELECT * FROM runs`).get() as Record<string, unknown>;
    expect(row.role).toBe("extract");
    expect(row.model).toBe("claude-sonnet-5");
    expect(row.cohort_id).toBe("c1");
    expect(row.input_tokens).toBe(18);
    expect(row.cache_create).toBe(10_651);
    expect(row.cache_read).toBe(48_000);
    expect(row.output_tokens).toBe(206);
    expect(row.cost_usd).toBe(0.02715);
    expect(row.started_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// U-001 / U-002 / U-006 / U-007 — the arithmetic.
// ---------------------------------------------------------------------------

describe("the four-way identity", () => {
  beforeEach(() => {
    cohort("c1");
    seed({ role: "extract", model: "claude-sonnet-5", cohortId: "c1", input: 18, create: 10_651, read: 48_000, output: 206, costUsd: 0.02715 });
    seed({ role: "media", model: "claude-haiku-4.5", cohortId: "c1", input: 1200, output: 300, costUsd: 0.004 });
    seed({ role: "triage", model: "claude-haiku-4.5", cohortId: "c1", input: 900, output: 40, costUsd: 0.001 });
  });

  it("U-001: total_input == cache_read + cache_creation + input on every row", () => {
    const rows = usageByRole();
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.totalInputTokens).toBe(
        r.cacheReadTokens + r.cacheCreationTokens + r.inputTokens,
      );
    }
    const t = usageTotals();
    expect(t.totalInputTokens).toBe(
      t.cacheReadTokens + t.cacheCreationTokens + t.inputTokens,
    );
  });

  it("U-002: total input is never the raw input_tokens field", () => {
    const extract = usageByRole().find((r) => r.role === "extract")!;
    // The bug: 18 displayed as the input of a 58,669-token call.
    expect(extract.inputTokens).toBe(18);
    expect(extract.totalInputTokens).toBe(58_669);
  });

  it("U-006: billable is the weighted sum, never the raw one", () => {
    const extract = usageByRole().find((r) => r.role === "extract")!;
    const expected = billableTokens({
      inputTokens: 18,
      cacheCreationInputTokens: 10_651,
      cacheReadInputTokens: 48_000,
      outputTokens: 206,
    });
    expect(extract.billableTokens).toBe(expected);
    expect(expected).toBe(26_326);
    // A raw sum would trip the quota window several times early.
    expect(extract.billableTokens).toBeLessThan(
      (extract.totalInputTokens + extract.outputTokens) / 2,
    );
  });

  it("U-007: cost is the CLI's number, stored and summed verbatim", () => {
    const extract = usageByRole().find((r) => r.role === "extract")!;
    expect(extract.costUsd).toBeCloseTo(0.02715, 10);
    expect(usageTotals().costUsd).toBeCloseTo(0.02715 + 0.004 + 0.001, 10);
  });
});

// ---------------------------------------------------------------------------
// U-004 / U-008 — one filter, one row set.
// ---------------------------------------------------------------------------

describe("cost and tokens aggregate over the same rows", () => {
  beforeEach(() => {
    cohort("c1");
    cohort("c2", { mode: "steady" });
    seed({ role: "extract", model: "s5", cohortId: "c1", input: 100, read: 900, output: 50, costUsd: 0.5 });
    seed({ role: "chat", model: "s5", cohortId: "c2", input: 200, output: 60, costUsd: 0.19 });
  });

  it("U-004: the per-role rows sum exactly to the totals — tokens AND cost", () => {
    const rows = usageByRole();
    const t = usageTotals();
    const sum = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((n, r) => n + f(r), 0);
    expect(sum((r) => r.inputTokens)).toBe(t.inputTokens);
    expect(sum((r) => r.cacheReadTokens)).toBe(t.cacheReadTokens);
    expect(sum((r) => r.cacheCreationTokens)).toBe(t.cacheCreationTokens);
    expect(sum((r) => r.totalInputTokens)).toBe(t.totalInputTokens);
    expect(sum((r) => r.outputTokens)).toBe(t.outputTokens);
    expect(sum((r) => r.billableTokens)).toBe(t.billableTokens);
    expect(sum((r) => r.costUsd)).toBeCloseTo(t.costUsd, 10);
    expect(sum((r) => r.runCount)).toBe(t.runCount);
  });

  it("U-004: cost never dashes while spend exists — $0.69 stays $0.69", () => {
    expect(usageTotals().costUsd).toBeCloseTo(0.69, 10);
    expect(usageTotals().runCount).toBe(2);
  });

  it("U-008: a role filter narrows tokens and cost together", () => {
    const chat = usageTotals({ role: "chat" });
    expect(chat.runCount).toBe(1);
    expect(chat.totalInputTokens).toBe(200);
    expect(chat.costUsd).toBeCloseTo(0.19, 10);
    // The 'chat' block contains chat only — background extraction is its own.
    expect(usageByRole({ role: "chat" }).map((r) => r.role)).toEqual(["chat"]);
  });

  it("a cohort filter narrows tokens and cost together", () => {
    const c1 = usageTotals({ cohortId: "c1" });
    expect(c1.runCount).toBe(1);
    expect(c1.costUsd).toBeCloseTo(0.5, 10);
    expect(usageByRole({ cohortId: "c1" }).reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(
      c1.costUsd,
      10,
    );
  });

  it("a time filter narrows tokens and cost together", () => {
    seed({ role: "arc", model: "s5", cohortId: "c1", input: 5, output: 5, costUsd: 1, startedAt: "2000-01-01T00:00:00.000Z" });
    const recent = usageTotals({ since: "2020-01-01T00:00:00.000Z" });
    expect(recent.runCount).toBe(2);
    expect(recent.costUsd).toBeCloseTo(0.69, 10);
    const rows = usageByRole({ since: "2020-01-01T00:00:00.000Z" });
    expect(rows.reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(recent.costUsd, 10);
    expect(rows.reduce((n, r) => n + r.runCount, 0)).toBe(recent.runCount);
  });

  it("an empty window totals to zero rather than to nothing at all", () => {
    const t = usageTotals({ since: "2099-01-01T00:00:00.000Z" });
    expect(t.runCount).toBe(0);
    expect(t.totalInputTokens).toBe(0);
    expect(t.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U-011 / U-012 — caching is measured, and its absence is documented.
// ---------------------------------------------------------------------------

describe("cache reality", () => {
  it("U-012: the hit rate is measured off the rows, not assumed", () => {
    cohort("c1");
    seed({ role: "extract", model: "claude-sonnet-5", cohortId: "c1", input: 100, create: 100, read: 800, output: 10 });
    expect(cacheReality().hitRate).toBeCloseTo(0.8, 10);
  });

  it("an unmeasured window reports null, which is not a 0% hit rate", () => {
    expect(cacheReality().hitRate).toBeNull();
  });

  it("U-011: a 1.2k-token haiku prompt with both cache fields 0 is expected, not a defect", () => {
    cohort("c1");
    seed({ role: "media", model: "claude-haiku-4.5", cohortId: "c1", input: 1200, output: 90 });
    const row = usageByRole()[0];
    expect(row.cacheReadTokens).toBe(0);
    expect(row.cacheCreationTokens).toBe(0);
    expect(row.cacheMinimumTokens).toBe(4096);
    expect(row.cacheExpectedZero).toBe(true);
    const c = cacheReality();
    expect(c.belowMinimumModels).toEqual(["claude-haiku-4.5"]);
    expect(c.minimumTokens).toBe(4096);
  });

  it("a sonnet prompt over its 1,024 floor that did not cache is NOT excused", () => {
    cohort("c1");
    seed({ role: "extract", model: "claude-sonnet-5", cohortId: "c1", input: 8000, output: 90 });
    expect(usageByRole()[0].cacheExpectedZero).toBe(false);
    expect(cacheReality().belowMinimumModels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U-009 / U-010 — estimate before spending, project during it.
// ---------------------------------------------------------------------------

describe("import spend", () => {
  it("U-010: spend-to-date and a projection during a bootstrap", () => {
    cohort("c1", { events: 1000, state: "done" });
    cohort("c2", { events: 3000, state: "understanding" });
    seed({ role: "extract", model: "s5", cohortId: "c1", input: 10, output: 10, costUsd: 1.0 });
    seed({ role: "extract", model: "s5", cohortId: "c2", input: 10, output: 10, costUsd: 1.21 });
    const p = importProgress();
    expect(p.events).toBe(4000);
    expect(p.eventsDone).toBe(1000);
    expect(p.spend.fractionComplete).toBeCloseTo(0.25, 10);
    expect(p.spend.spentUsd).toBeCloseTo(2.21, 10);
    // 2.21 spent for a quarter of the events → ~8.84 total, ~6.63 to go.
    expect(p.spend.projectedTotalUsd!).toBeCloseTo(8.84, 10);
    expect(p.spend.remainingUsd!).toBeCloseTo(6.63, 10);
  });

  it("projects nothing while nothing is done, rather than dividing by zero", () => {
    cohort("c1", { events: 500 });
    seed({ role: "extract", model: "s5", cohortId: "c1", input: 10, output: 10, costUsd: 0.2 });
    const p = importProgress();
    expect(p.spend.spentUsd).toBeCloseTo(0.2, 10);
    expect(p.spend.projectedTotalUsd).toBeNull();
    expect(p.spend.remainingUsd).toBeNull();
  });

  it("counts only the cohorts of the import it names", () => {
    cohort("c1", { events: 100, mode: "bootstrap" });
    cohort("c2", { events: 900, mode: "steady" });
    seed({ role: "extract", model: "s5", cohortId: "c2", input: 10, output: 10, costUsd: 5 });
    const p = importProgress();
    expect(p.events).toBe(100);
    expect(p.spend.spentUsd).toBe(0);
  });

  it("U-009: estimates a bootstrap from measured tokens-per-event", () => {
    cohort("done1", { events: 1000, state: "done" });
    seed({ role: "extract", model: "s5", cohortId: "done1", input: 4000, output: 1000, costUsd: 2 });
    const e = estimateImportSpend(3000);
    expect(e.basis).toBe("measured");
    expect(e.tokensPerEvent).toBeCloseTo(5, 10); // 5,000 billable / 1,000 events
    expect(e.usdPerEvent).toBeCloseTo(0.002, 10);
    expect(e.projectedUsd).toBeCloseTo(6, 10);
  });

  it("says it has no basis rather than guessing one", () => {
    const e = estimateImportSpend(3000);
    expect(e.basis).toBe("none");
    expect(e.projectedUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Run counts + the assembled payload.
// ---------------------------------------------------------------------------

describe("runCounts and usageSummary", () => {
  it("buckets outcomes over the same filter as the tokens", () => {
    cohort("c1");
    seed({ role: "extract", model: "s5", cohortId: "c1", status: "ok" });
    seed({ role: "extract", model: "s5", cohortId: "c1", status: "ok" });
    seed({ role: "extract", model: "s5", cohortId: "c1", status: "retried" });
    seed({ role: "media", model: "h", cohortId: "c1", status: "quarantined" });
    const c = runCounts();
    expect(c).toEqual({ ok: 2, retried: 1, quarantined: 1, error: 0, other: 0, total: 4 });
    expect(runCounts({ role: "media" }).quarantined).toBe(1);
  });

  it("usageSummary builds table, totals, cache and runs from one filter", () => {
    cohort("c1", { events: 10 });
    seed({ role: "extract", model: "claude-sonnet-5", cohortId: "c1", input: 50, create: 100, read: 850, output: 20, costUsd: 0.4 });
    seed({ role: "chat", model: "claude-sonnet-5", cohortId: "c1", input: 10, output: 5, costUsd: 0.29 });
    const u = usageSummary({});
    expect(u.byRole.reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(u.totals.costUsd, 10);
    expect(u.totals.costUsd).toBeCloseTo(0.69, 10);
    expect(u.totals.totalInputTokens).toBe(1010);
    expect(u.cache.hitRate).toBeCloseTo(850 / 1010, 10);
    expect(u.runs.total).toBe(2);
    expect(u.thisImport.events).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Cost <-> tokens. The one assertion that catches a wrong weight or a dropped
// field: if the dollars the CLI reported and the tokens we stored stop
// agreeing, one of the two halves is wrong, and it is never the dollars.
//
// This is what would have caught the 1.25 cache-write weight. That weight is
// the 5-MINUTE cache TTL; this build's CLI writes 1-HOUR entries (2.0x), and
// the gap read as a 31.5% under-count of billable tokens with nobody noticing,
// because nothing ever compared the token side against the cost side.
// ---------------------------------------------------------------------------

/**
 * The 23 real media runs from an installed build, verbatim:
 * [input, cache_write, cache_read, output, cost_usd the CLI reported].
 * claude-haiku-4-5, $1.36 of genuine spend.
 */
const MEASURED_RUNS: [number, number, number, number, number][] = [
  [20, 21055, 43863, 2936, 0.0626903],
  [20, 12420, 50929, 2140, 0.0418399],
  [20, 32782, 44434, 3539, 0.0898014],
  [20, 9555, 49245, 1181, 0.0309405],
  [20, 8020, 49050, 987, 0.026691],
  [20, 8949, 49054, 671, 0.0269784],
  [20, 33787, 44434, 3857, 0.0933554],
  [20, 10457, 49849, 912, 0.0314979],
  [20, 30710, 44434, 3359, 0.0848434],
  [20, 12708, 49414, 2102, 0.0420474],
  [20, 10281, 47452, 955, 0.0310972],
  [20, 9812, 49806, 1110, 0.0311676],
  [20, 7062, 47254, 765, 0.0234964],
  [20, 32042, 44434, 4136, 0.0912314],
  [20, 8884, 49060, 641, 0.026705],
  [20, 18207, 50228, 3301, 0.0593868],
  [20, 29556, 44434, 4914, 0.0901884],
  [20, 17753, 49671, 2243, 0.0531251],
  [20, 31064, 44434, 3493, 0.0861584],
  [20, 30838, 44434, 5165, 0.0943174],
  [20, 29328, 44434, 5720, 0.0937914],
  [20, 30299, 44434, 6105, 0.0977784],
  [20, 14415, 50236, 2839, 0.0494796],
];

/**
 * claude-haiku-4.5 list price with a 1-HOUR cache write, $/MTok.
 *
 * This table lives in the TEST and nowhere else. Production stores the CLI's
 * own `total_cost_usd` verbatim and never prices anything locally (§4.4.4
 * invariant 3) — which is exactly what makes it usable here as an INDEPENDENT
 * check: the stored dollars and the stored tokens come from different places,
 * so their agreeing is evidence rather than a tautology.
 */
const HAIKU_1H_USD_PER_MTOK = {
  input: 1.0,
  cacheWrite: 2.0,
  cacheRead: 0.1,
  output: 5.0,
};

function recomputeUsd([input, write, read, output]: [number, number, number, number, number]): number {
  const p = HAIKU_1H_USD_PER_MTOK;
  return (
    (input * p.input + write * p.cacheWrite + read * p.cacheRead + output * p.output) / 1e6
  );
}

describe("stored cost agrees with stored tokens", () => {
  beforeEach(() => {
    cohort("c1", { events: 23 });
    for (const r of MEASURED_RUNS) {
      seed({
        role: "media",
        model: "claude-haiku-4-5-20251001",
        cohortId: "c1",
        input: r[0],
        create: r[1],
        read: r[2],
        output: r[3],
        costUsd: r[4],
      });
    }
  });

  it("SUM(cost_usd) over the window lands within 5% of a 1h-price recompute", () => {
    const totals = usageTotals();
    const recomputed = MEASURED_RUNS.reduce((n, r) => n + recomputeUsd(r), 0);
    expect(totals.runCount).toBe(23);
    expect(Math.abs(totals.costUsd - recomputed) / totals.costUsd).toBeLessThan(0.05);
  });

  it("the 5-minute write price misses by five times the tolerance", () => {
    // The proof the assertion above has teeth: swap the one weight that was
    // wrong and the same check fails by ~27%.
    const totals = usageTotals();
    const atFiveMinute = MEASURED_RUNS.reduce(
      (n, r) => n + (r[0] * 1.0 + r[1] * 1.25 + r[2] * 0.1 + r[3] * 5.0) / 1e6,
      0,
    );
    expect(Math.abs(totals.costUsd - atFiveMinute) / totals.costUsd).toBeGreaterThan(0.25);
  });

  it("stored billable_tokens re-derives from the stored token columns", () => {
    // The gate and the pacer read the stored figure, so a weight that drifts
    // away from what the columns say would gate on a number nobody can check.
    const totals = usageTotals();
    const expected = MEASURED_RUNS.reduce(
      (n, r) =>
        n +
        billableTokens({
          inputTokens: r[0],
          cacheCreationInputTokens: r[1],
          cacheReadInputTokens: r[2],
          outputTokens: r[3],
        }),
      0,
    );
    expect(totals.billableTokens).toBe(expected);
    // 1,071,997 at the 1-hour rate; the flat-1.25 bug read 734,511 over the
    // same 23 rows — a 31.5% under-count of what the gate and the pacer see.
    expect(totals.billableTokens).toBe(1_071_997);
  });
});

// ---------------------------------------------------------------------------
// The production write path. `runs` used to have exactly ONE writer — the V2
// prompt runner — so an installed build whose real spend is chat plus
// background media reading showed an empty Usage board and an empty Latency
// panel over $1.36 of money that had genuinely been spent.
// ---------------------------------------------------------------------------

function logged(over: Partial<Parameters<typeof logRun>[0]> = {}): void {
  logRun({
    provider: "claude-local",
    sessionId: null,
    runId: "media-evt-1",
    kind: "media",
    promptChars: 120,
    inputTokens: 20,
    cacheCreationInputTokens: 21055,
    cacheReadInputTokens: 43863,
    outputTokens: 2936,
    costUsd: 0.0626903,
    durationMs: 42680,
    status: "ok",
    errorCode: null,
    role: "media",
    model: "claude-haiku-4-5-20251001",
    ...over,
  });
}

describe("logRun dual-writes production runs into runs", () => {
  it("a logged run reaches Settings > Usage, cost and tokens together", () => {
    logged();
    const totals = usageTotals();
    expect(totals.runCount).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.0626903, 10);
    expect(totals.totalInputTokens).toBe(20 + 21055 + 43863);
    expect(totals.billableTokens).toBe(
      billableTokens({
        inputTokens: 20,
        cacheCreationInputTokens: 21055,
        cacheReadInputTokens: 43863,
        outputTokens: 2936,
      }),
    );
    const [row] = usageByRole();
    expect(row.role).toBe("media");
    expect(row.model).toBe("claude-haiku-4-5-20251001");
  });

  it("writes the latency mark too, so per-call-type grading has data", () => {
    logged();
    const snap = latencySnapshot();
    expect(snap.calls).toHaveLength(1);
    expect(snap.calls[0]).toMatchObject({
      callType: "media",
      model: "claude-haiku-4-5-20251001",
      calls: 1,
      worstTotalMs: 42680,
    });
    // Nothing measured a first token on this path, and a 0 would claim the
    // call was instantaneous — so coverage reports the gap instead of hiding it.
    expect(snap.calls[0].worstTtftMs).toBeNull();
    expect(snap.ttftCoverage).toBe(0);
  });

  it("survives a retry reusing the same provider run id", () => {
    // `media-<event id>` is reused on a retry; keying `runs` on it would throw
    // a UNIQUE violation inside the streaming path. Both attempts are real
    // spend and both must land.
    logged();
    logged();
    expect(usageTotals().runCount).toBe(2);
    expect(runCounts().total).toBe(2);
  });

  it("does not mirror a run whose role is outside RUN_ROLES", () => {
    // Inventing a role would undo the one thing `runs` is for. The phase-0 log
    // still has the row; the accounting table refuses to guess at it.
    logged({ role: "gossip", kind: "gossip" });
    expect(usageTotals().runCount).toBe(0);
    const n = getDb().prepare(`SELECT COUNT(*) AS n FROM extraction_runs`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("labels a subscription-default model instead of grouping under a blank", () => {
    logged({ model: "" });
    expect(usageByRole()[0].model).toBe(DEFAULT_MODEL_LABEL);
  });

  it("leaves the cohort null, so background spend never joins an import", () => {
    cohort("c1", { events: 10, state: "done" });
    logged();
    expect(usageTotals({ importMode: "bootstrap" }).runCount).toBe(0);
    // ...and therefore never inflates the per-event pre-flight estimate.
    expect(estimateImportSpend(100).projectedUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 0026_runs_backfill — history carried across, twice-safe.
// ---------------------------------------------------------------------------

describe("the extraction_runs -> runs backfill", () => {
  /** A row written the way the pre-fix build wrote it: log only, no mirror. */
  function legacyRow(runId: string, role: string): void {
    getDb()
      .prepare(
        `INSERT INTO extraction_runs
           (provider, session_id, run_id, kind, prompt_chars, input_tokens,
            cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
            cost_usd, duration_ms, status, error_code, model, role, created_at)
         VALUES ('claude-local', NULL, ?, ?, 0, 20, 21055, 43863, 2936,
                 0.0626903, 42680, 'ok', NULL, 'claude-haiku-4-5-20251001', ?,
                 '2026-08-16T14:44:50.738Z')`,
      )
      .run(runId, role, role);
  }

  it("copies history in, and running it twice changes nothing", () => {
    legacyRow("media-a", "media");
    legacyRow("media-b", "media");
    expect(usageTotals().runCount).toBe(0);

    getDb().exec(RUNS_BACKFILL);
    const first = usageTotals();
    expect(first.runCount).toBe(2);
    expect(first.costUsd).toBeCloseTo(0.1253806, 10);
    expect(first.billableTokens).toBe(
      2 * billableTokens({ inputTokens: 20, cacheCreationInputTokens: 21055, cacheReadInputTokens: 43863, outputTokens: 2936 }),
    );
    // Latency marks come across with it: recordRun writes a run and its mark
    // together, so a half-backfill would leave the two at different counts.
    expect(latencySnapshot().calls[0].calls).toBe(2);

    getDb().exec(RUNS_BACKFILL);
    expect(usageTotals()).toEqual(first);
    expect(latencySnapshot().calls[0].calls).toBe(2);
  });

  it("backdates started_at by the measured duration, not the log's stamp", () => {
    legacyRow("media-a", "media");
    getDb().exec(RUNS_BACKFILL);
    const row = getDb().prepare(`SELECT started_at, ended_at FROM runs`).get() as {
      started_at: string;
      ended_at: string;
    };
    expect(row.ended_at).toBe("2026-08-16T14:44:50.738Z");
    expect(Date.parse(row.ended_at) - Date.parse(row.started_at)).toBe(42680);
  });

  it("leaves a row it cannot attribute in the log rather than inventing a role", () => {
    legacyRow("mystery", "gossip");
    getDb().exec(RUNS_BACKFILL);
    expect(usageTotals().runCount).toBe(0);
  });
});
