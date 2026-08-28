// ===========================================================================
// [CODE] Eval report renderer — build item 0.6.
//
// Three things, in this order, because that is the order a human needs them:
//   1. pass rate per category (evals doc §4 names and counts),
//   2. every §14.2 gate with its measured value beside its threshold,
//   3. a diff for EVERY failure — not the first five, not a count. A failing
//      case whose diff was truncated is a case somebody stops reading.
//
// Pure string building: the CLI prints it, the tests assert on it.
// ===========================================================================

import { CATEGORIES, type Fixture } from "./fixtures.js";
import type { GateReading, GateStatus } from "./gates.js";
import type { CaseResult, Diff, SuiteResult } from "./runner.js";

const CATEGORY_NAME = new Map(CATEGORIES.map((c) => [c.cat, c.name]));

export interface ReportOptions {
  /** Drop gates nothing measured from the gate table (they are still counted). */
  hideNoDataGates?: boolean;
  /** Cap the number of diff lines printed per failure. 0 = no cap. */
  maxDiffLines?: number;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null): string {
  if (value === null) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

function rule(width: number): string {
  return "─".repeat(width);
}

export function renderHeader(suite: SuiteResult, fixtureCount: number, source: string): string {
  const { totals } = suite;
  return [
    `SuperTwinV13 golden evals — ${suite.mode.toUpperCase()} mode`,
    `fixtures: ${fixtureCount} loaded from ${source}`,
    `cases:    ${totals.total} · pass ${totals.pass} · fail ${totals.fail} · pending ${totals.pending}`,
    `elapsed:  ${(suite.durationMs / 1000).toFixed(2)}s${suite.mode === "frozen" ? " · no network calls" : ""}`,
  ].join("\n");
}

export function renderCategories(suite: SuiteResult): string {
  const lines: string[] = [];
  lines.push("PER-CATEGORY");
  lines.push(
    `${pad("cat", 4)}${pad("name", 12)}${padLeft("n", 5)}${padLeft("pass", 6)}${padLeft("fail", 6)}${padLeft("pend", 6)}${padLeft("rate", 8)}`,
  );
  lines.push(rule(47));
  for (const tally of suite.categories) {
    lines.push(
      pad(tally.category, 4) +
        pad(CATEGORY_NAME.get(tally.category) ?? "—", 12) +
        padLeft(String(tally.total), 5) +
        padLeft(String(tally.pass), 6) +
        padLeft(String(tally.fail), 6) +
        padLeft(String(tally.pending), 6) +
        padLeft(pct(tally.passRate), 8),
    );
  }
  lines.push(rule(47));
  const t = suite.totals;
  const rate = t.pass + t.fail > 0 ? t.pass / (t.pass + t.fail) : null;
  lines.push(
    pad("all", 16) +
      padLeft(String(t.total), 5) +
      padLeft(String(t.pass), 6) +
      padLeft(String(t.fail), 6) +
      padLeft(String(t.pending), 6) +
      padLeft(pct(rate), 8),
  );
  return lines.join("\n");
}

const STATUS_LABEL: Record<GateStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  no_data: "no data",
  reported: "reported",
};

function gateValue(reading: GateReading): string {
  if (reading.value === null) return "—";
  return reading.gate.measure === "pass_rate" ? pct(reading.value) : num(reading.value);
}

export function renderGates(readings: readonly GateReading[], options: ReportOptions = {}): string {
  const shown = options.hideNoDataGates ? readings.filter((r) => r.status !== "no_data") : readings;
  const lines: string[] = [];
  const failed = readings.filter((r) => r.status === "fail").length;
  const measured = readings.filter((r) => r.status === "pass" || r.status === "fail").length;
  lines.push(
    `GATES (architecture §14.2) — ${readings.length} defined · ${measured} measured · ${failed} breached`,
  );
  lines.push(
    `${pad("gate", 34)}${pad("layer", 12)}${padLeft("value", 9)}  ${pad("fails if", 26)}status`,
  );
  lines.push(rule(92));
  for (const reading of shown) {
    const mark = reading.gate.critical ? "!" : " ";
    lines.push(
      mark +
        pad(reading.gate.id, 33) +
        pad(reading.gate.layer, 12) +
        padLeft(gateValue(reading), 9) +
        "  " +
        pad(reading.gate.failsIf, 26) +
        STATUS_LABEL[reading.status],
    );
  }
  lines.push(rule(92));
  if (options.hideNoDataGates) {
    const hidden = readings.length - shown.length;
    if (hidden > 0) lines.push(`${hidden} gate(s) with no measurement hidden — they are NOT passing.`);
  }
  lines.push("! = bolded in §14.2. A gate with no measurement is 'no data', never a pass.");
  return lines.join("\n");
}

function renderDiff(diff: Diff): string[] {
  const head = `    ${diff.kind.toUpperCase()} at ${diff.path}${diff.note ? ` — ${diff.note}` : ""}`;
  const lines = [head];
  if (diff.expected !== undefined) lines.push(`      - expected: ${stringify(diff.expected)}`);
  if (diff.actual !== undefined) lines.push(`      + actual:   ${stringify(diff.actual)}`);
  return lines;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function renderFailure(result: CaseResult, fixture?: Fixture, options: ReportOptions = {}): string {
  const lines: string[] = [];
  lines.push(`FAIL ${result.id}  [${result.layer} · ${result.assertMode}${result.gate ? ` · gate ${result.gate}` : ""}]`);
  if (fixture?.doc?.given) lines.push(`  given:  ${fixture.doc.given}`);
  if (fixture?.doc?.expect) lines.push(`  expect: ${fixture.doc.expect}`);
  if (result.reason) lines.push(`  reason: ${result.reason}`);
  const body: string[] = [];
  for (const diff of result.diffs) body.push(...renderDiff(diff));
  const cap = options.maxDiffLines ?? 0;
  if (cap > 0 && body.length > cap) {
    lines.push(...body.slice(0, cap));
    lines.push(`    … ${body.length - cap} more diff line(s)`);
  } else {
    lines.push(...body);
  }
  return lines.join("\n");
}

export function renderFailures(
  suite: SuiteResult,
  fixtures: readonly Fixture[] = [],
  options: ReportOptions = {},
): string {
  const failures = suite.results.filter((r) => r.status === "fail");
  if (failures.length === 0) return "FAILURES\nnone";
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const lines = [`FAILURES (${failures.length})`];
  for (const failure of failures) lines.push(renderFailure(failure, byId.get(failure.id), options), "");
  return lines.join("\n").trimEnd();
}

/** Pending cases, grouped by reason — the honest view of what is not yet proven. */
export function renderPending(suite: SuiteResult): string {
  const pending = suite.results.filter((r) => r.status === "pending");
  if (pending.length === 0) return "PENDING\nnone";
  const byReason = new Map<string, string[]>();
  for (const p of pending) {
    const reason = p.reason ?? "unknown";
    const list = byReason.get(reason) ?? [];
    list.push(p.id);
    byReason.set(reason, list);
  }
  const lines = [`PENDING (${pending.length})`];
  for (const [reason, ids] of [...byReason.entries()].sort()) {
    const sample = ids.slice(0, 6).join(", ");
    lines.push(`  ${ids.length.toString().padStart(4)}  ${reason}`);
    lines.push(`        ${sample}${ids.length > 6 ? `, … (+${ids.length - 6})` : ""}`);
  }
  return lines.join("\n");
}

export interface Verdict {
  ok: boolean;
  failedCases: number;
  breachedGates: string[];
  summary: string;
}

export function verdict(suite: SuiteResult): Verdict {
  const breached = suite.gates.filter((g) => g.status === "fail");
  const failedCases = suite.totals.fail;
  const ok = failedCases === 0 && breached.length === 0;
  const parts = [
    ok ? "PASS" : "FAIL",
    `${suite.totals.pass}/${suite.totals.pass + suite.totals.fail} cases`,
    `${breached.length} gate(s) breached`,
    `${suite.totals.pending} pending`,
  ];
  return {
    ok,
    failedCases,
    breachedGates: breached.map((g) => g.gate.id),
    summary: parts.join(" · "),
  };
}

export function renderReport(
  suite: SuiteResult,
  fixtures: readonly Fixture[],
  source: string,
  options: ReportOptions = {},
): string {
  const v = verdict(suite);
  const sections = [
    renderHeader(suite, fixtures.length, source),
    renderCategories(suite),
    renderGates(suite.gates, options),
    renderFailures(suite, fixtures, options),
    renderPending(suite),
    v.breachedGates.length > 0 ? `${v.summary}\nbreached: ${v.breachedGates.join(", ")}` : v.summary,
  ];
  return sections.join("\n\n");
}
