// ===========================================================================
// BRF executor (V6 P1 S4.6): the two code cases run against the real fixtures
// in evals/v13 through the real brief lane — seeded world, canned provider,
// zero live model calls, sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { setConsentGateMode } from "../../db/consent-gate.js";
import { loadFixture } from "../fixtures.js";
import type { ExecutorResult } from "../runner.js";
import { brfExecutor, proseFromLedger } from "./brf.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-brf-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  setConsentGateMode("open");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(id: string): Promise<ExecutorResult & { out: Record<string, unknown> }> {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  const result = await brfExecutor({ fixture });
  return { ...result, out: result.output as Record<string, unknown> };
}

describe("BRF-01 — brief only on a delta", () => {
  it("spends nothing and writes nothing on an unchanged world model", async () => {
    const r = await run("BRF-01");
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    const quiet = r.out.unchanged as Record<string, unknown>;
    expect(quiet.status).toBe("skipped");
    expect(quiet.reason).toBe("no_delta");
    expect(quiet.provider_calls).toBe(0);
    expect(quiet.brief_rows_written).toBe(0);
    expect(r.metrics?.clock_only_call).toBe(0);
    expect(r.gateObservations?.[0]).toEqual({ gateId: "clock_only_call", passed: true, counted: true });
  });

  it("wakes on one world-model write — the skip is a lookup, not a mute", async () => {
    const r = await run("BRF-01");
    const woken = r.out.after_one_write as Record<string, unknown>;
    expect(woken.status).toBe("composed");
    expect(woken.model_calls).toBe(1);
    expect(woken.provider_calls).toBe(1);
  });

  it("leaves the database as it found it", async () => {
    await run("BRF-01");
    const n = getDb().prepare(`SELECT COUNT(*) AS n FROM briefs`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("BRF-02 — brief composition", () => {
  it("composes three parts from the world model and buys exactly one call", async () => {
    const r = await run("BRF-02");
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.out.status).toBe("composed");
    expect(r.out.model_calls).toBe(1);
    const ledger = r.out.ledger as Record<string, { source: string }[]>;
    expect(ledger.needs_you.length).toBeGreaterThan(0);
    expect(ledger.today.length).toBeGreaterThan(0);
    expect(ledger.moved.length).toBeGreaterThan(0);
  });

  it("keeps every line's source chip and invents no figure", async () => {
    const r = await run("BRF-02");
    const ledger = r.out.ledger as Record<string, { source: string; text: string }[]>;
    for (const part of ["needs_you", "today", "moved"] as const) {
      for (const item of ledger[part]!) {
        expect(item.source).toBeTruthy();
        expect(item.text.trim()).not.toBe("");
      }
    }
    expect(r.metrics?.brief_inflation).toBe(0);
    expect(r.metrics?.uncited_item).toBe(0);
    expect(r.metrics?.figures_invented).toBe(0);
    expect(String(r.out.text)).toContain("Needs you");
    expect(String(r.out.text)).toContain("Today");
    expect(String(r.out.text)).toContain("Moved");
  });

  it("leaves the database as it found it", async () => {
    await run("BRF-02");
    for (const table of ["briefs", "tasks", "spaces", "questions", "calendar_events", "artifacts"]) {
      const n = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect({ table, n: n.n }).toEqual({ table, n: 0 });
    }
  });
});

describe("the canned brief.v2 stand-in", () => {
  it("can only echo the ledger it was handed", () => {
    const packed = ["NEEDS YOU", "- [t1] Pay ₹8,400", "", "TODAY", "- [c1] Dinner 20:00", "", "MOVED", "- (nothing)"].join("\n");
    expect(proseFromLedger(packed)).toBe("**Needs you** · Pay ₹8,400\n**Today** · Dinner 20:00");
  });
});
