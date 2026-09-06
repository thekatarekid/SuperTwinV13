// ===========================================================================
// AST parity ledger (Build V6 P1 §7.3 ship-gate item 2). Zero model calls.
//
// R1 deleted the nine AST fixtures with the lane they measured, so the ledger
// is now the ONLY record of what that lane proved. These cases changed shape
// with it: "every AST case in the corpus is covered" became "no AST case is
// in the corpus, and the ledger still names all nine".
// ===========================================================================

import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  assessAstParity,
  astParityGaps,
  AST_PARITY,
  rehomedCaseIds,
  renderAstParity,
  retiredCaseIds,
  type RehomedAssertion,
} from "./parity.js";
import type { CaseResult } from "./runner.js";

const FIX = join(import.meta.dirname, "../../../evals/v13");

function corpusIds(): string[] {
  return readdirSync(FIX)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function result(id: string, status: CaseResult["status"]): CaseResult {
  return {
    id,
    category: id.split("-")[0]!,
    pass: "x",
    mode: "code",
    status,
    judgeVerdict: null,
    wrongHits: [],
    metrics: {},
    gates: [],
    gateObservations: [],
    notes: [],
    durationMs: 0,
  };
}

const allPass = (map: readonly RehomedAssertion[] = AST_PARITY): CaseResult[] =>
  rehomedCaseIds(map).map((id) => result(id, "pass"));

describe("the parity map", () => {
  it("names all nine retired cases, and none of them is still in the corpus", () => {
    expect(corpusIds().filter((id) => id.startsWith("AST-"))).toEqual([]);
    const retired = retiredCaseIds();
    expect(retired).toHaveLength(9);
    expect([...new Set(retired)]).toHaveLength(9);
    expect(retired.every((id) => /^AST-0[1-9]$/.test(id))).toBe(true);
  });

  it("every re-homed case exists, and none of them is an AST case", () => {
    expect(astParityGaps(corpusIds())).toEqual([]);
    for (const id of rehomedCaseIds()) expect(id.startsWith("AST-")).toBe(false);
  });

  it("re-homes onto the S4 lanes the build doc names — LIV, EXE, NUD, CROSS, GATE", () => {
    const families = new Set(rehomedCaseIds().map((id) => id.split("-")[0]));
    expect([...families].sort()).toEqual(["CROSS", "EXE", "GATE", "LIV", "NUD"]);
  });

  it("gives every row an assertion sentence, not just a pointer", () => {
    for (const row of AST_PARITY) {
      expect(row.assertion.length).toBeGreaterThan(40);
      expect(row.to.length).toBeGreaterThan(0);
    }
  });
});

describe("astParityGaps", () => {
  it("names a home that does not exist", () => {
    const gaps = astParityGaps(["LIV-01"], [{ from: "AST-01", assertion: "a".repeat(50), to: ["LIV-99"] }]);
    expect(gaps).toEqual(["AST-01 → LIV-99: the re-homed case does not exist"]);
  });

  it("refuses a home on the lane being retired", () => {
    const gaps = astParityGaps(
      ["AST-01", "AST-02"],
      [
        { from: "AST-01", assertion: "a".repeat(50), to: ["AST-02"] },
        { from: "AST-02", assertion: "b".repeat(50), to: ["AST-01"] },
      ],
    );
    expect(gaps).toContain("AST-01 → AST-02: re-homed onto the lane being retired");
  });

  it("names an AST fixture that came BACK into the corpus", () => {
    // The resurrection guard. A re-materialized AST-77 would run on the
    // `assist` pass, which nothing registers since R1 — so it would read
    // `pending` forever, and a pending case measures nothing.
    const gaps = astParityGaps(["AST-77", "LIV-01"], [{ from: "AST-01", assertion: "a".repeat(50), to: ["LIV-01"] }]);
    expect(gaps).toContain("AST-77 is back in the corpus — the assist lane it runs on was deleted in R1");
  });

  it("names a row with no home at all", () => {
    expect(astParityGaps(["LIV-01"], [{ from: "AST-01", assertion: "a".repeat(50), to: [] }])).toContain(
      "AST-01: no case carries its assertion",
    );
  });

  it("names a retired case the ledger re-homes twice", () => {
    const gaps = astParityGaps(
      ["LIV-01"],
      [
        { from: "AST-01", assertion: "a".repeat(50), to: ["LIV-01"] },
        { from: "AST-01", assertion: "b".repeat(50), to: ["LIV-01"] },
      ],
    );
    expect(gaps).toEqual(["AST-01: re-homed twice — one row per retired case"]);
  });
});

describe("assessAstParity", () => {
  it("holds when every home passed", () => {
    const report = assessAstParity(allPass(), corpusIds());
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.unmeasured).toEqual([]);
    expect(report.rows.every((r) => r.held)).toBe(true);
    expect(renderAstParity(report)).toContain("PARITY HOLDS");
  });

  it("does not hold when a home is red, and names the assertion that lost its home", () => {
    const results = allPass().map((r) => (r.id === "LIV-03" ? result("LIV-03", "fail") : r));
    const report = assessAstParity(results, corpusIds());
    expect(report.ok).toBe(false);
    expect(report.failed.map((r) => r.from)).toEqual(["AST-07"]);
    const text = renderAstParity(report);
    expect(text).toContain("PARITY DOES NOT HOLD");
    expect(text).toContain("✗ LIV-03");
  });

  it("an unmeasured home is reported as unmeasured, never as a pass", () => {
    const report = assessAstParity(allPass().filter((r) => r.id !== "NUD-05"), corpusIds());
    expect(report.unmeasured.map((r) => r.from)).toContain("AST-06");
    expect(report.rows.find((r) => r.from === "AST-06")!.held).toBe(false);
    expect(renderAstParity(report)).toContain("– NUD-05");
    // A home nobody ran is not a FAILURE — the run simply did not cover it.
    expect(report.failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a pending home is not a pass either", () => {
    const results = allPass().map((r) => (r.id === "EXE-05" ? result("EXE-05", "pending") : r));
    const report = assessAstParity(results, corpusIds());
    expect(report.rows.find((r) => r.from === "AST-04")!.held).toBe(false);
    expect(report.unmeasured.map((r) => r.from)).toContain("AST-04");
  });

  it("a static gap sinks the report even when every measured home passed", () => {
    const map: RehomedAssertion[] = [{ from: "AST-01", assertion: "a".repeat(50), to: ["LIV-01", "LIV-99"] }];
    const report = assessAstParity([result("LIV-01", "pass"), result("LIV-99", "pass")], ["LIV-01"], map);
    expect(report.ok).toBe(false);
    expect(report.gaps).toHaveLength(1);
  });
});
