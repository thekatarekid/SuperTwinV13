import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CATEGORIES,
  coverageGaps,
  FixtureError,
  loadDirectory,
  MATERIALIZED_CASES,
  parseFixture,
  TOTAL_CASES,
  validateFixture,
} from "./fixtures.js";
import { goodFixture } from "./testutil.js";

describe("validateFixture", () => {
  it("accepts the V2-header shape (structured or prose)", () => {
    const f = validateFixture(goodFixture(), "x.json");
    expect(f.id).toBe("ROL-01");
    expect(f.wrong[0]!.label).toBe("task-theft");
  });

  it("accepts a prose-only doc-materialized case", () => {
    const f = validateFixture(
      goodFixture({ setup: "cursors current; window = 5 min", input_events: ["7 msgs in Goa gang"], expected: "3 bundles" }),
      "x.json",
    );
    expect(f.input_events).toEqual(["7 msgs in Goa gang"]);
  });

  it("collects every problem at once", () => {
    try {
      validateFixture(
        {
          id: "bad",
          category: "ZZZ",
          title: "",
          pass: "Orient!",
          mode: "frozen",
          setup: "",
          input_events: [],
          expected: null,
          wrong: [{ label: "Bad Label", assert_absent: "" }],
          gates: ["Not_A_Gate"],
          source: { doc: "V3", section: 1 },
          frozen_response: "gone",
        },
        "bad.json",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as FixtureError;
      expect(e).toBeInstanceOf(FixtureError);
      const text = e.problems.join("\n");
      for (const needle of [
        "frozen_response",
        "id must look like",
        "title",
        "pass",
        "mode",
        "setup",
        "input_events",
        "expected",
        "wrong[0].label",
        "wrong[0].assert_absent",
        "gates[0]",
        "source.doc",
      ]) {
        expect(text).toContain(needle.split(" ")[0]!);
      }
    }
  });

  it("rejects a category that does not match the id prefix", () => {
    expect(() => validateFixture(goodFixture({ category: "TOP" }), "x.json")).toThrow(/does not match the id prefix/);
  });

  it("rejects duplicate wrong labels", () => {
    expect(() =>
      validateFixture(
        goodFixture({
          wrong: [
            { label: "task-theft", assert_absent: "a" },
            { label: "task-theft", assert_absent: "b" },
          ],
        }),
        "x.json",
      ),
    ).toThrow(/duplicate label/);
  });

  it("allows an unknown category prefix only for selftest fixtures", () => {
    expect(() => validateFixture(goodFixture({ id: "STB-01", category: "STB" }), "x.json")).toThrow(/not a category/);
    const f = validateFixture(goodFixture({ id: "STB-01", category: "STB", selftest: true }), "x.json");
    expect(f.selftest).toBe(true);
  });

  it("rejects JSON that is not valid", () => {
    expect(() => parseFixture("{nope", "x.json")).toThrow(/not valid JSON/);
  });
});

describe("loadDirectory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    dirs.push(dir);
    return dir;
  }

  it("loads fixtures one level deep, sorted, with duplicate-id detection", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ROL-02.json"), JSON.stringify(goodFixture({ id: "ROL-02" })));
    mkdirSync(join(dir, "selftest"));
    writeFileSync(
      join(dir, "selftest", "STB-01.json"),
      JSON.stringify(goodFixture({ id: "STB-01", category: "STB", selftest: true })),
    );
    writeFileSync(join(dir, "ROL-01.json"), JSON.stringify(goodFixture()));
    const report = loadDirectory(dir);
    expect(report.errors).toEqual([]);
    expect(report.fixtures.map((f) => f.id)).toEqual(["ROL-01", "ROL-02", "STB-01"]);
  });

  it("reports a file whose name disagrees with its id", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ROL-09.json"), JSON.stringify(goodFixture({ id: "ROL-01" })));
    const report = loadDirectory(dir);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.message).toContain("named ROL-01.json");
  });

  it("collects errors instead of throwing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ROL-01.json"), "{broken");
    writeFileSync(join(dir, "ROL-02.json"), JSON.stringify(goodFixture({ id: "ROL-02" })));
    const report = loadDirectory(dir);
    expect(report.errors).toHaveLength(1);
    expect(report.fixtures).toHaveLength(1);
  });
});

describe("coverage", () => {
  it("the doc-parsed half never moves; every authored category owns its own row", () => {
    // THE TRIPWIRE IS ON WHAT THE DOCS OWN. `MATERIALIZED_CASES` — the cases
    // --materialize parses out of the V1/V2 docs — is 138 and stays 138
    // (materialize.test.ts pins the same number against the files on disk).
    // It was 147 until R1 RETIRED the whole AST category with the assist lane
    // (build §2.3 / §7.3 step 3): nine doc-parsed cases whose lane no longer
    // exists. That is the only direction this number is ever allowed to move
    // — a category leaving because the product retired it, never one arriving.
    // TOTAL_CASES is NOT a fixed number: every V6 P1 task lands an `authored`
    // category of its own, so a hard-coded total would make each lane rewrite
    // this line, and two lanes landing in one stage would fight over it. What
    // is asserted instead is the invariant between the two constants, the V1
    // half (nothing is being added there), and one row per category below —
    // which is the assertion that actually catches a typo'd `n` or `pass`.
    expect(MATERIALIZED_CASES).toBe(138);
    expect(CATEGORIES.filter((c) => c.doc === "V1").reduce((s, c) => s + c.n, 0)).toBe(72);
    expect(TOTAL_CASES).toBe(
      MATERIALIZED_CASES +
        CATEGORIES.filter((c) => c.authored).reduce((s, c) => s + c.n, 0) +
        CATEGORIES.reduce((s, c) => s + (c.authoredExtra ?? 0), 0),
    );
    // V6 P1 S5.3 — the derived calendar, five code cases on the `calendar` pass.
    expect(CATEGORIES.find((c) => c.cat === "CAL")).toMatchObject({ n: 5, pass: "calendar", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "TIER")?.n).toBe(4);
    expect(CATEGORIES.find((c) => c.cat === "DIG")?.n).toBe(2);
    // V6 P1 S4.6 — the brief, two code cases on the `brief` pass.
    expect(CATEGORIES.find((c) => c.cat === "BRF")).toMatchObject({ n: 2, pass: "brief", authored: true });
    expect(CATEGORIES.some((c) => c.cat === "SEG")).toBe(false);
    // R1 — the assist lane and its nine cases are gone from the inventory.
    expect(CATEGORIES.some((c) => c.cat === "AST")).toBe(false);
    expect(CATEGORIES.some((c) => c.pass === "assist")).toBe(false);
    expect(CATEGORIES.some((c) => c.cat === "BND")).toBe(true);
    expect(CATEGORIES.find((c) => c.cat === "CON")?.authored).toBe(true);
    expect(CATEGORIES.find((c) => c.cat === "IDEM")?.n).toBe(1);
    // V6 P1 §7.3 — CROSS-N2 (S3 gate, commit) plus CROSS-N50 (the S4 ship gate,
    // on its own `cross` pass); the category row keeps CROSS-N2's pass.
    expect(CATEGORIES.find((c) => c.cat === "CROSS")).toMatchObject({ n: 2, pass: "commit", authored: true });
    // V6 P1 S5.6 — Settings, three code cases on the `settings` pass.
    expect(CATEGORIES.find((c) => c.cat === "SET")).toMatchObject({ n: 3, pass: "settings", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "SPC")).toMatchObject({ n: 8, pass: "space", authored: true });
    // V6 P1 S4.1 + S4.4 — LIV-01..06 (the live call) plus LIV-07 (no starvation).
    expect(CATEGORIES.find((c) => c.cat === "LIV")).toMatchObject({ n: 7, pass: "live", authored: true });
    // V6 P1 S4.2 — EXE is executor-lite now: five code cases on the `lite` pass.
    expect(CATEGORIES.find((c) => c.cat === "EXE")).toMatchObject({ n: 5, doc: "V2", pass: "lite", authored: true });
    // V6 P1 S5.5 — the grounded bar (ten code cases) and the three new FIX cases.
    expect(CATEGORIES.find((c) => c.cat === "BAR")).toMatchObject({ n: 10, pass: "bar", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "FIX")).toMatchObject({ n: 9, pass: "feedback", authoredExtra: 3 });
    // V6 P1 S5.4 — the personal CRM. ROL and CIR stay doc-parsed categories;
    // their FIXTURES are re-authored code cases, which materialize() protects
    // file by file (isV6P1Authored).
    expect(CATEGORIES.find((c) => c.cat === "CRM")).toMatchObject({ n: 5, pass: "crm", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "ROL")).toMatchObject({ n: 10, pass: "orient+extract" });
    expect(CATEGORIES.find((c) => c.cat === "CIR")).toMatchObject({ n: 4, pass: "circles" });
    // V6 P1 S4.3 — nudges and the surface router, nine code cases on `router`.
    expect(CATEGORIES.find((c) => c.cat === "NUD")).toMatchObject({ n: 9, pass: "router", authored: true });
    // V6 P1 S4.5 — the send gate, three code cases on `send-gate`.
    expect(CATEGORIES.find((c) => c.cat === "GATE-A")).toMatchObject({
      n: 3,
      pass: "send-gate",
      authored: true,
    });
    // V6 P1 S4.7 — injection surfacing, four code cases on `injection`.
    expect(CATEGORIES.find((c) => c.cat === "INJ")).toMatchObject({ n: 4, pass: "injection", authored: true });
  });

  it("coverageGaps ignores selftest fixtures and reports shortfalls", () => {
    const gaps = coverageGaps([goodFixture(), goodFixture({ id: "STB-01", category: "STB", selftest: true })]);
    expect(gaps.find((g) => g.startsWith("ROL"))).toContain("1 fixtures");
    expect(gaps.some((g) => g.startsWith("STB"))).toBe(false);
  });
});
