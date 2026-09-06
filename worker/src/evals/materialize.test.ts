import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "./cli.js";
import { CATEGORIES, MATERIALIZED_CASES } from "./fixtures.js";
import { isCodeCase, isV6P1Authored, materializeDocs, parseDoc, parseGates, parseWrong, REAUTHORED_MARK, toFixture } from "./materialize.js";

const v1 = readFileSync(join(repoRoot(), "SuperTwinV13_GoldenEvals_V1.md"), "utf8");
const v2 = readFileSync(join(repoRoot(), "SuperTwinV13_GoldenEvals_V2.md"), "utf8");

describe("parseWrong", () => {
  it("splits on · and extracts backticked labels with parenthetical detail", () => {
    const wrong = parseWrong("`time-blender` (one mega-bundle) · `stream-shatter` (per-event bundles).");
    expect(wrong).toEqual([
      { label: "time-blender", assert_absent: "one mega-bundle" },
      { label: "stream-shatter", assert_absent: "per-event bundles" },
    ]);
  });

  it("keeps trailing emphasis as detail and survives label-only modes", () => {
    const wrong = parseWrong("`ghost-call` (any model invocation without a trace) — hard fail.");
    expect(wrong[0]!.label).toBe("ghost-call");
    expect(wrong[0]!.assert_absent).toContain("any model invocation without a trace");
  });

  it("slugs a prose-only wrong mode", () => {
    const wrong = parseWrong("a task appears for the user anyway.");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.label).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("parseGates", () => {
  it("takes the first snake token per part and drops qualifiers", () => {
    expect(parseGates("containment, bundle_purity.")).toEqual(["containment", "bundle_purity"]);
    expect(parseGates("trace_coverage = 100% (hard).")).toEqual(["trace_coverage"]);
    expect(parseGates("over_split_rate (hard input to over_creation).")).toEqual(["over_split_rate"]);
    expect(parseGates("assignment_accuracy, over_creation (hard).")).toEqual(["assignment_accuracy", "over_creation"]);
  });
});

describe("isCodeCase", () => {
  it("marks BND and code-parenthetical titles deterministic", () => {
    expect(isCodeCase("BND", "Window cut, one bundle per active stream")).toBe(true);
    expect(isCodeCase("CAT", "Chat category by user-reply (pure code)")).toBe(true);
    expect(isCodeCase("TRC", "Liveness: no dead passes (code)")).toBe(true);
    expect(isCodeCase("SCH", "Wake-up reads before it calls (lookup first, code)")).toBe(true);
    expect(isCodeCase("ROL", "@mention receiver + no task theft")).toBe(false);
  });
});

describe("parseDoc against the real docs", () => {
  it("V1 yields 72 cases and skips SEG (and CRI / CON / EXE, hand-authored since V6 P1 S3.5 / S3.9 / S4.2)", () => {
    const cases = parseDoc(v1, "V1");
    expect(cases).toHaveLength(72);
    expect(cases.some((c) => c.id.startsWith("EXE"))).toBe(false);
    expect(cases.some((c) => c.id.startsWith("CRI"))).toBe(false);
    expect(cases.some((c) => c.id.startsWith("SEG"))).toBe(false);
    expect(cases.filter((c) => c.id.startsWith("TOP"))).toHaveLength(10);
  });

  it("V2 yields 66 cases — BND is hand-authored (S3.3) and AST is retired (R1)", () => {
    // parseDoc skips any `### CAT` section fixtures.ts does not list, so
    // retiring a category is one line there: the doc keeps its prose, the
    // parser stops writing fixtures for it. AST left with the assist lane.
    const cases = parseDoc(v2, "V2");
    expect(cases).toHaveLength(66);
    expect(cases.filter((c) => c.id.startsWith("BND"))).toHaveLength(0);
    expect(cases.filter((c) => c.id.startsWith("AST"))).toHaveLength(0);
  });
});

describe("materializeDocs", () => {
  const fixtures = materializeDocs(v1, v2);

  it("produces the docs' full coverage — 138 validated fixtures (hand-authored V6 categories excluded)", () => {
    expect(fixtures).toHaveLength(MATERIALIZED_CASES);
    expect(MATERIALIZED_CASES).toBe(138);
    const perCat = new Map<string, number>();
    for (const f of fixtures) perCat.set(f.category, (perCat.get(f.category) ?? 0) + 1);
    // `authoredExtra` cases (FIX-07..09) are hand-written, so the doc owes
    // this category fewer than its table's `n`.
    for (const c of CATEGORIES.filter((c) => !c.authored)) {
      expect(perCat.get(c.cat)).toBe(c.n - (c.authoredExtra ?? 0));
    }
    expect(fixtures.some((f) => f.category === "SRC")).toBe(false);
  });

  it("ROL-01 carries the header example's pass and a wrong[] with task-theft", () => {
    const rol1 = fixtures.find((f) => f.id === "ROL-01")!;
    expect(rol1.pass).toBe("orient+extract");
    expect(rol1.mode).toBe("live");
    expect(rol1.wrong.map((w) => w.label)).toContain("task-theft");
    expect(rol1.gates).toContain("false_receiver_assignment");
  });

  it("no BND case is materialized any more (authored under pass bundle)", () => {
    expect(fixtures.filter((x) => x.category === "BND")).toHaveLength(0);
    for (const f of fixtures.filter((x) => x.category === "BND")) {
      expect(f.mode).toBe("code");
      expect(f.pass).toBe("scheduler.dispatch");
    }
  });

  it("TRC-03 is the liveness case, code-asserted, feeding pass_liveness", () => {
    const trc3 = fixtures.find((f) => f.id === "TRC-03")!;
    expect(trc3.mode).toBe("code");
    expect(trc3.gates).toContain("pass_liveness");
    expect(trc3.wrong.map((w) => w.label)).toContain("dead-code-green");
  });

  it("a case under the wrong section fails loudly", () => {
    expect(() => parseDoc("## ROL — roles\n### TOP-01 · x\n", "V2")).toThrow(/appears under section/);
  });

  it("a case missing a field fails loudly", () => {
    expect(() =>
      toFixture({ id: "ROL-01", title: "t", doc: "V2", fields: { Setup: "s", Input: "i" } }),
    ).toThrow(/missing Expected, Wrong, Gates/);
  });
});

describe("isV6P1Authored (V6 P1 S5.2)", () => {
  it("protects the V1/V2 ids the V6 P1 doc re-authored from being regenerated", () => {
    const dir = join(repoRoot(), "evals", "v13");
    // TSK-01/02, SCH-01..03 and FUP-01 are hand-written code cases now
    // (GoldenEvals V6P1 §5.17); --materialize must leave them alone. TSK-03
    // is protected for the other reason (R3): its id is NOT in §5, but the
    // V1 doc's wording measures a suggestion budget the product removed, so
    // the file on disk is a re-authoring and carries REAUTHORED_MARK.
    for (const id of ["TSK-01", "TSK-02", "SCH-01", "SCH-02", "SCH-03", "FUP-01", "TSK-03"]) {
      expect(isV6P1Authored(join(dir, `${id}.json`))).toBe(true);
    }
    expect(readFileSync(join(dir, "TSK-03.json"), "utf8")).toContain(REAUTHORED_MARK);
    // The carried V1/V2 cases in the same categories still regenerate.
    for (const id of ["SCH-04", "SCH-08", "FUP-02", "FUP-05", "ROL-01"]) {
      expect(isV6P1Authored(join(dir, `${id}.json`))).toBe(false);
    }
    expect(isV6P1Authored(join(dir, "NOPE-99.json"))).toBe(false);
  });
});
