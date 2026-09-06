// ===========================================================================
// The golden gate (V6 P1 S5.6, SET-02) — a model change runs the golden set
// first; a regression blocks the switch. The runner is a stub: ZERO model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import {
  awaitGoldenRun,
  goldenRunnerInstalled,
  goldenState,
  harnessPresent,
  installCliGoldenRunnerIfAvailable,
  installGoldenRunner,
  parseCompareOutput,
  proposeStepChange,
  resetStaleGoldenRun,
  startGoldenRun,
  type GoldenRunRequest,
  type GoldenRunResult,
} from "./golden-gate.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-golden-"));
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

const stub = (answers: GoldenRunResult[]): { runner: (r: GoldenRunRequest) => Promise<GoldenRunResult>; calls: GoldenRunRequest[] } => {
  const calls: GoldenRunRequest[] = [];
  let i = 0;
  return {
    calls,
    runner: async (r) => {
      calls.push(r);
      return answers[Math.min(i++, answers.length - 1)]!;
    },
  };
};

const decisions = (targetId: string): { action: string; reason: string | null }[] =>
  getDb().prepare(`SELECT action, reason FROM decisions WHERE target_id = ? ORDER BY rowid`).all(targetId) as { action: string; reason: string | null }[];

describe("proposeStepChange", () => {
  it("no runner installed: applies at once and records the gate as skipped (what every unit test sees)", async () => {
    expect(goldenRunnerInstalled()).toBe(false);
    let applied = 0;
    const r = await proposeStepChange({ step: "decide", label: "Decide", model: "sonnet" }, () => void applied++);
    expect(applied).toBe(1);
    expect(r.status).toBe("skipped");
    expect(goldenState()).toMatchObject({ status: "skipped", step: "decide", applied: true, candidate: { model: "sonnet" } });
    expect(goldenState().summary).toMatch(/no golden runner installed/);
  });

  it("SET-02 · a red compare leaves the old model in place and writes a blocked decision naming the categories", async () => {
    appStateSet("selected_model_decide", "haiku");
    const s = stub([{ ok: false, regressed: ["DEC", "TSK"], summary: "COMPARE: red — below baseline: DEC, TSK" }]);
    installGoldenRunner(s.runner, "stub");
    const r = await proposeStepChange({ step: "decide", label: "Decide", model: "sonnet" }, () => appStateSet("selected_model_decide", "sonnet"));
    // Returns before the run settles, with the OLD model still in force.
    expect(r.status).toBe("running");
    expect(appStateGet("selected_model_decide")).toBe("haiku");
    const settled = await awaitGoldenRun();
    expect(settled.status).toBe("blocked");
    expect(settled.applied).toBe(false);
    expect(settled.regressed).toEqual(["DEC", "TSK"]);
    expect(appStateGet("selected_model_decide")).toBe("haiku");
    const d = decisions("golden_gate_decide");
    expect(d).toHaveLength(1);
    expect(d[0]!.action).toBe("blocked");
    expect(d[0]!.reason).toMatch(/DEC, TSK/);
    // The runner was asked for Decide's categories with the candidate as the override.
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.categories).toContain("DEC");
    expect(s.calls[0]!.overrides).toEqual({ decide: { model: "sonnet" } });
  });

  it("a green compare applies the change and records passed", async () => {
    appStateSet("selected_model_decide", "haiku");
    const s = stub([{ ok: true, regressed: [], summary: "COMPARE: green" }]);
    installGoldenRunner(s.runner, "stub");
    await proposeStepChange({ step: "decide", label: "Decide", thinking: "high" }, () => appStateSet("selected_thinking_decide", "high"));
    const settled = await awaitGoldenRun();
    expect(settled).toMatchObject({ status: "passed", applied: true, step: "decide", candidate: { thinking: "high" } });
    expect(appStateGet("selected_thinking_decide")).toBe("high");
    expect(s.calls[0]!.overrides).toEqual({ decide: { thinking: "high" } });
  });

  it("a runner that cannot run (throws / CLI missing) blocks the change as an error, never applies", async () => {
    installGoldenRunner(async () => {
      throw new Error("npm not found");
    }, "stub");
    let applied = 0;
    await proposeStepChange({ step: "orient", label: "Orient", model: "opus" }, () => void applied++);
    const settled = await awaitGoldenRun();
    expect(settled.status).toBe("error");
    expect(settled.applied).toBe(false);
    expect(settled.error).toMatch(/npm not found/);
    expect(applied).toBe(0);
    expect(decisions("golden_gate_orient")[0]!.action).toBe("error");
  });

  it("one run at a time: a second proposal while one is in flight reports running and is not applied", async () => {
    let release!: (r: GoldenRunResult) => void;
    installGoldenRunner(() => new Promise<GoldenRunResult>((res) => (release = res)), "stub");
    let a = 0;
    let b = 0;
    const first = await proposeStepChange({ step: "decide", label: "Decide", model: "sonnet" }, () => void a++);
    const second = await proposeStepChange({ step: "orient", label: "Orient", model: "sonnet" }, () => void b++);
    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    release({ ok: true, regressed: [], summary: "COMPARE: green" });
    await awaitGoldenRun();
    expect(a).toBe(1);
    expect(b).toBe(0);
    expect(goldenState().step).toBe("decide");
  });

  it("an unknown step asks for the whole set (categories null)", async () => {
    const s = stub([{ ok: true, regressed: [], summary: "COMPARE: green" }]);
    installGoldenRunner(s.runner, "stub");
    await proposeStepChange({ step: "mystery", label: "Mystery", model: "sonnet" }, () => {});
    await awaitGoldenRun();
    expect(s.calls[0]!.categories).toBeNull();
  });
});

describe("startGoldenRun (the ops button)", () => {
  it("refuses without a runner — a test worker can never spend through it", async () => {
    const r = await startGoldenRun(null, "manual");
    expect(r.started).toBe(false);
    expect(r.error).toMatch(/no golden runner/);
  });

  it("runs the shipped configuration (no overrides) and records passed / blocked", async () => {
    const s = stub([{ ok: false, regressed: ["TOP"], summary: "COMPARE: red — below baseline: TOP" }]);
    installGoldenRunner(s.runner, "stub");
    const r = await startGoldenRun(["TOP", "ASN"], "manual");
    expect(r.started).toBe(true);
    expect(r.state.status).toBe("running");
    const settled = await awaitGoldenRun();
    expect(settled).toMatchObject({ status: "blocked", regressed: ["TOP"], categories: ["TOP", "ASN"], step: null, applied: false });
    expect(s.calls[0]!.overrides).toEqual({});
    // A second start while running is refused.
    installGoldenRunner(() => new Promise(() => {}), "stub");
    const again = await startGoldenRun(null, "manual");
    expect(again.started).toBe(true);
    expect((await startGoldenRun(null, "manual")).error).toMatch(/already in flight/);
  });
});

describe("boot and the CLI runner", () => {
  it("a worker that restarted mid-run leaves error, not running", () => {
    appStateSet("intelligence.golden", JSON.stringify({ status: "running", started_at: "2026-09-06T00:00:00Z" }));
    resetStaleGoldenRun(new Date("2026-09-06T00:10:00Z"));
    expect(goldenState()).toMatchObject({ status: "error", finished_at: "2026-09-06T00:10:00.000Z" });
  });

  it("installs nothing when the harness is not on disk (a packaged app) and says so", () => {
    expect(harnessPresent(tmpDir)).toBe(false);
    const note = installCliGoldenRunnerIfAvailable({ root: tmpDir });
    expect(goldenRunnerInstalled()).toBe(false);
    expect(note).toMatch(/not found/);
  });

  it("parses the COMPARE verdict line", () => {
    expect(parseCompareOutput("…\nCOMPARE: green — no category below its frozen rate\n")).toEqual({ ok: true, regressed: [] });
    expect(parseCompareOutput("x\nCOMPARE: red — below baseline: DEC, TIM\n")).toEqual({ ok: false, regressed: ["DEC", "TIM"] });
    expect(parseCompareOutput("eval: 3 fixture(s) failed validation")).toBeNull();
  });
});
