// ===========================================================================
// [CODE] BAR — the grounded bar (GoldenEvals V6 P1 §5.20; V6 P1 S5.5), plus
// the three new FIX cases (§5.21 FIX-07..09).
//
// Deterministic, ZERO model calls. Every seam the bar makes a call through —
// route.v1, judge.v1, bar-general.v1, bar-action.v2, correction-parse.v3 —
// is injected with the fixture's own canned output, so what these cases
// assert is the CODE around the calls:
//
//   BAR-01  type-ahead is local: SQLite only, under 150 ms, zero calls
//   BAR-02  the classes and the plans the router writes
//   BAR-03  a lookup answer cites hard — verbatim quotes, resolvable ids
//   BAR-04  an aggregate comes from the structured method, never the top-k,
//           and the judge is not asked about it at all
//   BAR-05  an absence answer scans the named thread WHOLE and carries the
//           coverage caveat
//   BAR-06  an enumeration that hit the cap says so, and says what is missing
//   BAR-07  a general answer is labelled and touches no user data
//   BAR-08  the named thing is created NOW, the thread locks to it, and the
//           utterance itself lands on the bar's hot stream — which is how the
//           rest of it reaches the live path, with no private write path
//   BAR-09  a follow-up in that thread updates the SAME object
//   BAR-10  an instruction with two candidates asks ONE question; a bare
//           question defaults to search
//   FIX-07  "Not mine" moves the task AND leaves a monitoring follow-up; undo
//           restores both halves
//   FIX-08  "Don't do this again" writes a scoped behavioral rule the next
//           router decision reads back
//   FIX-09  every correction — including one that did not parse — drafts a
//           golden case
//
// Each case runs against a SCRATCH database (the same isolation p4.ts uses):
// the bar's behaviour is defined over the world the fixture seeds, and the
// shared home DB full of other cases' rows would turn these into statements
// about eval residue.
// ===========================================================================

import { Readable } from "node:stream";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeClaimVersion } from "../../claims/store.js";
import { noteCaptured } from "../../coverage/index.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { appendEvent } from "../../db/eventlog.js";
import { setClaimTypedFields, SELF_ENTITY_ID } from "../../db/v6graph.js";
import { runBarTurn, type BarDeps } from "../../grounded/bar.js";
import {
  listBehavioralRules,
  suppressingRules,
} from "../../grounded/behavioral.js";
import { routeHeuristic, type RouteClass } from "../../prompts/route.v1.js";
import type { JudgeOutput } from "../../prompts/judge.v1.js";
import { resetTypeaheadForTests, typeahead, TYPEAHEAD_BUDGET_MS } from "../../retrieval/typeahead.js";
import { applyCorrectionRequest, handleCorrectionsRoute } from "../../server/corrections-routes.js";
import { handleGroundedRoute } from "../../server/grounded-routes.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { feedbackExecutor } from "./p4.js";

/** Golden-evals clock: Sat 2026-09-05 10:00 IST. */
const NOW = new Date("2026-09-05T04:30:00.000Z");

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function str(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

/** One case, over its own database file. */
async function withScratchDb<T>(fn: () => Promise<T>): Promise<T> {
  const prevDb = process.env.SUPERTWIN_DB_PATH;
  const prevDrafts = process.env.SUPERTWIN_EVAL_DRAFTS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "supertwin-eval-bar-"));
  process.env.SUPERTWIN_DB_PATH = join(dir, "st.db");
  // Golden-case drafts are files; a case's drafts belong to the case, not to
  // the user's home (FIX-09 counts them on disk).
  process.env.SUPERTWIN_EVAL_DRAFTS_DIR = join(dir, "eval-drafts");
  closeDb();
  runMigrations();
  resetTypeaheadForTests();
  try {
    return await fn();
  } finally {
    closeDb();
    resetTypeaheadForTests();
    if (prevDb === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = prevDb;
    if (prevDrafts === undefined) delete process.env.SUPERTWIN_EVAL_DRAFTS_DIR;
    else process.env.SUPERTWIN_EVAL_DRAFTS_DIR = prevDrafts;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drive one route handler exactly the way the HTTP server does. */
async function callRoute(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number | null; body: Record<string, unknown> }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
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
  await handler(req, res);
  return { status, body: payload === "" ? {} : (JSON.parse(payload) as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

let seq = 0;

function ev(text: string, opts: { streamKey?: string; actor?: string; ts?: string; source?: string } = {}): string {
  seq += 1;
  const { id } = appendEvent({
    ts: opts.ts ?? new Date(NOW.getTime() - seq * 3_600_000).toISOString(),
    source: opts.source ?? "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: opts.streamKey ?? "wa:goa-gang",
    actor: opts.actor ?? "contact:rohan",
    roles: { sender: opts.actor ?? "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  });
  return id;
}

function receipt(merchant: string, amount: number | null, date: string): string {
  seq += 1;
  const key = `claim_bar_${seq}`;
  const text = `Paid ₹${amount ?? "?"} to ${merchant}`;
  writeClaimVersion({
    claimKey: key,
    kind: "fact",
    subjectId: SELF_ENTITY_ID,
    text,
    confidence: 0.95,
    statedAt: `${date}T10:00:00.000Z`,
    evidence: [{ event_ids: [], quote: text }],
    decidedBy: "eval:bar",
  });
  setClaimTypedFields(key, { merchant, amount, currency: "INR", date });
  return key;
}

function space(id: string, label: string): string {
  getDb().prepare(`INSERT INTO spaces (id, label, status, goal) VALUES (?, ?, 'active', 'a goal')`).run(id, label);
  return id;
}

// ---------------------------------------------------------------------------
// Injected seams — the model's half, as values
// ---------------------------------------------------------------------------

const NO_JUDGE = async (): Promise<JudgeOutput> => ({ results: [], answer: null, dropped: [] });

/** A judge that quotes verbatim from the passages it was shown. */
function quoting(n: number, answer: string) {
  return async (_q: string, passages: readonly { id: string; text: string }[]): Promise<JudgeOutput> => ({
    results: passages.slice(0, n).map((p) => ({ id: p.id, quote: p.text.slice(0, 20), why: "answers the question" })),
    answer: passages.length > 0 ? answer : null,
    dropped: [],
  });
}

function planner(over: Partial<ReturnType<typeof routeHeuristic>> = {}) {
  return async (text: string, now: Date) => ({ ...routeHeuristic(text, now), ...over });
}

function deps(over: BarDeps = {}): BarDeps {
  return { reranker: null, judge: NO_JUDGE, ...over };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

type CaseFn = (fixture: Fixture) => Promise<ExecutorResult>;

// ---- BAR-01 · type-ahead is local -----------------------------------------

const bar01: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const query = str(rec(fixture.setup).query, "goa vill");
  const goa = space("sp_goa", "Goa dec trip");
  getDb().prepare(`INSERT INTO chapters (id, space_id, label, status) VALUES ('ch_stay', ?, 'Stay', 'active')`).run(goa);
  for (let i = 0; i < 19; i += 1) space(`sp_${i}`, `Unrelated ${i}`);
  for (let i = 0; i < 600; i += 1) {
    ev(i % 40 === 0 ? `the goa villa ${i % 80 === 0 ? "6k per night" : "with pool near anjuna"} #${i}` : `lunch call invoice ${i}`, {
      streamKey: i % 3 === 0 ? "wa:goa-gang" : `wa:stream-${i % 8}`,
    });
  }
  const insEp = getDb().prepare(
    `INSERT INTO episodes (id, space_id, chapter_id, state, summary, first_ts, last_ts, created_by)
     VALUES (?, ?, ?, 'open', ?, ?, ?, 'eval')`,
  );
  for (let i = 0; i < 30; i += 1) {
    const villa = i % 10 === 0;
    insEp.run(
      `ep_${i}`,
      villa ? goa : null,
      villa ? "ch_stay" : null,
      villa ? `Goa villa shortlist — budget 6k/night (${i})` : `chatter ${i}`,
      NOW.toISOString(),
      NOW.toISOString(),
    );
  }

  const result = typeahead(query);
  const budget = num(exp.budget_ms, TYPEAHEAD_BUDGET_MS);
  const spaceHit = result.spaces.some((s) => s.label.toLowerCase().includes(str(exp.space_label_contains, "Goa").toLowerCase()));
  const violations: Violation[] = [];
  if (result.model_calls > 0) violations.push({ label: "model-call-while-typing", note: `${result.model_calls} call(s)` });
  if (result.took_ms > budget) violations.push({ label: "over-budget", note: `${result.took_ms} ms > ${budget} ms` });
  const ok = result.events.length > 0 && result.episodes.length > 0 && spaceHit && result.model_calls === 0 && result.took_ms <= budget;
  return {
    ok,
    output: {
      took_ms: result.took_ms,
      model_calls: result.model_calls,
      events: result.events.length,
      episodes: result.episodes.length,
      spaces: result.spaces.map((s) => s.label),
    },
    violations,
    metrics: { typeahead_ms: result.took_ms, model_calls: 0 },
    notes: [`"${query}" → ${result.events.length} events · ${result.episodes.length} episodes · ${result.spaces.length} spaces in ${result.took_ms} ms, 0 calls`],
  };
};

// ---- BAR-02 · route classes ------------------------------------------------

const bar02: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const wanted = rec(exp.classes);
  const wantedMethods = rec(exp.methods);
  const seen: Record<string, string> = {};
  let hits = 0;
  const violations: Violation[] = [];
  for (const [question, cls] of Object.entries(wanted)) {
    const plan = routeHeuristic(question, NOW);
    seen[question] = plan.class;
    if (plan.class === cls) hits += 1;
    const method = wantedMethods[question];
    if (typeof method === "string" && !plan.methods.includes(method as never)) {
      violations.push({ label: "aggregate-as-lookup", note: `${question} → methods ${plan.methods.join("+") || "none"}, wanted ${method}` });
    }
  }
  if (seen["how much on cabs last month"] === "lookup") violations.push({ label: "aggregate-as-lookup" });
  if (seen["gst on hotel rooms"] !== "general") violations.push({ label: "general-as-personal" });
  const accuracy = Object.keys(wanted).length === 0 ? 0 : hits / Object.keys(wanted).length;
  const floor = num(exp.min_accuracy, 0.9);
  return {
    ok: accuracy > floor,
    output: { classes: seen, accuracy },
    violations,
    metrics: { route_class_accuracy: accuracy, model_calls: 0 },
    notes: [`${hits}/${Object.keys(wanted).length} classes correct (${Math.round(accuracy * 100)}%, gate > ${Math.round(floor * 100)}%)`],
  };
};

// ---- BAR-03 · a lookup answer cites hard ------------------------------------

const bar03: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const mine = ev("max 6k a night yaar, we can't do more", { actor: "self" });
  const rohan = ev("keep it under 20k pp all in", { actor: "contact:rohan" });
  const known = new Set([mine, rohan]);

  const turn = await runBarTurn(
    { text: "how much per night?", threadId: "th_bar03", now: NOW },
    deps({
      planner: planner(),
      judge: quoting(2, "₹6k max per night — you said so on Aug 24; Rohan framed it as under ₹20k per person."),
      resolveCitation: (id) => known.has(id),
    }),
  );

  const answer = turn.answer!;
  const rows = getDb()
    .prepare(`SELECT id, text FROM events WHERE id IN (?, ?)`)
    .all(mine, rohan) as { id: string; text: string }[];
  const textOf = new Map(rows.map((r) => [r.id, r.text]));
  const verbatim = answer.results.every((r) => (textOf.get(r.id) ?? "").toLowerCase().includes(r.quote.toLowerCase()));
  const resolvable = answer.citations.every((c) => known.has(c.id));

  const violations: Violation[] = [];
  if (!resolvable) violations.push({ label: "uncited-claim", note: "a citation did not resolve to a real event" });
  if (!verbatim) violations.push({ label: "paraphrased-quote" });
  const ok =
    turn.class === (str(exp.class, "lookup") as RouteClass) &&
    answer.grounded === (exp.grounded !== false) &&
    answer.citations.length >= num(exp.min_citations, 1) &&
    verbatim &&
    resolvable;
  return {
    ok,
    output: {
      class: turn.class,
      answer: answer.answer,
      citations: answer.citations.map((c) => ({ n: c.n, id: c.id, label: c.label })),
      results: answer.results,
      method: answer.method,
    },
    violations,
    metrics: { uncited_claim: resolvable ? 0 : 1, citations: answer.citations.length, model_calls: 0 },
    notes: [`${answer.citations.length} citation(s), all verbatim and resolvable`],
  };
};

// ---- BAR-04 · an aggregate is never a top-k --------------------------------

const bar04: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  receipt("Uber", 340, "2026-08-03");
  receipt("Uber", 280, "2026-08-14");
  receipt("Uber", 400, "2026-08-27");
  receipt("Swiggy", 560, "2026-08-12");
  receipt("Uber", 199, "2026-09-02");
  receipt("Uber", 250, "2026-07-30");
  // Chatter that would dominate any ranked list about "cabs".
  for (let i = 0; i < 40; i += 1) ev(`uber cab receipt chat ${i}`);

  let judgeCalls = 0;
  const turn = await runBarTurn(
    { text: "how much did I spend on cabs last month", threadId: "th_bar04", now: NOW },
    deps({
      planner: planner(),
      judge: async () => {
        judgeCalls += 1;
        return { results: [], answer: null, dropped: [] };
      },
    }),
  );
  const answer = turn.answer!;
  const violations: Violation[] = [];
  if (answer.method !== "structured") violations.push({ label: "topk-sum", note: `method ${answer.method}` });
  if (answer.value !== num(exp.value, 1020)) violations.push({ label: "topk-sum", note: `value ${answer.value}` });
  if (judgeCalls > num(exp.judge_calls, 0)) violations.push({ label: "judge-decides-an-aggregate", note: `${judgeCalls} judge call(s)` });
  return {
    ok: violations.length === 0 && turn.class === "aggregate",
    output: { class: turn.class, method: answer.method, value: answer.value, answer: answer.answer, judge_calls: judgeCalls, methods_ran: answer.methods_ran },
    violations,
    metrics: { aggregate_value: answer.value ?? -1, judge_calls: judgeCalls, model_calls: 0 },
    notes: [`₹${answer.value} over ${answer.scanned} typed row(s) through the structured method; ${judgeCalls} judge call(s)`],
  };
};

// ---- BAR-05 · absence with a coverage caveat --------------------------------

const bar05: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const setup = rec(fixture.setup);
  const messages = num(setup.messages, 9);
  for (let i = 0; i < messages; i += 1) ev(`goa gang chatter ${i}`, { streamKey: "wa:goa-gang" });
  ev("family stuff", { streamKey: "wa:family" });
  noteCaptured("wa", [`${str(setup.coverage_floor, "2026-07-04")}T10:00:00.000Z`, "2026-08-01T10:00:00.000Z"]);

  const turn = await runBarTurn(
    { text: "did karan pay the advance", threadId: "th_bar05", now: NOW },
    deps({
      planner: planner({ filters: { stream: "wa:goa-gang" }, time: { from: "2026-07-01T00:00:00.000Z", to: NOW.toISOString() } }),
    }),
  );
  const answer = turn.answer!;
  const complete = answer.scanned === messages && !answer.partial;
  const violations: Violation[] = [];
  if (!complete) violations.push({ label: "confident-no-from-top-30", note: `scanned ${answer.scanned} of ${messages}` });
  if (!answer.coverage_caveat) violations.push({ label: "no-without-caveat" });
  const ok =
    turn.class === "absence" &&
    answer.method === "time_window" &&
    complete &&
    answer.coverage_caveat === str(exp.caveat, "I only have WhatsApp back to Jul 2026") &&
    answer.answer.includes("wa:goa-gang");
  return {
    ok,
    output: { class: turn.class, method: answer.method, scanned: answer.scanned, answer: answer.answer, caveat: answer.coverage_caveat },
    violations,
    metrics: { absence_scanned: answer.scanned, model_calls: 0 },
    notes: [`scanned ${answer.scanned} message(s) in wa:goa-gang whole; caveat "${answer.coverage_caveat}"`],
  };
};

// ---- BAR-06 · partial says partial ------------------------------------------

const bar06: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const setup = rec(fixture.setup);
  const rows = num(setup.rows, 15);
  const limit = num(setup.limit, 12);
  for (let i = 0; i < rows; i += 1) receipt("Uber", 100 + i, `2026-08-${String((i % 28) + 1).padStart(2, "0")}`);

  const turn = await runBarTurn(
    { text: "list all the uber rides last month", threadId: "th_bar06", now: NOW },
    deps({
      planner: async (text, now) => ({
        ...routeHeuristic(text, now),
        class: "aggregate" as const,
        methods: ["structured" as const],
        completeness: "exhaustive" as const,
      }),
      // The surface's page size — what makes this enumeration hit its cap.
      listLimit: limit,
    }),
  );
  const answer = turn.answer!;
  const gap = answer.gaps.join(" ");
  const wanted = str(exp.gap_contains, "so far, list may be incomplete");
  const missing = num(exp.missing_named, rows - limit);
  const violations: Violation[] = [];
  if (!answer.partial) violations.push({ label: "silent-truncation", note: `${rows} rows, cap ${limit}, no caveat` });
  const ok =
    answer.partial &&
    gap.includes(wanted) &&
    gap.includes(`${missing} more row(s)`) &&
    answer.answer.includes("partial");
  return {
    ok,
    output: { partial: answer.partial, gaps: answer.gaps, answer: answer.answer, scanned: answer.scanned, rows, limit },
    violations,
    metrics: { rows: answer.scanned, model_calls: 0 },
    notes: [`${answer.scanned} row(s) matched, cap ${limit}: ${answer.partial ? `partial — ${gap}` : "complete"}`],
  };
};

// ---- BAR-07 · general labelled ----------------------------------------------

const bar07: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  ev("max 6k a night yaar for the anjuna villa");
  const turn = await runBarTurn(
    { text: "gst on hotel rooms", threadId: "th_bar07", now: NOW },
    deps({ planner: planner(), general: async () => "12% under ₹7,500 a night, 18% above." }),
  );
  const answer = turn.answer!;
  const violations: Violation[] = [];
  if (answer.citations.length > 0 || answer.methods_ran.length > 0) {
    violations.push({ label: "general-answered-from-data", note: `${answer.citations.length} citation(s), methods ${answer.methods_ran.join("+")}` });
  }
  if (!answer.not_from_your_data || !answer.answer.startsWith(str(exp.prefix, "Not from your data"))) {
    violations.push({ label: "unlabelled-general" });
  }
  return {
    ok: violations.length === 0 && turn.class === "general",
    output: { class: turn.class, answer: answer.answer, not_from_your_data: answer.not_from_your_data, citations: answer.citations.length },
    violations,
    metrics: { model_calls: 0 },
    notes: [`labelled: ${JSON.stringify(answer.answer)}`],
  };
};

// ---- BAR-08 · create now, learn later ---------------------------------------

const ACTION_HAMPI = JSON.stringify({
  verb: "create_space",
  title: "Hampi trek Oct",
  goal: "plan the october hampi trek",
  risky: false,
  chapters: ["Travel"],
  first_tasks: ["book train"],
});

const bar08: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const utterance = "plan hampi trek in october, tanvi's coming, budget 15k, she's vegetarian";
  const claimsBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM claims`).get() as { n: number }).n;
  const { body } = await callRoute(
    (req, res) =>
      handleGroundedRoute(req, res, {
        planner: async (text, now) => ({ ...routeHeuristic(text, now), class: "action" as const }),
        actionCall: async () => ACTION_HAMPI,
        reranker: null,
      }),
    "POST",
    "/api/bar",
    { text: utterance },
  );

  const action = rec(body.action);
  const spaceId = str(action.space_id);
  const spaceRow = getDb().prepare(`SELECT status, created_by, label FROM spaces WHERE id = ?`).get(spaceId) as
    | { status: string; created_by: string | null; label: string }
    | undefined;
  const lock = rec(body.lock);
  const logged = getDb()
    .prepare(`SELECT id, origin, source_type, stream_key, text FROM events WHERE kind = 'bar.message' ORDER BY rowid ASC`)
    .all() as { id: string; origin: string | null; source_type: string | null; stream_key: string | null; text: string | null }[];
  const userLine = logged.find((r) => (r.text ?? "").includes("hampi trek"));
  const claimsAfter = (getDb().prepare(`SELECT COUNT(*) AS n FROM claims`).get() as { n: number }).n;

  const violations: Violation[] = [];
  if (claimsAfter - claimsBefore > num(exp.claims_written_by_bar, 0)) {
    violations.push({ label: "private-write-path", note: `${claimsAfter - claimsBefore} claim(s) written by the bar` });
  }
  if (!userLine || userLine.origin !== str(exp.origin, "live")) {
    violations.push({ label: "nothing-else-learned", note: "the utterance never reached the hot stream" });
  }
  const ok =
    spaceRow?.status === str(exp.space_status, "active") &&
    spaceRow?.created_by === str(exp.created_by, "user") &&
    lock.kind === "space" &&
    lock.id === spaceId &&
    violations.length === 0;
  return {
    ok,
    output: {
      space: spaceRow ?? null,
      lock,
      chips: body.chips,
      progress: action.progress,
      bar_messages: logged.map((r) => ({ origin: r.origin, source: r.source_type, stream: r.stream_key })),
      claims_written_by_bar: claimsAfter - claimsBefore,
    },
    violations,
    metrics: { claims_written_by_bar: claimsAfter - claimsBefore, model_calls: 0 },
    notes: [
      `space ${spaceId} active + created_by user, thread locked to it`,
      `the utterance sits on ${userLine?.stream_key} (origin ${userLine?.origin}, source ${userLine?.source_type}) — the live path's input`,
    ],
  };
};

// ---- BAR-09 · a follow-up stays on the object --------------------------------

const bar09: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const first = await callRoute(
    (req, res) =>
      handleGroundedRoute(req, res, {
        planner: async (text, now) => ({ ...routeHeuristic(text, now), class: "action" as const }),
        actionCall: async () => ACTION_HAMPI,
        reranker: null,
      }),
    "POST",
    "/api/bar",
    { text: "plan hampi trek in october" },
  );
  const threadId = str(first.body.thread_id);
  const lockBefore = rec(first.body.lock);

  const second = await callRoute(
    (req, res) =>
      handleGroundedRoute(req, res, {
        planner: async (text, now) => routeHeuristic(text, now),
        correctionParser: async () => ({ type: "edit", field: "label", value: "Hampi trek Nov" }),
        reranker: null,
      }),
    "POST",
    "/api/bar",
    { text: "actually make it november", thread_id: threadId },
  );

  const spaces = getDb().prepare(`SELECT id, label FROM spaces`).all() as { id: string; label: string }[];
  const corrections = (getDb().prepare(`SELECT COUNT(*) AS n FROM corrections`).get() as { n: number }).n;
  const lockAfter = rec(second.body.lock);

  const violations: Violation[] = [];
  if (spaces.length > num(exp.spaces_after, 1)) violations.push({ label: "second-space", note: `${spaces.length} spaces` });
  if (lockAfter.id !== lockBefore.id) violations.push({ label: "lost-lock" });
  return {
    ok: violations.length === 0 && spaces[0]?.label === "Hampi trek Nov" && corrections === num(exp.corrections, 1),
    output: { intent: second.body.intent, spaces, corrections, lock_before: lockBefore, lock_after: lockAfter, summary: second.body.summary },
    violations,
    metrics: { spaces: spaces.length, corrections, model_calls: 0 },
    notes: [`one space, renamed in place; ${corrections} correction row; the lock never moved`],
  };
};

// ---- BAR-10 · ambiguity -------------------------------------------------------

const bar10: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const labels = (rec(fixture.setup).spaces as string[] | undefined) ?? ["Goa Dec", "Hampi trek"];
  space("sp_a", labels[0] ?? "Goa Dec");
  space("sp_b", labels[1] ?? "Hampi trek");
  ev("anjuna goa villa with a pool");

  const askDeps = {
    planner: async (text: string, now: Date) => ({ ...routeHeuristic(text, now), class: "action" as const }),
    actionCall: async () => JSON.stringify({ verb: "create_task", title: "book it", space_candidates: ["sp_a", "sp_b"], risky: false }),
    reranker: null,
  };
  const asked = await callRoute((req, res) => handleGroundedRoute(req, res, askDeps), "POST", "/api/bar", { text: "book it" });
  const askAction = rec(asked.body.action);
  const threadId = str(asked.body.thread_id);
  const tasksAfterAsk = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;

  // "goa" in the same thread answers the open question — no second question,
  // no model call.
  const answered = await callRoute(
    (req, res) => handleGroundedRoute(req, res, { planner: async (t, n) => routeHeuristic(t, n), reranker: null }),
    "POST",
    "/api/bar",
    { text: "goa", thread_id: threadId },
  );
  const answerAction = rec(answered.body.action);
  const task = getDb().prepare(`SELECT space_id FROM tasks WHERE id = ?`).get(str(answerAction.task_id)) as { space_id: string } | undefined;

  // A bare question in a FRESH thread is a search, not a question and not a
  // second ask.
  const searched = await callRoute(
    (req, res) => handleGroundedRoute(req, res, { planner: async (t, n) => routeHeuristic(t, n), reranker: null }),
    "POST",
    "/api/bar",
    { text: "goa" },
  );

  const violations: Violation[] = [];
  if (askAction.status !== "needs_input" || tasksAfterAsk > 0) violations.push({ label: "coin-flip", note: `status ${String(askAction.status)}, ${tasksAfterAsk} task(s)` });
  if (answerAction.status === "needs_input") violations.push({ label: "question-asked-twice" });
  const expInstruction = rec(exp.instruction);
  const expAnswer = rec(exp.answer);
  const ok =
    askAction.status === "needs_input" &&
    (askAction.options as unknown[] | undefined)?.length === num(expInstruction.options, 2) &&
    tasksAfterAsk === num(expInstruction.tasks_written, 0) &&
    answerAction.status === str(expAnswer.status, "done") &&
    task?.space_id === "sp_a" &&
    num(answered.body.model_calls, -1) === num(expAnswer.model_calls, 0) &&
    searched.body.intent === "search" &&
    num(searched.body.model_calls, -1) === 0;
  return {
    ok,
    output: {
      instruction: { status: askAction.status, question: askAction.question, options: askAction.options, tasks_written: tasksAfterAsk },
      answer: { status: answerAction.status, space: task?.space_id ?? null, model_calls: answered.body.model_calls },
      bare_question: { intent: searched.body.intent, model_calls: searched.body.model_calls },
    },
    violations,
    metrics: { guess_rate: askAction.status === "needs_input" ? 0 : 1, model_calls: 0 },
    notes: [
      `"book it" asked one question with 2 one-tap options and wrote nothing`,
      `"goa" answered it for 0 calls; a bare "goa" in a fresh thread searched for 0 calls`,
    ],
  };
};

// ---- FIX-07 · quick chip "Not mine" -------------------------------------------

const fix07: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const db = getDb();
  space("sp_home", "Home");
  db.prepare(
    `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, created_by, status)
     VALUES ('t_court', 'sp_home', 'book badminton court', 'explicit', 'advise-only', 'self', 'user', 'open')`,
  ).run();

  const applied = await applyCorrectionRequest({
    target: { kind: "task", id: "t_court" },
    structured: { type: "wrong_person", owner: str(exp.owner, "karan") },
    scope: "once",
  });
  const correctionId = str(rec(applied.body).correction_id);
  const after = db.prepare(`SELECT owner FROM tasks WHERE id = 't_court'`).get() as { owner: string };
  const followUp = db
    .prepare(`SELECT id, title, category, status, owner FROM tasks WHERE id != 't_court'`)
    .get() as { id: string; title: string; category: string | null; status: string; owner: string } | undefined;

  const undone = await callRoute(handleCorrectionsRoute, "POST", `/api/corrections/${correctionId}/undo`);
  const restored = db.prepare(`SELECT owner FROM tasks WHERE id = 't_court'`).get() as { owner: string };
  const followUpAfterUndo = followUp
    ? (db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(followUp.id) as { status: string })
    : undefined;

  const violations: Violation[] = [];
  if (!followUp) violations.push({ label: "silent-handoff", note: "no monitoring follow-up left on our side" });
  if (followUpAfterUndo && followUpAfterUndo.status === "open") violations.push({ label: "undo-leaves-the-follow-up" });
  const corrections = (db.prepare(`SELECT COUNT(*) AS n FROM corrections`).get() as { n: number }).n;
  const ok =
    after.owner === str(exp.owner, "karan") &&
    followUp?.category === str(exp.follow_up_category, "monitoring") &&
    undone.status === 200 &&
    restored.owner === "self" &&
    followUpAfterUndo?.status === "dismissed" &&
    corrections === num(exp.correction_rows, 1) &&
    str(rec(applied.body).eval_draft) !== "";
  return {
    ok,
    output: {
      owner_after: after.owner,
      follow_up: followUp ?? null,
      undo: { status: undone.status, owner: restored.owner, follow_up_status: followUpAfterUndo?.status ?? null },
      eval_draft: rec(applied.body).eval_draft,
    },
    violations,
    metrics: { corrections, model_calls: 0 },
    notes: [`owner → ${after.owner} with a monitoring follow-up; undo restored both halves`],
  };
};

// ---- FIX-08 · "Don't do this again" -------------------------------------------

const fix08: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const setup = rec(fixture.setup);
  const db = getDb();
  space("sp_watch", "Fares");
  db.prepare(
    `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, created_by, status)
     VALUES ('t_fare', 'sp_watch', 'fares down ₹1,100 on the watched route', 'suggested', 'advise-only', 'self', 'llm', 'open')`,
  ).run();

  const applied = await applyCorrectionRequest({
    target: { kind: "task", id: "t_fare" },
    structured: {
      type: "dont_do_this",
      kind: str(setup.kind, "something_moved"),
      context: str(setup.context, "app:YouTube"),
      behavioral: { rule: str(exp.rule, "no cards while YouTube is frontmost"), scope: str(exp.scope, "router") },
    },
    scope: "global",
  });

  const rules = listBehavioralRules();
  const applies = rec(exp.applies_to);
  const doesNot = rec(exp.does_not_apply_to);
  const suppressesNext = suppressingRules({ app: str(applies.app, "YouTube"), kind: str(applies.kind, "something_moved"), surface: "router" });
  const leavesAlone = suppressingRules({ app: str(doesNot.app, "Mail"), kind: str(doesNot.kind, "something_moved"), surface: "router" });
  const listed = await callRoute(handleCorrectionsRoute, "GET", "/api/corrections/behavioral-rules");
  const versions = (db.prepare(`SELECT COUNT(*) AS n FROM claim_versions WHERE kind = 'behavioral'`).get() as { n: number }).n;

  const violations: Violation[] = [];
  if (rules.length === 0) violations.push({ label: "rule-not-written" });
  if (leavesAlone.length > 0) violations.push({ label: "rule-suppresses-everything", note: `${leavesAlone.length} rule(s) fired in another app` });
  const ok =
    rules.length === 1 &&
    rules[0]!.rule === str(exp.rule, "no cards while YouTube is frontmost") &&
    rules[0]!.scope === str(exp.scope, "router") &&
    suppressesNext.length === 1 &&
    leavesAlone.length === 0 &&
    ((listed.body.rules as unknown[]) ?? []).length === 1 &&
    versions >= 1 &&
    str(rec(applied.body).summary).includes("rule saved");
  return {
    ok,
    output: {
      rules: rules.map((r) => ({ rule: r.rule, scope: r.scope, kind: r.kind, context: r.context, evidence: r.evidence })),
      suppresses_next: suppressesNext.length,
      leaves_alone: leavesAlone.length,
      settings_list: (listed.body.rules as unknown[])?.length ?? 0,
      versions,
    },
    violations,
    metrics: { behavioral_rules: rules.length, model_calls: 0 },
    notes: [`rule "${rules[0]?.rule}" (${rules[0]?.scope}) suppresses the next YouTube card and nothing in Mail`],
  };
};

// ---- FIX-09 · every correction drafts a golden case ---------------------------

const fix09: CaseFn = async (fixture) => {
  const exp = rec(fixture.expected);
  const db = getDb();
  space("sp_home", "Home");
  db.prepare(
    `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, created_by, status)
     VALUES ('t_court', 'sp_home', 'book badminton court', 'explicit', 'advise-only', 'self', 'user', 'open')`,
  ).run();

  const parses = await applyCorrectionRequest(
    { target: { kind: "task", id: "t_court" }, utterance: "this is karan's, not mine", scope: "once" },
    async () => ({ type: "wrong_person", owner: "karan" }),
  );
  const doesNot = await applyCorrectionRequest(
    { target: { kind: "task", id: "t_court" }, utterance: "do the thing with the stuff", scope: "once" },
    async () => null,
  );

  const drafts = [str(rec(parses.body).eval_draft), str(rec(doesNot.body).eval_draft)].filter((p) => p !== "");
  const onDisk = drafts.filter((p) => existsSync(p));
  const rows = db.prepare(`SELECT id, status, instruction FROM corrections ORDER BY rowid ASC`).all() as {
    id: string;
    status: string;
    instruction: string;
  }[];

  const violations: Violation[] = [];
  if (rows.length < 2 || !rows.some((r) => r.status === "pending")) {
    violations.push({ label: "parse-to-nothing", note: "the unparseable correction left no row" });
  }
  if (onDisk.length < num(exp.drafts, 2)) violations.push({ label: "applied-only-drafts", note: `${onDisk.length} draft(s) on disk` });
  return {
    ok: violations.length === 0 && onDisk.length === num(exp.drafts, 2) && rows.length === 2,
    output: { corrections: rows, drafts, on_disk: onDisk.length },
    violations,
    metrics: { drafts: onDisk.length, model_calls: 0 },
    notes: [`${rows.length} correction row(s) — one applied, one pending — and ${onDisk.length} golden-case draft(s)`],
  };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const CASES: Record<string, CaseFn> = {
  "BAR-01": bar01,
  "BAR-02": bar02,
  "BAR-03": bar03,
  "BAR-04": bar04,
  "BAR-05": bar05,
  "BAR-06": bar06,
  "BAR-07": bar07,
  "BAR-08": bar08,
  "BAR-09": bar09,
  "BAR-10": bar10,
  "FIX-07": fix07,
  "FIX-08": fix08,
  "FIX-09": fix09,
};

/** BAR — every case is code, every seam is injected, zero model calls. */
export const barExecutor: Executor = async ({ fixture }) => {
  const run = CASES[fixture.id];
  if (!run) return { output: null, pending: `no BAR executor for ${fixture.id}` };
  seq = 0;
  return withScratchDb(() => run(fixture));
};

/**
 * FIX — the V2 prose cases (FIX-01..06) keep running live through p4.ts's
 * feedback executor; the three V6 P1 cases are code, here. One directory,
 * two shapes, the same category.
 */
export const fixExecutor: Executor = async (ctx) => {
  const run = CASES[ctx.fixture.id];
  if (!run) return feedbackExecutor(ctx);
  seq = 0;
  return withScratchDb(() => run(ctx.fixture));
};
