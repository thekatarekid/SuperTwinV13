import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { assessLiveness, collectRunCounts, renderLiveness, V13_PASSES } from "./liveness.js";

describe("assessLiveness (TRC-03)", () => {
  it("passes only when every registered pass has runs in the window", () => {
    const counts: Record<string, number> = {};
    for (const pass of V13_PASSES) counts[pass] = 5;
    const report = assessLiveness(counts);
    expect(report.ok).toBe(true);
    expect(report.liveness).toBe(1);
  });

  it("fails loudly on a pass with tests but zero runs — dead-code-green", () => {
    const counts: Record<string, number> = {};
    for (const pass of V13_PASSES) counts[pass] = 5;
    delete counts.digest;
    const report = assessLiveness(counts);
    expect(report.ok).toBe(false);
    expect(report.liveness).toBeCloseTo(5 / 6);
    expect(report.entries.find((e) => e.pass === "digest")).toEqual({ pass: "digest", runs: 0, ok: false });
    expect(renderLiveness(report)).toContain("dead-code-green");
    expect(renderLiveness(report)).toContain("DEAD  digest");
  });
});

describe("collectRunCounts", () => {
  function db(): Database.Database {
    const handle = new Database(":memory:");
    handle.exec(`CREATE TABLE extraction_runs (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, role TEXT,
      created_at TEXT NOT NULL
    )`);
    return handle;
  }

  it("counts per pass inside the window, role over kind, excluding eval runs", () => {
    const handle = db();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const insert = handle.prepare("INSERT INTO extraction_runs (kind, role, created_at) VALUES (?, ?, ?)");
    insert.run("chat", "orient", now);
    insert.run("chat", "orient", now);
    insert.run("extract", null, now); // legacy row: falls back to kind
    insert.run("chat", "decide", old); // outside the 48h window
    insert.run("chat", "eval-judge", now); // the harness may not keep itself alive
    const counts = collectRunCounts(handle);
    expect(counts).toEqual({ orient: 2, extract: 1 });
  });
});
