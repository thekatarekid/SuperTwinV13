// ===========================================================================
// Unit tests for db/decisions.ts ordering.
//
// `decisions.created_at` is `strftime('%Y-%m-%dT%H:%M:%fZ','now')` —
// MILLISECOND precision. Adjacent writes (a pass writing its batch, or a
// create immediately followed by the user's approve) land inside the same
// millisecond almost every time; measured at 191/200 on this machine. So the
// tie-break is not a rare edge, it is the common path, and it decides what the
// "why?" surface calls "the latest decision".
//
// It used to tie-break on `id`, which is `dec_` + 9 random bytes. That made
// same-millisecond ordering a coin flip: 84/200 runs returned the SUPERSEDED
// decision first. The tie-break is now `rowid` — insertion order — because
// SQLite assigns max(rowid)+1, which is greater than every surviving row even
// after deletes.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "./connection.js";
import { runMigrations } from "./index.js";
import { decisionsFor, writeDecision } from "./decisions.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-decisions-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** How many of these rows actually share a created_at, so the test can say
 *  whether it exercised the tie-break at all rather than silently passing. */
function collidingTimestamps(targetId: string): number {
  const rows = getDb()
    .prepare(`SELECT created_at FROM decisions WHERE target_id = ?`)
    .all(targetId) as { created_at: string }[];
  return rows.length - new Set(rows.map((r) => r.created_at)).size;
}

describe("decisionsFor ordering", () => {
  it("returns the newest decision first when both land in the same millisecond", () => {
    // 60 independent targets: with a random tie-break this fails with
    // probability 1 - 2^-60. With insertion order it cannot fail.
    let exercised = 0;
    for (let i = 0; i < 60; i++) {
      const target = `sp_${i}`;
      writeDecision({
        pass: "decide",
        targetKind: "space",
        targetId: target,
        action: "create",
        new: { status: "proposed" },
      });
      writeDecision({
        pass: "user",
        targetKind: "space",
        targetId: target,
        action: "approve",
        old: { status: "proposed" },
        new: { status: "active" },
      });
      if (collidingTimestamps(target) > 0) exercised++;
      const rows = decisionsFor("space", target);
      expect(rows.map((r) => r.action)).toEqual(["approve", "create"]);
    }
    // Guard the guard: if writes ever stop colliding this test would pass for
    // the wrong reason, so assert it really did exercise same-ms ordering.
    expect(exercised).toBeGreaterThan(0);
  });

  it("keeps a real created_at gap authoritative over insertion order", () => {
    // An explicitly back-dated row must still sort by its timestamp, so the
    // rowid tie-break may only apply WITHIN one millisecond.
    getDb()
      .prepare(
        `INSERT INTO decisions (id, pass, target_kind, target_id, action, created_at)
         VALUES ('dec_old', 'decide', 'space', 'sp_gap', 'create', '2020-01-01T00:00:00.000Z')`,
      )
      .run();
    writeDecision({ pass: "user", targetKind: "space", targetId: "sp_gap", action: "approve" });
    getDb()
      .prepare(
        `INSERT INTO decisions (id, pass, target_kind, target_id, action, created_at)
         VALUES ('dec_future', 'decide', 'space', 'sp_gap', 'close', '2099-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(decisionsFor("space", "sp_gap").map((r) => r.action)).toEqual([
      "close",
      "approve",
      "create",
    ]);
  });

  it("orders a whole same-millisecond batch by insertion order", () => {
    const actions = ["create", "link", "merge", "update", "close"];
    for (const action of actions) {
      writeDecision({ pass: "decide", targetKind: "space", targetId: "sp_batch", action });
    }
    expect(collidingTimestamps("sp_batch")).toBeGreaterThan(0);
    expect(decisionsFor("space", "sp_batch").map((r) => r.action)).toEqual([...actions].reverse());
  });
});
