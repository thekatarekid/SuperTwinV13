// ===========================================================================
// BND executor (V6 P1 S3.3): the twelve code cases run against the real
// fixtures in evals/v13 through the real scheduler/v6 code — zero model calls,
// sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { bundleExecutor } from "./bnd.js";
import { registerProductExecutors } from "./index.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-bnd-eval-"));
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
  expect(fixture.pass).toBe("bundle");
  return bundleExecutor({ fixture });
}

describe("BND executor", () => {
  it("registers under `bundle` alongside `gate`", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("bundle");
    expect(registeredPasses()).toContain("gate");
    expect(registeredPasses()).not.toContain("scheduler.dispatch");
  });

  for (const id of ["BND-01", "BND-02", "BND-03", "BND-04", "BND-05", "BND-06", "BND-07", "BND-09", "BND-10", "BND-11", "BND-12"]) {
    it(`${id} passes with no violations`, async () => {
      const r = await run(id);
      expect(r.violations ?? []).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }

  it("BND-08 passes, reports dispatch_over_cap = 0, and leaves the harness DB clean", async () => {
    const r = await run("BND-08");
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics?.dispatch_over_cap).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM streams`).get() as { n: number }).n).toBe(0);
  });
});
