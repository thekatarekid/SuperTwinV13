// ===========================================================================
// Decide work queue (build P1.4, spec §6.3.2): one pending row per space,
// merge-in on re-enqueue (priority upgrades, never downgrades), claim =
// per-space lock, merge-ins during a run survive the finish.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import {
  claimDecideBatch,
  enqueueDecide,
  finishDecide,
  pendingDecideCount,
  releaseDecide,
} from "./decide-queue.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-dq-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  getDb()
    .prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_a', 'goa dec trip', 'active')`)
    .run();
  getDb()
    .prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_b', 'side project', 'active')`)
    .run();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("decide queue", () => {
  it("keeps ONE row per space and merges new episodes in", () => {
    enqueueDecide("sp_a", ["ep_1", "ep_2"]);
    const merged = enqueueDecide("sp_a", ["ep_2", "ep_3"], "backfill");
    expect(merged.episodeIds.sort()).toEqual(["ep_1", "ep_2", "ep_3"]);
    // backfill never downgrades an existing live entry
    expect(merged.priority).toBe("live");
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM decide_queue`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("upgrades priority on merge-in, never downgrades", () => {
    enqueueDecide("sp_a", ["ep_1"], "backfill");
    expect(enqueueDecide("sp_a", ["ep_2"], "urgent").priority).toBe("urgent");
    expect(enqueueDecide("sp_a", ["ep_3"], "backfill").priority).toBe("urgent");
  });

  it("claims by priority then age, and a claimed space cannot be claimed twice", () => {
    enqueueDecide("sp_a", ["ep_1"], "backfill");
    enqueueDecide("sp_b", ["ep_2"], "urgent");
    const batch = claimDecideBatch(10);
    expect(batch.map((r) => r.spaceId)).toEqual(["sp_b", "sp_a"]);
    expect(claimDecideBatch(10)).toEqual([]); // all running — serial per space
  });

  it("finish deletes the row unless episodes merged in while running", () => {
    enqueueDecide("sp_a", ["ep_1"]);
    const [claimed] = claimDecideBatch(1);
    enqueueDecide("sp_a", ["ep_9"]); // merges into the RUNNING row
    finishDecide(claimed.spaceId, claimed.episodeIds);
    expect(pendingDecideCount()).toBe(1);
    const [again] = claimDecideBatch(1);
    expect(again.episodeIds).toEqual(["ep_9"]); // only the unprocessed id
    finishDecide(again.spaceId, again.episodeIds);
    expect(pendingDecideCount()).toBe(0);
  });

  it("release puts a failed claim back to pending with its work intact", () => {
    enqueueDecide("sp_a", ["ep_1"]);
    const [claimed] = claimDecideBatch(1);
    releaseDecide(claimed.spaceId);
    const [again] = claimDecideBatch(1);
    expect(again.episodeIds).toEqual(["ep_1"]);
  });
});
