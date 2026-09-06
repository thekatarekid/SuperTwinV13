// ===========================================================================
// [CODE] The P1 setting groups Product_V6_Phase1 §25 adds over the eight
// 13.4 subtabs (V6 P1 S5.6):
//
//   Assist      freshness preset (= the cold window, read live by the
//               dispatcher each tick — SET-03), burst K / W, nudge card
//               duration, merge window, intent-confidence floor, blocked
//               kinds (from "don't do this again", reversible), behavioral
//               rules list.
//   Calendar    NOT here — the calendar lane owns Settings › Calendar
//               (calendar/lead-time.ts serves GET/POST /api/settings/calendar:
//               lead times and plan-or-wish per circle, snooze defaults).
//   Retrieval   agentic retrieval on/off, exhaustive-scan row limit, graph hop
//               limit + fan-out cap, hub-node exclusion list; the T2 hop /
//               time budgets are STORED but flagged hidden — P1 ships T0 only.
//   AI Connector doors (CLI live; OAuth · OpenRouter · local LLM are P3 and
//               say so), fallback order, spend ceilings, the stop-all switch.
//
// Every value is one app_state row with a typed reader that clamps to the
// rails below, so a typo cannot disable a gate. Readers never throw: no
// database reads as the default. Sharing, Public and Economy are hidden in P1
// and have no keys here.
// ===========================================================================

import { appStateGet, appStateSet } from "../db/ingest.js";
import { listHubs, removeHub, addHub } from "../db/v6graph.js";
import { budgetCeilings, isModelActivityPaused } from "../providers/budget.js";
import { GRAPH_DEFAULTS } from "../retrieval/graph.js";
import { MAX_LIST_LIMIT } from "../retrieval/structured.js";
import { BURST_K, BURST_WINDOW_MS, type BurstParams } from "../scheduler/v6/burst.js";
import {
  DEFAULT_PRESET,
  FRESHNESS_PRESETS,
  presetParams,
  type ColdParams,
  type FreshnessPreset,
} from "../scheduler/v6/cold.js";
import { FRESHNESS_KEY } from "../scheduler/v6/dispatch.js";

// ---- helpers ---------------------------------------------------------------

function readNumber(key: string, dflt: number, min: number, max: number): number {
  try {
    const raw = appStateGet(key);
    if (raw === null) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  } catch {
    return dflt;
  }
}

function writeNumber(key: string, value: unknown, min: number, max: number): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  appStateSet(key, String(Math.min(max, Math.max(min, n))));
  return true;
}

function readBool(key: string, dflt: boolean): boolean {
  try {
    const raw = appStateGet(key);
    if (raw === null) return dflt;
    return raw === "1" || raw === "true";
  } catch {
    return dflt;
  }
}

function writeBool(key: string, value: boolean): void {
  appStateSet(key, value ? "1" : "0");
}

function readJson<T>(key: string, dflt: T, check: (v: unknown) => v is T): T {
  try {
    const raw = appStateGet(key);
    if (!raw) return dflt;
    const v: unknown = JSON.parse(raw);
    return check(v) ? v : dflt;
  } catch {
    return dflt;
  }
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function cleanList(v: unknown, cap: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    const s = String(x).trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

// ===========================================================================
// Assist
// ===========================================================================

export const BURST_K_KEY = "assist.burst_k";
export const BURST_W_S_KEY = "assist.burst_window_s";
export const CARD_DURATION_S_KEY = "assist.card_duration_s";
export const MERGE_WINDOW_S_KEY = "assist.merge_window_s";
export const INTENT_FLOOR_KEY = "assist.intent_confidence_min"; // shared with ./assist-settings.ts
export const BLOCKED_KINDS_KEY = "assist.blocked_kinds";
export const BEHAVIORAL_RULES_KEY = "assist.behavioral_rules";

export const DEFAULT_CARD_DURATION_S = 60;
/** Two nudges on one context inside this window merge into one card. */
export const DEFAULT_MERGE_WINDOW_S = 120;
/**
 * Spec §10.1, and the ONE default for this key (S4.4). It used to be 0.6 here
 * while brain/live.ts read the same `assist.intent_confidence_min` row with a
 * 0.7 default, so an action at 0.65 was shelved by the writer and carded by
 * the router. Both now go through surfaces/nudge-verdict.ts.
 */
export const DEFAULT_INTENT_FLOOR = 0.7;

export const FRESHNESS_PRESET_IDS = Object.keys(FRESHNESS_PRESETS) as FreshnessPreset[];

export function isFreshnessPreset(v: unknown): v is FreshnessPreset {
  return typeof v === "string" && (FRESHNESS_PRESET_IDS as string[]).includes(v);
}

export function freshnessPreset(): FreshnessPreset {
  try {
    const raw = appStateGet(FRESHNESS_KEY);
    return isFreshnessPreset(raw) ? raw : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

/** Writes the key the dispatcher re-reads on its next tick — no restart, no re-plan. */
export function setFreshnessPreset(p: FreshnessPreset): void {
  appStateSet(FRESHNESS_KEY, p);
}

export function burstParams(): BurstParams {
  return {
    k: Math.round(readNumber(BURST_K_KEY, BURST_K, 2, 50)),
    windowMs: Math.round(readNumber(BURST_W_S_KEY, BURST_WINDOW_MS / 1000, 30, 3600)) * 1000,
  };
}

export interface BehavioralRule {
  id: string;
  text: string;
  /** Where it came from: a bar utterance, a quick chip, Settings. */
  source: string;
  created_at: string;
}

const isRuleList = (v: unknown): v is BehavioralRule[] =>
  Array.isArray(v) &&
  v.every(
    (r) =>
      r && typeof r === "object" && typeof (r as BehavioralRule).id === "string" && typeof (r as BehavioralRule).text === "string",
  );

export function behavioralRules(): BehavioralRule[] {
  return readJson<BehavioralRule[]>(BEHAVIORAL_RULES_KEY, [], isRuleList);
}

export function addBehavioralRule(text: string, source = "settings", now: Date = new Date()): BehavioralRule {
  const rules = behavioralRules();
  const rule: BehavioralRule = {
    id: `rule_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text: text.trim().slice(0, 500),
    source,
    created_at: now.toISOString(),
  };
  appStateSet(BEHAVIORAL_RULES_KEY, JSON.stringify([...rules, rule].slice(-200)));
  return rule;
}

export function removeBehavioralRule(id: string): boolean {
  const rules = behavioralRules();
  const next = rules.filter((r) => r.id !== id);
  if (next.length === rules.length) return false;
  appStateSet(BEHAVIORAL_RULES_KEY, JSON.stringify(next));
  return true;
}

export interface AssistP1Settings {
  freshness: FreshnessPreset;
  /** The window the preset means, so the pane can print idle / max. */
  freshness_window: { idle_s: number; max_s: number };
  freshness_presets: Record<FreshnessPreset, { idle_s: number; max_s: number }>;
  burst: { k: number; window_s: number };
  card_duration_s: number;
  merge_window_s: number;
  intent_floor: number;
  blocked_kinds: string[];
  behavioral_rules: BehavioralRule[];
}

function windowOf(p: ColdParams): { idle_s: number; max_s: number } {
  return { idle_s: p.idleMs / 1000, max_s: p.maxMs / 1000 };
}

export function assistP1Settings(): AssistP1Settings {
  const preset = freshnessPreset();
  const b = burstParams();
  const presets = {} as Record<FreshnessPreset, { idle_s: number; max_s: number }>;
  for (const id of FRESHNESS_PRESET_IDS) presets[id] = windowOf(presetParams(id));
  return {
    freshness: preset,
    freshness_window: windowOf(presetParams(preset)),
    freshness_presets: presets,
    burst: { k: b.k, window_s: b.windowMs / 1000 },
    card_duration_s: readNumber(CARD_DURATION_S_KEY, DEFAULT_CARD_DURATION_S, 5, 600),
    merge_window_s: readNumber(MERGE_WINDOW_S_KEY, DEFAULT_MERGE_WINDOW_S, 0, 3600),
    intent_floor: readNumber(INTENT_FLOOR_KEY, DEFAULT_INTENT_FLOOR, 0, 1),
    blocked_kinds: readJson<string[]>(BLOCKED_KINDS_KEY, [], isStringList),
    behavioral_rules: behavioralRules(),
  };
}

export interface AssistP1Patch {
  freshness?: unknown;
  burst?: { k?: unknown; window_s?: unknown };
  card_duration_s?: unknown;
  merge_window_s?: unknown;
  intent_floor?: unknown;
  blocked_kinds?: unknown;
  add_rule?: unknown;
  remove_rule?: unknown;
}

/** Apply what validates; return what was refused, by field. */
export function applyAssistP1Patch(patch: AssistP1Patch): string[] {
  const refused: string[] = [];
  if (patch.freshness !== undefined) {
    if (isFreshnessPreset(patch.freshness)) setFreshnessPreset(patch.freshness);
    else refused.push(`freshness must be one of ${FRESHNESS_PRESET_IDS.join(", ")}`);
  }
  if (patch.burst && typeof patch.burst === "object") {
    if (patch.burst.k !== undefined && !writeNumber(BURST_K_KEY, patch.burst.k, 2, 50)) refused.push("burst.k must be a number 2–50");
    if (patch.burst.window_s !== undefined && !writeNumber(BURST_W_S_KEY, patch.burst.window_s, 30, 3600))
      refused.push("burst.window_s must be a number 30–3600");
  }
  if (patch.card_duration_s !== undefined && !writeNumber(CARD_DURATION_S_KEY, patch.card_duration_s, 5, 600))
    refused.push("card_duration_s must be a number 5–600");
  if (patch.merge_window_s !== undefined && !writeNumber(MERGE_WINDOW_S_KEY, patch.merge_window_s, 0, 3600))
    refused.push("merge_window_s must be a number 0–3600");
  if (patch.intent_floor !== undefined && !writeNumber(INTENT_FLOOR_KEY, patch.intent_floor, 0, 1))
    refused.push("intent_floor must be a number 0–1");
  if (patch.blocked_kinds !== undefined) {
    const list = cleanList(patch.blocked_kinds, 100);
    if (list) appStateSet(BLOCKED_KINDS_KEY, JSON.stringify(list));
    else refused.push("blocked_kinds must be a list of strings");
  }
  if (patch.add_rule !== undefined) {
    if (typeof patch.add_rule === "string" && patch.add_rule.trim()) addBehavioralRule(patch.add_rule);
    else refused.push("add_rule must be a non-empty string");
  }
  if (patch.remove_rule !== undefined) {
    if (typeof patch.remove_rule !== "string" || !removeBehavioralRule(patch.remove_rule)) refused.push("remove_rule names no rule");
  }
  return refused;
}

// ===========================================================================
// Retrieval (Product_V6 §25 Retrieval; P1: "T2 rows hidden")
// ===========================================================================

export const AGENTIC_RETRIEVAL_KEY = "retrieval.agentic";
export const T2_HOP_BUDGET_KEY = "retrieval.t2_hop_budget";
export const T2_TIME_BUDGET_S_KEY = "retrieval.t2_time_budget_s";
export const SCAN_ROW_LIMIT_KEY = "retrieval.scan_row_limit";
export const GRAPH_HOPS_KEY = "retrieval.graph_hops";
export const GRAPH_FANOUT_KEY = "retrieval.graph_fanout";

export const DEFAULT_T2_HOP_BUDGET = 3;
export const DEFAULT_T2_TIME_BUDGET_S = 20;

export interface RetrievalSettings {
  agentic: boolean;
  /** Stored, served, HIDDEN by the pane in P1 (T0 only ships). */
  t2: { hidden: true; hop_budget: number; time_budget_s: number };
  scan_row_limit: number;
  graph: { hops: number; fanout: number; default_hops: number; default_fanout: number };
  hubs: { entity_id: string; reason: string; degree: number | null; added_by: string | null }[];
}

export function retrievalSettings(): RetrievalSettings {
  let hubs: RetrievalSettings["hubs"] = [];
  try {
    hubs = listHubs().map((h) => ({ entity_id: h.entityId, reason: h.reason, degree: h.degree, added_by: h.addedBy }));
  } catch {
    hubs = [];
  }
  return {
    agentic: readBool(AGENTIC_RETRIEVAL_KEY, true),
    t2: {
      hidden: true,
      hop_budget: Math.round(readNumber(T2_HOP_BUDGET_KEY, DEFAULT_T2_HOP_BUDGET, 1, 10)),
      time_budget_s: readNumber(T2_TIME_BUDGET_S_KEY, DEFAULT_T2_TIME_BUDGET_S, 1, 300),
    },
    scan_row_limit: Math.round(readNumber(SCAN_ROW_LIMIT_KEY, MAX_LIST_LIMIT, 100, 1_000_000)),
    graph: {
      hops: Math.round(readNumber(GRAPH_HOPS_KEY, GRAPH_DEFAULTS.maxHops, 1, 4)),
      fanout: Math.round(readNumber(GRAPH_FANOUT_KEY, GRAPH_DEFAULTS.fanOut, 1, 200)),
      default_hops: GRAPH_DEFAULTS.maxHops,
      default_fanout: GRAPH_DEFAULTS.fanOut,
    },
    hubs,
  };
}

export interface RetrievalPatch {
  agentic?: unknown;
  t2?: { hop_budget?: unknown; time_budget_s?: unknown };
  scan_row_limit?: unknown;
  graph?: { hops?: unknown; fanout?: unknown };
  add_hub?: unknown;
  remove_hub?: unknown;
}

export function applyRetrievalPatch(patch: RetrievalPatch): string[] {
  const refused: string[] = [];
  if (patch.agentic !== undefined) {
    if (typeof patch.agentic === "boolean") writeBool(AGENTIC_RETRIEVAL_KEY, patch.agentic);
    else refused.push("agentic must be a boolean");
  }
  if (patch.t2 && typeof patch.t2 === "object") {
    if (patch.t2.hop_budget !== undefined && !writeNumber(T2_HOP_BUDGET_KEY, patch.t2.hop_budget, 1, 10)) refused.push("t2.hop_budget must be 1–10");
    if (patch.t2.time_budget_s !== undefined && !writeNumber(T2_TIME_BUDGET_S_KEY, patch.t2.time_budget_s, 1, 300))
      refused.push("t2.time_budget_s must be 1–300");
  }
  if (patch.scan_row_limit !== undefined && !writeNumber(SCAN_ROW_LIMIT_KEY, patch.scan_row_limit, 100, 1_000_000))
    refused.push("scan_row_limit must be 100–1,000,000");
  if (patch.graph && typeof patch.graph === "object") {
    if (patch.graph.hops !== undefined && !writeNumber(GRAPH_HOPS_KEY, patch.graph.hops, 1, 4)) refused.push("graph.hops must be 1–4");
    if (patch.graph.fanout !== undefined && !writeNumber(GRAPH_FANOUT_KEY, patch.graph.fanout, 1, 200)) refused.push("graph.fanout must be 1–200");
  }
  if (patch.add_hub !== undefined) {
    if (typeof patch.add_hub === "string" && patch.add_hub.trim()) {
      try {
        addHub(patch.add_hub.trim(), "user", { addedBy: "settings" });
      } catch (err) {
        refused.push(`add_hub: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else refused.push("add_hub must be an entity id");
  }
  if (patch.remove_hub !== undefined) {
    if (typeof patch.remove_hub !== "string" || !removeHub(patch.remove_hub)) refused.push("remove_hub names no hub");
  }
  return refused;
}

// ===========================================================================
// AI Connector (Product_V6 §9, §25)
// ===========================================================================

export const FALLBACK_ORDER_KEY = "connector.fallback_order";
export const DOORS = ["cli", "oauth", "openrouter", "local"] as const;
export type Door = (typeof DOORS)[number];
export const DEFAULT_FALLBACK_ORDER: readonly Door[] = ["cli", "local"];

export interface ConnectorDoor {
  door: Door;
  label: string;
  /** "live" = shipped and usable; "p3" = later phase; "local-only" = on-device models. */
  status: "live" | "p3" | "local-only";
  /** For the CLI door: what discovery found. */
  detail: string | null;
  connected: boolean;
}

export interface ConnectorSettings {
  doors: ConnectorDoor[];
  fallback_order: Door[];
  ceilings: { usd_per_call: number; usd_per_hour: number; usd_per_day: number; calls_per_hour: number; calls_per_day: number };
  /** The General pane's "Stop all model activity", mirrored here because §25 lists it under the connector. */
  stop_all: boolean;
}

export function fallbackOrder(): Door[] {
  const raw = readJson<string[]>(FALLBACK_ORDER_KEY, [...DEFAULT_FALLBACK_ORDER], isStringList);
  const order = raw.filter((d): d is Door => (DOORS as readonly string[]).includes(d));
  return order.length > 0 ? order : [...DEFAULT_FALLBACK_ORDER];
}

export function connectorSettings(cli: { connected: boolean; detail: string | null }): ConnectorSettings {
  const c = budgetCeilings();
  return {
    doors: [
      { door: "cli", label: "Claude Code CLI (your subscription)", status: "live", detail: cli.detail, connected: cli.connected },
      { door: "oauth", label: "Sign in to a provider (Anthropic · OpenAI · Google)", status: "p3", detail: "arrives in P3", connected: false },
      { door: "openrouter", label: "OpenRouter key", status: "p3", detail: "arrives in P3", connected: false },
      { door: "local", label: "Local models (embeddings · reranker · whisper)", status: "local-only", detail: "always on device", connected: true },
    ],
    fallback_order: fallbackOrder(),
    ceilings: {
      usd_per_call: c.usdPerCall,
      usd_per_hour: c.usdPerHour,
      usd_per_day: c.usdPerDay,
      calls_per_hour: c.callsPerHour,
      calls_per_day: c.callsPerDay,
    },
    stop_all: isModelActivityPaused(),
  };
}

export function applyConnectorPatch(patch: { fallback_order?: unknown }): string[] {
  const refused: string[] = [];
  if (patch.fallback_order !== undefined) {
    const list = cleanList(patch.fallback_order, DOORS.length);
    const doors = list?.filter((d): d is Door => (DOORS as readonly string[]).includes(d));
    if (doors && doors.length > 0 && doors.length === list!.length) appStateSet(FALLBACK_ORDER_KEY, JSON.stringify(doors));
    else refused.push(`fallback_order must list doors from ${DOORS.join(", ")}`);
  }
  return refused;
}
