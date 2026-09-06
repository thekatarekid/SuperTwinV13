import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BASELINE_ENV } from "./baseline.js";
import { countLines, main, parseArgs, repoRoot, selectFixtures } from "./cli.js";
import { goodFixture } from "./testutil.js";

describe("parseArgs", () => {
  it("defaults to evals/v13, haiku judge, full coverage", () => {
    const o = parseArgs([]);
    expect(o.dir.endsWith(join("evals", "v13"))).toBe(true);
    expect(o.judge).toBe("haiku");
    expect(o.checkCoverage).toBe(true);
  });

  it("--cat ROL,BND selects categories and drops the coverage check", () => {
    const o = parseArgs(["--cat", "ROL,BND"]);
    expect(o.cats).toEqual(["ROL", "BND"]);
    expect(o.checkCoverage).toBe(false);
  });

  it("rejects an unknown flag and a bad judge", () => {
    expect(() => parseArgs(["--frozen"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--judge", "gpt"])).toThrow(/haiku\|stub\|none/);
  });

  it("--mode code narrows to deterministic cases and drops the coverage check", () => {
    const o = parseArgs(["--mode", "code"]);
    expect(o.mode).toBe("code");
    expect(o.checkCoverage).toBe(false);
    expect(() => parseArgs(["--mode", "frozen"])).toThrow(/live\|code/);
  });

  it("parses the baseline flags", () => {
    expect(parseArgs(["--baseline"]).baseline).toBe(true);
    expect(parseArgs([]).compareBaseline).toBe(false);
    expect(parseArgs(["--cat", "TOP", "--compare-baseline"]).compareBaseline).toBe(true);
    const o = parseArgs(["--record-baseline", "--model-calls", "12", "--note", "live TIM"]);
    expect(o.recordBaseline).toBe(true);
    expect(o.modelCalls).toBe(12);
    expect(o.note).toBe("live TIM");
    expect(parseArgs([]).modelCalls).toBeNull();
    expect(() => parseArgs(["--model-calls", "-1"])).toThrow(/non-negative integer/);
    expect(parseArgs(["--calls-log", "x.log"]).callsLog).toBe(join(process.cwd(), "x.log"));
    expect(() => parseArgs(["--calls-log", "x.log", "--model-calls", "1"])).toThrow(/exclusive/);
  });
});

describe("selectFixtures", () => {
  const rol = goodFixture();
  const bnd = goodFixture({ id: "BND-01", category: "BND", pass: "bundle", mode: "code" });
  const stb = goodFixture({ id: "STB-01", category: "STB", selftest: true });

  it("filters by category and excludes selftest cases from a mixed load", () => {
    const picked = selectFixtures([rol, bnd, stb], parseArgs(["--cat", "ROL"]));
    expect(picked.map((f) => f.id)).toEqual(["ROL-01"]);
    const all = selectFixtures([rol, bnd, stb], parseArgs([]));
    expect(all.map((f) => f.id)).toEqual(["ROL-01", "BND-01"]);
  });

  it("runs selftest cases when the load is selftest-only (--dir)", () => {
    const picked = selectFixtures([stb], parseArgs(["--dir", "evals/v13/selftest"]));
    expect(picked.map((f) => f.id)).toEqual(["STB-01"]);
  });

  it("--mode code keeps only code cases", () => {
    const picked = selectFixtures([rol, bnd], parseArgs(["--mode", "code"]));
    expect(picked.map((f) => f.id)).toEqual(["BND-01"]);
    expect(selectFixtures([rol, bnd], parseArgs(["--mode", "live"])).map((f) => f.id)).toEqual(["ROL-01"]);
  });
});

describe("countLines", () => {
  it("counts non-empty lines and reads a missing file as 0", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "evals-calls-"));
    try {
      expect(countLines(join(dir, "none.log"))).toBe(0);
      const p = join(dir, "calls.log");
      writeFileSync(p, "");
      expect(countLines(p)).toBe(0);
      writeFileSync(p, "a\nb\nc\n");
      expect(countLines(p)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  it("runs the committed harness self-test green with the stub judge — no live calls", async () => {
    const lines: string[] = [];
    const code = await main(
      ["--dir", join(repoRoot(), "evals", "v13", "selftest"), "--judge", "stub"],
      (l) => lines.push(l),
    );
    const text = lines.join("\n");
    expect(text).toContain("VERDICT: green");
    expect(code).toBe(0);
  });

  it("--record-baseline writes the run's tallies and --baseline prints them — stub judge, no live calls", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "evals-baseline-"));
    const path = join(dir, "v13.json");
    // Two pre-existing lines: the run must record the DELTA (0), not the total.
    const callsLog = join(dir, "calls.log");
    (await import("node:fs")).writeFileSync(callsLog, "earlier\nearlier\n");
    process.env[BASELINE_ENV] = path;
    try {
      const missing: string[] = [];
      expect(await main(["--baseline"], (l) => missing.push(l))).toBe(2);
      expect(missing.join("\n")).toContain("no baseline at");

      const recorded: string[] = [];
      const code = await main(
        [
          "--dir",
          join(repoRoot(), "evals", "v13", "selftest"),
          "--judge",
          "stub",
          "--record-baseline",
          "--calls-log",
          callsLog,
          "--note",
          "harness self-test",
        ],
        (l) => recorded.push(l),
      );
      expect(code).toBe(0);
      expect(recorded.join("\n")).toContain(`recorded 1 category tally(ies) into ${path} (model calls: 0)`);
      expect(existsSync(path)).toBe(true);

      const printed: string[] = [];
      expect(await main(["--baseline"], (l) => printed.push(l))).toBe(0);
      const text = printed.join("\n");
      expect(text).toContain(`eval baseline — ${path}`);
      expect(text).toMatch(/STB\s+3\s+3\s+0\s+0\s+100%\s+live/);
      expect(text).toContain("model calls: 0");
      expect(text).toContain("harness self-test");
    } finally {
      delete process.env[BASELINE_ENV];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 3 on a bad flag", async () => {
    const lines: string[] = [];
    expect(await main(["--nope"], (l) => lines.push(l))).toBe(3);
    expect(lines[0]).toContain("unknown flag");
  });

  it("exits 2 on an empty fixture directory", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "evals-empty-"));
    expect(await main(["--dir", dir], () => {})).toBe(2);
  });
});
