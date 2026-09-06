// ===========================================================================
// CON / IDEM executor (V6 P1 S3.9): the four code cases run against the real
// fixtures in evals/v13 through the real consolidation code (t2.ts, t3.ts)
// and the harness commit path — zero model calls (the judge is a stub),
// sandboxed DB. The legacy prose CON shape still routes to the live executor.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture, type Fixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { conExecutor, contentDigest, isV6ConFixture, type Con01Output, type Con02Output, type Con03Output, type IdemOutput } from "./con.js";
import { registerProductExecutors } from "./index.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-con-eval-"));
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
  expect(fixture.pass).toBe("consolidate");
  return conExecutor({ fixture });
}

function tableCount(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("CON / IDEM executor", () => {
  it("registers under `consolidate` (the V6 code cases and the legacy prose cases share the key)", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("consolidate");
  });

  it("routes only structured code fixtures to the code cases", () => {
    const v6 = loadFixture(join(FIX, "CON-01.json"));
    expect(isV6ConFixture(v6)).toBe(true);
    const prose: Fixture = { ...v6, id: "CON-09", mode: "live", setup: "two cards" };
    expect(isV6ConFixture(prose)).toBe(false);
  });

  it("CON-01 · an hour with no writes makes no call; one write wakes the roll and judges the pair once", async () => {
    const r = await run("CON-01");
    const out = r.output as Con01Output;
    expect(r.violations ?? []).toEqual([]);
    expect(out.unchanged).toMatchObject({ rollSkipped: true, changedRows: 0, modelCalls: 0, providerCalls: 0, questions: 0 });
    expect(out.changed).toMatchObject({ rollSkipped: false, modelCalls: 1, merged: 0, mergeQuestions: 1 });
    expect(out.changed.changedRows).toBeGreaterThan(0);
    expect(r.metrics?.clock_only_call).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("CON-02 · a 0.95 merge verdict is a merge QUESTION, never a silent merge; the answered flag is not re-asked", async () => {
    const r = await run("CON-02");
    const out = r.output as Con02Output;
    expect(r.violations ?? []).toEqual([]);
    expect(out.report).toMatchObject({ flagsProcessed: 1, merged: 0, mergeSuggestions: 1, modelCalls: 1 });
    expect(out.question?.kind).toBe("merge");
    expect(out.question?.status).toBe("open");
    expect(out.question?.options).toEqual(["merge", "keep"]);
    expect(out.suggestMergeDecision).toBe(true);
    expect(out.loserStatus).toBe("active");
    expect(out.episodeStillInLoser).toBe(true);
    expect(out.taskStillInLoser).toBe(true);
    expect(out.secondRunWrites).toBe(0);
    expect(r.metrics?.false_auto_merge).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("CON-03 · old claim versions get an end date; every row stays; a second pass ends nothing more", async () => {
    const r = await run("CON-03");
    const out = r.output as Con03Output;
    expect(r.violations ?? []).toEqual([]);
    expect(out.versionsBefore).toBe(6);
    expect(out.versionsAfter).toBe(6);
    expect(out.ended.map((e) => e.text)).toEqual(["rent is 21k", "rent is 22k"]);
    expect(out.ended.every((e) => e.valid_to !== null && e.closed_by === "consolidate:t3")).toBe(true);
    expect(out.openEnded).toBe(4);
    expect(out.compressDecisions).toBe(1);
    expect(out.secondRunEnded).toBe(0);
    expect(r.metrics?.deleted_rows).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("IDEM-01 · the same fixture batch twice: zero new episodes/claims/tasks/spaces, identical content digest", async () => {
    const r = await run("IDEM-01");
    const out = r.output as IdemOutput;
    expect(r.violations ?? []).toEqual([]);
    expect(out.first.committedEpisodes).toBe(1);
    expect(out.first.t2.mergeSuggestions).toBe(1);
    expect(out.first.t3Ended).toBe(1); // 5 versions: active + 4 non-active, keep 3, end 1
    expect(out.second.committedEpisodes).toBe(0);
    expect(out.second.stamped).toBe(0);
    expect(out.newRows).toEqual({});
    expect(out.byteIdentical).toBe(true);
    expect(r.metrics?.idempotency).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("every case cleans up after itself — the harness DB is left as it was found", async () => {
    const before = { spaces: tableCount("spaces"), episodes: tableCount("episodes"), events: tableCount("events"), claims: tableCount("claim_versions"), digest: contentDigest() };
    for (const id of ["CON-01", "CON-02", "CON-03", "IDEM-01"]) await run(id);
    expect({ spaces: tableCount("spaces"), episodes: tableCount("episodes"), events: tableCount("events"), claims: tableCount("claim_versions"), digest: contentDigest() }).toEqual(before);
  });
});
