// ===========================================================================
// [PROMPT] route.v1 — grounded-bar planner (Prompts V6 P1 P-08; Product_V6
// Phase 1 §19 rule 3; Build S5.5).
//
// On Enter the bar makes ONE fast call: the model classifies the question and
// writes the retrieval plan CODE executes. It never answers. The classes are
// the seven question shapes plus `action` and `correction`; the plan names the
// methods (lexical · vector · structured · graph · time_window), the entities
// and seeds, an absolute time range, filters and completeness.
//
// Everything after the call is code: the five methods, RRF, the reranker, the
// judge, the sufficiency check per class, the coverage caveat.
//
// `routeHeuristic` is the deterministic fallback — what runs when the model
// is unavailable (a dead provider, a quarantined pass, a unit test) and what
// BAR-02's code half measures. It is not a second router: the model plan wins
// whenever one comes back and parses.
//
// Output contract: ONE JSON object on one line, no prose, no fences.
// ===========================================================================

import { lastMonthRange, resolvePeriod } from "../retrieval/structured.js";
import { resolveTimeWindow } from "../retrieval/time-window.js";

/** The versioned prompt id — names the trace, the runs row and the file. */
export const ROUTE_V1_VERSION = "route.v1";

export const ROUTE_CLASSES = [
  "lookup",
  "aggregate",
  "temporal",
  "relational",
  "multihop",
  "absence",
  "general",
  "action",
  "correction",
] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

export const ROUTE_METHODS = ["lexical", "vector", "structured", "graph", "time_window"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export const ROUTE_V1_INSTRUCTIONS = `Classify ONE question typed to a personal memory system and write the retrieval
plan code will execute. Never answer the question.
CLASSES lookup · aggregate · temporal · relational · multihop · absence · general · action · correction
METHODS lexical · vector · structured · graph · time_window
RULES
- how much / how many / list all / total → structured, completeness "exhaustive".
- did X ever / never → absence: time_window over the named stream, "exhaustive".
- who/what via a person → graph with seeds; then vector.
- when / last week / on Tuesday → time_window with an absolute range.
- General knowledge with no personal referent → general.
- Imperatives → action; "this is wrong / not mine" → correction.
OUTPUT {"class":"…","methods":["…"],"entities":["…"],"time":{"from":"<ISO>","to":"<ISO>"}|null,
 "filters":{"stream":"…","kind":"…","source":"…"},"completeness":"topk"|"exhaustive","seeds":["…"]}`;

export interface RouteTime {
  from: string;
  to: string;
}

export interface RouteFilters {
  stream?: string;
  kind?: string;
  source?: string;
  /** Aggregate plans: the merchants the typed rows must carry. */
  merchant_in?: string[];
}

export interface RoutePlan {
  class: RouteClass;
  methods: RouteMethod[];
  entities: string[];
  time: RouteTime | null;
  filters: RouteFilters;
  completeness: "topk" | "exhaustive";
  seeds: string[];
  /** Who produced the plan — the model (route.v1) or the deterministic fallback. */
  planner: "route.v1" | "heuristic" | "intent";
}

const CLASS_SET: ReadonlySet<string> = new Set(ROUTE_CLASSES);
const METHOD_SET: ReadonlySet<string> = new Set(ROUTE_METHODS);

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()) : [];
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? v : null;
}

/**
 * Parse the model's raw text into a plan, or null when nothing usable came
 * back — the caller then falls back to `routeHeuristic`, never to a guess.
 * Unknown methods are dropped; an unknown class fails the parse.
 */
export function parseRouteOutput(raw: string): RoutePlan | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const cls = typeof rec.class === "string" ? rec.class.trim().toLowerCase() : "";
  if (!CLASS_SET.has(cls)) return null;
  const methods = strs(rec.methods)
    .map((m) => m.toLowerCase())
    .filter((m): m is RouteMethod => METHOD_SET.has(m));
  let time: RouteTime | null = null;
  if (rec.time && typeof rec.time === "object") {
    const t = rec.time as Record<string, unknown>;
    const from = isoOrNull(t.from);
    const to = isoOrNull(t.to);
    if (from && to && Date.parse(from) <= Date.parse(to)) time = { from, to };
  }
  const filters: RouteFilters = {};
  if (rec.filters && typeof rec.filters === "object") {
    const f = rec.filters as Record<string, unknown>;
    if (typeof f.stream === "string" && f.stream.trim()) filters.stream = f.stream.trim();
    if (typeof f.kind === "string" && f.kind.trim()) filters.kind = f.kind.trim();
    if (typeof f.source === "string" && f.source.trim()) filters.source = f.source.trim();
    const merchants = strs(f.merchant_in);
    if (merchants.length > 0) filters.merchant_in = merchants;
  }
  const completeness = rec.completeness === "exhaustive" ? "exhaustive" : "topk";
  return {
    class: cls as RouteClass,
    methods: [...new Set(methods)],
    entities: strs(rec.entities),
    time,
    filters,
    completeness,
    seeds: strs(rec.seeds),
    planner: "route.v1",
  };
}

/** Pack the variable half: the utterance, the clock and the streams it may name. */
export function packRouteInput(text: string, now: Date, streams: readonly string[] = []): string {
  const lines = [`NOW ${now.toISOString()}`];
  if (streams.length > 0) lines.push(`STREAMS ${streams.slice(0, 40).join(" · ")}`);
  lines.push(`QUESTION ${text}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "did", "do", "does", "is", "was", "were", "are", "be",
  "i", "we", "me", "my", "our", "you", "it", "that", "this", "with", "and", "or", "what", "who", "when", "where",
  "how", "much", "many", "ever", "never", "about", "per", "last", "week", "month", "year", "yesterday", "today",
  "tomorrow", "tuesday", "monday", "wednesday", "thursday", "friday", "saturday", "sunday", "afternoon",
  "morning", "evening", "night", "happened", "said", "say", "mentioned", "recommended", "pay", "paid", "there",
  "any", "all", "total", "list", "spend", "spent", "cost", "actually", "make", "not", "mine", "wrong", "true",
]);

/** An imperative opener — "book it", "plan hampi", "remind me". */
export function isImperative(text: string): boolean {
  return IMPERATIVE_RE.test(text.trim()) && !/\?$/.test(text.trim());
}

const IMPERATIVE_RE =
  /^(?:please\s+)?(?:plan|remind|add|create|book|send|pay|schedule|set|make|start|open|track|note|save|put|call|order|buy|cancel|move|rename|find me|show me|draft|write)\b/i;
const CORRECTION_RE =
  /\b(?:not mine|isn'?t mine|that'?s wrong|this is wrong|not true|isn'?t true|outdated|already done|karan'?s,? not mine|(?:it'?s|its|that'?s) (?:\w+'s),? not mine|stop (?:nudging|doing|showing)|don'?t do (?:this|that) again)\b/i;
const FOLLOWUP_CORRECTION_RE = /^(?:actually|no,|nah,|instead|change (?:it|that)|make it|rename|move it)\b/i;
const AGGREGATE_RE = /\b(?:how much|how many|total|list all|all (?:the|my)|sum of|spent|spend|count)\b/i;
const ABSENCE_RE = /\b(?:ever|never|at all)\b|\bdid \w+ (?:pay|send|reply|confirm|book|come)\b/i;
const TEMPORAL_RE =
  /\b(?:what happened|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|yesterday|last (?:week|night|tuesday|monday|wednesday|thursday|friday|saturday|sunday)|this (?:morning|afternoon|evening)|(?:mon|tues|wednes|thurs|fri|satur|sun)day (?:morning|afternoon|evening|night))\b/i;
const MULTIHOP_RE = /\b(?:who (?:recommended|suggested|told|introduced)|the (?:place|one|thing|person) \w+ (?:mentioned|said|recommended)|via|through)\b/i;
const RELATIONAL_RE = /\b(?:who is|who'?s|how (?:do|does) \w+ know|related to|friend of|\w+'s (?:friend|cousin|boss|manager|wife|husband|sister|brother|mother|father|colleague))\b/i;
const GENERAL_RE =
  /\b(?:gst|tax|vat|capital of|population of|definition of|what is (?:a|an|the) \w+|how (?:do|does) \w+ work|convert|exchange rate|meaning of|who invented|when was \w+ (?:founded|born))\b/i;
const PERSONAL_RE = /\b(?:i|we|my|our|me|us|rohan|karan|tanvi|ma|papa|mom|dad)\b|\?$/i;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/'s$/, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

/** Capitalised words and known first names — the graph seeds a name buys. */
function nameSeeds(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}]+/u)) {
    if (raw.length < 3) continue;
    const lower = raw.toLowerCase();
    if (STOP.has(lower)) continue;
    if (/^\p{Lu}/u.test(raw) || /^(?:rohan|karan|tanvi|riya|ma|papa|pranjali|arjun|neha|priya|amit)$/i.test(raw)) {
      if (!out.includes(lower)) out.push(lower);
    }
  }
  return out;
}

/**
 * The deterministic router. Same classes, same plan shape, built from the
 * question's surface: aggregates go to structured (never top-k), "ever/never"
 * to an exhaustive time window, names to the graph, dates to a time window,
 * general knowledge to `general`, imperatives to `action`, and "not mine /
 * that's wrong" to `correction`. Ties fall to lookup — the cheapest, instantly
 * revisable outcome.
 */
export function routeHeuristic(text: string, now: Date, opts: { locked?: boolean } = {}): RoutePlan {
  const q = text.trim();
  const lower = q.toLowerCase();
  const ents = tokens(q);
  const seeds = nameSeeds(q);
  const base: Omit<RoutePlan, "class" | "methods" | "completeness"> = {
    entities: ents,
    time: null,
    filters: {},
    seeds,
    planner: "heuristic",
  };
  const plan = (cls: RouteClass, methods: RouteMethod[], completeness: "topk" | "exhaustive" = "topk"): RoutePlan => ({
    ...base,
    class: cls,
    methods,
    completeness,
  });

  if (CORRECTION_RE.test(lower) || (opts.locked && FOLLOWUP_CORRECTION_RE.test(lower))) return plan("correction", []);
  if (IMPERATIVE_RE.test(q) && !/\?$/.test(q)) return plan("action", []);

  // A question with no personal referent and a general-knowledge shape.
  if (GENERAL_RE.test(lower) && !/\b(?:i|we|my|our|me|us)\b/i.test(lower) && seeds.length === 0) {
    return { ...plan("general", []), entities: [], seeds: [] };
  }

  if (ABSENCE_RE.test(lower) && !AGGREGATE_RE.test(lower)) {
    const p = plan("absence", ["time_window", "lexical"], "exhaustive");
    const from = new Date(now.getTime() - 60 * 86_400_000);
    p.time = { from: from.toISOString(), to: now.toISOString() };
    return p;
  }

  if (AGGREGATE_RE.test(lower) && /\b(?:how many|how much|total|list all|all (?:the|my)|sum|spent|spend|count)\b/i.test(lower) && !/\bper (?:night|day|person|head|pp)\b/i.test(lower)) {
    const p = plan("aggregate", ["structured"], "exhaustive");
    const period = resolvePeriod(q, now);
    if (period) p.time = { from: period.range.fromIso, to: period.range.toIso };
    else if (/\blast month\b/i.test(lower)) {
      const r = lastMonthRange(now);
      p.time = { from: r.fromIso, to: r.toIso };
    }
    return p;
  }

  if (MULTIHOP_RE.test(lower)) return plan("multihop", ["graph", "vector", "lexical"]);
  if (RELATIONAL_RE.test(lower)) return plan("relational", ["graph", "vector"]);

  if (TEMPORAL_RE.test(lower)) {
    const p = plan("temporal", ["time_window", "lexical"]);
    const w = resolveTimeWindow(q, now);
    if (w) p.time = { from: w.fromIso, to: w.toIso };
    return p;
  }

  if (!PERSONAL_RE.test(lower) && GENERAL_RE.test(lower)) return { ...plan("general", []), entities: [], seeds: [] };

  const p = plan("lookup", seeds.length > 0 ? ["lexical", "vector", "graph"] : ["lexical", "vector"]);
  return p;
}

/** The legacy four-way intent, mapped onto a plan (route tests inject it). */
export function planFromIntent(
  intent: "search" | "question" | "action" | "correction",
  text: string,
  now: Date,
): RoutePlan {
  if (intent === "action") return { ...routeHeuristic(text, now), class: "action", methods: [], planner: "intent" };
  if (intent === "correction") return { ...routeHeuristic(text, now), class: "correction", methods: [], planner: "intent" };
  const h = routeHeuristic(text, now);
  const cls: RouteClass = h.class === "action" || h.class === "correction" || h.class === "general" ? "lookup" : h.class;
  return { ...h, class: cls, methods: h.methods.length > 0 ? h.methods : ["lexical", "vector"], planner: "intent" };
}
