// ===========================================================================
// FACT / TYP executor (V6 P1 S3.6): the nine code cases run against the real
// fixtures in evals/v13 through the real extract pass with recorded
// extract.v6 outputs — zero model calls, sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { claimsExecutor } from "./fact.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-fact-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("claims");
  return claimsExecutor({ fixture });
}

describe("claims executor (FACT / TYP)", () => {
  for (const id of ["FACT-01", "FACT-02", "FACT-03", "FACT-04", "FACT-05", "FACT-06", "TYP-01", "TYP-02", "TYP-03"]) {
    it(`${id} passes with no violations, overwrite = 0 and model_calls = 0`, async () => {
      const r = await run(id);
      expect(r.notes?.filter((n) => n.startsWith("FAIL"))).toEqual([]);
      expect(r.violations).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.metrics?.overwrite).toBe(0);
      expect(r.metrics?.model_calls).toBe(0);
    });
  }

  it("FACT-01 · the old claim keeps its row (overwrite = 0) and the new one is linked", async () => {
    const r = await run("FACT-01");
    const out = r.output as { written: Array<{ supersedes: string | null; valid_from: string | null }> };
    expect(out.written[0]!.supersedes).not.toBeNull();
    expect(out.written[0]!.valid_from).toBe("2026-09-15");
  });

  it("TYP-03 · the midpoint is refused and the currency does not survive alone", async () => {
    const r = await run("TYP-03");
    const out = r.output as { written: Array<{ fields: { amount: number | null; currency: string | null } }> };
    expect(out.written[0]!.fields).toMatchObject({ amount: null, currency: null });
    expect(r.metrics?.typed_fields_dropped).toBe(2);
  });

  it("leaves the harness DB clean after every case", async () => {
    await run("FACT-01");
    await run("TYP-02");
    const db = getDb();
    for (const t of ["claim_versions", "claims", "events", "episodes", "episode_events", "tone_profiles"]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    }
  });
});
