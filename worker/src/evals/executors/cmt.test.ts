// ===========================================================================
// CMT executor (V6 P1 S3.1): the five code cases run against the real
// fixtures in evals/v13 through the real commit path — zero model calls,
// sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { commitExecutor } from "./cmt.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cmt-eval-"));
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
  expect(fixture.pass).toBe("commit");
  return commitExecutor({ fixture });
}

describe("commit executor", () => {
  it("CMT-01 passes: membership rows equal the cited aliases, no ranges", async () => {
    const r = await run("CMT-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.episode_membership_explicit).toBe(1);
    expect(r.metrics!.model_calls).toBe(0);
  });

  it("CMT-02 passes: the S1+S2 item rejects alone; streams derive from the events", async () => {
    const r = await run("CMT-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as { rejections: Array<{ reason: string }>; held: string[] };
    expect(out.rejections.map((x) => x.reason)).toEqual(["multi_stream"]);
    expect(out.held).toEqual(["e1", "e2"]);
  });

  it("CMT-03 passes: 4 of 5 commit, e3 held, cursor at e2, e3 re-collected alone", async () => {
    const r = await run("CMT-03");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as { recollected: string[]; stamped: string[] };
    expect(out.recollected).toEqual(["e3"]);
    expect(out.stamped).toEqual(["e1", "e2", "e4", "e5"]);
    expect(r.metrics!.held_events).toBe(1);
  });

  it("CMT-04 passes: the fabricated quote is a reject, fabricated_evidence = 0", async () => {
    const r = await run("CMT-04");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics!.fabricated_evidence).toBe(0);
    const out = r.output as { unsorted_rows: number; rejections: Array<{ reason: string }> };
    expect(out.unsorted_rows).toBe(0);
    expect(out.rejections[0]!.reason).toBe("evidence_not_verbatim");
  });

  it("CMT-05 passes: e4 uncovered and e2 doubled are flagged; the first placement wins", async () => {
    const r = await run("CMT-05");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as { coverage: { uncovered: string[]; duplicated: string[] }; coverage_flags: number };
    expect(out.coverage).toEqual({ uncovered: ["e4"], duplicated: ["e2"] });
    expect(out.coverage_flags).toBe(1);
  });

  it("cleans the harness DB after each case", async () => {
    await run("CMT-01");
    await run("CMT-03");
    const db = getDb();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM episode_events`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM streams`).get()).toEqual({ n: 0 });
  });
});
