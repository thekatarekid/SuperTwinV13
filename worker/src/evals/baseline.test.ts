import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BASELINE_SCHEMA,
  baselinePath,
  BASELINE_ENV,
  DEFAULT_METHOD,
  readBaseline,
  recordBaseline,
  renderBaseline,
  writeBaseline,
  type BaselineFile,
} from "./baseline.js";
import type { CaseResult, SuiteResult } from "./runner.js";

function result(over: Partial<CaseResult>): CaseResult {
  return {
    id: "X-01",
    category: "X",
    pass: "orient",
    mode: "live",
    status: "pass",
    judgeVerdict: null,
    wrongHits: [],
    metrics: {},
    gates: [],
    gateObservations: [],
    notes: [],
    durationMs: 1,
    ...over,
  };
}

function suite(results: CaseResult[]): SuiteResult {
  const byCat = new Map<string, { total: number; pass: number; fail: number; pending: number }>();
  for (const r of results) {
    const t = byCat.get(r.category) ?? { total: 0, pass: 0, fail: 0, pending: 0 };
    t.total += 1;
    t[r.status] += 1;
    byCat.set(r.category, t);
  }
  return {
    results,
    categories: [...byCat.entries()]
      .map(([category, t]) => ({ category, ...t, passRate: t.pass + t.fail > 0 ? t.pass / (t.pass + t.fail) : null }))
      .sort((a, b) => (a.category < b.category ? -1 : 1)),
    gates: [],
    totals: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      pending: results.filter((r) => r.status === "pending").length,
    },
    durationMs: 5,
  };
}

const AT1 = "2026-09-06T10:00:00.000Z";
const AT2 = "2026-09-06T11:00:00.000Z";

describe("recordBaseline", () => {
  it("writes per-category tallies, per-case statuses and the measured kind", () => {
    const file = recordBaseline(
      null,
      suite([
        result({ id: "BND-01", category: "BND", mode: "code", status: "pass" }),
        result({ id: "BND-02", category: "BND", mode: "code", status: "fail" }),
        result({ id: "TIM-01", category: "TIM", status: "pass" }),
        result({ id: "TIM-02", category: "TIM", mode: "code", status: "pass" }),
        result({ id: "ROL-01", category: "ROL", status: "pending" }),
      ]),
      { at: AT1, git: "abc1234", argv: ["--mode", "code"], modelCalls: 0 },
    );
    expect(file.schema).toBe(BASELINE_SCHEMA);
    expect(file.git).toBe("abc1234");
    expect(file.method).toEqual([...DEFAULT_METHOD]);
    expect(file.categories.BND).toMatchObject({ total: 2, pass: 1, fail: 1, pending: 0, rate: 0.5, measured: "code" });
    expect(file.categories.BND!.cases).toEqual({ "BND-01": "pass", "BND-02": "fail" });
    expect(file.categories.TIM).toMatchObject({ rate: 1, measured: "live" });
    expect(file.categories.ROL).toMatchObject({ total: 1, pending: 1, rate: null, measured: "pending" });
    // Every doc category is listed even when this run never touched it.
    expect(file.categories.TOP).toMatchObject({ total: 0, rate: null, measured: "not-run" });
    expect(Object.keys(file.categories)).toEqual([...Object.keys(file.categories)].sort());
    expect(file.runs).toHaveLength(1);
    expect(file.runs[0]).toMatchObject({ at: AT1, argv: ["--mode", "code"], categories: ["BND", "ROL", "TIM"], cases: 5, model_calls: 0 });
    expect(file.model_calls).toBe(0);
  });

  it("merges a later run: replaces only the categories it ran, appends the run, sums calls", () => {
    const first = recordBaseline(
      null,
      suite([
        result({ id: "BND-01", category: "BND", mode: "code", status: "pass" }),
        result({ id: "TIM-02", category: "TIM", mode: "code", status: "pass" }),
      ]),
      { at: AT1, git: "abc1234", argv: ["--mode", "code"], modelCalls: 0 },
    );
    const second = recordBaseline(
      first,
      suite([
        result({ id: "TIM-01", category: "TIM", status: "fail" }),
        result({ id: "TIM-02", category: "TIM", mode: "code", status: "pass" }),
      ]),
      { at: AT2, git: "def5678", argv: ["--cat", "TIM"], modelCalls: 7, note: "live TIM" },
    );
    expect(second.recorded_at).toBe(AT2);
    expect(second.categories.BND).toEqual(first.categories.BND);
    expect(second.categories.TIM).toMatchObject({ total: 2, pass: 1, fail: 1, rate: 0.5, measured: "live", recorded_at: AT2 });
    expect(second.runs).toHaveLength(2);
    expect(second.runs[1]!.note).toBe("live TIM");
    expect(second.model_calls).toBe(7);
  });

  it("reports model_calls as null when any contributing run was not counted", () => {
    const first = recordBaseline(null, suite([result({ id: "TIM-01", category: "TIM" })]), { at: AT1, modelCalls: 3 });
    const second = recordBaseline(first, suite([result({ id: "FIX-01", category: "FIX" })]), { at: AT2 });
    expect(second.model_calls).toBeNull();
    expect(second.runs.map((r) => r.model_calls)).toEqual([3, null]);
  });
});

describe("read/write/render", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    delete process.env[BASELINE_ENV];
  });

  it("round-trips through disk, creating the directory", () => {
    dir = mkdtempSync(join(tmpdir(), "eval-baseline-"));
    const path = join(dir, "nested", "v13.json");
    const file = recordBaseline(null, suite([result({ id: "TIM-01", category: "TIM" })]), { at: AT1, git: "abc1234" });
    writeBaseline(path, file);
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
    expect(readBaseline(path)).toEqual(file);
  });

  it("returns null for a missing file and throws on a foreign JSON file", () => {
    dir = mkdtempSync(join(tmpdir(), "eval-baseline-"));
    expect(readBaseline(join(dir, "none.json"))).toBeNull();
    const bad = join(dir, "bad.json");
    writeBaseline(bad, { schema: 99 } as unknown as BaselineFile);
    expect(() => readBaseline(bad)).toThrow(/not a schema-1 baseline/);
  });

  it("resolves the default path under evals/baseline and honours the env override", () => {
    expect(baselinePath("/repo")).toBe(join("/repo", "evals", "baseline", "v13.json"));
    process.env[BASELINE_ENV] = "/elsewhere/b.json";
    expect(baselinePath("/repo")).toBe("/elsewhere/b.json");
  });

  it("renders a category table, the runs and the method", () => {
    const file = recordBaseline(
      null,
      suite([
        result({ id: "TIM-01", category: "TIM", status: "pass" }),
        result({ id: "TIM-02", category: "TIM", status: "fail" }),
      ]),
      { at: AT1, git: "abc1234", argv: ["--cat", "TIM"], modelCalls: 4, note: "n" },
    );
    const text = renderBaseline(file, "/x/v13.json");
    expect(text).toContain("eval baseline — /x/v13.json");
    expect(text).toContain("model calls: 4");
    expect(text).toMatch(/TIM\s+2\s+1\s+1\s+0\s+50%\s+live/);
    expect(text).toMatch(/TOP\s+0\s+0\s+0\s+0\s+—\s+not-run/);
    expect(text).toContain("runs (1):");
    expect(text).toContain("[--cat TIM]");
    expect(text).toContain(DEFAULT_METHOD[0]!);
  });
});
