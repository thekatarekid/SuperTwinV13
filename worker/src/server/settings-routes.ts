// ===========================================================================
// [CODE] Settings routes — build P4.3, spec §14.9. The worker back-end for the
// eight-subtab Settings screen. Everything here is a thin, typed view over
// app_state keys plus reads the owning modules already serve:
//
//   GET/POST /api/settings/general      hotkeys · launch at login · notifications
//                                       · brief times · appearance · graduation
//   GET/POST /api/settings/capture      per-source pause · blocklists ·
//                                       page-text rules · incognito (fixed off)
//   GET      /api/settings/sources      status per source: streams, last event
//   GET/POST /api/settings/graduation   mode + streak + the 14-day metric window
//   GET      /api/settings/t3           last deep-pass report + eval-due marker
//   GET/POST /api/settings/retrieval    agentic on/off · scan limit · graph hops/fan-out · hubs (T2 hidden)
//   GET/POST /api/settings/connector    doors · fallback order · ceilings · stop-all
//   GET      /api/settings/golden       golden-gate state (SET-02)
//   POST     /api/settings/golden/run   the manual golden run (spends; 409 without a runner)
//   GET      /api/settings/data         storage per store · retention windows
//   POST     /api/settings/data/retention {traces_days}
//   GET      /api/runs?pass=&day=&status=&origin=&quarantined=&limit=&offset=
//                                       the RUN index + per-pass cost rollup
//   GET      /api/runs/diff?a=&b=       two runs side by side: header fields +
//                                       the decision diff (V6 P1 §25 "diff runs")
//   GET      /api/runs/:id              one run: traces, decisions, undo preview
//   POST     /api/runs/:id/quarantine   {quarantined, reason} — mark / release
//   GET      /api/traces?pass=&day=&run_id=&limit=&offset=   filtered index +
//                                       per-pass cost rollup (Runs subtab)
//   GET      /api/trace/:id/full        the EXACT record — system prompt,
//                                       packed context, raw output — read back
//                                       from the day's jsonl (TRC-02: what the
//                                       viewer shows is byte-what-the-model-saw)
//
// Intelligence and Enrichment already have owners (/api/settings/models,
// /api/settings/media, /api/retrieval/semantic/*) — this file adds only what
// P4.3 introduced, and never re-implements a served number.
// ===========================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appStateGet, appStateSet, pausedKey } from "../db/ingest.js";
import { CAPTURE_LIST_KEYS, readCaptureList, setCaptureList } from "../db/capture-filter.js";
import {
  getNotificationsEnabled,
  setNotificationsEnabled,
} from "../db/settings.js";
import {
  assistCooldownMinutes,
  assistQuietHours,
  assistThreshold,
  getAssistEnabled,
  setAssistEnabled,
  setAssistQuietHours,
  setAssistThreshold,
} from "../assist/settings.js";
import {
  checkGraduation,
  graduationMode,
  graduationWindow,
  setGraduationMode,
  DEFAULT_GRADUATION_MODE,
  GRADUATION_MIN_PROPOSALS,
  GRADUATION_REQUIRED_DAYS,
} from "../consolidation/graduation.js";
import { lastT3Report, lastT3RunAt, T3_EVAL_DUE_KEY } from "../consolidation/t3.js";
import { homeRoot } from "../home.js";
import { dayFilePath } from "../traces/store.js";
import {
  discoverClaudeModels,
  type ClaudeModelInfo,
  type ModelCatalog,
} from "../providers/claude-local/discovery.js";
import {
  DEFAULT_STEP_THINKING,
  isThinkingLevel,
  thinkingKeyFor,
} from "../brain/reasoning.js";
import {
  awaitGoldenRun,
  goldenRunnerInstalled,
  goldenRunnerNote,
  goldenState,
  proposeStepChange,
  startGoldenRun,
} from "../settings/golden-gate.js";
import {
  applyAssistP1Patch,
  applyConnectorPatch,
  applyRetrievalPatch,
  assistP1Settings,
  connectorSettings,
  retrievalSettings,
} from "../settings/p1-settings.js";
import { evalCategoriesForStep, PROCESS_ENABLED_PREFIX } from "../settings/steps.js";
import { diffRuns, listRuns, runDetail, setRunQuarantine } from "../settings/runs.js";

// ---- keys ------------------------------------------------------------------

export const HOTKEY_SUMMON_KEY = "general.hotkey_summon";
export const HOTKEY_BAR_KEY = "general.hotkey_bar";
export const LAUNCH_AT_LOGIN_KEY = "general.launch_at_login";
export const BRIEF_TIMES_KEY = "general.brief_times";
export const APPEARANCE_KEY = "general.appearance";
// The four filter lists live in db/capture-filter.ts (V6 S1.7) — the funnel
// reads them; these two names stay for the callers that already use them.
export const APP_BLOCKLIST_KEY = CAPTURE_LIST_KEYS.apps;
export const DOMAIN_BLOCKLIST_KEY = CAPTURE_LIST_KEYS.sites;
export const CHAT_BLOCKLIST_KEY = CAPTURE_LIST_KEYS.chats;
export const SENDER_BLOCKLIST_KEY = CAPTURE_LIST_KEYS.senders;
export const PAGETEXT_RULES_KEY = "capture.pagetext_rules";
export const TRACES_RETENTION_DAYS_KEY = "traces.retention_days";

export const DEFAULT_HOTKEY_SUMMON = "double-right-cmd";
export const DEFAULT_HOTKEY_BAR = "cmd-shift-s";
export const DEFAULT_BRIEF_TIMES = ["08:30", "18:30"];
export const DEFAULT_TRACES_RETENTION_DAYS = 30;

/** The sources Capture & Privacy renders pause switches for. */
export const CAPTURE_SOURCES = ["whatsapp", "browser", "screen"] as const;

// ---- Intelligence: the V13 step list (spec §14.9.4) ------------------------
//
// Every step DEFAULTS to Haiku (modelForPass in brain/llm.ts reads app_state
// `selected_model_<key>`, "haiku" when unset); the recommendation is shown
// beside the picker and applied only by user choice. The keys are the LIVE
// pass STEMS the traced runners spend under (`orient`, `critic`, `extract`,
// `decide`, `digest`, `consolidate`, `assist`, `executor`, `chat`, `tier`) —
// modelForPass / storedThinkingForPass fall back from a versioned id
// (`orient.v7`) to its stem, so one key follows a step across prompt
// versions. The 13.9 build keyed Orient as `orient.v6` and Critic as
// `critic.v4`, which nothing read (V6 P1 S5.6). "chat" doubles as the
// grounded bar's role key (grounded/handlers.ts reads getSelectedModel("chat"),
// same app_state key).

export interface IntelligenceStep {
  key: string;
  label: string;
  group: "Understanding" | "Fast lane" | "Agents" | "Utility";
  recommended: "haiku" | "sonnet";
}

export const INTELLIGENCE_STEPS: readonly IntelligenceStep[] = [
  { key: "orient", label: "Orient", group: "Understanding", recommended: "sonnet" },
  { key: "critic", label: "Critic", group: "Understanding", recommended: "haiku" },
  { key: "extract", label: "Extract", group: "Understanding", recommended: "sonnet" },
  { key: "decide", label: "Decide", group: "Understanding", recommended: "sonnet" },
  { key: "digest", label: "Digest", group: "Understanding", recommended: "haiku" },
  { key: "consolidate", label: "Consolidation judge", group: "Understanding", recommended: "haiku" },
  { key: "assist", label: "Assist watcher", group: "Fast lane", recommended: "haiku" },
  { key: "executor", label: "Executor", group: "Agents", recommended: "sonnet" },
  { key: "chat", label: "Grounded bar", group: "Agents", recommended: "sonnet" },
  { key: "tier", label: "Tiering (business character)", group: "Utility", recommended: "haiku" },
  // V6 P1 S4.6: the brief's prose call. Code composes the ledger, so turning
  // this step off holds the set time rather than dropping the brief.
  { key: "brief", label: "Brief (prose)", group: "Utility", recommended: "haiku" },
] as const;

/**
 * The pickable classes for a V13 step, as the 13.4.1 build had them.
 *
 * KEPT ONLY as the answer of last resort. Three bare family names is what
 * defect 6 was: it does not say which version will run, what it costs, or
 * whether the model has a reasoning dial. The picker is now served from
 * `modelCatalog()` below — the models this machine's `claude` can actually
 * reach, read out of the CLI — and these three stay valid ids because every
 * install that predates the fix has one of them persisted.
 */
export const STEP_MODEL_OPTIONS = ["haiku", "sonnet", "opus"] as const;

export const DEFAULT_STEP_MODEL = "haiku";

/** app_state key holding the last successful discovery, so a cold worker is instant. */
export const MODEL_CATALOG_CACHE_KEY = "intelligence.model_catalog";

/**
 * Every model the picker may offer, discovered from the CLI when that works
 * and served from the curated registry when it does not — with `mode` saying
 * which, because a stale list shown as a live one is the thing this replaced.
 *
 * The last DISCOVERED answer is remembered in app_state: a worker that just
 * started, or one whose `claude` moved, still shows the real list rather than
 * silently dropping to the curated one.
 */
export function modelCatalog(): ModelCatalog {
  const live = discoverClaudeModels();
  if (live.mode === "discovered") {
    try {
      appStateSet(MODEL_CATALOG_CACHE_KEY, JSON.stringify(live));
    } catch {
      // No database yet — the catalogue is still perfectly usable.
    }
    return live;
  }
  try {
    const cached: unknown = JSON.parse(appStateGet(MODEL_CATALOG_CACHE_KEY) ?? "null");
    const models = (cached as ModelCatalog | null)?.models;
    if (Array.isArray(models) && models.length > 0) {
      // Remembered, not re-read: said plainly, with the reason this boot could
      // not reach the CLI.
      return { ...(cached as ModelCatalog), mode: "cached", error: live.error };
    }
  } catch {
    // Unparseable cache — the curated list is the honest answer.
  }
  return live;
}

/** The catalogue row for an id, or null. Ids are catalogue keys, never free text. */
function findModel(catalog: ModelCatalog, id: string): ClaudeModelInfo | null {
  return catalog.models.find((m) => m.id === id) ?? null;
}

// ---- helpers ---------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringList(key: string): string[] {
  const raw = appStateGet(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function writeStringList(key: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  appStateSet(key, JSON.stringify(value.map((v) => String(v)).slice(0, 500)));
}

function dirBytes(path: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(path)) {
      const p = join(path, name);
      try {
        const st = statSync(p);
        total += st.isDirectory() ? dirBytes(p) : st.size;
      } catch {
        // unreadable entry — skip
      }
    }
  } catch {
    return 0;
  }
  return total;
}

// ---- payload builders ------------------------------------------------------

function generalSettings(): Record<string, unknown> {
  return {
    hotkey_summon: appStateGet(HOTKEY_SUMMON_KEY) ?? DEFAULT_HOTKEY_SUMMON,
    hotkey_bar: appStateGet(HOTKEY_BAR_KEY) ?? DEFAULT_HOTKEY_BAR,
    launch_at_login: appStateGet(LAUNCH_AT_LOGIN_KEY) === "1",
    notifications_enabled: getNotificationsEnabled(),
    brief_times: (() => {
      const list = readStringList(BRIEF_TIMES_KEY);
      return list.length > 0 ? list : DEFAULT_BRIEF_TIMES;
    })(),
    appearance: appStateGet(APPEARANCE_KEY) ?? "system",
    graduation_mode: graduationMode(),
  };
}

function captureSettings(): Record<string, unknown> {
  const sources: Record<string, { paused: boolean }> = {};
  for (const s of CAPTURE_SOURCES) {
    sources[s] = { paused: appStateGet(pausedKey(s)) === "1" };
  }
  return {
    sources,
    app_blocklist: readCaptureList("apps"),
    domain_blocklist: readCaptureList("sites"),
    chat_blocklist: readCaptureList("chats"),
    sender_blocklist: readCaptureList("senders"),
    pagetext_rules: readStringList(PAGETEXT_RULES_KEY),
    // Shown for trust, never editable: incognito is ALWAYS excluded (§14.9.2).
    incognito: "always-off",
  };
}

function assistSettings(): Record<string, unknown> {
  const suppressed = getDb()
    .prepare(
      `SELECT topic_key, suppressed_until FROM assist_topics
        WHERE suppressed_until IS NOT NULL AND suppressed_until > ?
        ORDER BY suppressed_until DESC`,
    )
    .all(new Date().toISOString()) as { topic_key: string; suppressed_until: string }[];
  return {
    enabled: getAssistEnabled(),
    thresholds: {
      default: assistThreshold(null),
      transaction: assistThreshold("transaction"),
      research: assistThreshold("research"),
      communication: assistThreshold("communication"),
    },
    cooldown_min: assistCooldownMinutes(),
    quiet_hours: assistQuietHours(),
    suppressed_contexts: suppressed,
    // V6 P1 §25 Assist: freshness = the cold window, burst K/W, card duration,
    // merge window, intent floor, blocked kinds, behavioral rules.
    ...assistP1Settings(),
  };
}

/**
 * Space creation: the mode, plus the over-creation metric as INFORMATION.
 * `default_mode` is what a fresh install does (auto-create); `mode` is what
 * this install is doing. The streak no longer gates anything — it is reported
 * so the user can see whether the twin's filing has been clean.
 */
function graduationSettings(): Record<string, unknown> {
  const check = checkGraduation();
  return {
    mode: check.mode,
    default_mode: DEFAULT_GRADUATION_MODE,
    reverted: check.reverted,
    required_days: GRADUATION_REQUIRED_DAYS,
    consecutive_green: check.consecutiveGreen,
    window_proposals: check.windowProposals,
    min_proposals: GRADUATION_MIN_PROPOSALS,
    window: graduationWindow(GRADUATION_REQUIRED_DAYS),
  };
}

// ---- the handler -----------------------------------------------------------

/**
 * Handle one settings route. Returns false for any path it does not claim
 * (the server's shared handler contract).
 */
export async function handleSettingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // ======================= General ========================================

  if (method === "GET" && path === "/api/settings/general") {
    sendJson(res, 200, generalSettings());
    return true;
  }

  if (method === "POST" && path === "/api/settings/general") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    if (typeof body.hotkey_summon === "string") appStateSet(HOTKEY_SUMMON_KEY, body.hotkey_summon);
    if (typeof body.hotkey_bar === "string") appStateSet(HOTKEY_BAR_KEY, body.hotkey_bar);
    if (typeof body.launch_at_login === "boolean")
      appStateSet(LAUNCH_AT_LOGIN_KEY, body.launch_at_login ? "1" : "0");
    if (typeof body.notifications_enabled === "boolean")
      setNotificationsEnabled(body.notifications_enabled);
    if (body.brief_times !== undefined) writeStringList(BRIEF_TIMES_KEY, body.brief_times);
    if (typeof body.appearance === "string") appStateSet(APPEARANCE_KEY, body.appearance);
    if (body.graduation_mode === "propose" || body.graduation_mode === "auto")
      setGraduationMode(body.graduation_mode, "user");
    sendJson(res, 200, generalSettings());
    return true;
  }

  // ======================= Capture & Privacy ==============================

  if (method === "GET" && path === "/api/settings/capture") {
    sendJson(res, 200, captureSettings());
    return true;
  }

  if (method === "POST" && path === "/api/settings/capture") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const sources = body.sources as Record<string, { paused?: unknown }> | undefined;
    if (sources && typeof sources === "object") {
      for (const s of CAPTURE_SOURCES) {
        const v = sources[s]?.paused;
        if (typeof v === "boolean") appStateSet(pausedKey(s), v ? "1" : "0");
      }
    }
    // The lists the funnel enforces (db/capture-filter.ts, V6 S1.7).
    if (body.app_blocklist !== undefined) setCaptureList("apps", body.app_blocklist);
    if (body.domain_blocklist !== undefined) setCaptureList("sites", body.domain_blocklist);
    if (body.chat_blocklist !== undefined) setCaptureList("chats", body.chat_blocklist);
    if (body.sender_blocklist !== undefined) setCaptureList("senders", body.sender_blocklist);
    if (body.pagetext_rules !== undefined) writeStringList(PAGETEXT_RULES_KEY, body.pagetext_rules);
    sendJson(res, 200, captureSettings());
    return true;
  }

  // ======================= Sources ========================================

  if (method === "GET" && path === "/api/settings/sources") {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT source_id AS source, COUNT(*) AS streams,
                SUM(CASE WHEN capture_paused = 1 THEN 1 ELSE 0 END) AS paused_streams
           FROM streams GROUP BY source_id ORDER BY source_id`,
      )
      .all() as { source: string; streams: number; paused_streams: number }[];
    const lastEvent = db.prepare(`SELECT MAX(ts) AS ts FROM events WHERE source_id = ?`);
    sendJson(res, 200, {
      sources: rows.map((r) => ({
        source: r.source,
        streams: r.streams,
        paused_streams: r.paused_streams,
        paused: appStateGet(pausedKey(r.source)) === "1",
        import_done: appStateGet(`source.${r.source}.import_done`) === "true",
        last_event_at: (lastEvent.get(r.source) as { ts: string | null }).ts,
      })),
    });
    return true;
  }

  // ======================= Graduation (also under General) ================

  if (method === "GET" && path === "/api/settings/graduation") {
    sendJson(res, 200, graduationSettings());
    return true;
  }

  if (method === "POST" && path === "/api/settings/graduation") {
    const body = await readJsonBody(req);
    const mode = body?.mode;
    if (mode !== "propose" && mode !== "auto") {
      sendJson(res, 400, { error: `mode must be "propose" or "auto"` });
      return true;
    }
    setGraduationMode(mode, "user");
    sendJson(res, 200, graduationSettings());
    return true;
  }

  // ======================= Intelligence (V13 steps) =======================

  if (method === "GET" && path === "/api/settings/intelligence") {
    const db = getDb();
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const costFor = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls
         FROM traces WHERE created_at >= ? AND (pass = ? OR pass LIKE ?)`,
    );
    const catalog = modelCatalog();
    sendJson(res, 200, {
      default_model: DEFAULT_STEP_MODEL,
      default_thinking: DEFAULT_STEP_THINKING,
      // The old three-string list, still sent so an older shell keeps working.
      options: STEP_MODEL_OPTIONS,
      // What the picker actually renders: versioned ids, prices, reasoning
      // levels — and where the list came from.
      discovery: {
        mode: catalog.mode,
        source: catalog.source,
        error: catalog.error,
        discovered_at: catalog.discoveredAt,
      },
      models: catalog.models.map((m) => ({
        id: m.id,
        label: m.label,
        family: m.family,
        alias: m.alias,
        resolves_to: m.resolvesTo,
        input_per_mtok: m.inputPerMTok,
        output_per_mtok: m.outputPerMTok,
        thinking_levels: m.thinkingLevels,
        default_thinking: m.defaultThinking,
        effort: m.effort,
        context_window: m.contextWindow,
      })),
      eval_gated: true,
      // SET-02: whether a change RUNS the golden set here (runner installed) or
      // applies recorded as skipped; plus the last / current run.
      golden: {
        runner_installed: goldenRunnerInstalled(),
        runner_note: goldenRunnerNote(),
        state: goldenState(),
      },
      steps: INTELLIGENCE_STEPS.map((s) => {
        const stem = s.key.split(".")[0]!;
        const c = costFor.get(since, s.key, `${stem}.%`) as { cost: number; calls: number };
        const selected = appStateGet(`selected_model_${s.key}`) ?? DEFAULT_STEP_MODEL;
        const levels = findModel(catalog, selected)?.thinkingLevels ?? [];
        const stored = appStateGet(thinkingKeyFor(s.key));
        return {
          ...s,
          selected,
          // A level the current model does not offer reads as "off" rather
          // than as a selection the runner would silently drop.
          thinking:
            isThinkingLevel(stored) && levels.includes(stored) ? stored : DEFAULT_STEP_THINKING,
          thinking_levels: levels,
          enabled: appStateGet(`${PROCESS_ENABLED_PREFIX}${s.key}`) !== "0",
          cost_7d_usd: c.cost,
          calls_7d: c.calls,
          eval_categories: evalCategoriesForStep(s.key),
          // A candidate waiting on the golden set for THIS step, if any.
          pending: (() => {
            const g = goldenState();
            return g.status === "running" && g.step === s.key ? g.candidate : null;
          })(),
        };
      }),
    });
    return true;
  }

  if (method === "POST" && path === "/api/settings/intelligence") {
    const body = await readJsonBody(req);
    const step = INTELLIGENCE_STEPS.find((s) => s.key === body?.step);
    if (!step) {
      sendJson(res, 400, { error: "unknown step" });
      return true;
    }
    if (typeof body?.enabled === "boolean") {
      // A step turned off queues, never drops (SET-01): the dispatcher reads
      // this key before every hand-off (scheduler/v6/dispatch.ts submit) and
      // holds the lane; here we only persist and record it.
      appStateSet(`${PROCESS_ENABLED_PREFIX}${step.key}`, body.enabled ? "1" : "0");
    }
    const catalog = modelCatalog();
    let gate: { status: string; state: unknown } | null = null;
    if (body?.model !== undefined) {
      const model = String(body.model);
      // Validated against the list the picker was SERVED, not against three
      // hardcoded family names — otherwise every real model the CLI can reach
      // is rejected at the edge, which is half of what defect 6 was.
      if (!findModel(catalog, model)) {
        sendJson(res, 400, { error: `model must be one this build can reach: ${model}` });
        return true;
      }
      const before = appStateGet(`selected_model_${step.key}`) ?? DEFAULT_STEP_MODEL;
      if (before !== model) {
        // SET-02: the golden set runs FIRST. `apply` is called only when the
        // gate lets the change through — at once when no runner is installed
        // (recorded as skipped), after a green compare when one is. A red
        // compare leaves `before` in place and writes a "blocked" decision.
        const apply = (): void => {
          appStateSet(`selected_model_${step.key}`, model);
          // A model change can invalidate the reasoning level: the new model may
          // not offer the one that was set. Clearing it here is what keeps the
          // stored pair (model, level) one the runner can actually send.
          const kept = findModel(catalog, model)?.thinkingLevels ?? [];
          const heldLevel = appStateGet(thinkingKeyFor(step.key));
          if (isThinkingLevel(heldLevel) && !kept.includes(heldLevel)) {
            appStateSet(thinkingKeyFor(step.key), DEFAULT_STEP_THINKING);
          }
          // Every model change is a decision row AND marks the golden set due
          // for the next full pass (spec §18).
          writeDecision({
            pass: "user",
            targetKind: "setting",
            targetId: `selected_model_${step.key}`,
            action: "update",
            old: { model: before },
            new: { model },
            reason: `user picked ${model} for ${step.label} (rec: ${step.recommended})`,
          });
          appStateSet(T3_EVAL_DUE_KEY, new Date().toISOString());
        };
        const r = await proposeStepChange({ step: step.key, label: step.label, model }, apply);
        gate = { status: r.status, state: r.state };
      }
    }
    if (body?.thinking !== undefined) {
      const thinking = String(body.thinking);
      const model = appStateGet(`selected_model_${step.key}`) ?? DEFAULT_STEP_MODEL;
      const levels = findModel(catalog, model)?.thinkingLevels ?? [];
      if (!isThinkingLevel(thinking) || !levels.includes(thinking)) {
        sendJson(res, 400, {
          error:
            levels.length === 0
              ? `${model} has no reasoning levels`
              : `thinking must be one of ${levels.join(", ")}`,
        });
        return true;
      }
      const before = appStateGet(thinkingKeyFor(step.key)) ?? DEFAULT_STEP_THINKING;
      if (before !== thinking) {
        // Same gate as the model: how hard a step thinks changes what it
        // answers, so it runs the golden set first, is a decision row, and
        // marks the set due.
        const apply = (): void => {
          appStateSet(thinkingKeyFor(step.key), thinking);
          writeDecision({
            pass: "user",
            targetKind: "setting",
            targetId: thinkingKeyFor(step.key),
            action: "update",
            old: { thinking: before },
            new: { thinking },
            reason: `user set ${step.label} reasoning to ${thinking} on ${model}`,
          });
          appStateSet(T3_EVAL_DUE_KEY, new Date().toISOString());
        };
        const r = await proposeStepChange({ step: step.key, label: step.label, thinking }, apply);
        gate = { status: r.status, state: r.state };
      }
    }
    sendJson(res, 200, { step: step.key, ok: true, gate });
    return true;
  }

  // ======================= Golden set (SET-02; the ops button) =============

  if (method === "GET" && path === "/api/settings/golden") {
    sendJson(res, 200, {
      runner_installed: goldenRunnerInstalled(),
      runner_note: goldenRunnerNote(),
      state: goldenState(),
    });
    return true;
  }

  // POST /api/settings/golden/run { categories?: string[], wait?: boolean }
  // The manual run. SPENDS MODEL CALLS when a runner is installed; refuses
  // (409) when none is, so a test worker can never spend through it.
  if (method === "POST" && path === "/api/settings/golden/run") {
    const body = (await readJsonBody(req)) ?? {};
    const cats = Array.isArray(body.categories)
      ? body.categories.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
      : null;
    const r = await startGoldenRun(cats && cats.length > 0 ? cats : null, "manual run from Settings");
    if (!r.started) {
      sendJson(res, 409, { error: r.error, state: r.state });
      return true;
    }
    const state = body.wait === true ? await awaitGoldenRun() : r.state;
    sendJson(res, 200, { started: true, state });
    return true;
  }

  // ======================= T3 =============================================

  if (method === "GET" && path === "/api/settings/t3") {
    sendJson(res, 200, {
      last_run_at: lastT3RunAt(),
      last_report: lastT3Report(),
      eval_regression_due: appStateGet(T3_EVAL_DUE_KEY) ?? null,
    });
    return true;
  }

  // ======================= Assist (spec §14.9.6 — the §10.1 gate) =========

  if (method === "GET" && path === "/api/settings/assist") {
    sendJson(res, 200, assistSettings());
    return true;
  }

  if (method === "POST" && path === "/api/settings/assist") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    if (typeof body.enabled === "boolean") setAssistEnabled(body.enabled);
    const thresholds = body.thresholds as Record<string, unknown> | undefined;
    if (thresholds && typeof thresholds === "object") {
      for (const [cat, v] of Object.entries(thresholds)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1 && n <= 50) setAssistThreshold(cat, Math.floor(n));
      }
    }
    if (body.cooldown_min !== undefined) {
      const n = Number(body.cooldown_min);
      if (Number.isFinite(n) && n >= 0) appStateSet("assist.cooldown_min", String(Math.floor(n)));
    }
    const qh = body.quiet_hours as { start?: unknown; end?: unknown } | undefined;
    if (qh && typeof qh.start === "string" && typeof qh.end === "string") {
      setAssistQuietHours(qh.start, qh.end);
    }
    // "Suppression is visible state, not a black box" — the list clears here.
    if (body.clear_suppressed === true) {
      getDb().prepare(`UPDATE assist_topics SET suppressed_until = NULL`).run();
    }
    // V6 P1 §25: freshness preset (SET-03 — the dispatcher re-reads it on its
    // next tick), burst K/W, card duration, merge window, intent floor,
    // blocked kinds, behavioral rules. Anything that fails its rail is refused
    // by name and the rest still applies.
    const refused = applyAssistP1Patch(body as Parameters<typeof applyAssistP1Patch>[0]);
    sendJson(res, 200, { ...assistSettings(), ...(refused.length > 0 ? { refused } : {}) });
    return true;
  }

  // ======================= Retrieval (V6 P1 §25; T2 rows hidden) ==========

  if (method === "GET" && path === "/api/settings/retrieval") {
    sendJson(res, 200, retrievalSettings());
    return true;
  }

  if (method === "POST" && path === "/api/settings/retrieval") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const refused = applyRetrievalPatch(body as Parameters<typeof applyRetrievalPatch>[0]);
    sendJson(res, 200, { ...retrievalSettings(), ...(refused.length > 0 ? { refused } : {}) });
    return true;
  }

  // ======================= AI Connector (V6 P1 §25, Product_V6 §9) =========

  if (method === "GET" && path === "/api/settings/connector") {
    const catalog = modelCatalog();
    sendJson(
      res,
      200,
      connectorSettings({
        connected: catalog.mode !== "fallback",
        detail: catalog.mode === "fallback" ? (catalog.error ?? "claude CLI not found") : catalog.source,
      }),
    );
    return true;
  }

  if (method === "POST" && path === "/api/settings/connector") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const refused = applyConnectorPatch(body as { fallback_order?: unknown });
    const catalog = modelCatalog();
    sendJson(res, 200, {
      ...connectorSettings({
        connected: catalog.mode !== "fallback",
        detail: catalog.mode === "fallback" ? (catalog.error ?? "claude CLI not found") : catalog.source,
      }),
      ...(refused.length > 0 ? { refused } : {}),
    });
    return true;
  }

  // ======================= Data ===========================================

  if (method === "GET" && path === "/api/settings/data") {
    const root = homeRoot();
    const db = getDb();
    const perSource = db
      .prepare(
        `SELECT COALESCE(source_type, source_id, '(unknown)') AS source, COUNT(*) AS events
           FROM events GROUP BY 1 ORDER BY 1`,
      )
      .all() as { source: string; events: number }[];
    let dbBytes = 0;
    try {
      dbBytes = statSync(db.name).size; // better-sqlite3: .name is the file path
    } catch {
      dbBytes = 0;
    }
    sendJson(res, 200, {
      home: root,
      storage: {
        db_bytes: dbBytes,
        traces_bytes: dirBytes(join(root, "traces")),
        media_bytes: dirBytes(join(root, "media")),
        logs_bytes: dirBytes(join(root, "logs")),
      },
      events_per_source: perSource,
      retention: {
        traces_days: Number(appStateGet(TRACES_RETENTION_DAYS_KEY) ?? DEFAULT_TRACES_RETENTION_DAYS),
      },
    });
    return true;
  }

  if (method === "POST" && path === "/api/settings/data/retention") {
    const body = await readJsonBody(req);
    const days = Number(body?.traces_days);
    if (!Number.isFinite(days) || days < 7 || days > 3650) {
      sendJson(res, 400, { error: "traces_days must be 7–3650" });
      return true;
    }
    appStateSet(TRACES_RETENTION_DAYS_KEY, String(Math.floor(days)));
    sendJson(res, 200, { retention: { traces_days: Math.floor(days) } });
    return true;
  }

  // ======================= Runs & Traces viewer ===========================

  // ---- The RUN index (Product_V6 §25 Runs) --------------------------------
  //
  // A trace is one model call; a RUN is the unit the product doc names, the
  // unit `undo` reverses and the unit a diff is worth reading. Quarantined
  // runs are listed and flagged by default: hiding them would hide real spend
  // from the cost rollup, which is the one number this pane must not soften.

  if (method === "GET" && path === "/api/runs") {
    const q = url.searchParams.get("quarantined");
    sendJson(
      res,
      200,
      listRuns({
        pass: url.searchParams.get("pass"),
        day: url.searchParams.get("day"),
        status: url.searchParams.get("status"),
        origin: url.searchParams.get("origin"),
        quarantined: q === null || q === "" ? null : q === "1" || q === "true",
        limit: Number(url.searchParams.get("limit") ?? 100),
        offset: Number(url.searchParams.get("offset") ?? 0),
      }),
    );
    return true;
  }

  // Two runs side by side. Ordered BEFORE /api/runs/:id so "diff" is never
  // read as a run id.
  if (method === "GET" && path === "/api/runs/diff") {
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    if (!a || !b) {
      sendJson(res, 400, { error: "diff needs both a and b run ids" });
      return true;
    }
    const diff = diffRuns(a, b);
    if (!diff) {
      sendJson(res, 404, { error: `no run ${a} or ${b}` });
      return true;
    }
    sendJson(res, 200, diff);
    return true;
  }

  const runQuarantinePath = path.match(/^\/api\/runs\/([^/]+)\/quarantine$/);
  if (runQuarantinePath && method === "POST") {
    const id = decodeURIComponent(runQuarantinePath[1]!);
    const body = (await readJsonBody(req)) ?? {};
    // Default is TO quarantine: the button that reads "quarantine" must not
    // release when the body is empty.
    const quarantined = body.quarantined === undefined ? true : body.quarantined === true;
    const reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : null;
    const state = setRunQuarantine(id, quarantined, reason);
    if (!state) {
      sendJson(res, 404, { error: `no run ${id}` });
      return true;
    }
    sendJson(res, 200, { run_id: id, quarantine: state });
    return true;
  }

  const runPath = path.match(/^\/api\/runs\/([^/]+)$/);
  if (runPath && method === "GET") {
    const id = decodeURIComponent(runPath[1]!);
    const detail = runDetail(id);
    if (!detail) {
      sendJson(res, 404, { error: `no run ${id}` });
      return true;
    }
    sendJson(res, 200, detail);
    return true;
  }

  if (method === "GET" && path === "/api/traces") {
    const db = getDb();
    const pass = url.searchParams.get("pass");
    const day = url.searchParams.get("day");
    const runId = url.searchParams.get("run_id");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const where: string[] = [];
    const args: unknown[] = [];
    if (pass) {
      where.push("pass = ?");
      args.push(pass);
    }
    if (day) {
      where.push("day = ?");
      args.push(day);
    }
    if (runId) {
      where.push("run_id = ?");
      args.push(runId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const traces = db
      .prepare(
        `SELECT id, run_id, pass, caller, model, prompt_version, repair_count,
                input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
                output_tokens, cost_usd, latency_ms, status, day, created_at
           FROM traces ${clause}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    // The cost dashboard: same filter, rolled up per pass — one read, so the
    // list and the rollup can never disagree.
    const costs = db
      .prepare(
        `SELECT COALESCE(pass, '(none)') AS pass, COUNT(*) AS calls,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM traces ${clause} GROUP BY pass ORDER BY cost_usd DESC`,
      )
      .all(...args);
    sendJson(res, 200, { traces, costs });
    return true;
  }

  const full = path.match(/^\/api\/trace\/([^/]+)\/full$/);
  if (full && method === "GET") {
    const id = decodeURIComponent(full[1]!);
    const row = getDb()
      .prepare(`SELECT id, day, compressed FROM traces WHERE id = ?`)
      .get(id) as { id: string; day: string | null; compressed: number } | undefined;
    if (!row || !row.day) {
      sendJson(res, 404, { error: `no trace ${id}` });
      return true;
    }
    // The jsonl day file holds the EXACT record: system prompt, packed
    // context, raw output. Serving the stored line — never a paraphrase — is
    // what makes the viewer byte-what-the-model-saw (TRC-02).
    try {
      const lines = readFileSync(dayFilePath(row.day), "utf8").split("\n");
      for (const line of lines) {
        if (!line.includes(id)) continue;
        const record: unknown = JSON.parse(line);
        if ((record as { trace_id?: string }).trace_id === id) {
          sendJson(res, 200, { trace: record, compressed: row.compressed === 1 });
          return true;
        }
      }
    } catch {
      // fall through to 404
    }
    sendJson(res, 404, { error: `day file for trace ${id} unreadable` });
    return true;
  }

  return false;
}
