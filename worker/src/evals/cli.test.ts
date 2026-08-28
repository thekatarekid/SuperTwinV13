import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { main, parseArgs, repoRoot, selectFixtures } from "./cli.js";
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
});

describe("selectFixtures", () => {
  const rol = goodFixture();
  const bnd = goodFixture({ id: "BND-01", category: "BND", pass: "scheduler.dispatch", mode: "code" });
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
