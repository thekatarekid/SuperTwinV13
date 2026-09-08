// ===========================================================================
// SET executor (V6 P1 S5.6) — the three Settings cases run against the real
// fixtures in evals/v13 through the real product code (scheduler/v6/dispatch.ts,
// settings/golden-gate.ts, settings/p1-settings.ts) on a sandboxed DB.
//
// ZERO model calls: SET-01's sink is a stub, SET-02's golden runner is a stub
// standing in for the eval CLI, SET-03 never leaves the dispatcher.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { appStateGet } from "../../db/ingest.js";
import { providerModelKey } from "../../db/settings.js";
import { goldenRunnerInstalled, installGoldenRunner } from "../../settings/golden-gate.js";
import { FRESHNESS_KEY } from "../../scheduler/v6/dispatch.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { registerProductExecutors } from "./index.js";
import { settingsExecutor } from "./set.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-set-eval-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  installGoldenRunner(null);
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("settings");
  return settingsExecutor({ fixture });
}

function out(r: { output?: unknown }): Record<string, unknown> {
  return (r.output ?? {}) as Record<string, unknown>;
}

describe("SET executor", () => {
  it("registers under `settings`", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("settings");
  });

  it("SET-01: a step turned off holds its bundles — no sink call, no stamp, no attempt row, no dead letter", async () => {
    const r = await run("SET-01");
    const o = out(r);
    expect(o.while_off).toMatchObject({
      sink_calls: 0,
      undispatched: 3,
      dead_letters: 0,
      attempt_rows: 0,
    });
    expect((o.while_off as { held_for_step: number }).held_for_step).toBeGreaterThanOrEqual(1);
    // Switched back on, the next tick hands over exactly what was queued.
    expect(o.after_on).toEqual({ sink_calls: 1, events_in_bundle: 3, undispatched: 0 });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics?.model_calls).toBe(0);
  });

  it("SET-01 leaves the on/off key exactly as it found it", async () => {
    expect(appStateGet("process_enabled_orient")).toBeNull();
    await run("SET-01");
    expect(appStateGet("process_enabled_orient")).toBeNull();
  });

  it("SET-02: a red compare blocks the switch and names the categories; a green one applies it", async () => {
    const r = await run("SET-02");
    const o = out(r);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(o.runner_calls).toBe(2);
    expect(o.provider).toBe("claude-local");
    expect(o.provider_model_key).toBe(providerModelKey("claude-local", "decide"));
    // The runner was asked for Decide's categories with the candidate as an override.
    expect(o.runner_asked).toEqual({ categories: expect.arrayContaining(["DEC"]), override_model: "sonnet" });
    const outcomes = o.outcomes as {
      proposed: string;
      gate: string;
      applied: boolean;
      selected_after: string;
      regressed: string[];
    }[];
    // First: proposal returns RUNNING with the old model still in force; the
    // settled verdict is blocked and haiku survives.
    expect(outcomes[0]).toMatchObject({ proposed: "running", gate: "blocked", applied: false, selected_after: "haiku" });
    expect(outcomes[0]!.regressed).toEqual(["DEC"]);
    // Second: green → applied.
    expect(outcomes[1]).toMatchObject({ gate: "passed", applied: true, selected_after: "sonnet" });
    expect(r.metrics?.model_calls).toBe(0);
  });

  it("SET-02 uninstalls its stub runner and restores the model key", async () => {
    await run("SET-02");
    expect(goldenRunnerInstalled()).toBe(false);
    expect(appStateGet("selected_model_decide")).toBeNull();
    expect(appStateGet(providerModelKey("claude-local", "decide"))).toBeNull();
    // The gate's own decision rows are cleaned up with the case.
    const n = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_id IN (?, 'selected_model_decide','golden_gate_decide')`)
        .get(providerModelKey("claude-local", "decide")) as { n: number }
    ).n;
    expect(n).toBe(0);
  });

  it("SET-03: the freshness preset moves the running dispatcher's cold window between ticks", async () => {
    const r = await run("SET-03");
    const o = out(r);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(o.windows).toEqual([
      { preset: "balanced", idle_s: 300, max_s: 540 },
      { preset: "live", idle_s: 120, max_s: 180 },
      { preset: "relaxed", idle_s: 420, max_s: 600 },
    ]);
    // An unknown preset is refused by name and the window holds.
    expect(o.after_refused).toEqual({ preset: "relaxed", idle_s: 420, max_s: 600 });
    expect(o.restart_needed).toBe(false);
    expect((o.refused as string[]).length).toBeGreaterThan(0);
    expect(r.metrics?.model_calls).toBe(0);
    // No max window above the 10-minute promise, ever.
    for (const w of o.windows as { max_s: number }[]) expect(w.max_s).toBeLessThanOrEqual(600);
  });

  it("SET-03 restores the preset key it found", async () => {
    expect(appStateGet(FRESHNESS_KEY)).toBeNull();
    await run("SET-03");
    expect(appStateGet(FRESHNESS_KEY)).toBeNull();
  });

  it("an id with no case is a loud failure, not a silent pass", async () => {
    const fixture = loadFixture(join(FIX, "SET-01.json"));
    await expect(settingsExecutor({ fixture: { ...fixture, id: "SET-99" } })).rejects.toThrow(/no case for SET-99/);
  });
});
