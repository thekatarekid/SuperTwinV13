// ===========================================================================
// GATE executor (V6 P1 S3.3): the ten code cases run against the real
// fixtures in evals/v13 through the real scheduler/v6 gate, burst, cold window
// and dispatcher — zero model calls, sandboxed DB. GATE-10 replays a seeded
// synthetic 63-day corpus.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { gateExecutor } from "./gate.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-gate-eval-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("gate");
  return gateExecutor({ fixture });
}

describe("GATE executor", () => {
  for (const id of ["GATE-01", "GATE-02", "GATE-03", "GATE-04", "GATE-05", "GATE-06", "GATE-07", "GATE-08", "GATE-09"]) {
    it(`${id} passes with no violations and content_gated_call = 0`, async () => {
      const r = await run(id);
      expect(r.violations ?? []).toEqual([]);
      expect(r.metrics?.content_gated_call).toBe(0);
      expect(r.ok).toBe(true);
    });
  }

  it("GATE-10 · the 63-day replay stays under 200 calls/day with hot median ≤ 60 s, and cleans up", async () => {
    const r = await run("GATE-10");
    const out = r.output as { callsPerDay: { max: number; total: number }; hotMedianS: number; days: number; replayMs: number };
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(out.days).toBe(63);
    expect(out.callsPerDay.max).toBeLessThanOrEqual(200);
    expect(out.hotMedianS).toBeLessThanOrEqual(60);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
  }, 120_000);
});
