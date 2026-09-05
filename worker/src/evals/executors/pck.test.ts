// ===========================================================================
// PCK executor (V6 P1 S3.2): the seven code cases run against the real
// fixtures in evals/v13 through the real packer — zero model calls,
// sandboxed DB, harness DB left clean after every case.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { packExecutor } from "./pck.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-pck-eval-"));
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
  expect(fixture.pass).toBe("pack");
  const r = await packExecutor({ fixture });
  // Clean after itself: no case rows survive.
  const db = getDb();
  expect((db.prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(0);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  return r;
}

describe("pack executor", () => {
  it("PCK-01 passes: nine blocks in order, one untrusted block, candidates with exemplars", async () => {
    const r = await run("PCK-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.blocks_present).toBe(9);
    expect(r.metrics!.untrusted_blocks).toBe(1);
    expect(r.metrics!.model_calls).toBe(0);
  });

  it("PCK-02 passes: exactly 5 candidates over 104 spaces, pack under 16,000 and flat", async () => {
    const r = await run("PCK-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.candidates).toBe(5);
    expect(r.metrics!.packer_enumeration).toBe(0);
    expect(r.metrics!.pack_chars).toBeLessThan(16_000);
    expect(Math.abs(r.metrics!.pack_chars - r.metrics!.pack_chars_small)).toBeLessThan(300);
  });

  it("PCK-03 passes: 37 history events, varying with the episode", async () => {
    const r = await run("PCK-03");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.history_events).toBe(37);
    expect((r.output as { short_episode_history: number }).short_episode_history).toBe(16);
  });

  it("PCK-04 passes: the 40-day-old quoted message is in the thread block", async () => {
    const r = await run("PCK-04");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.quoted_present).toBe(1);
  });

  it("PCK-05 passes: 4,000 for one event, 400 for 150", async () => {
    const r = await run("PCK-05");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.allowance_1).toBe(4_000);
    expect(r.metrics!.allowance_150).toBe(400);
  });

  it("PCK-06 passes: thin, held once, then instructed — no model call, nothing marked", async () => {
    const r = await run("PCK-06");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.thin).toBe(1);
    expect(r.metrics!.held_once).toBe(1);
  });

  it("PCK-07 passes: 0 model calls, under 200 ms over 104 spaces", async () => {
    const r = await run("PCK-07");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.packer_escalation).toBe(0);
    expect(r.metrics!.pack_ms).toBeLessThan(200);
  });
});
