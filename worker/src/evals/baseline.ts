// ===========================================================================
// [CODE] Frozen eval baseline — `evals/baseline/v13.json` (build V6P1, S0.1).
//
// The golden set's V2 categories (ROL, CIR, CHP, SCH, FUP, USR, FIX, TIM, TRC)
// carry forward into V6 as REGRESSION GATES: a category that scores below its
// frozen baseline is a hard fail (GoldenEvals_V6_Phase1 §1.1, §3.1). This
// module owns that frozen file — how it is written from a suite run, how it
// is merged when a later run covers more categories, and how it is printed.
//
//   npm run eval -- --baseline                  print the frozen file
//   npm run eval -- [selection] --record-baseline
//                                               run, then merge the per-category
//                                               tallies of THIS run into the file
//
// The file is a merge, not a snapshot: a run only replaces the categories it
// actually ran, so a zero-cost `--mode code` run and a paid live run of the
// gated categories can be recorded one after the other. Every recorded run is
// appended to `runs[]` so the method behind each number stays legible. A
// category the file has never seen is listed as `not-run` (rate null) — the
// print never hides a gap behind an empty row.
// ===========================================================================

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CATEGORIES } from "./fixtures.js";
import type { SuiteResult } from "./runner.js";

export const BASELINE_SCHEMA = 1;
/** Env override for the baseline path (mirrors EVAL_FIXTURES for --dir). */
export const BASELINE_ENV = "EVAL_BASELINE";

/**
 * How a category's number was produced.
 *   live      at least one `mode: "live"` case ran (real pass + haiku judge)
 *   code      every counted case was `mode: "code"` — zero model calls
 *   pending   cases were selected but every one reported pending
 *   not-run   the category has never been recorded
 */
export type BaselineMeasured = "live" | "code" | "pending" | "not-run";

export interface BaselineCategory {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  /** pass / (pass + fail); null when nothing counted. */
  rate: number | null;
  measured: BaselineMeasured;
  /** Per-case status, so a later comparison can name the case that regressed. */
  cases: Record<string, "pass" | "fail" | "pending">;
  /** ISO time of the run that last wrote this row. */
  recorded_at: string;
}

export interface BaselineRun {
  at: string;
  git: string;
  /** The eval CLI argv that produced the run (selection + judge). */
  argv: string[];
  categories: string[];
  cases: number;
  /** Exact `claude` invocations the operator counted for the run; null = not counted. */
  model_calls: number | null;
  /** Free-text method note for the run. */
  note?: string;
}

export interface BaselineFile {
  schema: number;
  /** Time of the most recent record. */
  recorded_at: string;
  git: string;
  /** One paragraph per line: what this baseline is and how it was produced. */
  method: string[];
  /** Sum of `runs[].model_calls` (nulls treated as unknown → null overall). */
  model_calls: number | null;
  runs: BaselineRun[];
  categories: Record<string, BaselineCategory>;
}

export function baselinePath(root: string): string {
  return process.env[BASELINE_ENV] ?? join(root, "evals", "baseline", "v13.json");
}

export function readBaseline(path: string): BaselineFile | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BaselineFile>;
  if (parsed.schema !== BASELINE_SCHEMA || typeof parsed.categories !== "object" || parsed.categories === null) {
    throw new Error(`${path}: not a schema-${BASELINE_SCHEMA} baseline file`);
  }
  return parsed as BaselineFile;
}

export function writeBaseline(path: string, file: BaselineFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Short git sha of the working tree, or "unknown" outside a checkout. */
export function gitShortSha(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export interface RecordOptions {
  at?: string;
  git?: string;
  argv?: readonly string[];
  modelCalls?: number | null;
  note?: string;
  /** Replaces the file's method paragraphs when given; otherwise kept/defaulted. */
  method?: string[];
}

export const DEFAULT_METHOD: readonly string[] = [
  "Frozen V13 golden-set baseline (SuperTwinV13_Build_V6_Phase1 S0.1). Per-category tallies of `npm run eval` on the tree at `git`.",
  "The file is merged run-by-run: each recorded run replaces only the categories it ran; `runs[]` lists every contributing run with its argv and counted model calls.",
  "Regression rule (GoldenEvals_V6_Phase1 §1.1/§3.1): a V2 category (ROL, CIR, CHP, SCH, FUP, USR, FIX, TIM, TRC) scoring below its `rate` here is a hard fail.",
];

function categoryRow(suite: SuiteResult, category: string, at: string): BaselineCategory {
  const results = suite.results.filter((r) => r.category === category);
  const tally = suite.categories.find((c) => c.category === category);
  const cases: BaselineCategory["cases"] = {};
  for (const r of results) cases[r.id] = r.status;
  const counted = results.filter((r) => r.status !== "pending");
  let measured: BaselineMeasured;
  if (counted.length === 0) measured = "pending";
  else if (counted.some((r) => r.mode === "live")) measured = "live";
  else measured = "code";
  return {
    total: tally?.total ?? results.length,
    pass: tally?.pass ?? 0,
    fail: tally?.fail ?? 0,
    pending: tally?.pending ?? 0,
    rate: tally?.passRate ?? null,
    measured,
    cases,
    recorded_at: at,
  };
}

function notRun(at: string): BaselineCategory {
  return { total: 0, pass: 0, fail: 0, pending: 0, rate: null, measured: "not-run", cases: {}, recorded_at: at };
}

/**
 * Merge one suite run into the baseline. Categories the run touched are
 * replaced wholesale; every other known category keeps its previous row (or
 * a `not-run` placeholder). The result is sorted by category for stable diffs.
 */
export function recordBaseline(previous: BaselineFile | null, suite: SuiteResult, options: RecordOptions = {}): BaselineFile {
  const at = options.at ?? new Date().toISOString();
  const git = options.git ?? "unknown";
  const ran = suite.categories.map((c) => c.category);

  const merged: Record<string, BaselineCategory> = {};
  const known = new Set<string>([...CATEGORIES.map((c) => c.cat), ...Object.keys(previous?.categories ?? {}), ...ran]);
  for (const cat of [...known].sort()) {
    if (ran.includes(cat)) merged[cat] = categoryRow(suite, cat, at);
    else merged[cat] = previous?.categories[cat] ?? notRun(at);
  }

  const run: BaselineRun = {
    at,
    git,
    argv: [...(options.argv ?? [])],
    categories: ran,
    cases: suite.totals.total,
    model_calls: options.modelCalls ?? null,
    ...(options.note ? { note: options.note } : {}),
  };
  const runs = [...(previous?.runs ?? []), run];
  const knownCalls = runs.map((r) => r.model_calls);
  const modelCalls = knownCalls.every((n): n is number => typeof n === "number")
    ? knownCalls.reduce((a, b) => a + b, 0)
    : null;

  return {
    schema: BASELINE_SCHEMA,
    recorded_at: at,
    git,
    method: options.method ?? previous?.method ?? [...DEFAULT_METHOD],
    model_calls: modelCalls,
    runs,
    categories: merged,
  };
}

function pct(v: number | null): string {
  return v === null ? "  —  " : `${(v * 100).toFixed(0).padStart(4)}%`;
}

export function renderBaseline(file: BaselineFile, path: string): string {
  const lines: string[] = [];
  lines.push(`eval baseline — ${path}`);
  lines.push(`recorded ${file.recorded_at} at ${file.git} · model calls: ${file.model_calls ?? "not counted"}`);
  lines.push("");
  lines.push("category  total  pass  fail  pending  rate   measured");
  let total = 0;
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const [cat, row] of Object.entries(file.categories)) {
    lines.push(
      `${cat.padEnd(9)} ${String(row.total).padStart(5)} ${String(row.pass).padStart(5)} ${String(row.fail).padStart(5)} ${String(row.pending).padStart(8)}  ${pct(row.rate)}  ${row.measured}`,
    );
    total += row.total;
    pass += row.pass;
    fail += row.fail;
    pending += row.pending;
  }
  lines.push(
    `${"TOTAL".padEnd(9)} ${String(total).padStart(5)} ${String(pass).padStart(5)} ${String(fail).padStart(5)} ${String(pending).padStart(8)}`,
  );
  lines.push("");
  lines.push(`runs (${file.runs.length}):`);
  for (const run of file.runs) {
    lines.push(
      `  ${run.at}  ${run.git}  ${run.cases} case(s) · ${run.categories.join(",") || "—"} · calls ${run.model_calls ?? "?"}  [${run.argv.join(" ") || "(no flags)"}]`,
    );
    if (run.note) lines.push(`      ${run.note}`);
  }
  lines.push("");
  lines.push("method:");
  for (const m of file.method) lines.push(`  ${m}`);
  return lines.join("\n");
}
