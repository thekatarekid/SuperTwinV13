// ===========================================================================
// [CODE] AST parity — Build V6 P1 §7.3 ship-gate item 2, "AST parity on the
// re-homed LIV cases".
//
// S4.4 deletes `assist/` (watcher, evaluator, tick, cursor, gate) and with it
// the nine AST fixtures, which are the only cases in the golden set that run
// on the `assist` pass. Deleting a lane is only safe if nothing it PROVED
// stops being proved: every assertion an AST case carried has to have a new
// home among the V6 cases, and that home has to be green.
//
// This module is that ledger, and it is deliberately explicit rather than
// derived. A count ("AST had 9 cases, LIV+NUD+EXE have 20") proves nothing:
// parity is per-ASSERTION. So each row names the retired case, the assertion
// in one sentence, and the V6 cases that carry it now — and two checks run
// over it:
//
//   astParityGaps(ids)       every home names a fixture that EXISTS, no home
//                            is itself an AST case, and every AST fixture in
//                            the corpus is accounted for. Static — no run.
//   assessAstParity(rs, ids) of the homes a run actually selected, every one
//                            passed. A home that was not selected is reported
//                            as "not measured", never as a pass.
//
// The CLI wires both behind `--ast-parity` (evals/cli.ts), so the gate is a
// command, not a paragraph in a report.
// ===========================================================================

import type { CaseResult } from "./runner.js";

export interface RehomedAssertion {
  /** The retiring case (dies with `assist/` in S4.4). */
  from: string;
  /** What it proved, in one sentence. */
  assertion: string;
  /** The V6 cases that prove it now. */
  to: readonly string[];
}

/**
 * The nine AST cases and where each one's assertion lives in V6 Phase 1.
 * GoldenEvals V6 P1 §5.11 (LIV) · §5.12 (EXE) · §5.13 (NUD) · §5.10 (CROSS) ·
 * §5.2 (GATE).
 */
export const AST_PARITY: readonly RehomedAssertion[] = [
  {
    from: "AST-01",
    assertion:
      "Intent is inferred and the RIGHT preparation follows — a comparison of options, never a purchase — and the card names the intent, what was done and the space.",
    to: ["LIV-01", "EXE-01", "NUD-01"],
  },
  {
    from: "AST-02",
    assertion:
      "Below the threshold the twin is silent, and the silence costs nothing: the decision not to act is taken by CODE, with zero model calls.",
    to: ["GATE-02", "LIV-06"],
  },
  {
    from: "AST-03",
    assertion:
      "Per-context suppression and cooldown: a context the user keeps waving off stops surfacing, while the work itself is still prepared and parked on the shelf.",
    to: ["NUD-07", "NUD-08", "LIV-06"],
  },
  {
    from: "AST-04",
    assertion:
      "The risk line holds: the twin prepares up to the payment or the login and then asks — it never sends, pays or authenticates on its own.",
    to: ["LIV-01", "EXE-05"],
  },
  {
    from: "AST-05",
    assertion:
      "Artifact durability: dismissed is not deleted. A closed or dismissed artifact survives, keeps its provenance, and can still graduate into the space.",
    to: ["NUD-03", "NUD-07"],
  },
  {
    from: "AST-06",
    assertion:
      "Engagement is graded, not binary: signals of different strength produce different ranks rather than a single on/off flag.",
    to: ["NUD-05", "NUD-07"],
  },
  {
    from: "AST-07",
    assertion:
      "The preparation reads FRESH memory, not stale: what grounds an action is this flush and the current world model, never three-week-old intent.",
    to: ["LIV-03"],
  },
  {
    from: "AST-08",
    assertion:
      "A hard deadline is handled at once — urgency and the deadline instant come out of the message — and the understanding lane still files it durably.",
    to: ["LIV-01", "GATE-01"],
  },
  {
    from: "AST-09",
    assertion:
      "Cross-source novelty is what fires the gate: distinct events across chat, browser and screen join up (a re-capture adds nothing) and produce ONE piece of work.",
    to: ["CROSS-N50", "GATE-04"],
  },
];

/** Every case id that carries a retired AST assertion, deduped and sorted. */
export function rehomedCaseIds(map: readonly RehomedAssertion[] = AST_PARITY): string[] {
  return [...new Set(map.flatMap((r) => r.to))].sort();
}

/** The retiring case ids the map covers. */
export function retiredCaseIds(map: readonly RehomedAssertion[] = AST_PARITY): string[] {
  return map.map((r) => r.from);
}

/**
 * Static check: the map is complete and points at real, non-AST fixtures.
 * `ids` is every fixture id in the corpus.
 */
export function astParityGaps(
  ids: readonly string[],
  map: readonly RehomedAssertion[] = AST_PARITY,
): string[] {
  const have = new Set(ids);
  const gaps: string[] = [];
  const covered = new Set(map.map((r) => r.from));
  for (const id of ids) {
    if (id.startsWith("AST-") && !covered.has(id)) {
      gaps.push(`${id} is in the corpus but no parity row re-homes its assertion`);
    }
  }
  for (const row of map) {
    if (!have.has(row.from)) gaps.push(`${row.from}: the retiring case is not in the corpus`);
    if (row.to.length === 0) gaps.push(`${row.from}: no case carries its assertion`);
    for (const to of row.to) {
      if (!have.has(to)) gaps.push(`${row.from} → ${to}: the re-homed case does not exist`);
      if (to.startsWith("AST-")) gaps.push(`${row.from} → ${to}: re-homed onto the lane being retired`);
    }
  }
  return gaps;
}

export interface ParityRow extends RehomedAssertion {
  /** Per-home status from the run; "not-measured" when the run did not select it. */
  results: { id: string; status: CaseResult["status"] | "not-measured" }[];
  /** True when every home was measured AND passed. */
  held: boolean;
}

export interface ParityReport {
  rows: ParityRow[];
  /** Rows where a home failed. */
  failed: ParityRow[];
  /** Rows where at least one home was not selected by this run. */
  unmeasured: ParityRow[];
  /** Static gaps (missing fixtures, uncovered AST cases). */
  gaps: string[];
  ok: boolean;
}

/**
 * Grade the map against a run. `ok` is true only when there are no static
 * gaps and no home FAILED; an unmeasured home is reported separately, because
 * "we did not run it" must never read as "it passed".
 */
export function assessAstParity(
  results: readonly CaseResult[],
  ids: readonly string[],
  map: readonly RehomedAssertion[] = AST_PARITY,
): ParityReport {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows: ParityRow[] = map.map((row) => {
    const results = row.to.map((id) => ({ id, status: byId.get(id)?.status ?? ("not-measured" as const) }));
    return { ...row, results, held: results.every((r) => r.status === "pass") };
  });
  const failed = rows.filter((r) => r.results.some((x) => x.status === "fail"));
  const unmeasured = rows.filter((r) => r.results.some((x) => x.status === "not-measured" || x.status === "pending"));
  const gaps = astParityGaps(ids, map);
  return { rows, failed, unmeasured, gaps, ok: gaps.length === 0 && failed.length === 0 };
}

const MARK: Record<string, string> = { pass: "✓", fail: "✗", pending: "·", "not-measured": "–" };

/** The table `--ast-parity` prints. */
export function renderAstParity(report: ParityReport): string {
  const lines: string[] = [
    "AST PARITY — every assertion the retiring assist/ lane proved, and where it lives now",
    "",
  ];
  for (const row of report.rows) {
    const homes = row.results.map((r) => `${MARK[r.status] ?? "?"} ${r.id}`).join("   ");
    lines.push(`  ${row.from}  ${homes}`);
    lines.push(`           ${row.assertion}`);
  }
  lines.push("");
  for (const g of report.gaps) lines.push(`  GAP  ${g}`);
  if (report.failed.length > 0) {
    lines.push(`  FAIL ${report.failed.map((r) => r.from).join(", ")} — a re-homed case is red`);
  }
  if (report.unmeasured.length > 0) {
    lines.push(
      `  NOTE ${report.unmeasured.map((r) => r.from).join(", ")} — a home was not selected by this run (not measured, not passed)`,
    );
  }
  // Item 2 is one of four. Parity holding clears THIS item; it does not on its
  // own authorise the retirement (Build V6 P1 §7.3: "all four must hold").
  lines.push(
    report.ok
      ? "  PARITY HOLDS — §7.3 item 2 of four is clear (the other three still gate assist/)"
      : "  PARITY DOES NOT HOLD — keep assist/ (Build V6 P1 §7.3 fallback)",
  );
  return lines.join("\n");
}
