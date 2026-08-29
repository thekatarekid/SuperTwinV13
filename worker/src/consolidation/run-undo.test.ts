// ===========================================================================
// Run undo — reverse-replay one run's decisions.
//
// The shipped 13.4.1 build rendered an "undo run" link in Settings › Runs &
// Traces against a route that was never implemented: every click 404'd. These
// tests pin the behaviour the link now has, and the two rules that bound its
// blast radius — a human's own row is never reversed, and a decision this
// build cannot restore is reported, never guessed at.
//
// Real DB, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { RUN_UNDO_BY, runUndoPreview, undoRun } from "./run-undo.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-run-undo-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedSpace(id: string, status = "active"): void {
  getDb()
    .prepare(`INSERT INTO spaces (id, label, status) VALUES (?, ?, ?)`)
    .run(id, `space ${id}`, status);
}

function seedEpisode(id: string, spaceId: string | null): void {
  getDb()
    .prepare(`INSERT INTO episodes (id, space_id, state, summary) VALUES (?, ?, 'open', ?)`)
    .run(id, spaceId, `episode ${id}`);
}

function seedTask(id: string, status: string): void {
  getDb()
    .prepare(`INSERT INTO tasks (id, title, status, risk_class) VALUES (?, ?, ?, 'safe-auto')`)
    .run(id, `task ${id}`, status);
}

function statusOf(table: "spaces" | "tasks", id: string): string {
  return (getDb().prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string })
    .status;
}

describe("run undo", () => {
  it("previews without touching anything, then reverses exactly that run", () => {
    seedSpace("sp_a");
    seedSpace("sp_b");
    seedEpisode("ep_moved", "sp_b");
    seedTask("tk_closed", "closed");

    // Run A: an episode moved sp_a → sp_b and a task closed.
    writeDecision({
      runId: "run_a",
      pass: "decide",
      targetKind: "episode",
      targetId: "ep_moved",
      action: "attach",
      old: { spaceId: "sp_a" },
      new: { spaceId: "sp_b" },
      reason: "same trip thread",
    });
    writeDecision({
      runId: "run_a",
      pass: "decide",
      targetKind: "task",
      targetId: "tk_closed",
      action: "close",
      old: { status: "open" },
      new: { status: "closed" },
      reason: "villa booked",
    });
    // Run B: a different run's work, which must survive untouched.
    seedEpisode("ep_other", "sp_b");
    writeDecision({
      runId: "run_b",
      pass: "decide",
      targetKind: "episode",
      targetId: "ep_other",
      action: "attach",
      old: { spaceId: null },
      new: { spaceId: "sp_b" },
    });

    // Preview is pure: it names the blast radius and changes nothing.
    const preview = runUndoPreview("run_a");
    expect(preview.items).toHaveLength(2);
    expect(preview.reversible).toBe(2);
    expect(preview.skipped).toBe(0);
    expect(preview.items.map((i) => `${i.targetKind}:${i.action}`).sort()).toEqual([
      "episode:attach",
      "task:close",
    ]);
    expect(preview.items.every((i) => i.reason !== undefined)).toBe(true);
    expect(statusOf("tasks", "tk_closed")).toBe("closed"); // still closed

    const result = undoRun("run_a");
    expect(result.reversed).toBe(2);
    expect(result.skipped).toBe(0);

    // The world moved back.
    const ep = getDb().prepare(`SELECT space_id FROM episodes WHERE id = 'ep_moved'`).get() as {
      space_id: string;
    };
    expect(ep.space_id).toBe("sp_a");
    expect(statusOf("tasks", "tk_closed")).toBe("open");

    // Exactly one run: run_b's episode is where run_b put it.
    const other = getDb().prepare(`SELECT space_id FROM episodes WHERE id = 'ep_other'`).get() as {
      space_id: string;
    };
    expect(other.space_id).toBe("sp_b");

    // The rows are marked reversed, attributed to the undo.
    const rows = getDb()
      .prepare(`SELECT reversed_at, reversed_by FROM decisions WHERE run_id = 'run_a'`)
      .all() as { reversed_at: string | null; reversed_by: string | null }[];
    expect(rows.every((r) => r.reversed_at !== null)).toBe(true);
    expect(rows.every((r) => r.reversed_by === RUN_UNDO_BY)).toBe(true);

    // Idempotent: a second undo has nothing left to reverse.
    const again = undoRun("run_a");
    expect(again.reversed).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.items.every((i) => i.skipReason === "already reversed")).toBe(true);
  });

  it("never reverses a human's row, and reports what it cannot restore", () => {
    seedSpace("sp_x", "proposed");
    seedEpisode("ep_x", null);

    // The user's own approval, recorded against the same run.
    writeDecision({
      runId: "run_c",
      pass: "user",
      targetKind: "space",
      targetId: "sp_x",
      action: "approve",
      old: { status: "proposed" },
      new: { status: "active" },
    });
    // A shape this build has no restore path for.
    writeDecision({
      runId: "run_c",
      pass: "decide",
      targetKind: "claim",
      targetId: "ck_1",
      action: "compress",
      old: { versions: [] },
    });
    // A restorable row with its payload missing — refused, not guessed at.
    writeDecision({
      runId: "run_c",
      pass: "decide",
      targetKind: "episode",
      targetId: "ep_x",
      action: "attach",
    });

    const preview = runUndoPreview("run_c");
    expect(preview.reversible).toBe(0);
    expect(preview.skipped).toBe(3);
    const byId = Object.fromEntries(preview.items.map((i) => [i.targetId, i.skipReason]));
    expect(byId.sp_x).toMatch(/human/i);
    expect(byId.ck_1).toMatch(/no restore path for claim:compress/);
    expect(byId.ep_x).toMatch(/no restore path for episode:attach/);

    const result = undoRun("run_c");
    expect(result.reversed).toBe(0);
    // The user's approval is untouched — status and ledger row both intact.
    const dec = getDb()
      .prepare(`SELECT reversed_at FROM decisions WHERE pass = 'user'`)
      .get() as { reversed_at: string | null };
    expect(dec.reversed_at).toBeNull();
  });

  it("an unknown run id is an empty, harmless preview", () => {
    const preview = runUndoPreview("run_nope");
    expect(preview.items).toHaveLength(0);
    expect(preview.reversible).toBe(0);
    expect(undoRun("run_nope").reversed).toBe(0);
  });
});
