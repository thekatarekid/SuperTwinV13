import http from "node:http";
import net from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installOfflineGuard, main, parseArgs, repoRoot, selectFixtures } from "./cli.js";
import { loadDirectory } from "./fixtures.js";

const SELFTEST = join(repoRoot(), "evals", "selftest");

function capture(): { out: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), text: () => lines.join("\n") };
}

describe("flags", () => {
  it("defaults to frozen mode over evals/fixtures", () => {
    const options = parseArgs([]);
    expect(options.mode).toBe("frozen");
    expect(options.dir).toBe(join(repoRoot(), "evals", "fixtures"));
    expect(options.checkCoverage).toBe(true);
  });

  it("reads the modes and the filters", () => {
    const options = parseArgs(["--live", "--only", "m,n", "--id", "m-014", "--measured", "--max-diff-lines", "8"]);
    expect(options.mode).toBe("live");
    expect(options.only).toEqual(["M", "N"]);
    expect(options.ids).toEqual(["M-014"]);
    expect(options.hideNoDataGates).toBe(true);
    expect(options.maxDiffLines).toBe(8);
    // A filtered run cannot claim §4 coverage.
    expect(options.checkCoverage).toBe(false);
  });

  it("rejects an unknown flag and a flag missing its value", () => {
    expect(() => parseArgs(["--fast"])).toThrow(/unknown flag --fast/);
    expect(() => parseArgs(["--dir"])).toThrow(/needs a value/);
  });

  it("filters fixtures by category and id", () => {
    const { fixtures } = loadDirectory(SELFTEST);
    expect(selectFixtures(fixtures, parseArgs(["--only", "S"]))).toHaveLength(3);
    expect(selectFixtures(fixtures, parseArgs(["--id", "A-901"]))).toHaveLength(1);
  });
});

describe("the offline guard", () => {
  it("turns every outbound transport into a loud failure, and puts it back", async () => {
    const originalFetch = globalThis.fetch;
    const restore = installOfflineGuard();
    try {
      expect(() => (globalThis.fetch as () => unknown)()).toThrow(/attempted a network call via fetch/);
      expect(() => net.connect(1234)).toThrow(/net\.connect/);
      expect(() => http.request("http://example.com")).toThrow(/http\.request/);
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(originalFetch);
    expect(typeof net.connect).toBe("function");
  });
});

describe("npm run eval", () => {
  it("runs the whole gold set offline and renders the gate report", async () => {
    const sink = capture();
    const code = await main([], sink.out);
    const text = sink.text();
    expect(code).toBe(0);
    expect(text).toContain("fixtures: 1000 loaded");
    expect(text).toContain("no network calls");
    expect(text).toContain("GATES (architecture §14.2)");
    // A–I, O, S, T, U and V are authored and run; the other 8 are stubs.
    expect(text).toContain("PENDING (420)");
    expect(text).toContain("cases:    1000 · pass 580 · fail 0 · pending 420");
  });

  it("goes green on the self-test directory", async () => {
    const sink = capture();
    const code = await main(["--dir", SELFTEST], sink.out);
    expect(code).toBe(0);
    expect(sink.text()).toContain("cases:    10 · pass 10 · fail 0 · pending 0");
  });

  it("fails the build (exit 1) when a case fails or a gate is breached", async () => {
    const sink = capture();
    // A-901 asserted against S-901's frozen response: real failure, real diff.
    const code = await main(["--dir", SELFTEST, "--id", "A-901,S-901", "--strict"], sink.out);
    expect(code).toBe(1); // --strict: gates with no measurement are not passes
    expect(sink.text()).toContain("unmeasured gate(s)");
  });

  it("exits 2 when a fixture directory does not validate", async () => {
    const sink = capture();
    const code = await main(["--dir", join(repoRoot(), "worker", "src", "evals")], sink.out);
    expect(code).toBe(2);
    expect(sink.text()).toContain("no fixtures found");
  });

  it("exits 3 when live mode is asked for without an invoker", async () => {
    const sink = capture();
    const code = await main(["--live", "--dir", SELFTEST], sink.out);
    expect(code).toBe(3);
    expect(sink.text()).toContain("--live-module");
  });

  it("exits 3 on a bad flag rather than pretending to run", async () => {
    const sink = capture();
    expect(await main(["--turbo"], sink.out)).toBe(3);
  });
});
