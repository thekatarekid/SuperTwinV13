// ===========================================================================
// [CODE] One bar turn (Product_V6 Phase 1 §19; Build S5.5; BAR-01..10).
//
//   Enter → route.v1 (one call; heuristic when the model is out)
//         → class question  : code runs the plan's methods → RRF → reranker
//                             → judge.v1 over the top 10 → sufficiency in
//                             code per class → cited answer, partial when the
//                             class's bar is not met, coverage caveat attached
//         → class general   : bar-general.v1, labelled "Not from your data"
//         → class action    : the NAMED THING is created now (space, task…)
//                             through the normal object paths; the utterance
//                             is already in the event log on the bar's stream
//                             (twin source → the gate reads it hot) so the
//                             REST of it flows down the live path — no
//                             private write path (BAR-08)
//         → class correction: with a lock → the one corrections pipeline on
//                             the locked object (correction-parse.v3, chips,
//                             behavioral memory, golden draft); without one →
//                             pointed at "Tell the twin"
//
// The thread LOCKS to the object the bar just made: the lock rides back in
// the response and on the twin's message, and a follow-up in the same thread
// ("actually make it november") is a correction on that object, never a
// second object (BAR-09). Ambiguity: an instruction with two candidates asks
// ONE question (ask-once); a question defaults to search (BAR-10).
//
// Every model call is injectable so unit tests stay offline; production uses
// the traced JSON runner for route / judge / general (P-08, P-09, P-14).
// ===========================================================================

import { getDb } from "../db/connection.js";
import { runJsonPass } from "../brain/llm.js";
import {
  BAR_GENERAL_V1_INSTRUCTIONS,
  BAR_GENERAL_V1_VERSION,
  labelGeneralAnswer,
  packGeneralInput,
  parseGeneralOutput,
} from "../prompts/bar-general.v1.js";
import {
  JUDGE_V1_INSTRUCTIONS,
  JUDGE_V1_VERSION,
  packJudgeInput,
  parseJudgeOutput,
  type JudgeOutput,
  type JudgePassage,
} from "../prompts/judge.v1.js";
import {
  ROUTE_V1_INSTRUCTIONS,
  ROUTE_V1_VERSION,
  isImperative,
  packRouteInput,
  parseRouteOutput,
  planFromIntent,
  routeHeuristic,
  type RoutePlan,
} from "../prompts/route.v1.js";
import type { Citation } from "../server/chat-grounding.js";
import { applyCorrectionRequest, type CorrectionParser, type CorrectionTarget } from "../server/corrections-routes.js";
import {
  applyPendingAction,
  handleAction,
  handleQuestion,
  handleSearch,
  NOTHING_TEXT,
  type BarActionOutcome,
  type BarModelCall,
  type BarSearchResult,
  type CitationResolver,
} from "./handlers.js";
import type { ParsedBarAction } from "../prompts/bar-action.v1.js";
import type { IntentRouter } from "./router.js";
import { executePlan, JUDGE_WINDOW, type BarPassage, type BarRetrieval } from "./retrieval.js";
import { checkSufficiency, type Sufficiency } from "./sufficiency.js";
import type { Reranker } from "../retrieval/reranker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The object a thread is locked to — what the bar just made, or what the user opened. */
export interface BarLockRef {
  kind: CorrectionTarget["kind"];
  id: string;
  label: string;
}

/** Quick chips offered on the locked object (Product_V6_Phase1 §21). */
export interface BarChip {
  label: string;
  structured: Record<string, unknown>;
}

export interface BarAnswerV6 {
  answer: string;
  citations: Citation[];
  grounded: boolean;
  refused_uncited: boolean;
  class: RoutePlan["class"];
  method: string;
  /** Aggregates: the exact value (never from the top-k). */
  value: number | null;
  by_currency?: { currency: string | null; value: number; rows: number }[];
  partial: boolean;
  gaps: string[];
  coverage_caveat: string | null;
  not_from_your_data: boolean;
  results: { id: string; kind: BarPassage["kind"]; quote: string; why: string }[];
  scanned: number;
  methods_ran: string[];
}

export type BarIntentV6 = "search" | "question" | "action" | "correction";

export interface BarTurnResult {
  /** The legacy four-way intent the UI keys its states on. */
  intent: BarIntentV6;
  class: RoutePlan["class"];
  plan: RoutePlan;
  search?: BarSearchResult;
  answer?: BarAnswerV6;
  action?: BarActionOutcome;
  correction?: Record<string, unknown>;
  summary?: string;
  /** The lock after this turn (null = no lock). */
  lock: BarLockRef | null;
  chips: BarChip[];
  /** Model calls this turn made (route + judge/general/action/correction). */
  model_calls: number;
}

export interface BarTurnInput {
  text: string;
  threadId: string;
  lock?: BarLockRef | null;
  history?: readonly { role: "user" | "twin"; text: string }[];
  /**
   * The ask-once question still open on this thread (BAR-10 / USR-03). When
   * the next line names one of its options, it ANSWERS — it does not start a
   * second turn — and nothing is spent doing it.
   */
  pending?: { question: string; options: { id: string; label: string }[]; action: ParsedBarAction } | null;
  now?: Date;
}

export type RoutePlanner = (text: string, now: Date, ctx: { locked: boolean; streams: string[] }) => Promise<RoutePlan | null>;
export type JudgeCall = (question: string, passages: readonly JudgePassage[]) => Promise<JudgeOutput>;
export type GeneralCall = (question: string) => Promise<string | null>;

export interface BarDeps {
  /** route.v1. null from the planner → the heuristic. */
  planner?: RoutePlanner;
  /** Legacy intent router (the P4.1 tests inject it); mapped onto a plan. */
  route?: IntentRouter;
  judge?: JudgeCall;
  general?: GeneralCall;
  actionCall?: BarModelCall;
  /**
   * The P4.1 grounded-answer seam. Injected together with `route` it keeps the
   * legacy one-call answer path (handlers.handleQuestion + its citation gate)
   * running unchanged for the USR route cases; production leaves both unset
   * and gets route.v1 → methods → RRF → reranker → judge.v1.
   */
  answerCall?: BarModelCall;
  correctionParser?: CorrectionParser;
  resolveCitation?: CitationResolver;
  reranker?: Reranker | null;
  /** Rows an enumeration returns — the surface's page size (BAR-06). */
  listLimit?: number;
}

// ---------------------------------------------------------------------------
// Production model seams (traced JSON runner, P-08 / P-09 / P-14)
// ---------------------------------------------------------------------------

export const planViaModel: RoutePlanner = async (text, now, ctx) => {
  try {
    const result = await runJsonPass<RoutePlan>({
      pass: ROUTE_V1_VERSION,
      system: ROUTE_V1_INSTRUCTIONS,
      user: packRouteInput(text, now, ctx.streams),
      role: "classify",
      cohortId: null,
      unit: { kind: "bar-route", id: "bar" },
      validate: (parsed) => {
        const plan = parseRouteOutput(JSON.stringify(parsed));
        if (!plan) throw new Error('the object must carry a known "class" and a "methods" array');
        return plan;
      },
    });
    return result.output ?? null;
  } catch {
    return null;
  }
};

export const judgeViaModel: JudgeCall = async (question, passages) => {
  const result = await runJsonPass<JudgeOutput>({
    pass: JUDGE_V1_VERSION,
    system: JUDGE_V1_INSTRUCTIONS,
    user: packJudgeInput(question, passages),
    role: "chat",
    cohortId: null,
    unit: { kind: "bar-judge", id: "bar" },
    validate: (parsed) => {
      const rec = parsed as Record<string, unknown>;
      if (!rec || !Array.isArray(rec.results)) throw new Error('the object must carry a "results" array');
      return parseJudgeOutput(JSON.stringify(parsed), passages);
    },
  });
  return result.output ?? { results: [], answer: null, dropped: [] };
};

export const generalViaModel: GeneralCall = async (question) => {
  const result = await runJsonPass<string>({
    pass: BAR_GENERAL_V1_VERSION,
    system: BAR_GENERAL_V1_INSTRUCTIONS,
    user: packGeneralInput(question),
    role: "chat",
    cohortId: null,
    unit: { kind: "bar-general", id: "bar" },
    validate: (parsed) => {
      const text = parseGeneralOutput(JSON.stringify(parsed));
      if (!text) throw new Error('the object must carry a non-empty "text"');
      return text;
    },
  });
  return result.output ?? null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Chips per locked object type — the DotMenu contract (FIX-06), never crossed. */
export function chipsForLock(lock: BarLockRef | null): BarChip[] {
  if (!lock) return [];
  switch (lock.kind) {
    case "task":
      return [
        { label: "Not mine", structured: { type: "wrong_person", owner: "them" } },
        { label: "Already done", structured: { type: "already_done" } },
      ];
    case "claim":
      return [
        { label: "Not true", structured: { type: "not_true" } },
        { label: "Outdated", structured: { type: "outdated" } },
      ];
    case "space":
      return [{ label: "Merge into…", structured: { type: "merge_into" } }];
    default:
      return [];
  }
}

function streamsForRouter(): string[] {
  try {
    return (
      getDb()
        .prepare(`SELECT DISTINCT stream_key AS k FROM events WHERE stream_key IS NOT NULL AND stream_key NOT LIKE 'bar:%' ORDER BY ts DESC LIMIT 30`)
        .all() as { k: string }[]
    ).map((r) => r.k);
  } catch {
    return [];
  }
}

/**
 * Words that make a short line something other than a search: a correction, a
 * yes/no, an undo. "goa" searches; "that's wrong" does not.
 */
const NOT_A_SEARCH = new Set([
  "wrong", "not", "mine", "no", "nope", "yes", "yeah", "ok", "okay", "stop", "dont", "don't",
  "actually", "already", "done", "true", "untrue", "outdated", "undo", "cancel", "wait", "never",
  "isnt", "isn't", "thats", "that's", "its", "it's", "nah", "yep", "sure", "delete", "remove",
]);

/**
 * A one- or two-word utterance is a SEARCH, always — the cheapest, instantly
 * revisable outcome, and the second half of BAR-10 ("a question defaults to
 * search"). It never reaches the router, so an ambiguous fragment costs
 * nothing at all. Anything longer, anything ending in "?", and anything whose
 * words are a correction or an answer instead of a subject, routes.
 */
export function isBareFragment(text: string): boolean {
  const t = text.trim();
  if (t === "" || t.endsWith("?") || isImperative(t)) return false;
  const words = t.toLowerCase().replace(/[.!,]+/g, "").split(/\s+/).filter((w) => w !== "");
  if (words.length === 0 || words.length > 2) return false;
  return !words.some((w) => NOT_A_SEARCH.has(w));
}

/** The option a short answer names — by id, exact label, or label fragment. */
export function matchOption(
  text: string,
  options: readonly { id: string; label: string }[],
): { id: string; label: string } | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (t === "") return null;
  const byId = options.find((o) => o.id.toLowerCase() === t);
  if (byId) return byId;
  const exact = options.filter((o) => o.label.toLowerCase() === t);
  if (exact.length === 1) return exact[0]!;
  const partial = options.filter((o) => o.label.toLowerCase().includes(t));
  return partial.length === 1 ? partial[0]! : null;
}

function passageMeta(p: BarPassage): string {
  const parts: string[] = [];
  if (p.actor) parts.push(p.actor);
  if (p.ts) parts.push(p.ts.slice(0, 10));
  if (p.stream) parts.push(p.stream);
  if (p.kind !== "event") parts.push(p.kind);
  return parts.join(" · ");
}

function lockFor(outcome: BarActionOutcome): BarLockRef | null {
  const db = getDb();
  if (outcome.space_id) {
    const row = db.prepare(`SELECT label FROM spaces WHERE id = ?`).get(outcome.space_id) as { label: string } | undefined;
    return { kind: "space", id: outcome.space_id, label: row?.label ?? outcome.space_id };
  }
  if (outcome.task_id) {
    const row = db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(outcome.task_id) as { title: string } | undefined;
    return { kind: "task", id: outcome.task_id, label: row?.title ?? outcome.task_id };
  }
  return null;
}

const NUM = (n: number): string => (Number.isInteger(n) ? n.toLocaleString("en-IN") : n.toFixed(2));

/** The aggregate line: exact, from the structured value, never from the top-k. */
function aggregateLine(r: BarRetrieval): { text: string; value: number | null } {
  const s = r.structured!;
  if (s.op === "count") return { text: `${NUM(s.value ?? 0)} — ${s.rowCount} matching row(s), counted over typed fields`, value: s.value };
  if (s.op === "list") {
    const items = s.rows.slice(0, 12).map((row) => `${row.merchant ?? row.text ?? row.claimKey}${row.amount !== null ? ` ₹${NUM(row.amount)}` : ""}${row.date ? ` (${row.date})` : ""}`);
    return { text: `${s.rows.length}${s.complete ? "" : " so far"}: ${items.join(" · ")}${s.rows.length > 12 ? " …" : ""}`, value: s.rowCount };
  }
  if (s.op === "range" && s.range) return { text: `${s.range.min} → ${s.range.max} over ${s.rowCount} row(s)`, value: null };
  if (s.value !== null) {
    const cur = s.byCurrency[0]?.currency;
    return { text: `${cur ? `${cur} ` : "₹"}${NUM(s.value)} over ${s.rowCount} row(s), summed over typed amounts`, value: s.value };
  }
  const per = s.byCurrency.map((c) => `${c.currency ?? "?"} ${NUM(c.value)} (${c.rows})`).join(" · ");
  return { text: `per currency: ${per}`, value: null };
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export async function runBarTurn(input: BarTurnInput, deps: BarDeps = {}): Promise<BarTurnResult> {
  const now = input.now ?? new Date();
  const text = input.text.trim();
  const lock = input.lock ?? null;
  let calls = 0;

  // ---- The open ask-once question, answered (BAR-10, USR-03) ---------------
  // "book it" asked which space; "goa" is the ANSWER, not a new turn. Matched
  // by option id or label against the held parse, in code, for zero calls.
  const answered = input.pending ? matchOption(text, input.pending.options) : null;
  if (input.pending && answered) {
    const outcome = applyPendingAction(input.pending.action, answered.id);
    const newLock = outcome.status === "done" ? lockFor(outcome) ?? lock : lock;
    return {
      intent: "action",
      class: "action",
      plan: { ...routeHeuristic(text, now), class: "action", methods: [], planner: "heuristic" },
      action: outcome,
      lock: newLock,
      chips: chipsForLock(newLock),
      model_calls: calls,
    };
  }

  // ---- A one- or two-word line is a search (BAR-10, second half) -----------
  // Skipped when the caller injected the legacy four-way router: that seam
  // decides the intent itself, and the P4 route cases depend on it doing so.
  if (!deps.route && isBareFragment(text)) {
    return {
      intent: "search",
      class: "lookup",
      plan: { ...routeHeuristic(text, now), class: "lookup", methods: ["lexical"], planner: "heuristic" },
      search: handleSearch(text),
      lock,
      chips: chipsForLock(lock),
      model_calls: calls,
    };
  }

  // ---- Route ---------------------------------------------------------------
  let plan: RoutePlan | null = null;
  if (deps.route) {
    const intent = await deps.route(text);
    calls += 1;
    if (intent === "search") {
      return {
        intent: "search",
        class: "lookup",
        plan: planFromIntent("search", text, now),
        search: handleSearch(text),
        lock,
        chips: chipsForLock(lock),
        model_calls: calls,
      };
    }
    plan = planFromIntent(intent, text, now);
    if (intent === "question" && deps.answerCall) {
      const legacy = await handleQuestion(text, input.history ?? [], deps.answerCall, deps.resolveCitation);
      calls += 1;
      return {
        intent: "question",
        class: plan.class,
        plan,
        answer: {
          ...legacy,
          class: plan.class,
          method: "lexical ∪ vector",
          value: null,
          partial: false,
          gaps: [],
          coverage_caveat: null,
          not_from_your_data: false,
          results: [],
          scanned: legacy.citations.length,
          methods_ran: ["lexical", "vector"],
        },
        lock,
        chips: chipsForLock(lock),
        model_calls: calls,
      };
    }
  } else {
    const planner = deps.planner ?? planViaModel;
    plan = await planner(text, now, { locked: lock !== null, streams: streamsForRouter() });
    calls += 1;
    if (!plan) plan = routeHeuristic(text, now, { locked: lock !== null });
  }
  // A locked thread reads "actually …" as a correction on the object, whatever
  // the model said about a bare utterance (BAR-09).
  if (lock && plan.class !== "correction" && plan.class !== "action" && /^(?:actually|no,|nah,|instead|make it|change (?:it|that)|rename it|move it)\b/i.test(text)) {
    plan = { ...plan, class: "correction", methods: [] };
  }

  // ---- Correction ------------------------------------------------------------
  if (plan.class === "correction") {
    if (!lock) {
      return {
        intent: "correction",
        class: plan.class,
        plan,
        summary: "open the thing that's wrong and use Tell the twin — corrections never guess a target",
        lock: null,
        chips: [],
        model_calls: calls,
      };
    }
    const outcome = await applyCorrectionRequest(
      { target: { kind: lock.kind, id: lock.id }, utterance: text, scope: "once" },
      deps.correctionParser,
    );
    if (outcome.status !== 404) calls += 1;
    const body = outcome.body as Record<string, unknown>;
    const summary = outcome.status === 200 ? `${lock.label}: ${String(body.summary ?? "recorded")}` : String(body.error ?? "couldn't apply that");
    return { intent: "correction", class: plan.class, plan, correction: body, summary, lock, chips: chipsForLock(lock), model_calls: calls };
  }

  // ---- Action: create the named thing now ----------------------------------------
  if (plan.class === "action") {
    const outcome = await handleAction(text, deps.actionCall, now);
    calls += 1;
    const newLock = outcome.status === "done" ? lockFor(outcome) ?? lock : lock;
    return { intent: "action", class: plan.class, plan, action: outcome, lock: newLock, chips: chipsForLock(newLock), model_calls: calls };
  }

  // ---- General: labelled, no retrieval ------------------------------------------
  if (plan.class === "general") {
    let text2: string | null = null;
    try {
      text2 = await (deps.general ?? generalViaModel)(text);
    } catch {
      text2 = null;
    }
    calls += 1;
    const answer: BarAnswerV6 = {
      answer: text2 ? labelGeneralAnswer(text2) : "couldn't answer that right now",
      citations: [],
      grounded: false,
      refused_uncited: false,
      class: "general",
      method: "general knowledge",
      value: null,
      partial: false,
      gaps: [],
      coverage_caveat: null,
      not_from_your_data: true,
      results: [],
      scanned: 0,
      methods_ran: [],
    };
    return { intent: "question", class: plan.class, plan, answer, lock, chips: chipsForLock(lock), model_calls: calls };
  }

  // ---- Question: methods → RRF → reranker → judge → sufficiency -----------------
  const retrieval = await executePlan(text, plan, {
    now,
    reranker: deps.reranker,
    ...(deps.listLimit !== undefined ? { listLimit: deps.listLimit } : {}),
  });
  let judged: JudgeOutput | null = null;
  const passages: JudgePassage[] = retrieval.candidates.slice(0, JUDGE_WINDOW).map((p) => ({ id: p.id, text: p.text, meta: passageMeta(p) }));
  const needsJudge = plan.class !== "aggregate" && passages.length > 0;
  if (needsJudge) {
    try {
      judged = await (deps.judge ?? judgeViaModel)(text, passages);
    } catch {
      judged = { results: [], answer: null, dropped: [] };
    }
    calls += 1;
  }
  const suff: Sufficiency = checkSufficiency(plan, retrieval, judged, now);
  const byId = new Map(retrieval.candidates.map((p) => [p.id, p]));
  const resolve = deps.resolveCitation;
  const results = (judged?.results ?? [])
    .filter((r) => byId.has(r.id))
    .filter((r) => (resolve && byId.get(r.id)!.kind === "event" ? resolve(r.id) : true))
    .map((r) => ({ id: r.id, kind: byId.get(r.id)!.kind, quote: r.quote, why: r.why }));
  const citations: Citation[] = results
    .filter((r) => r.kind === "event")
    .map((r, i) => ({ n: i + 1, kind: "event" as const, id: r.id, label: r.quote }));

  let answerText: string;
  let value: number | null = null;
  let byCurrency: BarAnswerV6["by_currency"];
  let grounded = true;
  let refused = false;

  if (plan.class === "aggregate") {
    if (retrieval.structured && retrieval.structured.rowCount > 0) {
      const line = aggregateLine(retrieval);
      answerText = line.text;
      value = line.value;
      byCurrency = retrieval.structured.byCurrency;
      // The rows ARE the citation: each typed row, plus its evidence events
      // when the claim carries any (those become tappable chips).
      let n = 1;
      for (const row of retrieval.structured.rows.slice(0, 10)) {
        results.push({ id: row.claimKey, kind: "claim", quote: row.text ?? row.claimKey, why: "typed row in the total" });
      }
      const evidenceIds = getDb()
        .prepare(
          `SELECT cv.claim_key, cv.evidence_json FROM claims_active cv WHERE cv.claim_key IN (${retrieval.structured.rows
            .slice(0, 10)
            .map(() => "?")
            .join(",") || "''"})`,
        )
        .all(...retrieval.structured.rows.slice(0, 10).map((r) => r.claimKey)) as { claim_key: string; evidence_json: string | null }[];
      for (const r of evidenceIds) {
        try {
          const ev = JSON.parse(r.evidence_json ?? "[]") as { event_ids?: string[]; quote?: string }[];
          for (const e of ev) for (const id of e.event_ids ?? []) {
            if (resolve && !resolve(id)) continue;
            citations.push({ n: n++, kind: "event", id, label: e.quote ?? r.claim_key });
          }
        } catch {
          // no evidence ids on this row
        }
      }
    } else {
      answerText = NOTHING_TEXT;
      grounded = false;
    }
  } else if (plan.class === "absence") {
    const tw = retrieval.time_window;
    const what = plan.entities.filter((e) => !plan.seeds.includes(e)).join(" ") || plan.entities.join(" ") || "that";
    if (results.length > 0) {
      answerText = judged?.answer ?? `found ${results.length} message(s) about ${what}`;
    } else if (tw && suff.sufficient) {
      answerText = `no ${what} found in ${tw.count} message(s) scanned${retrieval.stream_keys.length > 0 ? ` across ${retrieval.stream_keys.join(", ")}` : ""}`;
      grounded = false;
    } else {
      answerText = `couldn't confirm a "no" — ${suff.gaps[0] ?? "the scan was incomplete"}`;
      grounded = false;
    }
  } else if (results.length > 0) {
    answerText = judged?.answer ?? results.map((r) => `“${r.quote}”`).join(" · ");
  } else if (judged?.answer) {
    // The model wrote prose it could not pin to a passage — refuse (uncited_claim = 0).
    answerText = NOTHING_TEXT;
    grounded = false;
    refused = true;
  } else {
    answerText = NOTHING_TEXT;
    grounded = false;
  }

  if (suff.partial && suff.gaps.length > 0 && answerText !== NOTHING_TEXT) {
    answerText = `${answerText} — partial: ${suff.gaps.join("; ")}`;
  }
  if (suff.caveat) answerText = `${answerText} — ${suff.caveat.text}`;

  const answer: BarAnswerV6 = {
    answer: answerText,
    citations,
    grounded,
    refused_uncited: refused,
    class: plan.class,
    method: suff.method,
    value,
    ...(byCurrency ? { by_currency: byCurrency } : {}),
    partial: suff.partial,
    gaps: suff.gaps,
    coverage_caveat: suff.caveat?.text ?? null,
    not_from_your_data: false,
    results,
    scanned: suff.scanned,
    methods_ran: retrieval.methods_ran,
  };
  return { intent: "question", class: plan.class, plan, answer, lock, chips: chipsForLock(lock), model_calls: calls };
}
