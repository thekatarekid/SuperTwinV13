// ===========================================================================
// P4 eval executors — offline coverage. NO live model calls: only the
// executors whose paths are pure code (USR-06 bar threads) run here; the live
// ones (USR-01…05, FIX-03, TRC-02) are exercised by `npm run eval` in the
// Gates phase. CIR moved to executors/people.test.ts in V6 P1 S5.4.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../../db/connection.js";
import { registerProductExecutors } from "./index.js";
import { tracesExecutor, userObjectsExecutor } from "./p4.js";
import { getExecutor } from "../runner.js";
import type { Fixture } from "../fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-p4exec-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_EVAL_DRAFTS_DIR = join(tmpDir, "eval-drafts");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_EVAL_DRAFTS_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function fixture(id: string, pass: string): Fixture {
  return {
    id,
    category: id.slice(0, 3),
    title: id,
    pass,
    mode: "live",
    setup: "",
    input_events: [],
    expected: "",
    wrong: [],
    gates: [],
    source: { doc: "V2", section: id },
  } as unknown as Fixture;
}

describe("P4 executor registration", () => {
  it("registers the four P4 passes", async () => {
    await registerProductExecutors();
    for (const pass of ["user-objects", "circles", "feedback", "traces"]) {
      expect(getExecutor(pass), pass).toBeDefined();
    }
  });

  it("unwired ids report PENDING (not a fake pass, not a fake fail)", async () => {
    const trc = await tracesExecutor({ fixture: fixture("TRC-01", "traces") });
    expect(trc.pending).toMatch(/trc-01/i);
  });
});

describe("USR-06 — bar history is a real surface (code path)", () => {
  it("threads list, reopen, continue, and stay searchable as events", async () => {
    const result = await userObjectsExecutor({ fixture: fixture("USR-06", "user-objects") });
    expect(result.ok).toBe(true);
    const out = result.output as Record<string, unknown>;
    expect(out.all_12_seeded_threads_listed).toBe(true);
    expect((out.thread_after_continuation as unknown[]).length).toBe(3);
    expect(out.searchable_in_timeline_fts).toBe(true);
  });

  it("cleans up its seeded bar events", async () => {
    await userObjectsExecutor({ fixture: fixture("USR-06", "user-objects") });
    const { getDb } = await import("../../db/connection.js");
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'bar.message'`).get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
