// ===========================================================================
// [CODE] SET — Settings (GoldenEvals V6 P1 §5.21 SET-01..03; V6 P1 S5.6).
//
// Deterministic, zero model calls. Each case drives the PRODUCT code the
// setting reaches, not a copy of it:
//
//   SET-01  a step turned off queues, never drops — app_state
//           `process_enabled_orient` = "0", live events come due, the real
//           Dispatcher offers the bundle and gets "held": no sink call, no
//           stamp, no attempt row, no dead letter. Switched back on, the next
//           tick hands the sink exactly what was queued.
//   SET-02  a model change runs the golden set first — settings/golden-gate.ts
//           with a stub runner standing in for the eval CLI: a red compare
//           leaves the old model in place and writes a "blocked" decision; a
//           green one applies the change. The runner is asked for the step's
//           categories with the candidate in the overrides.
//   SET-03  freshness preset changes the cold window live — the real
//           Dispatcher's default preset reader (app_state `assist.freshness`)
//           on a mature world: Balanced → Live → Relaxed between ticks with no
//           restart; an unknown preset is refused and the window holds.
//
// Every case removes its own rows afterwards.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { appStateGet, appStateSet } from "../../db/ingest.js";
import {
  getActiveProvider,
  getProviderModelSelection,
  providerModelKey,
  setProviderModelSelection,
} from "../../db/settings.js";
import { markDispatched, type DeltaBundle } from "../../scheduler/v6/bundle.js";
import { FRESHNESS_PRESETS } from "../../scheduler/v6/cold.js";
import { Dispatcher, FRESHNESS_KEY, type SinkResult } from "../../scheduler/v6/dispatch.js";
import { append, msgAt, SEC } from "../../scheduler/v6/testutil.js";
import {
  installGoldenRunner,
  proposeStepChange,
  awaitGoldenRun,
  GOLDEN_STATE_KEY,
  type GoldenRunRequest,
  type GoldenRunResult,
} from "../../settings/golden-gate.js";
import { applyAssistP1Patch, setFreshnessPreset } from "../../settings/p1-settings.js";
import { PROCESS_ENABLED_PREFIX, STEP_OFF_HOLD_MS } from "../../settings/steps.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { CaseWorld } from "./bnd.js";

const T0 = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 86_400_000;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}
function deleteAppState(key: string): void {
  getDb().prepare(`DELETE FROM app_state WHERE key = ?`).run(key);
}

type CaseFn = (fixture: Fixture, w: CaseWorld) => Promise<ExecutorResult> | ExecutorResult;

/** Twenty spaces + a consent 30 days old: the preset window, never bootstrapping. */
function matureWorld(w: CaseWorld): () => void {
  for (let i = 0; i < 20; i++) w.space(`sp_${i}`, `space ${i}`);
  const consentId = w.key("consent");
  getDb()
    .prepare(`INSERT OR IGNORE INTO consents (id, source, state, granted_at) VALUES (?, 'wa', 'connected', ?)`)
    .run(consentId, new Date(T0 - 30 * DAY).toISOString());
  return () => {
    getDb().prepare(`DELETE FROM consents WHERE id = ?`).run(consentId);
  };
}

// ---- SET-01 · a step turned off queues, never drops --------------------------

const set01: CaseFn = async (fixture, w) => {
  const setup = rec(fixture.setup);
  const step = typeof setup.step === "string" ? setup.step : "orient";
  const n = typeof setup.events === "number" ? setup.events : 3;
  const key = `${PROCESS_ENABLED_PREFIX}${step}`;
  const before = appStateGet(key);
  const rohan = w.key("rohan@s.whatsapp.net");
  const undispatched = (): number =>
    count(`SELECT COUNT(*) AS n FROM events WHERE stream_key = ? AND dispatched_at IS NULL`, rohan);
  const attemptRows = (): number =>
    count(`SELECT COUNT(*) AS n FROM bundle_attempts WHERE stream_id IN (SELECT id FROM streams WHERE external_key = ?)`, rohan);

  const sinkCalls: DeltaBundle[] = [];
  const sink = (b: DeltaBundle): SinkResult => {
    sinkCalls.push(b);
    markDispatched(b);
    return { status: "committed" };
  };
  try {
    appStateSet(key, "0");
    const lines = ["villa advance by 5pm", "sending the upi id now", "done"];
    append(Array.from({ length: n }, (_, i) => msgAt(rohan, T0 + i * SEC, lines[i % lines.length]!, { actor: "contact:rohan" })));
    const cold = FRESHNESS_PRESETS.live;
    const d = new Dispatcher({ sink, streamKeyPrefix: w.prefix, coldParams: cold, history: false, digest: false });
    d.tick(T0);
    // The cold window comes due while the step is off, then two hold periods pass.
    let t = T0 + cold.idleMs + n * SEC + SEC;
    d.tick(t);
    await d.drain();
    for (let i = 0; i < 2; i++) {
      t += STEP_OFF_HOLD_MS + SEC;
      d.tick(t);
      await d.drain();
    }
    const whileOff = {
      sink_calls: sinkCalls.length,
      undispatched: undispatched(),
      dead_letters: d.stats().deadLetters,
      attempt_rows: attemptRows(),
      held_for_step: d.stats().heldForStep,
    };

    // Switched back on: the next tick after the hold hands over what waited.
    appStateSet(key, "1");
    t += STEP_OFF_HOLD_MS + SEC;
    d.tick(t);
    await d.drain();
    const afterOn = {
      sink_calls: sinkCalls.length,
      events_in_bundle: sinkCalls[0]?.events.length ?? 0,
      undispatched: undispatched(),
    };

    const violations: Violation[] = [];
    if (whileOff.sink_calls > 0) violations.push({ label: "called-while-off", note: `${whileOff.sink_calls} sink call(s) while ${step} was off` });
    if (whileOff.undispatched !== n || whileOff.dead_letters > 0 || whileOff.attempt_rows > 0)
      violations.push({ label: "dropped", note: JSON.stringify(whileOff) });
    if (afterOn.sink_calls !== 1 || afterOn.events_in_bundle !== n || afterOn.undispatched !== 0)
      violations.push({ label: "lost-on-resume", note: JSON.stringify(afterOn) });
    const ok = violations.length === 0 && whileOff.held_for_step >= 1;
    return {
      ok,
      output: { step, while_off: whileOff, after_on: afterOn },
      violations,
      metrics: { model_calls: 0, held_for_step: whileOff.held_for_step },
      notes: ["deterministic; zero model calls (scheduler/v6/dispatch.ts submit → held)"],
    };
  } finally {
    if (before === null) deleteAppState(key);
    else appStateSet(key, before);
  }
};

// ---- SET-02 · a model change runs the golden set first ------------------------

const set02: CaseFn = async (fixture) => {
  const setup = rec(fixture.setup);
  const step = typeof setup.step === "string" ? setup.step : "decide";
  const from = typeof setup.from === "string" ? setup.from : "haiku";
  const to = typeof setup.to === "string" ? setup.to : "sonnet";
  const runs = (Array.isArray(setup.runs) ? setup.runs : [{ compare: "red", regressed: ["DEC"] }, { compare: "green", regressed: [] }]) as {
    compare: string;
    regressed?: string[];
  }[];
  const provider = getActiveProvider();
  const modelKey = providerModelKey(provider, step);
  const legacyModelKey = `selected_model_${step}`;
  const beforeModel = appStateGet(modelKey);
  const beforeLegacyModel = appStateGet(legacyModelKey);
  const beforeGolden = appStateGet(GOLDEN_STATE_KEY);
  const db = getDb();
  const decisionsSince = (targetId: string, sinceRowid: number): { action: string; reason: string | null }[] =>
    db
      .prepare(`SELECT action, reason FROM decisions WHERE target_id = ? AND rowid > ? ORDER BY rowid`)
      .all(targetId, sinceRowid) as { action: string; reason: string | null }[];
  const maxRowid = (): number => (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM decisions`).get() as { n: number }).n;

  const calls: GoldenRunRequest[] = [];
  let i = 0;
  const stub = async (req: GoldenRunRequest): Promise<GoldenRunResult> => {
    calls.push(req);
    const r = runs[Math.min(i++, runs.length - 1)]!;
    const red = r.compare === "red";
    return { ok: !red, regressed: red ? (r.regressed ?? []) : [], summary: red ? `COMPARE: red — below baseline: ${(r.regressed ?? []).join(", ")}` : "COMPARE: green", exitCode: red ? 1 : 0 };
  };

  const startRowid = maxRowid();
  try {
    setProviderModelSelection(provider, step, from);
    installGoldenRunner(stub, "SET-02 stub runner");
    const outcomes: unknown[] = [];
    const violations: Violation[] = [];
    let appliedBeforeReturn = false;
    for (let k = 0; k < runs.length; k++) {
      const apply = (): void => {
        setProviderModelSelection(provider, step, to);
        db.prepare(`INSERT INTO decisions (id, pass, target_kind, target_id, action, old_json, new_json, reason) VALUES (?, 'user', 'setting', ?, 'update', ?, ?, ?)`).run(
          `set02_${k}_${Date.now().toString(36)}`,
          modelKey,
          JSON.stringify({ model: from }),
          JSON.stringify({ model: to }),
          `user picked ${to} for ${step}`,
        );
      };
      const proposed = await proposeStepChange({ step, label: step, model: to }, apply);
      // "switch-before-eval": the proposal returns "running" with the OLD model in place.
      if (getProviderModelSelection(provider, step) !== from && k === 0) appliedBeforeReturn = true;
      const settled = await awaitGoldenRun();
      const selected = getProviderModelSelection(provider, step);
      const gateDecisions = decisionsSince(`golden_gate_${step}`, startRowid);
      const updateDecisions = decisionsSince(modelKey, startRowid);
      outcomes.push({ proposed: proposed.status, gate: settled.status, applied: settled.applied, selected_after: selected, regressed: settled.regressed });
      const red = runs[k]!.compare === "red";
      if (red) {
        if (selected !== from || settled.status !== "blocked" || settled.applied) violations.push({ label: "regression-shipped", note: JSON.stringify(outcomes[k]) });
        if (!gateDecisions.some((d) => d.action === "blocked" && (runs[k]!.regressed ?? []).every((c) => (d.reason ?? "").includes(c))))
          violations.push({ label: "silent-block", note: JSON.stringify(gateDecisions) });
      } else if (selected !== to || settled.status !== "passed" || !settled.applied || !updateDecisions.some((d) => d.action === "update")) {
        violations.push({ label: "not-applied-after-green", note: JSON.stringify(outcomes[k]) });
      }
    }
    if (appliedBeforeReturn) violations.push({ label: "switch-before-eval" });
    const first = calls[0];
    const runnerAsked = {
      categories: first?.categories ?? null,
      override_model: first?.overrides[step]?.model ?? null,
    };
    if (!first || !(first.categories ?? []).includes("DEC") || runnerAsked.override_model !== to)
      violations.push({ label: "runner-not-asked-for-candidate", note: JSON.stringify(runnerAsked) });
    if (calls.length !== runs.length) violations.push({ label: "runner-call-count", note: `${calls.length} ≠ ${runs.length}` });
    return {
      ok: violations.length === 0,
      output: { step, provider, provider_model_key: modelKey, from, to, runner_asked: runnerAsked, runner_calls: calls.length, outcomes },
      violations,
      metrics: { model_calls: 0, runner_calls: calls.length },
      notes: ["deterministic; the golden runner is a stub — zero model calls (settings/golden-gate.ts)"],
    };
  } finally {
    installGoldenRunner(null);
    if (beforeModel === null) deleteAppState(modelKey);
    else appStateSet(modelKey, beforeModel);
    if (beforeLegacyModel === null) deleteAppState(legacyModelKey);
    else appStateSet(legacyModelKey, beforeLegacyModel);
    if (beforeGolden === null) deleteAppState(GOLDEN_STATE_KEY);
    else appStateSet(GOLDEN_STATE_KEY, beforeGolden);
    db.prepare(`DELETE FROM decisions WHERE rowid > ? AND target_id IN (?, ?)`).run(startRowid, modelKey, `golden_gate_${step}`);
  }
};

// ---- SET-03 · freshness preset changes the cold window live -------------------

const set03: CaseFn = async (fixture, w) => {
  const setup = rec(fixture.setup);
  const presets = (Array.isArray(setup.presets) ? setup.presets : ["balanced", "live", "relaxed"]) as string[];
  const before = appStateGet(FRESHNESS_KEY);
  const dropConsent = matureWorld(w);
  const sink = (b: DeltaBundle): SinkResult => {
    markDispatched(b);
    return { status: "committed" };
  };
  try {
    deleteAppState(FRESHNESS_KEY); // the shipped default (Balanced) — no restart between steps
    const d = new Dispatcher({ sink, streamKeyPrefix: w.prefix, history: false, digest: false });
    const windows: { preset: string; idle_s: number; max_s: number }[] = [];
    let t = T0;
    for (const [i, p] of presets.entries()) {
      if (i > 0) setFreshnessPreset(p as keyof typeof FRESHNESS_PRESETS);
      d.tick((t += 5 * SEC));
      const c = d.cold.currentParams;
      windows.push({ preset: p, idle_s: c.idleMs / SEC, max_s: c.maxMs / SEC });
    }
    const refused = applyAssistP1Patch({ freshness: "turbo" });
    d.tick((t += 5 * SEC));
    const c = d.cold.currentParams;
    const afterRefused = { preset: appStateGet(FRESHNESS_KEY), idle_s: c.idleMs / SEC, max_s: c.maxMs / SEC };

    const expected = (rec(fixture.expected).windows as { preset: string; idle_s: number; max_s: number }[] | undefined) ??
      presets.map((p) => ({ preset: p, idle_s: FRESHNESS_PRESETS[p as keyof typeof FRESHNESS_PRESETS].idleMs / SEC, max_s: FRESHNESS_PRESETS[p as keyof typeof FRESHNESS_PRESETS].maxMs / SEC }));
    const violations: Violation[] = [];
    if (JSON.stringify(windows) !== JSON.stringify(expected)) violations.push({ label: "restart-needed", note: JSON.stringify(windows) });
    if (windows.some((x) => x.max_s > 600) || afterRefused.max_s > 600) violations.push({ label: "max-over-600" });
    const last = presets[presets.length - 1];
    if (refused.length === 0 || afterRefused.preset !== last || afterRefused.idle_s !== windows[windows.length - 1]!.idle_s)
      violations.push({ label: "garbage-accepted", note: JSON.stringify({ refused, afterRefused }) });
    return {
      ok: violations.length === 0,
      output: { windows, after_refused: afterRefused, refused, restart_needed: false },
      violations,
      metrics: { model_calls: 0, content_gated_call: 0 },
      notes: ["deterministic; zero model calls (dispatch.ts tick re-reads app_state assist.freshness)"],
    };
  } finally {
    dropConsent();
    if (before === null) deleteAppState(FRESHNESS_KEY);
    else appStateSet(FRESHNESS_KEY, before);
  }
};

const CASES: Record<string, CaseFn> = {
  "SET-01": set01,
  "SET-02": set02,
  "SET-03": set03,
};

/** The executor registered for pass `settings` (SET). */
export const settingsExecutor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const run = CASES[fixture.id];
  if (!run) throw new Error(`SET executor: no case for ${fixture.id}`);
  const w = new CaseWorld(fixture.id);
  try {
    return await run(fixture, w);
  } finally {
    w.cleanup();
  }
};
