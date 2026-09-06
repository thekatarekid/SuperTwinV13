// ===========================================================================
// REC executor (V6 P1 S6e · E2): the five code cases run against the real
// fixtures in evals/v13 through the real recovery/space-repair.ts — sandboxed
// DB, zero model calls, and each case restores the shared home it borrowed.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { registerProductExecutors } from "./index.js";
import { recoveryExecutor } from "./rec.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-rec-eval-"));
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

function tableCount(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("repair");
  const r = await recoveryExecutor({ fixture });
  // Nothing in this category may reach a provider: no run rows, ever.
  expect(tableCount("runs")).toBe(0);
  return r;
}

describe("REC executor (REC-01..05)", () => {
  it("registers under `repair`", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("repair");
  });

  it("REC-01: the preview prices the damage and writes nothing", async () => {
    const r = await run("REC-01");
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics).toMatchObject({ model_calls: 0, preview_writes: 0 });
  });

  it("REC-02: a discarded birth is restored at the propose-only status, evidence-free", async () => {
    const r = await run("REC-02");
    expect(r.ok).toBe(true);
    const out = r.output as { space: { status: string; createdBy: string; birthEvidence: unknown[] } };
    expect(out.space.status).toBe("proposed");
    expect(out.space.createdBy).toBe("repair");
    expect(out.space.birthEvidence).toEqual([]);
  });

  it("REC-03: neither a critic duplicate nor an unverifiable quote is replayed", async () => {
    const r = await run("REC-03");
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics?.replayed_on_merits).toBe(0);
  });

  it("REC-04: a second and third run write nothing — the idempotency gate", async () => {
    const r = await run("REC-04");
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics?.repeat_writes).toBe(0);
    // The gate is scored from the fixture's `gates: ["idempotency"]`, so the
    // executor must NOT emit a second observation for the same case.
    expect(r.gateObservations).toBeUndefined();
  });

  it("REC-05: the repair attaches nothing; the sweep is offered the orphan", async () => {
    const r = await run("REC-05");
    expect(r.ok).toBe(true);
    expect(r.metrics?.episodes_attached_by_repair).toBe(0);
  });

  it("every case leaves the home exactly as it found it", async () => {
    const before = {
      spaces: tableCount("spaces"),
      episodes: tableCount("episodes"),
      decisions: tableCount("decisions"),
      unsorted: tableCount("unsorted"),
      events: tableCount("events"),
    };
    for (const id of ["REC-01", "REC-02", "REC-03", "REC-04", "REC-05"]) await run(id);
    expect({
      spaces: tableCount("spaces"),
      episodes: tableCount("episodes"),
      decisions: tableCount("decisions"),
      unsorted: tableCount("unsorted"),
      events: tableCount("events"),
    }).toEqual(before);
  });
});
