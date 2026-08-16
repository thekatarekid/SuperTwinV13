// ===========================================================================
// The runner's accounting, against a REAL database.
//
// runner.test.ts swaps `recordRun` out and asserts on the params, which is the
// right shape for the repair/quarantine logic but says nothing about the two
// defects that only exist where the rows actually land:
//
//   * `runs.cohort_id` is a FOREIGN KEY onto `cohorts`. A sentinel id
//     ("steady", "-") does not park a call outside the import — it throws
//     inside the write and LOSES the row that was supposed to account for the
//     money. NULL is the stated answer.
//   * one provider call is one `runs` row AND one `extraction_runs` row. The
//     pipeline wrote only the first, so Settings → Recent runs — which reads
//     extraction_runs — rendered the entire derivation pipeline as $0.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, ProviderErrorCode, Usage } from "../providers/types.js";
import { resetLegendCache } from "./legend.js";
import { resetPromptFilesForTests, runPrompt, type PromptCallSpec, type RunnerDeps } from "./runner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-runner-acct-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetLegendCache();
  resetPromptFilesForTests();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Turn {
  text?: string;
  code?: ProviderErrorCode;
  message?: string;
}

/** One `send` per turn, in order — the same shape runner.test.ts uses. */
function fakeProvider(turns: Turn[]): Provider {
  let n = 0;
  return {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      const turn = turns[n++] ?? { text: "" };
      const usage: Usage = {
        inputTokens: 100,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 300,
        outputTokens: 40,
        costUsd: 0.25,
      };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: turn.message ?? "" });
        opts.onEvent({ type: "done", sessionId: "s", usage });
        return { sessionId: "s", usage, freshFallback: false, status: "error", errorCode: turn.code };
      }
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" };
    },
  };
}

function deps(turns: Turn[]): RunnerDeps {
  let t = 0;
  return {
    provider: fakeProvider(turns),
    pool: new ResourcePool({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    }),
  };
}

const CLEAN = "F | 1 | a1 | 1p | 0.9 | 2026-08-01 | likes filter coffee";

function spec(over: Partial<PromptCallSpec> = {}): PromptCallSpec {
  return {
    callType: "P-CL1",
    legend: { callType: "P-CL1", tags: ["F", "P"] },
    instructions: "Extract claims from the episode below.",
    user: "#E e1 coffee talk\n  1 09:12 a1 | I only drink filter",
    role: "extract",
    cohortId: null,
    model: "sonnet-5",
    unit: { kind: "episode", id: "epi-1" },
    ...over,
  };
}

function rows<T>(sql: string): T[] {
  return getDb().prepare(sql).all() as T[];
}

function cohort(id: string): string {
  getDb()
    .prepare(`INSERT INTO cohorts (id, mode, horizon, session_ids, state) VALUES (?, 'bootstrap', 'd7', '[]', 'planned')`)
    .run(id);
  return id;
}

describe("the cohort foreign key", () => {
  it("accepts an explicit null for a call that belongs to no cohort", async () => {
    const result = await runPrompt(spec({ cohortId: null }), deps([{ text: CLEAN }]));

    expect(result.status).toBe("ok");
    const written = rows<{ id: string; cohort_id: string | null; role: string }>(
      `SELECT id, cohort_id, role FROM runs`,
    );
    expect(written).toHaveLength(1);
    // The row EXISTS — the whole point. A sentinel id threw here and the call
    // was never accounted for at all.
    expect(written[0]!.cohort_id).toBeNull();
    expect(written[0]!.role).toBe("extract");
  });

  it("still attributes a call that does belong to one", async () => {
    const id = cohort("coh:bootstrap:d7:0");
    await runPrompt(spec({ cohortId: id }), deps([{ text: CLEAN }]));

    expect(rows<{ cohort_id: string | null }>(`SELECT cohort_id FROM runs`)[0]!.cohort_id).toBe(id);
  });

  it("quarantines under a null cohort too — same FK, same answer", async () => {
    const result = await runPrompt(
      spec({ cohortId: null }),
      deps([{ code: "TIMEOUT", message: "timed out" }, { code: "TIMEOUT" }, { code: "TIMEOUT" }, { code: "TIMEOUT" }]),
    );

    expect(result.status).toBe("quarantined");
    const parked = rows<{ cohort_id: string | null }>(`SELECT cohort_id FROM quarantine`);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.cohort_id).toBeNull();
  });
});

describe("the dual write", () => {
  it("lands derivation spend in extraction_runs exactly once per call", async () => {
    await runPrompt(spec(), deps([{ text: CLEAN }]));

    const runs = rows<{ id: string; cost_usd: number }>(`SELECT id, cost_usd FROM runs`);
    const log = rows<{ run_id: string; role: string | null; kind: string; cost_usd: number | null; provider: string }>(
      `SELECT run_id, role, kind, cost_usd, provider FROM extraction_runs`,
    );

    expect(runs).toHaveLength(1);
    expect(log).toHaveLength(1);
    // Joined on the run id, so a human can walk from one table to the other.
    expect(log[0]!.run_id).toBe(runs[0]!.id);
    expect(log[0]!.role).toBe("extract");
    expect(log[0]!.kind).toBe("P-CL1");
    expect(log[0]!.provider).toBe("fake");
    // The money is the CLI's own number, in BOTH tables. $0 in Settings →
    // Recent runs over a real bill is the defect this closes.
    expect(log[0]!.cost_usd).toBeCloseTo(0.25);
    expect(runs[0]!.cost_usd).toBeCloseTo(0.25);
  });

  it("does not double-write: one row per table per provider call, retries included", async () => {
    // Round one times out and is retried; the retry answers cleanly. Two
    // provider calls, therefore two rows in each table — never four, and never
    // one call mirrored twice by the two directions meeting.
    const result = await runPrompt(spec(), deps([{ code: "TIMEOUT", message: "timed out" }, { text: CLEAN }]));

    expect(result.status).toBe("ok");
    expect(result.runIds).toHaveLength(2);
    expect(rows(`SELECT id FROM runs`)).toHaveLength(2);
    expect(rows(`SELECT id FROM extraction_runs`)).toHaveLength(2);
    expect(rows<{ status: string }>(`SELECT status FROM runs ORDER BY started_at, id`).map((r) => r.status)).toEqual(
      expect.arrayContaining(["retried", "ok"]),
    );
    // extraction_runs carries the two-way grade; the finer one lives on `runs`.
    expect(
      rows<{ status: string }>(`SELECT status FROM extraction_runs ORDER BY id`).map((r) => r.status),
    ).toEqual(["error", "ok"]);
  });

  it("bills every provider call: the retry is real money and is counted", async () => {
    await runPrompt(spec(), deps([{ code: "TIMEOUT", message: "timed out" }, { text: CLEAN }]));

    const billed = getDb()
      .prepare(`SELECT COUNT(*) AS calls, SUM(cost_usd) AS cost FROM runs`)
      .get() as { calls: number; cost: number };
    // ONE logical invocation, TWO billed calls. A wallet that counts
    // invocations caps at half of what it pays.
    expect(billed.calls).toBe(2);
    expect(billed.cost).toBeCloseTo(0.5);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM extraction_runs`).get() as { n: number }).n).toBe(2);
  });
});
