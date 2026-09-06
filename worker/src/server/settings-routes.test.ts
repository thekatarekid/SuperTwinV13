// ===========================================================================
// Settings routes — build P4.3, spec §14.9. Round-trips for every subtab this
// lane added, plus the TRC-02 chain test: task → decision → trace → source
// events, every hop served, and the packed context byte-what-the-model-saw.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "st-settings-routes-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = join(tmpDir, "home");
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { runMigrations } = await import("../db/index.js");
const { getDb } = await import("../db/connection.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const { writeDecision } = await import("../db/decisions.js");
const { writeTrace, usageToTokens4Way } = await import("../traces/store.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  runMigrations();
  register({
    id: "claude-local",
    send: async () => ({
      sessionId: "",
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      freshFallback: false,
      status: "ok" as const,
    }),
    cancel: () => false,
  });
  server = await startServer({ port: 0, media: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

describe("Settings round-trips (spec §14.9)", () => {
  it("general: defaults, then a POST persists and reads back", async () => {
    const before = await get("/api/settings/general");
    expect(before.status).toBe(200);
    expect(before.body.hotkey_summon).toBe("double-right-cmd");
    expect(before.body.notifications_enabled).toBe(true);
    expect(before.body.brief_times).toEqual(["08:30", "18:30"]);
    expect(before.body.graduation_mode).toBe("propose"); // fresh install proposes (S5.1)

    const saved = await post("/api/settings/general", {
      launch_at_login: true,
      notifications_enabled: false,
      brief_times: ["07:00", "19:00"],
      appearance: "dark",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.launch_at_login).toBe(true);
    expect(saved.body.notifications_enabled).toBe(false);

    const after = await get("/api/settings/general");
    expect(after.body.launch_at_login).toBe(true);
    expect(after.body.notifications_enabled).toBe(false);
    expect(after.body.brief_times).toEqual(["07:00", "19:00"]);
    expect(after.body.appearance).toBe("dark");
  });

  it("capture: blocklists and per-source pause round-trip; incognito is fixed", async () => {
    const before = await get("/api/settings/capture");
    expect(before.body.incognito).toBe("always-off");
    expect(before.body.app_blocklist).toEqual([]);

    const saved = await post("/api/settings/capture", {
      sources: { screen: { paused: true } },
      app_blocklist: ["1Password", "Banking App"],
      domain_blocklist: ["bank.example.com"],
      pagetext_rules: ["docs.google.com: capture"],
      incognito: "on", // must be ignored — never editable
    });
    expect(saved.status).toBe(200);
    expect(saved.body.sources.screen.paused).toBe(true);
    expect(saved.body.sources.whatsapp.paused).toBe(false);
    expect(saved.body.app_blocklist).toEqual(["1Password", "Banking App"]);
    expect(saved.body.incognito).toBe("always-off");

    const after = await get("/api/settings/capture");
    expect(after.body.domain_blocklist).toEqual(["bank.example.com"]);
    expect(after.body.pagetext_rules).toEqual(["docs.google.com: capture"]);
  });

  it("space creation: propose-only out of the box, graduates after two clean weeks, user switch sticky", async () => {
    const before = await get("/api/settings/graduation");
    expect(before.status).toBe(200);
    // The fresh-install default (V6 P1 S5.1): inferred spaces queue for review.
    expect(before.body.mode).toBe("propose");
    expect(before.body.default_mode).toBe("propose");
    expect(before.body.reverted).toBe(false);
    // The graduation window is reported: the streak this install has to earn.
    expect(before.body.required_days).toBe(14);
    expect(Array.isArray(before.body.window)).toBe(true);

    const on = await post("/api/settings/graduation", { mode: "auto" });
    expect(on.body.mode).toBe("auto");
    const off = await post("/api/settings/graduation", { mode: "propose" });
    expect(off.body.mode).toBe("propose");
    expect(off.body.reverted).toBe(true); // deliberate choice — code never undoes it

    const bad = await post("/api/settings/graduation", { mode: "yolo" });
    expect(bad.status).toBe(400);
  });

  it("intelligence: V13 steps default Haiku with recommendations; a change is decisioned + eval-marked", async () => {
    const before = await get("/api/settings/intelligence");
    expect(before.status).toBe(200);
    expect(before.body.default_model).toBe("haiku");
    expect(before.body.eval_gated).toBe(true);
    // Keyed on the pass STEM the runner spends under, not a prompt version:
    // `orient.v6` was a picker nothing read (V6 P1 S5.6).
    const orient = before.body.steps.find((s: any) => s.key === "orient");
    expect(orient.selected).toBe("haiku"); // default Haiku everywhere
    expect(orient.recommended).toBe("sonnet"); // recommendation shown, not applied
    expect(orient.enabled).toBe(true);
    expect(before.body.steps.every((s: any) => s.selected === "haiku")).toBe(true);

    // Upgrade one step: persisted, decisioned, and the golden set marked due.
    const up = await post("/api/settings/intelligence", { step: "decide", model: "sonnet" });
    expect(up.status).toBe(200);
    const after = await get("/api/settings/intelligence");
    expect(after.body.steps.find((s: any) => s.key === "decide").selected).toBe("sonnet");
    const dec = getDb()
      .prepare(`SELECT * FROM decisions WHERE target_id = 'selected_model_decide'`)
      .all();
    expect(dec).toHaveLength(1);
    const t3 = await get("/api/settings/t3");
    expect(t3.body.eval_regression_due).not.toBeNull();

    // Per-step on/off toggle round-trips.
    await post("/api/settings/intelligence", { step: "digest", enabled: false });
    const toggled = await get("/api/settings/intelligence");
    expect(toggled.body.steps.find((s: any) => s.key === "digest").enabled).toBe(false);

    // Garbage refused.
    expect((await post("/api/settings/intelligence", { step: "nope", model: "sonnet" })).status).toBe(400);
    expect((await post("/api/settings/intelligence", { step: "decide", model: "gpt" })).status).toBe(400);
  });

  it("t3: serves the last-run report shape", async () => {
    const { status, body } = await get("/api/settings/t3");
    expect(status).toBe(200);
    expect(body).toHaveProperty("last_run_at");
    expect(body).toHaveProperty("last_report");
    expect(body).toHaveProperty("eval_regression_due");
  });

  it("assist: gate knobs round-trip; suppressed contexts are visible and clearable", async () => {
    const before = await get("/api/settings/assist");
    expect(before.status).toBe(200);
    expect(before.body.enabled).toBe(true);
    expect(before.body.thresholds).toEqual({
      default: 5,
      transaction: 3,
      research: 7,
      communication: 5,
    });
    expect(before.body.cooldown_min).toBe(45);

    // Seed one suppressed context, then read + clear it through the routes.
    getDb()
      .prepare(
        `INSERT INTO assist_topics (topic_key, suppressed_until, updated_at)
         VALUES ('domain:news.example', ?, ?)`,
      )
      .run(new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString());
    const withSuppressed = await get("/api/settings/assist");
    expect(withSuppressed.body.suppressed_contexts.map((s: any) => s.topic_key)).toEqual([
      "domain:news.example",
    ]);

    const saved = await post("/api/settings/assist", {
      thresholds: { research: 9, transaction: 2 },
      cooldown_min: 30,
      quiet_hours: { start: "23:00", end: "08:00" },
      clear_suppressed: true,
    });
    expect(saved.body.thresholds.research).toBe(9);
    expect(saved.body.thresholds.transaction).toBe(2);
    expect(saved.body.cooldown_min).toBe(30);
    expect(saved.body.quiet_hours).toEqual({ start: "23:00", end: "08:00" });
    expect(saved.body.suppressed_contexts).toEqual([]);
  });

  it("data: storage + retention read; retention round-trips and validates", async () => {
    const before = await get("/api/settings/data");
    expect(before.status).toBe(200);
    expect(before.body.storage.db_bytes).toBeGreaterThan(0);
    expect(before.body.retention.traces_days).toBe(30);

    const saved = await post("/api/settings/data/retention", { traces_days: 90 });
    expect(saved.body.retention.traces_days).toBe(90);
    const after = await get("/api/settings/data");
    expect(after.body.retention.traces_days).toBe(90);

    const bad = await post("/api/settings/data/retention", { traces_days: 1 });
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// TRC-02 — why? → trace, end to end (code-asserted chain)
// ---------------------------------------------------------------------------

describe("TRC-02: task → decision → trace → source events", () => {
  const RUN_ID = "run_trc02";
  const TRACE_ID = "trc_trc02";
  const PACKED = `## thread\n[e_v1] Rohan: villa is ₹18k/night\n[e_v2] You: book it for Oct 4-6`;
  const SYSTEM = "You are the Decide pass. Emit strict JSON.";
  const RAW = `{"tasks":[{"title":"Book the Hampi villa","events":["e_v1","e_v2"]}]}`;

  it("every hop is served, and the packed context is byte-what-the-model-saw", async () => {
    const db = getDb();
    // Source events the villa task grew from.
    db.prepare(
      `INSERT INTO events (id, ts, kind, text) VALUES
         ('e_v1', '2026-08-20T10:00:00Z', 'message', 'villa is 18k/night'),
         ('e_v2', '2026-08-20T10:05:00Z', 'message', 'book it for Oct 4-6')`,
    ).run();
    // The villa task, carrying its evidence.
    db.prepare(
      `INSERT INTO tasks (id, title, status, evidence_json, created_by)
       VALUES ('tsk_villa', 'Book the Hampi villa', 'open', ?, ?)`,
    ).run(JSON.stringify({ event_ids: ["e_v1", "e_v2"] }), RUN_ID);
    // The Decide decision that created it.
    const decisionId = writeDecision({
      runId: RUN_ID,
      pass: "decide",
      targetKind: "task",
      targetId: "tsk_villa",
      action: "create",
      new: { title: "Book the Hampi villa" },
      reason: "explicit ask in thread",
      confidence: 0.92,
    });
    // The trace of the run that proposed it — full record, exact bytes.
    writeTrace({
      trace_id: TRACE_ID,
      ts: "2026-08-20T10:06:00.000Z",
      run_id: RUN_ID,
      attempt: 1,
      pass: "decide",
      caller: "test/trc02",
      model: "claude-haiku-4-5-20251001",
      prompt_version: "decide.v8",
      system_prompt: SYSTEM,
      packed_context: PACKED,
      raw_output: RAW,
      parsed_result: JSON.parse(RAW),
      repair_count: 0,
      verdicts: null,
      tokens_4way: usageToTokens4Way({
        inputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 20,
      }),
      cost_usd: 0.0001,
      latency_ms: 900,
      status: "ok",
    });

    // Hop 1: task → its decisions ("why?").
    const why = await get("/api/decisions/task/tsk_villa");
    expect(why.status).toBe(200);
    const dec = why.body.decisions.find((d: any) => d.id === decisionId);
    expect(dec).toBeDefined();
    expect(dec.runId).toBe(RUN_ID);
    // Hop 2: decision → trace, linked in the same payload (no broken-chain).
    expect(dec.traceId).toBe(TRACE_ID);

    // Hop 3: trace → the FULL record: exact system prompt, packed context,
    // raw output — never a paraphrase (trace-summary-only is the failure).
    const full = await get(`/api/trace/${TRACE_ID}/full`);
    expect(full.status).toBe(200);
    expect(full.body.trace.system_prompt).toBe(SYSTEM);
    expect(full.body.trace.packed_context).toBe(PACKED); // byte-identical
    expect(full.body.trace.raw_output).toBe(RAW);

    // Hop 4: trace → source events named in the packed context exist.
    const taskEvidence = JSON.parse(
      (db.prepare(`SELECT evidence_json FROM tasks WHERE id = 'tsk_villa'`).get() as any)
        .evidence_json,
    ) as { event_ids: string[] };
    for (const id of taskEvidence.event_ids) {
      expect(full.body.trace.packed_context).toContain(id);
      expect(db.prepare(`SELECT 1 FROM events WHERE id = ?`).get(id)).toBeDefined();
    }
  });

  it("the traces index filters by pass/day and rolls up cost for the viewer", async () => {
    const listed = await get("/api/traces?pass=decide&day=2026-08-20");
    expect(listed.status).toBe(200);
    expect(listed.body.traces.map((t: any) => t.id)).toContain(TRACE_ID);
    const cost = listed.body.costs.find((c: any) => c.pass === "decide");
    expect(cost.calls).toBeGreaterThanOrEqual(1);
    expect(cost.cost_usd).toBeGreaterThan(0);

    const none = await get("/api/traces?pass=orient&day=2026-08-20");
    expect(none.body.traces).toHaveLength(0);

    const missing = await get("/api/trace/no_such/full");
    expect(missing.status).toBe(404);
  });
});
