import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CATEGORIES,
  coverageGaps,
  FixtureError,
  loadDirectory,
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
  it("the category table totals 258 cases (78 from V1 minus SEG/CRI/CON, 180 from V2 incl. the V6P1 authored categories)", () => {
    expect(TOTAL_CASES).toBe(258);
    expect(CATEGORIES.filter((c) => c.doc === "V1").reduce((s, c) => s + c.n, 0)).toBe(78);
    expect(CATEGORIES.filter((c) => c.doc === "V2").reduce((s, c) => s + c.n, 0)).toBe(180);
    // V6 P1 S5.3 — the derived calendar, five code cases on the `calendar` pass.
    expect(CATEGORIES.find((c) => c.cat === "CAL")).toMatchObject({ n: 5, pass: "calendar", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "TIER")?.n).toBe(4);
    expect(CATEGORIES.find((c) => c.cat === "DIG")?.n).toBe(2);
    expect(CATEGORIES.some((c) => c.cat === "SEG")).toBe(false);
    expect(CATEGORIES.some((c) => c.cat === "BND")).toBe(true);
    expect(CATEGORIES.find((c) => c.cat === "CON")?.authored).toBe(true);
    expect(CATEGORIES.find((c) => c.cat === "IDEM")?.n).toBe(1);
    expect(CATEGORIES.find((c) => c.cat === "CROSS")?.pass).toBe("commit");
    // V6 P1 S5.6 — Settings, three code cases on the `settings` pass.
    expect(CATEGORIES.find((c) => c.cat === "SET")).toMatchObject({ n: 3, pass: "settings", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "SPC")).toMatchObject({ n: 8, pass: "space", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "LIV")).toMatchObject({ n: 6, pass: "live", authored: true });
    // V6 P1 S5.5 — the grounded bar (ten code cases) and the three new FIX cases.
    expect(CATEGORIES.find((c) => c.cat === "BAR")).toMatchObject({ n: 10, pass: "bar", authored: true });
    expect(CATEGORIES.find((c) => c.cat === "FIX")).toMatchObject({ n: 9, pass: "feedback", authoredExtra: 3 });
  });

  it("coverageGaps ignores selftest fixtures and reports shortfalls", () => {
    const gaps = coverageGaps([goodFixture(), goodFixture({ id: "STB-01", category: "STB", selftest: true })]);
    expect(gaps.find((g) => g.startsWith("ROL"))).toContain("1 fixtures");
    expect(gaps.some((g) => g.startsWith("STB"))).toBe(false);
  });
});
