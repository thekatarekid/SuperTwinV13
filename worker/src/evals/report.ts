// ===========================================================================
// [CODE] Eval report — renders a SuiteResult for the terminal / CI log.
//
// Three blocks: per-category table (pass/fail/pending), the gate table (hard
// gates asserted, tracked metrics printed), and per-failure detail. The
// verdict is what CI exits on: any failed case or breached hard gate fails.
// ===========================================================================

import { getHardGate, type GateReading } from "./gates.js";
import type { CaseResult, SuiteResult } from "./runner.js";

function pct(v: number | null): string {
  return v === null ? "  —  " : `${(v * 100).toFixed(0).padStart(4)}%`;
}

function renderCategories(suite: SuiteResult): string[] {
  const lines = ["category  total  pass  fail  pending  rate"];
  for (const c of suite.categories) {
    lines.push(
      `${c.category.padEnd(9)} ${String(c.total).padStart(5)} ${String(c.pass).padStart(5)} ${String(c.fail).padStart(5)} ${String(c.pending).padStart(8)}  ${pct(c.passRate)}`,
    );
  }
  const t = suite.totals;
  lines.push(
    `${"TOTAL".padEnd(9)} ${String(t.total).padStart(5)} ${String(t.pass).padStart(5)} ${String(t.fail).padStart(5)} ${String(t.pending).padStart(8)}`,
  );
  return lines;
}

function gateValue(r: GateReading): string {
  if (r.value === null) return "—";
  // Zero-violation gates read a COUNT; the rate kinds read a fraction.
  if (getHardGate(r.id)?.kind === "zero_violations") return `${r.value} violation(s)`;
  return r.value <= 1 ? `${(r.value * 100).toFixed(1)}%` : String(r.value);
}

function renderGates(gates: readonly GateReading[], hideNoData: boolean): string[] {
  const lines: string[] = ["gates (hard asserted · tracked printed only):"];
  for (const r of gates) {
    if (hideNoData && r.status === "no_data") continue;
    const tag =
      r.status === "pass" ? "PASS " : r.status === "fail" ? "FAIL " : r.status === "tracked" ? "track" : "nodat";
    const label = r.hard ? `${r.id} — ${r.metric}` : r.id;
    lines.push(`  ${tag}  ${label}  [${gateValue(r)} over ${r.cases} case(s)]`);
  }
  return lines;
}

function renderFailure(r: CaseResult, maxNotes: number): string[] {
  const lines = [`  ${r.id} (${r.pass}, ${r.mode}) — ${r.reason ?? "failed"}`];
  for (const hit of r.wrongHits) {
    lines.push(`      wrong[${hit.label}] by ${hit.by}${hit.note ? `: ${hit.note}` : ""}`);
  }
  for (const note of r.notes.slice(0, maxNotes)) lines.push(`      ${note}`);
  return lines;
}

export interface ReportOptions {
  hideNoDataGates?: boolean;
  maxNotesPerFailure?: number;
}

export function renderReport(suite: SuiteResult, dir: string, options: ReportOptions = {}): string {
  const lines: string[] = [];
  lines.push(`golden evals (live-call) — ${dir}`);
  lines.push("");
  lines.push(...renderCategories(suite));
  lines.push("");
  lines.push(...renderGates(suite.gates, options.hideNoDataGates ?? false));

  const failures = suite.results.filter((r) => r.status === "fail");
  if (failures.length > 0) {
    lines.push("");
    lines.push(`failures (${failures.length}):`);
    for (const r of failures) lines.push(...renderFailure(r, options.maxNotesPerFailure ?? 3));
  }

  const pendings = suite.results.filter((r) => r.status === "pending");
  if (pendings.length > 0) {
    lines.push("");
    const byReason = new Map<string, number>();
    for (const p of pendings) byReason.set(p.reason ?? "?", (byReason.get(p.reason ?? "?") ?? 0) + 1);
    lines.push(`pending (${pendings.length}):`);
    for (const [reason, n] of byReason) lines.push(`  ${n} case(s): ${reason}`);
  }

  lines.push("");
  const v = verdict(suite);
  lines.push(v.ok ? "VERDICT: green" : `VERDICT: red — ${v.reasons.join("; ")}`);
  lines.push(`(${suite.durationMs} ms)`);
  return lines.join("\n");
}

export function verdict(suite: SuiteResult): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (suite.totals.fail > 0) reasons.push(`${suite.totals.fail} case(s) failed`);
  const breached = suite.gates.filter((g) => g.status === "fail");
  if (breached.length > 0) reasons.push(`hard gate(s) breached: ${breached.map((g) => g.id).join(", ")}`);
  return { ok: reasons.length === 0, reasons };
}
