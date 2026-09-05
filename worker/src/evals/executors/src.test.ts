// ===========================================================================
// SRC executor (V6 P1 S1.4): the three code cases run against the real
// fixtures in evals/v13 — zero model calls, zero DB.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { loadFixture } from "../fixtures.js";
import { sourceQualityExecutor, src01Code, src10Code } from "./src.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("source-quality");
  return sourceQualityExecutor({ fixture });
}

describe("source-quality executor", () => {
  it("SRC-01 passes: v,t · q · path kept; Netflix tracking dropped; survivors sorted", async () => {
    const r = await run("SRC-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as Array<{ text: string; params: string[] }>;
    expect(out[0]!.params).toEqual(["t", "v"]);
    expect(out[1]!.text).toBe("https://www.google.com/search?q=tfidf");
    expect(out[2]!.text).toBe("http://rd3.localhost:7373/?path=%2FUsers%2Fme%2Fnotes%2Froadmap.md");
    expect(out[3]!.text).toBe("https://www.netflix.com/watch/81234567");
    expect(r.metrics!.url_text_tracking_bytes).toBeGreaterThan(100);
  });

  it("SRC-01 catches the named wrong modes", () => {
    const r = src01Code([{ url: "https://x.example/?b=1&a=2&utm_source=z", keep: ["a", "b", "c"] }]);
    expect(r.ok).toBe(false);
    expect(r.violations!.map((v) => v.label)).toEqual(["content-param-stripped"]);
  });

  it("SRC-02 passes: payload.url byte-identical for every visit, text differs where params were stripped", async () => {
    const r = await run("SRC-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as Array<{ identical: boolean; text_differs: boolean }>;
    expect(out.every((o) => o.identical)).toBe(true);
    expect(out.filter((o) => o.text_differs).length).toBeGreaterThanOrEqual(3);
  });

  it("SRC-10 passes: one packed line, ×6, first–last times, all six rows kept", async () => {
    const r = await run("SRC-10");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as { lines: string[]; runs: string[][]; events: number };
    expect(out.events).toBe(7);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain("×6");
    expect(out.lines[0]).toContain("e1–e6");
    expect(out.runs[0]).toHaveLength(6);
    expect(r.metrics!.survivors).toBe(7);
  });

  it("SRC-10 flags the six-lines wrong mode when the window is too small to fold", () => {
    const r = src10Code([{ url: "https://x.example/", count: 6, start: "2026-08-28T13:58:00.000Z", step_ms: 40_000, transitions: ["typed"], visit_count: 3 }]);
    expect(r.ok).toBe(false);
    expect(r.violations!.map((v) => v.label)).toContain("six-lines");
  });

  it("other SRC ids report pending (owned by S1.5 / S1.6), never a fake verdict", async () => {
    const fixture = loadFixture(join(FIX, "SRC-01.json"));
    const r = await sourceQualityExecutor({ fixture: { ...fixture, id: "SRC-03" } });
    expect(r.pending).toContain("SRC-03");
    expect(r.ok).toBeUndefined();
  });
});
