// ===========================================================================
// The P1 setting groups and the Runs pane (V6 P1 S5.6) — Product_V6_Phase1 §25.
//
// Called through `handleSettingsRoute` directly: no port is opened, no worker
// is booted, and no golden runner is installed, so NOTHING here can reach the
// `claude` CLI. Zero model calls.
//
// Covered: Intelligence (per-step model / reasoning / on-off + the golden
// gate), Assist (freshness preset, burst, card duration, merge window, intent
// floor, blocked kinds, behavioral rules), Retrieval (agentic, scan limit,
// graph hops/fan-out, hubs; T2 rows served-but-hidden), AI Connector (doors,
// fallback order, ceilings, stop-all), and Runs (index, run detail with the
// undo preview, run diff, quarantine).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateSet } from "../db/ingest.js";
import { writeDecision } from "../db/decisions.js";
import { installGoldenRunner, type GoldenRunRequest, type GoldenRunResult } from "../settings/golden-gate.js";
import { handleSettingsRoute } from "./settings-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-settings-p1-"));
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

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number | null; body: any }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  ) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = path;
  let status: number | null = null;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const handled = await handleSettingsRoute(req, res);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

const get = (p: string) => call("GET", p);
const post = (p: string, b: unknown) => call("POST", p, b);

// ---------------------------------------------------------------------------
// Intelligence — model / reasoning / on-off per step, gated by the golden set
// ---------------------------------------------------------------------------

describe("Settings › Intelligence (§25)", () => {
  it("serves one row per LIVE pass stem, with the recommendation, the eval categories and the golden state", async () => {
    const r = await get("/api/settings/intelligence");
    expect(r.status).toBe(200);
    const keys = r.body.steps.map((s: { key: string }) => s.key);
    // The keys are the stems the runners spend under — a picker keyed on
    // `orient.v6` would be a setting nothing reads.
    expect(keys).toEqual([
      "orient",
      "critic",
      "extract",
      "decide",
      "digest",
      "consolidate",
      "assist",
      "executor",
      "chat",
      "tier",
      // S4.6's brief lane spends under its own stem, so Settings › Intelligence
      // gets its own row (categories BRF) — not a hidden sub-setting of digest.
      "brief",
    ]);
    const decide = r.body.steps.find((s: { key: string }) => s.key === "decide");
    expect(decide).toMatchObject({ label: "Decide", recommended: "sonnet", enabled: true });
    expect(decide.eval_categories).toContain("DEC");
    // No runner in a test build: the pane says so rather than pretending.
    expect(r.body.golden.runner_installed).toBe(false);
    expect(r.body.golden.state.status).toBe("idle");
  });

  it("on/off per step persists the key the dispatcher reads (SET-01)", async () => {
    const off = await post("/api/settings/intelligence", { step: "orient", enabled: false });
    expect(off.status).toBe(200);
    const after = await get("/api/settings/intelligence");
    expect(after.body.steps.find((s: { key: string }) => s.key === "orient").enabled).toBe(false);
    await post("/api/settings/intelligence", { step: "orient", enabled: true });
    const back = await get("/api/settings/intelligence");
    expect(back.body.steps.find((s: { key: string }) => s.key === "orient").enabled).toBe(true);
  });

  it("a model change with no runner installed applies and records the gate as skipped", async () => {
    const r = await post("/api/settings/intelligence", { step: "decide", model: "sonnet" });
    expect(r.status).toBe(200);
    expect(r.body.gate).toMatchObject({ status: "skipped" });
    const after = await get("/api/settings/intelligence");
    expect(after.body.steps.find((s: { key: string }) => s.key === "decide").selected).toBe("sonnet");
    expect(after.body.golden.state.summary).toMatch(/no golden runner installed/);
  });

  it("SET-02 through the route: a red compare blocks the switch, a green one lets it through", async () => {
    const calls: GoldenRunRequest[] = [];
    let answer: GoldenRunResult = { ok: false, regressed: ["DEC"], summary: "COMPARE: red — below baseline: DEC" };
    installGoldenRunner(async (req) => {
      calls.push(req);
      return answer;
    }, "test stub");

    const red = await post("/api/settings/intelligence", { step: "decide", model: "sonnet" });
    expect(red.body.gate.status).toBe("running"); // the switch has NOT happened yet
    const { awaitGoldenRun, goldenState } = await import("../settings/golden-gate.js");
    expect((await awaitGoldenRun()).status).toBe("blocked");
    let after = await get("/api/settings/intelligence");
    expect(after.body.steps.find((s: { key: string }) => s.key === "decide").selected).toBe("haiku");
    expect(goldenState().regressed).toEqual(["DEC"]);
    const blocked = getDb()
      .prepare(`SELECT action, reason FROM decisions WHERE target_id = 'golden_gate_decide'`)
      .all() as { action: string; reason: string }[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.action).toBe("blocked");
    expect(blocked[0]!.reason).toMatch(/DEC/);

    answer = { ok: true, regressed: [], summary: "COMPARE: green" };
    await post("/api/settings/intelligence", { step: "decide", model: "sonnet" });
    expect((await awaitGoldenRun()).status).toBe("passed");
    after = await get("/api/settings/intelligence");
    expect(after.body.steps.find((s: { key: string }) => s.key === "decide").selected).toBe("sonnet");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.overrides).toEqual({ decide: { model: "sonnet" } });
  });

  it("the manual golden run REFUSES (409) without a runner — a test worker can never spend through it", async () => {
    const r = await post("/api/settings/golden/run", {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no golden runner/);
  });

  it("the manual golden run measures the shipped configuration when a runner is installed", async () => {
    const calls: GoldenRunRequest[] = [];
    installGoldenRunner(async (req) => {
      calls.push(req);
      return { ok: true, regressed: [], summary: "COMPARE: green" };
    }, "test stub");
    const r = await post("/api/settings/golden/run", { categories: ["dec", " tim "], wait: true });
    expect(r.status).toBe(200);
    expect(r.body.state.status).toBe("passed");
    expect(calls[0]!.categories).toEqual(["DEC", "TIM"]);
    expect(calls[0]!.overrides).toEqual({}); // the SHIPPED config, no candidate
    const state = await get("/api/settings/golden");
    expect(state.body.state.status).toBe("passed");
    expect(state.body.runner_installed).toBe(true);
  });

  it("an unknown model is refused against the list the picker was served", async () => {
    const r = await post("/api/settings/intelligence", { step: "decide", model: "gpt-9" });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Assist — the P1 fields §25 adds
// ---------------------------------------------------------------------------

describe("Settings › Assist (§25)", () => {
  it("serves the freshness preset with its window and all three presets", async () => {
    const r = await get("/api/settings/assist");
    expect(r.status).toBe(200);
    expect(r.body.freshness).toBe("balanced");
    expect(r.body.freshness_window).toEqual({ idle_s: 300, max_s: 540 });
    expect(r.body.freshness_presets).toEqual({
      live: { idle_s: 120, max_s: 180 },
      balanced: { idle_s: 300, max_s: 540 },
      relaxed: { idle_s: 420, max_s: 600 },
    });
    expect(r.body.card_duration_s).toBe(60);
  });

  it("SET-03: the preset round-trips and an unknown one is refused by name", async () => {
    const live = await post("/api/settings/assist", { freshness: "live" });
    expect(live.body.freshness_window).toEqual({ idle_s: 120, max_s: 180 });
    const bad = await post("/api/settings/assist", { freshness: "turbo" });
    expect(bad.status).toBe(200);
    expect(bad.body.refused[0]).toMatch(/freshness must be one of/);
    expect(bad.body.freshness).toBe("live"); // the old value holds
  });

  it("burst K/W, card duration, merge window and the intent floor clamp to their rails", async () => {
    const r = await post("/api/settings/assist", {
      burst: { k: 9, window_s: 240 },
      card_duration_s: 5000,
      merge_window_s: 30,
      intent_floor: 0.8,
    });
    expect(r.body.burst).toEqual({ k: 9, window_s: 240 });
    expect(r.body.card_duration_s).toBe(600); // clamped, not rejected
    expect(r.body.merge_window_s).toBe(30);
    expect(r.body.intent_floor).toBe(0.8);
    const junk = await post("/api/settings/assist", { intent_floor: "loads" });
    expect(junk.body.refused).toContain("intent_floor must be a number 0–1");
    expect(junk.body.intent_floor).toBe(0.8);
  });

  it("blocked kinds and behavioral rules are a list you can add to and take back", async () => {
    const add = await post("/api/settings/assist", {
      blocked_kinds: ["nudge:price_drop", "nudge:price_drop", "nudge:birthday"],
      add_rule: "never nudge me about deliveries",
    });
    expect(add.body.blocked_kinds).toEqual(["nudge:price_drop", "nudge:birthday"]); // deduped
    expect(add.body.behavioral_rules).toHaveLength(1);
    expect(add.body.behavioral_rules[0].text).toBe("never nudge me about deliveries");
    const id = add.body.behavioral_rules[0].id;
    const gone = await post("/api/settings/assist", { remove_rule: id });
    expect(gone.body.behavioral_rules).toEqual([]);
    const nope = await post("/api/settings/assist", { remove_rule: "rule_nothing" });
    expect(nope.body.refused).toContain("remove_rule names no rule");
  });
});

// ---------------------------------------------------------------------------
// Retrieval and AI Connector — the two groups §25 adds that had no route
// ---------------------------------------------------------------------------

describe("Settings › Retrieval (§25, T2 rows hidden)", () => {
  it("serves agentic on/off, the scan limit, graph hops/fan-out and the hub list", async () => {
    const r = await get("/api/settings/retrieval");
    expect(r.status).toBe(200);
    expect(r.body.agentic).toBe(true);
    expect(r.body.t2.hidden).toBe(true); // stored and served, not shown in P1
    expect(typeof r.body.scan_row_limit).toBe("number");
    expect(r.body.graph).toMatchObject({ hops: expect.any(Number), fanout: expect.any(Number) });
    expect(Array.isArray(r.body.hubs)).toBe(true);
  });

  it("round-trips, clamps the graph rails and refuses what it cannot read", async () => {
    const r = await post("/api/settings/retrieval", {
      agentic: false,
      graph: { hops: 9, fanout: 12 },
      scan_row_limit: 5000,
    });
    expect(r.body.agentic).toBe(false);
    expect(r.body.graph.hops).toBe(4); // the 2-hop-plus-slack ceiling, clamped
    expect(r.body.graph.fanout).toBe(12);
    expect(r.body.scan_row_limit).toBe(5000);
    const bad = await post("/api/settings/retrieval", { agentic: "sure" });
    expect(bad.body.refused).toContain("agentic must be a boolean");
    expect(bad.body.agentic).toBe(false);
  });

  it("a hub can be excluded and put back", async () => {
    getDb()
      .prepare(`INSERT OR IGNORE INTO entities (id, type, canonical) VALUES ('ent_hub', 'person', 'Hub')`)
      .run();
    const added = await post("/api/settings/retrieval", { add_hub: "ent_hub" });
    expect(added.body.hubs.map((h: { entity_id: string }) => h.entity_id)).toContain("ent_hub");
    const removed = await post("/api/settings/retrieval", { remove_hub: "ent_hub" });
    expect(removed.body.hubs.map((h: { entity_id: string }) => h.entity_id)).not.toContain("ent_hub");
    const nope = await post("/api/settings/retrieval", { remove_hub: "ent_nothing" });
    expect(nope.body.refused).toContain("remove_hub names no hub");
  });
});

describe("Settings › AI Connector (§25)", () => {
  it("names the four doors honestly — CLI live, OAuth and OpenRouter P3, local always on device", async () => {
    const r = await get("/api/settings/connector");
    expect(r.status).toBe(200);
    const byDoor = Object.fromEntries(r.body.doors.map((d: { door: string; status: string }) => [d.door, d.status]));
    expect(byDoor).toEqual({ cli: "live", oauth: "p3", openrouter: "p3", local: "local-only" });
    // The ceilings the budget module actually enforces, not a second copy.
    expect(r.body.ceilings).toMatchObject({ usd_per_hour: 3, usd_per_day: 15, calls_per_hour: 400, calls_per_day: 3000 });
    expect(r.body.stop_all).toBe(false);
    expect(r.body.fallback_order).toEqual(["cli", "local"]);
  });

  it("the fallback order round-trips and a made-up door is refused whole", async () => {
    const ok = await post("/api/settings/connector", { fallback_order: ["local", "cli"] });
    expect(ok.body.fallback_order).toEqual(["local", "cli"]);
    const bad = await post("/api/settings/connector", { fallback_order: ["local", "carrier-pigeon"] });
    expect(bad.body.refused[0]).toMatch(/fallback_order must list doors/);
    expect(bad.body.fallback_order).toEqual(["local", "cli"]);
  });

  it("mirrors the stop-all switch the General pane owns", async () => {
    const { setModelActivityPaused } = await import("../providers/budget.js");
    setModelActivityPaused(true);
    expect((await get("/api/settings/connector")).body.stop_all).toBe(true);
    setModelActivityPaused(false);
  });
});

// ---------------------------------------------------------------------------
// Runs — the run index, run detail, diff and quarantine
// ---------------------------------------------------------------------------

function seedRun(id: string, o: { pass?: string; model?: string; cost?: number; started?: string; status?: string } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO runs (id, kind, pass, origin, role, model, started_at, ended_at, status, cost_usd, input_tokens, output_tokens)
       VALUES (?, 'llm', ?, 'live', 'understanding', ?, ?, ?, ?, ?, 100, 50)`,
    )
    .run(id, o.pass ?? "decide", o.model ?? "haiku", o.started ?? "2026-09-01T10:00:00.000Z", o.started ?? "2026-09-01T10:00:05.000Z", o.status ?? "ok", o.cost ?? 0.004);
}

describe("Settings › Runs (§25 — diff runs, quarantine, undo a run)", () => {
  it("the index lists runs with their trace / decision counts and a per-pass cost rollup", async () => {
    seedRun("run_a", { cost: 0.004 });
    seedRun("run_b", { pass: "orient", cost: 0.002 });
    writeDecision({ runId: "run_a", pass: "decide", targetKind: "task", targetId: "t1", action: "create" });
    writeDecision({ runId: "run_a", pass: "decide", targetKind: "space", targetId: "sp1", action: "attach" });
    const r = await get("/api/runs");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const a = r.body.runs.find((x: { id: string }) => x.id === "run_a");
    expect(a).toMatchObject({ pass: "decide", model: "haiku", decisions: 2, reversed: 0, quarantine: null });
    expect(r.body.costs.map((c: { pass: string }) => c.pass).sort()).toEqual(["decide", "orient"]);
  });

  it("filters by pass and by day", async () => {
    seedRun("run_a", { pass: "decide", started: "2026-09-01T10:00:00.000Z" });
    seedRun("run_b", { pass: "orient", started: "2026-09-02T10:00:00.000Z" });
    expect((await get("/api/runs?pass=orient")).body.runs.map((r: { id: string }) => r.id)).toEqual(["run_b"]);
    expect((await get("/api/runs?day=2026-09-01")).body.runs.map((r: { id: string }) => r.id)).toEqual(["run_a"]);
  });

  it("one run reads back its decisions and the UNDO PREVIEW — the blast radius before the click", async () => {
    seedRun("run_a");
    writeDecision({ runId: "run_a", pass: "decide", targetKind: "task", targetId: "t1", action: "create" });
    const r = await get("/api/runs/run_a");
    expect(r.status).toBe(200);
    expect(r.body.run.id).toBe("run_a");
    expect(r.body.decisions.map((d: { target_id: string }) => d.target_id)).toEqual(["t1"]);
    // A create is not reversible — the preview says so instead of pretending.
    expect(r.body.undo).toMatchObject({ runId: "run_a", reversible: 0 });
    expect(r.body.undo.items[0].skipReason).toBeTruthy();
    expect((await get("/api/runs/run_nothing")).status).toBe(404);
  });

  it("the diff names what changed and, crucially, the targets both runs touched differently", async () => {
    seedRun("run_a", { model: "haiku" });
    seedRun("run_b", { model: "sonnet" });
    writeDecision({ runId: "run_a", pass: "decide", targetKind: "task", targetId: "t_same", action: "create" });
    writeDecision({ runId: "run_b", pass: "decide", targetKind: "task", targetId: "t_same", action: "create" });
    writeDecision({ runId: "run_a", pass: "decide", targetKind: "task", targetId: "t_moved", action: "close" });
    writeDecision({ runId: "run_b", pass: "decide", targetKind: "task", targetId: "t_moved", action: "monitor" });
    writeDecision({ runId: "run_b", pass: "decide", targetKind: "space", targetId: "sp_new", action: "create" });

    const r = await get("/api/runs/diff?a=run_a&b=run_b");
    expect(r.status).toBe(200);
    const model = r.body.fields.find((f: { field: string }) => f.field === "model");
    expect(model).toEqual({ field: "model", a: "haiku", b: "sonnet", same: false });
    expect(r.body.fields.find((f: { field: string }) => f.field === "pass").same).toBe(true);
    expect(r.body.decisions.same).toBe(1);
    expect(r.body.decisions.changed).toEqual([
      { target_kind: "task", target_id: "t_moved", a_action: "close", b_action: "monitor" },
    ]);
    expect(r.body.decisions.only_b).toEqual([
      { target_kind: "space", target_id: "sp_new", a_action: null, b_action: "create" },
    ]);
    expect(r.body.decisions.only_a).toEqual([]);
  });

  it("a diff needs two run ids and 404s on a run that is not there", async () => {
    seedRun("run_a");
    expect((await get("/api/runs/diff?a=run_a")).status).toBe(400);
    expect((await get("/api/runs/diff?a=run_a&b=nope")).status).toBe(404);
  });

  it("quarantine marks a run and releases it — a decisions row, never a silent flag", async () => {
    seedRun("run_a");
    const on = await post("/api/runs/run_a/quarantine", { reason: "sonnet trial, bad calls" });
    expect(on.status).toBe(200);
    expect(on.body.quarantine).toMatchObject({ quarantined: true, reason: "sonnet trial, bad calls" });
    // Listed and FLAGGED by default: hiding it would hide real spend.
    const all = await get("/api/runs");
    expect(all.body.runs[0].quarantine.quarantined).toBe(true);
    expect((await get("/api/runs?quarantined=1")).body.runs).toHaveLength(1);
    expect((await get("/api/runs?quarantined=0")).body.runs).toHaveLength(0);
    // The run's own quarantine rows never pollute its decision count.
    expect(all.body.runs[0].decisions).toBe(0);

    const off = await post("/api/runs/run_a/quarantine", { quarantined: false });
    expect(off.body.quarantine.quarantined).toBe(false);
    expect((await get("/api/runs?quarantined=1")).body.runs).toHaveLength(0);
    const ledger = getDb()
      .prepare(`SELECT action FROM decisions WHERE target_kind = 'run' AND target_id = 'run_a' ORDER BY rowid`)
      .all() as { action: string }[];
    expect(ledger.map((d) => d.action)).toEqual(["quarantine", "release"]);
    expect((await post("/api/runs/run_nothing/quarantine", {})).status).toBe(404);
  });

  it("an empty body quarantines — the button that says quarantine must never release", async () => {
    seedRun("run_a");
    const r = await post("/api/runs/run_a/quarantine", {});
    expect(r.body.quarantine.quarantined).toBe(true);
  });
});

describe("route ownership", () => {
  it("returns false for a path it does not claim", async () => {
    const r = await call("GET", "/api/nothing/here");
    expect(r.handled).toBe(false);
  });

  it("does not claim /api/settings/calendar — the calendar lane owns Settings › Calendar", async () => {
    const r = await call("GET", "/api/settings/calendar");
    expect(r.handled).toBe(false);
  });

  it("leaves app_state alone for a step it has never been told about", async () => {
    appStateSet("selected_model_mystery", "opus");
    const r = await post("/api/settings/intelligence", { step: "mystery", model: "sonnet" });
    expect(r.status).toBe(400);
  });
});
