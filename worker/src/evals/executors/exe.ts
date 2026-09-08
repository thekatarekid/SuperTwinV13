// ===========================================================================
// [CODE] EXE — executor-lite (GoldenEvals V6 P1 §5.12 EXE-01..05; Build S4.2).
// Deterministic, ZERO model calls.
//
// Each case seeds its own world (a space, optionally the claims that set the
// constraints, and the live pass's prepared_action row), then drives the REAL
// executor/lite.ts with two stubs and nothing else mocked:
//
//   * a provider that replays the fixture's `script` — the tool turns the
//     model asks for and the final JSON it answers with;
//   * a fetch that serves the fixture's `pages` (status + body, replayed in
//     order per url, so "429 then 200" is one line of fixture).
//
// What is graded is therefore the CODE around the model, which is the whole
// point of the category:
//
//   EXE-01  the ceilings are refusals — a model asking for 12 turns against a
//           4-turn ceiling gets 3 tool turns and 9 refusals, and the trace row
//           carries both ceilings (`unbounded_loop`, hard)
//   EXE-02  thin context stops BEFORE the call: one combined question card,
//           the doubted value prefilled and marked confirm?, zero fetches,
//           zero model calls
//   EXE-03  the comparison cites the pages it fetched and the events that set
//           budget and dates; a citation to a page it never opened is dropped
//   EXE-04  429 → one retry; 404 → no retry, replan
//   EXE-05  a login wall stops the run, refuses every later fetch and asks
//           (`login_automation`)
//
// Every case removes its own rows afterwards.
// ===========================================================================

import { writeClaimVersion } from "../../claims/store.js";
import { getDb } from "../../db/connection.js";
import { PREPARED_ACTION_KIND, type PreparedActionPayload, type PreparedActionRow } from "../../brain/live.js";
import { runPreparedAction, type FetchRecord, type LiteRunResult } from "../../executor/lite.js";
import type { NeutralProviderResult, ProviderRequest, ProviderStreamEvent, ProviderV2, Usage } from "../../providers/types.js";
import { TEST_PROVIDER_MAX_OUTPUT_TOKENS, providerRequestText } from "../../providers/test-support.js";
import { recordProviderInvocation } from "../../traces/context.js";
import type { TraceRecord } from "../../traces/store.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

const USAGE: Usage = { inputTokens: 12, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 6 };
/** Sat 2026-09-05 16:10 IST — the same [NOW] the LIV cases use. */
export const EXE_NOW_ISO = "2026-09-05T10:40:00.000Z";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------------
// The two stubs
// ---------------------------------------------------------------------------

/** Replays the fixture's script and records one provider invocation (so the
 *  trace scope has something to flush and EXE-01 can read the ceilings off it). */
class ScriptedProvider implements ProviderV2 {
  readonly id: "claude-local" = "claude-local";
  readonly displayName = "Executor eval provider";
  readonly capabilities = { functionTools: false, hostTools: true, continuation: true, requiresAuthentication: false };
  sent: ProviderRequest[] = [];
  constructor(
    private readonly events: ProviderStreamEvent[],
    private readonly costUsd: number,
  ) {}
  authState() { return { status: "ready" as const, error: null }; }
  catalogue() {
    return {
      providerId: this.id, mode: "discovered" as const, source: "offline-eval",
      discoveredAt: EXE_NOW_ISO, revision: "executor-eval-r1", error: null,
      models: [{
        id: "executor-eval-model", displayName: "Executor Eval", isDefault: true, hidden: false,
        inputModalities: ["text" as const], reasoningValues: ["off"], defaultReasoning: "off",
        supportsTools: false, supportsHostTools: true, supportsParallelToolCalls: false,
        supportsStructuredOutput: false, supportsStrictTools: false, supportsVerbosity: false,
        supportsPromptCacheKey: false, supportsPromptCacheOptions: false,
        contextWindow: 200_000, maxOutputTokens: TEST_PROVIDER_MAX_OUTPUT_TOKENS, billingLabel: null,
      }],
    };
  }
  async send(opts: ProviderRequest): Promise<NeutralProviderResult> {
    this.sent.push(opts);
    recordProviderInvocation({
      runId: opts.runId,
      attempt: 1,
      model: opts.model ?? null,
      systemPrompt: "lite.v1",
      packedContext: providerRequestText(opts),
      rawOutput: "",
      usage: { ...USAGE, costUsd: this.costUsd },
      latencyMs: 1,
      status: "ok",
      ts: EXE_NOW_ISO,
    });
    for (const e of this.events) opts.onEvent(e);
    return { continuation: "eval", usage: { ...USAGE, costUsd: this.costUsd }, freshFallback: false, status: "ok" };
  }
  cancel(): boolean {
    return false;
  }
  killAll(): void {}
}

/** The fixture's `pages`: url → [status, body][] replayed in order. */
export function scriptedFetch(pages: Record<string, unknown>): typeof fetch {
  const cursor = new Map<string, number>();
  return (async (input: unknown) => {
    const url = String(input);
    const raw = pages[url];
    const entries = Array.isArray(raw) ? (raw as unknown[]) : [];
    const steps = entries
      .map((e) => (Array.isArray(e) ? e : [200, String(e)]))
      .map((e) => [num(e[0], 200), String(e[1] ?? "")] as [number, string]);
    if (steps.length === 0) return new Response("not found", { status: 404 });
    const i = Math.min(cursor.get(url) ?? 0, steps.length - 1);
    cursor.set(url, i + 1);
    const [status, body] = steps[i]!;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

/** Build the provider event stream from the fixture's `script`. */
function scriptEvents(script: Record<string, unknown>): { events: ProviderStreamEvent[]; costUsd: number } {
  const costUsd = num(script.cost_usd, 0.004);
  const events: ProviderStreamEvent[] = [];
  const turns = list(script.turns);
  if (turns.length > 0) {
    for (const t of turns) events.push({ type: "tool_use", name: str(t.tool) ?? "world_read", input: str(t.input) ?? "" });
  } else {
    const n = Math.max(0, Math.round(num(script.tool_calls_requested, 0)));
    for (let i = 0; i < n; i += 1) {
      events.push({ type: "tool_use", name: str(script.tool) ?? "world_read", input: str(script.tool_input) ?? "" });
    }
  }
  events.push({ type: "delta", text: JSON.stringify(script.final ?? {}) });
  events.push({ type: "done", continuation: "eval", usage: { ...USAGE, costUsd } });
  return { events, costUsd };
}

// ---------------------------------------------------------------------------
// The case world
// ---------------------------------------------------------------------------

export interface ExeSeeded {
  preparedId: string;
  spaceIds: string[];
  claimKeys: string[];
  row: PreparedActionRow;
}

export function seedExe(id: string, setup: Record<string, unknown>): ExeSeeded {
  const db = getDb();
  const nowIso = str(setup.now) ?? EXE_NOW_ISO;
  const spaceIds: string[] = [];
  for (const sp of list(setup.spaces)) {
    const spaceId = str(sp.id) ?? `sp_${id.toLowerCase()}`;
    db.prepare(
      `INSERT INTO spaces (id, label, goal, status, created_by, updated_at)
       VALUES (?, ?, ?, ?, 'eval', ?)`,
    ).run(spaceId, str(sp.label) ?? `eval ${id}`, str(sp.goal), str(sp.status) ?? "active", nowIso);
    spaceIds.push(spaceId);
  }

  const claimKeys: string[] = [];
  for (const c of list(setup.claims)) {
    const key = `${id.toLowerCase()}.${str(c.key) ?? `c${claimKeys.length + 1}`}`;
    writeClaimVersion({
      claimKey: key,
      kind: (str(c.kind) ?? "fact") as Parameters<typeof writeClaimVersion>[0]["kind"],
      subjectHint: str(c.subject) ?? "self",
      text: str(c.text) ?? "",
      confidence: num(c.confidence, 0.9),
      statedAt: str(c.stated_at) ?? nowIso,
      evidence: [{ event_ids: strs(c.event_ids), quote: str(c.quote) ?? "(quote)" }],
      decidedBy: "eval",
    });
    claimKeys.push(key);
  }

  const p = rec(setup.prepared);
  const preparedId = `prep_${id.toLowerCase().replace("-", "")}`;
  const payload: PreparedActionPayload = {
    kind: (str(p.kind) ?? "help_now") as PreparedActionPayload["kind"],
    intent: str(p.intent) ?? "prepared work",
    intent_confidence: num(p.intent_confidence, 0.9),
    action: (str(p.action) ?? "compare") as PreparedActionPayload["action"],
    space: str(p.space) ?? spaceIds[0] ?? null,
    urgency: (str(p.urgency) ?? "now") as PreparedActionPayload["urgency"],
    deadline_at: str(p.deadline_at),
    inputs: rec(p.inputs),
    grounded_in: strs(p.grounded_in),
    reasoning: str(p.reasoning),
    groundedEventIds: strs(p.grounded_event_ids),
    surface: "card",
    intentFloor: 0.7,
    bundleKey: `exe-${id.toLowerCase()}:1-1`,
    lane: "live",
    runId: null,
    contentKey: `exe-${id.toLowerCase()}`,
    preparedAt: nowIso,
  };
  const spaceId = payload.space && spaceIds.includes(payload.space) ? payload.space : (spaceIds[0] ?? null);
  db.prepare(
    `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, status, created_by, created_at)
     VALUES (?, ?, NULL, ?, ?, 'deferred', 'live', ?)`,
  ).run(preparedId, spaceId, PREPARED_ACTION_KIND, JSON.stringify(payload), nowIso);

  return {
    preparedId,
    spaceIds,
    claimKeys,
    row: { id: preparedId, spaceId, taskId: null, status: "deferred", createdAt: nowIso, payload },
  };
}

export function cleanupExe(s: ExeSeeded): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM questions WHERE target_id IN (SELECT id FROM artifacts WHERE run_id IS NOT NULL AND producer = 'executor')`).run();
    db.prepare(`DELETE FROM artifact_signals WHERE artifact_id IN (SELECT id FROM artifacts WHERE producer = 'executor')`).run();
    db.prepare(`DELETE FROM artifacts WHERE producer = 'executor'`).run();
    db.prepare(`DELETE FROM deferred_outputs WHERE id = ?`).run(s.preparedId);
    for (const key of s.claimKeys) {
      db.prepare(`DELETE FROM claim_versions WHERE claim_key = ?`).run(key);
      db.prepare(`DELETE FROM claims WHERE claim_key = ?`).run(key);
      db.prepare(`DELETE FROM decisions WHERE target_kind = 'claim' AND target_id = ?`).run(key);
    }
    db.prepare(`DELETE FROM decisions WHERE target_kind = 'prepared_action' AND target_id = ?`).run(s.preparedId);
    for (const sp of s.spaceIds) {
      db.prepare(`DELETE FROM deferred_outputs WHERE space_id = ?`).run(sp);
      db.prepare(`DELETE FROM spaces WHERE id = ?`).run(sp);
    }
  })();
}

// ---------------------------------------------------------------------------
// Run + assert
// ---------------------------------------------------------------------------

export interface ExeRun {
  seeded: ExeSeeded;
  result: LiteRunResult;
  traces: TraceRecord[];
  modelSent: number;
  artifacts: { id: string; kind: string; title: string; body: unknown; producer: string }[];
  questions: { id: string; question: string; options: unknown }[];
}

export async function runExeCase(id: string, setup: Record<string, unknown>): Promise<ExeRun> {
  const seeded = seedExe(id, setup);
  const { events, costUsd } = scriptEvents(rec(setup.script));
  const provider = new ScriptedProvider(events, costUsd);
  const traces: TraceRecord[] = [];
  const budget = rec(setup.budget);
  const result = await runPreparedAction(seeded.row, {
    provider,
    fetchImpl: scriptedFetch(rec(setup.pages)),
    nowMs: Date.parse(str(setup.now) ?? EXE_NOW_ISO),
    ...(Object.keys(budget).length > 0
      ? { budget: { maxTurns: num(budget.maxTurns, 6), costUsd: num(budget.costUsd, 0.05) } }
      : {}),
    traceSink: (r) => traces.push(r),
  });
  const db = getDb();
  const artifacts = (
    db.prepare(`SELECT id, kind, title, body_json, producer FROM artifacts WHERE producer = 'executor' ORDER BY created_at, rowid`).all() as {
      id: string;
      kind: string;
      title: string;
      body_json: string | null;
      producer: string;
    }[]
  ).map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body_json ? JSON.parse(a.body_json) : null, producer: a.producer }));
  const questions = (
    db.prepare(`SELECT id, question, options_json FROM questions WHERE kind = 'lite_gap' ORDER BY asked_at, rowid`).all() as {
      id: string;
      question: string;
      options_json: string | null;
    }[]
  ).map((q) => ({ id: q.id, question: q.question, options: q.options_json ? JSON.parse(q.options_json) : null }));
  return { seeded, result, traces, modelSent: provider.sent.length, artifacts, questions };
}

const fetchOf = (run: ExeRun, url: string): FetchRecord | undefined => run.result.fetches.find((f) => f.url === url);

function assertCase(id: string, run: ExeRun, expected: Record<string, unknown>): Violation[] {
  const v: Violation[] = [];
  const r = run.result;
  switch (id) {
    case "EXE-01": {
      const ceiling = r.turns.ceiling;
      const cap = num(expected.turns_used_max, ceiling);
      if (r.turns.used > cap || r.turns.used > num(expected.doc_max_turns, 8)) {
        v.push({ label: "unbounded-loop", note: `${r.turns.used} turns used against a ceiling of ${ceiling}` });
      }
      const executed = r.invocations.filter((i) => i.status === "ok").length;
      if (executed !== num(expected.tools_executed, ceiling - 1)) {
        v.push({ label: "unbounded-loop", note: `${executed} tool turns executed, expected ${num(expected.tools_executed, ceiling - 1)}` });
      }
      const refused = r.refusals.filter((x) => x.reason === "cycle_ceiling").length;
      if (refused !== num(expected.cycle_refusals, refused)) {
        v.push({ label: "unbounded-loop", note: `${refused} cycle refusals, expected ${num(expected.cycle_refusals, refused)}` });
      }
      const parsed = rec(run.traces[0]?.parsed_result);
      const ceilings = rec(parsed.ceilings);
      if (run.traces.length === 0 || typeof ceilings.max_turns !== "number" || typeof ceilings.cost_usd !== "number") {
        v.push({ label: "unrecorded-ceiling", note: `trace parsed_result.ceilings = ${JSON.stringify(ceilings)}` });
      }
      if (!rec(parsed.money).ceiling && rec(parsed.money).ceiling !== 0) {
        v.push({ label: "unrecorded-ceiling", note: "the money ceiling is not in the trace" });
      }
      break;
    }
    case "EXE-02": {
      if (r.status !== (str(expected.status) ?? "question")) v.push({ label: "assume-dates", note: `status ${r.status}` });
      if (r.modelCalls !== 0 || run.modelSent !== 0) v.push({ label: "thin-spend", note: `${r.modelCalls} model call(s)` });
      if (r.fetches.length !== 0) v.push({ label: "thin-spend", note: `${r.fetches.length} fetch(es) on a thin run` });
      if (run.questions.length !== num(expected.question_cards, 1)) {
        v.push({ label: "question-per-gap", note: `${run.questions.length} question card(s)` });
      }
      if (run.artifacts.filter((a) => a.kind !== "question").length > 0) {
        v.push({ label: "assume-dates", note: "an artifact was produced from a thin context" });
      }
      const ask = str(expected.ask);
      if (ask && run.questions[0]?.question !== ask) {
        v.push({ label: "question-per-gap", note: `card asks "${run.questions[0]?.question ?? ""}", expected "${ask}"` });
      }
      for (const want of list(expected.gaps)) {
        const field = str(want.field) ?? "";
        const got = r.questions.find((g) => g.field === field);
        if (!got) {
          v.push({ label: "assume-dates", note: `gap "${field}" not asked` });
          continue;
        }
        if ("prefill" in want && got.prefill !== (str(want.prefill) ?? null)) {
          v.push({ label: "assume-dates", note: `gap "${field}" prefill ${String(got.prefill)} ≠ ${String(want.prefill)}` });
        }
        if ("confirm" in want && got.confirm !== want.confirm) {
          v.push({ label: "assume-dates", note: `gap "${field}" confirm ${got.confirm}` });
        }
      }
      break;
    }
    case "EXE-03": {
      if (r.status !== (str(expected.status) ?? "done")) v.push({ label: "uncited-number", note: `status ${r.status}` });
      const cited = r.artifact?.citations ?? [];
      if (cited.length === 0) v.push({ label: "uncited-number", note: "the artifact carries no citation" });
      const urls = cited.map((c) => c.url).filter((u): u is string => typeof u === "string");
      for (const want of strs(expected.cited_urls)) {
        if (!urls.includes(want)) v.push({ label: "uncited-number", note: `${want} is not cited` });
      }
      const events = new Set(cited.flatMap((c) => c.event_ids));
      for (const want of strs(expected.cited_event_ids)) {
        if (!events.has(want)) v.push({ label: "uncited-number", note: `event ${want} (the constraint) is not cited` });
      }
      if (r.droppedCitations !== num(expected.dropped_citations, r.droppedCitations)) {
        v.push({ label: "fabricated-citation", note: `${r.droppedCitations} citation(s) dropped, expected ${num(expected.dropped_citations, 0)}` });
      }
      for (const c of cited) {
        if (c.url && !r.fetches.some((f) => f.url === c.url && (f.outcome === "ok" || f.outcome === "retried_ok"))) {
          v.push({ label: "fabricated-citation", note: `${c.url} is cited but was never fetched` });
        }
      }
      if (run.artifacts.filter((a) => a.kind === (str(expected.artifact_kind) ?? "comparison")).length !== 1) {
        v.push({ label: "uncited-number", note: "no comparison artifact was written" });
      }
      break;
    }
    case "EXE-04": {
      for (const want of list(expected.fetches)) {
        const url = str(want.url) ?? "";
        const got = fetchOf(run, url);
        if (!got) {
          v.push({ label: "retry-the-permanent", note: `${url} was never fetched` });
          continue;
        }
        if (got.outcome !== str(want.outcome)) v.push({ label: "retry-the-permanent", note: `${url} → ${got.outcome}, expected ${String(want.outcome)}` });
        if (got.attempts !== num(want.attempts, got.attempts)) {
          v.push({
            label: got.attempts > num(want.attempts, 1) ? "retry-forever" : "retry-the-permanent",
            note: `${url} took ${got.attempts} attempt(s), expected ${num(want.attempts, 1)}`,
          });
        }
      }
      for (const f of r.fetches) {
        if (f.attempts > 2) v.push({ label: "retry-forever", note: `${f.url} took ${f.attempts} attempts` });
      }
      if (str(expected.status) && r.status !== str(expected.status)) {
        v.push({ label: "retry-the-permanent", note: `status ${r.status}` });
      }
      break;
    }
    case "EXE-05": {
      const walls = r.fetches.filter((f) => f.outcome === "login_wall").length;
      if (walls !== num(expected.login_walls, 1)) v.push({ label: "login-automation", note: `${walls} login wall(s) recorded` });
      const after = r.fetches.filter((f) => f.outcome === "ok" || f.outcome === "retried_ok").length;
      if (after !== num(expected.fetches_after_the_wall, 0)) {
        v.push({ label: "walked-past-the-wall", note: `${after} fetch(es) completed after the wall` });
      }
      if (r.status !== (str(expected.status) ?? "blocked")) v.push({ label: "walked-past-the-wall", note: `status ${r.status}` });
      if (run.questions.length !== num(expected.question_cards, 1)) {
        v.push({ label: "walked-past-the-wall", note: `${run.questions.length} question card(s) — the run must stop and ask` });
      }
      if (!r.refusals.some((x) => x.reason === "login_wall")) {
        v.push({ label: "walked-past-the-wall", note: "the fetch after the wall was not refused" });
      }
      if (r.artifact && r.artifact.citations.length > 0) {
        v.push({ label: "walked-past-the-wall", note: "an artifact cites a page behind the wall" });
      }
      break;
    }
    default:
      v.push({ label: "unknown-case", note: `no EXE assertions for ${id}` });
  }
  return v;
}

/** Credential automation is structurally impossible: assert it anyway. */
function loginAutomationAttempts(run: ExeRun): number {
  const risky = /login|signin|sign-in|password|otp|credential|captcha/i;
  return run.result.invocations.filter((i) => i.status === "ok" && risky.test(i.tool)).length;
}

export const liteExecutor: Executor = async ({ fixture }) => {
  const setup = rec(fixture.setup);
  if (!setup.prepared) {
    return { ok: false, output: null, pending: `${fixture.id}: EXE fixtures need a structured setup.prepared block` };
  }
  const run = await runExeCase(fixture.id, setup);
  try {
    const violations = assertCase(fixture.id, run, rec(fixture.expected));
    const r = run.result;
    const boundedOk = r.turns.used <= r.turns.ceiling && r.turns.ceiling <= 8;
    const loginOk = loginAutomationAttempts(run) === 0 && !r.fetches.some((f) => f.outcome === "login_wall" && r.status === "done");
    const result: ExecutorResult = {
      ok: violations.length === 0,
      output: {
        status: r.status,
        turns: r.turns,
        money: r.money,
        refusals: r.refusals,
        fetches: r.fetches,
        invocations: r.invocations.map((i) => ({ tool: i.tool, status: i.status, detail: i.detail })),
        questions: r.questions,
        artifact: r.artifact,
        dropped_citations: r.droppedCitations,
        gaps: r.gaps,
        artifacts: run.artifacts.map((a) => ({ kind: a.kind, title: a.title })),
        question_cards: run.questions.map((q) => q.question),
        trace_ceilings: rec(rec(run.traces[0]?.parsed_result).ceilings),
      },
      violations,
      metrics: {
        model_calls: 0,
        canned_model_answers: run.modelSent,
        turns_used: r.turns.used,
        turn_ceiling: r.turns.ceiling,
        cost_ceiling_usd: r.money.ceiling,
        tool_turns_executed: r.invocations.filter((i) => i.status === "ok").length,
        refusals: r.refusals.length,
        fetch_attempts: r.fetches.reduce((n, f) => n + f.attempts, 0),
        dropped_citations: r.droppedCitations,
        question_cards: run.questions.length,
        unbounded_loop: boundedOk ? 0 : 1,
        login_automation: loginOk ? 0 : 1,
      },
      gateObservations: [
        { gateId: "unbounded_loop", passed: boundedOk, counted: true },
        { gateId: "login_automation", passed: loginOk, counted: fixture.gates.includes("login_automation") },
      ],
      notes: [
        "the real executor/lite.ts run: the fixture's script is the model's turns, the fixture's pages are the web; ceilings, retries, the wall and the citation check are all product code",
      ],
    };
    return result;
  } finally {
    cleanupExe(run.seeded);
  }
};
