// ===========================================================================
// EXECUTOR-LITE (V6 Phase 1, S4.2; Build §7.1; Prompts P-11 `lite.v1`;
// Product P1 §17). The bounded agent that finishes ONE prepared action.
//
//   live.v1 (S4.1) ─► deferred_outputs 'prepared_action'
//                        │
//                        ▼
//                   executor-lite ── web_fetch · world_read · world_write_draft
//                        │
//                        ├─ artifact (with evidence)  ─► surface router (S4.3)
//                        └─ ONE question card         ─► surface router (S4.3)
//
// FOUR PROPERTIES, EACH ENFORCED IN CODE, EACH GATED BY EXE-0x:
//
//   BOUNDED (EXE-01, `unbounded_loop = 0`, hard). The cycle ceiling is 3–8
//   turns and it is a REFUSAL, not a request: `--max-turns` goes to the CLI,
//   and this module also counts the tool turns it dispatches and refuses the
//   (maxTurns)th onward, so a provider that ignores the flag still cannot
//   loop. The money ceiling works the same way — cumulative cost is read off
//   the usage events and, once it reaches the ceiling, the next tool call is
//   refused. BOTH ceilings and both counters are written into the trace.
//
//   THIN CONTEXT STOPS (EXE-02). What the action needs is checked BEFORE the
//   model is called: a missing or doubted input produces ONE combined
//   question card naming every gap, each with the best guess prefilled and
//   marked "confirm?" — and zero fetches, zero model calls. An assumption is
//   never written; the prefill is a question, not a value.
//
//   EVIDENCE OR IT DIDN'T HAPPEN (EXE-03). A citation survives only if the
//   run actually fetched that URL and/or actually read that event. Everything
//   else is dropped and counted; an artifact left with no citation at all is
//   downgraded to a partial with the gap named. The model cannot cite a page
//   it never opened.
//
//   NO BROWSER, NO LOGIN (EXE-04, EXE-05, `login_automation = 0`). web_fetch
//   is a GET with no credentials, no forms and no cookie jar. A transient
//   status (429, 503, …) is retried ONCE; a permanent one (404, 410) is never
//   retried — the model replans. A login/OTP/challenge wall stops the run:
//   every later fetch is refused and the run ends in a question card. There
//   is no tool in the table that could log in, send or pay — the registry's
//   own registration guard (executor/tools.ts) refuses such a name.
//
// The three tools are registered as risk "safe" on the SAME ToolRegistry the
// full executor uses, so every invocation passes the one choke point that
// knows about approval tokens. Executor-lite registers no gated tool at all:
// a send or a payment is not gated here, it is absent.
// ===========================================================================

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArtifact, contentKeyFor, type ArtifactRow } from "../assist/artifacts.js";
import { extractJson, stableSystemPrompt } from "../brain/llm.js";
import { PREPARED_ACTION_KIND, listPreparedActions, type PreparedActionPayload, type PreparedActionRow } from "../brain/live.js";
import { reasoningForPass } from "../brain/reasoning.js";
import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  LITE_MAX_TURNS,
  LITE_V1,
  clampLiteBudget,
  liteSystemPrompt,
  type LiteBudget,
} from "../prompts/lite.v1.js";
import { modelForVersionedPass } from "../prompts/versions.js";
import { DEFAULT_PROVIDER_ID, get as getProvider } from "../providers/registry.js";
import { untrustedArgumentQuestion, worldModelToolArgCheck } from "../safety/tool-args.js";
import type { Provider, ProviderStreamEvent, Usage } from "../providers/types.js";
import { annotateTrace, withTraceContext } from "../traces/context.js";
import type { TraceRecord } from "../traces/store.js";
import {
  ToolRegistry,
  invokeTool,
  taskWorkspaceDir,
  type ToolContext as RegistryToolContext,
  type ToolInvocation,
} from "./tools.js";
// LEGACY (deleted with assist/ in S4.4) — see the banner at the foot of the file.
import type { AssistEvaluation } from "../assist/evaluator.js";
import type { TopicState } from "../assist/gate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const LITE_ARTIFACT_TYPES = ["comparison", "draft", "brief", "research"] as const;
export type LiteArtifactType = (typeof LITE_ARTIFACT_TYPES)[number];

export const LITE_STATUSES = ["done", "question", "partial", "blocked"] as const;
export type LiteStatus = (typeof LITE_STATUSES)[number];

export interface LiteCitation {
  /** A page this run fetched, or null when the citation is event-only. */
  url: string | null;
  /** Event ids this run actually read (world_read) or was grounded in. */
  event_ids: string[];
}

export interface LiteArtifact {
  type: LiteArtifactType;
  title: string;
  body: string;
  rows: unknown[];
  citations: LiteCitation[];
}

/** One gap in the combined question card. `prefill` is a guess, never a value. */
export interface LiteGap {
  field: string;
  prefill: string | null;
  /** Always true for a prefilled guess — the card renders it as "confirm?". */
  confirm: boolean;
  why: string;
}

export interface FetchRecord {
  url: string;
  /** null on a transport error. */
  status: number | null;
  outcome: "ok" | "retried_ok" | "transient" | "permanent" | "login_wall" | "refused";
  attempts: number;
  bytes: number;
  detail?: string;
}

export interface LiteRefusal {
  tool: string;
  reason: "cycle_ceiling" | "money_ceiling" | "login_wall" | "untrusted_argument" | "unknown_tool";
  detail: string;
  /** The argument the model asked for — what an untrusted-argument question names. */
  input: string;
}

export interface LiteRunResult {
  preparedId: string;
  runId: string;
  status: LiteStatus;
  /** The artifact row, when one was written. */
  artifactId: string | null;
  artifact: LiteArtifact | null;
  /** The questions row of the ONE combined question card, when raised. */
  questionId: string | null;
  questions: LiteGap[];
  criteria: string[];
  gaps: string[];
  turns: { used: number; attempted: number; ceiling: number };
  money: { usd: number; ceiling: number };
  invocations: ToolInvocation[];
  fetches: FetchRecord[];
  refusals: LiteRefusal[];
  /** Citations dropped because the run never fetched/read them (EXE-03). */
  droppedCitations: number;
  /** Model calls this run made. A thin stop makes ZERO. */
  modelCalls: number;
  /** Token/cost accounting for the caller's ledger. */
  usage: Usage;
  workspaceDir: string;
}

export interface LiteRunDeps {
  provider?: Provider;
  providerId?: string;
  /** Injectable fetch (evals and tests stub it; the default is global fetch). */
  fetchImpl?: typeof fetch;
  budget?: Partial<LiteBudget>;
  nowMs?: number;
  newId?: () => string;
  timeoutMs?: number;
  signal?: AbortSignal;
  registry?: ToolRegistry;
  /** Test/eval sink for the trace records this run flushes. */
  traceSink?: (record: TraceRecord) => void;
  /**
   * S4.7's injection detector slots in here: a tool argument that originates
   * in captured text is refused before the tool runs, and surfaced as a card.
   * Absent, every argument is allowed — the tools are read-only anyway.
   */
  validateToolArg?: (tool: string, input: string) => { ok: boolean; reason?: string };
}

// ---------------------------------------------------------------------------
// web_fetch — bounded GET, retry-once-on-transient, login wall stops the run
// ---------------------------------------------------------------------------

export const LITE_FETCH_TIMEOUT_MS = 8_000;
export const LITE_FETCH_MAX_BYTES = 200_000;
/** Retried exactly ONCE (EXE-04). Everything else is replanned, not retried. */
export const TRANSIENT_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];
/** A wall, not a failure: stop and ask (EXE-05). */
export const LOGIN_STATUSES: readonly number[] = [401, 403, 407, 511];

const LOGIN_URL_RE = /\/(login|log-in|signin|sign-in|sso|oauth|auth(?:orize)?|account\/login|checkpoint|challenge)\b/i;
const LOGIN_BODY_RE =
  /<input[^>]+type=["']?password|name=["']?password|one[- ]time (?:password|code)|\bOTP\b|log ?in to continue|sign ?in to continue|please (?:log|sign) ?in|verify (?:you are human|your identity)|g-recaptcha|hcaptcha|cf-challenge/i;
/** Hosts a personal twin has no business fetching (SSRF hygiene). */
const PRIVATE_HOST_RE =
  /^(?:localhost|(?:127|10|0)\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|.+\.(?:local|internal|localhost))$/i;

/** Normalised for comparison: lowercase host, no hash, no trailing slash. */
export function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    const s = u.toString();
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return raw.trim();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LiteToolContext extends RegistryToolContext {
  run: RunState;
}

interface RunState {
  preparedId: string;
  payload: PreparedActionPayload;
  fetchImpl: typeof fetch;
  fetches: FetchRecord[];
  /** Normalised URLs fetched successfully — the only citable pages. */
  fetchedUrls: Set<string>;
  /** Event ids world_read handed back — the only citable events. */
  readEventIds: Set<string>;
  /** Set by the first login wall; every later fetch is refused. */
  loginWall: { url: string; detail: string } | null;
  draft: LiteArtifact | null;
  retryDelayMs: number;
}

/** One bounded GET. Never sends credentials, never posts, never logs in. */
async function liteWebFetch(input: string, ctx: RegistryToolContext): Promise<string> {
  const run = (ctx as LiteToolContext).run;
  const url = input.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`web_fetch: not an http(s) url: ${url}`);
  const host = new URL(url).hostname;
  if (PRIVATE_HOST_RE.test(host)) throw new Error(`web_fetch: refused private host ${host}`);
  if (run.loginWall) {
    run.fetches.push({ url, status: null, outcome: "refused", attempts: 0, bytes: 0, detail: "run stopped at a login wall" });
    throw new Error(`web_fetch: the run stopped at a login wall (${run.loginWall.url}) — no further fetches`);
  }

  let attempts = 0;
  let lastDetail = "";
  let lastStatus: number | null = null;
  // Two passes at most: the second only ever runs for a TRANSIENT status or a
  // transport error. A 404 falls straight through — the model replans (EXE-04).
  for (let pass = 0; pass < 2; pass += 1) {
    attempts += 1;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LITE_FETCH_TIMEOUT_MS);
    try {
      const res = await run.fetchImpl(url, { signal: ac.signal, redirect: "follow" });
      lastStatus = res.status;
      const landed = typeof res.url === "string" && res.url !== "" ? res.url : url;
      const body = (await res.text()).slice(0, LITE_FETCH_MAX_BYTES);

      if (LOGIN_STATUSES.includes(res.status) || LOGIN_URL_RE.test(landed) || LOGIN_BODY_RE.test(body)) {
        const detail = LOGIN_STATUSES.includes(res.status)
          ? `HTTP ${res.status}`
          : LOGIN_URL_RE.test(landed)
            ? `redirected to ${landed}`
            : "the page asks for a login, an OTP or a challenge";
        run.loginWall = { url, detail };
        run.fetches.push({ url, status: res.status, outcome: "login_wall", attempts, bytes: body.length, detail });
        return `LOGIN_WALL ${url} — ${detail}. I do not log in. Stopping and asking the user.`;
      }
      if (TRANSIENT_STATUSES.includes(res.status)) {
        lastDetail = `HTTP ${res.status} (transient)`;
        if (pass === 0) {
          await sleep(run.retryDelayMs);
          continue; // the ONE retry
        }
        run.fetches.push({ url, status: res.status, outcome: "transient", attempts, bytes: 0, detail: lastDetail });
        return `TRANSIENT ${url} — ${lastDetail} after ${attempts} attempts. Try a different source.`;
      }
      if (!res.ok) {
        const detail = `HTTP ${res.status}`;
        run.fetches.push({ url, status: res.status, outcome: "permanent", attempts, bytes: 0, detail });
        return `PERMANENT ${url} — ${detail}. Not retried; replan.`;
      }
      run.fetches.push({
        url,
        status: res.status,
        outcome: attempts > 1 ? "retried_ok" : "ok",
        attempts,
        bytes: body.length,
      });
      run.fetchedUrls.add(normaliseUrl(url));
      return body;
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      if (pass === 0) {
        await sleep(run.retryDelayMs);
        continue; // a transport error is transient too
      }
    } finally {
      clearTimeout(timer);
    }
  }
  run.fetches.push({ url, status: lastStatus, outcome: "transient", attempts, bytes: 0, detail: lastDetail });
  return `TRANSIENT ${url} — ${lastDetail} after ${attempts} attempts. Try a different source.`;
}

// ---------------------------------------------------------------------------
// world_read — read-only slices, WITH the event ids that back them
// ---------------------------------------------------------------------------

/**
 * Spaces, open tasks and active claims matching the query. Claims come back
 * with their evidence event ids: that is what lets the artifact cite "the
 * event that set the budget" instead of asserting it (EXE-03).
 */
async function worldRead(input: string, ctx: RegistryToolContext): Promise<string> {
  const run = (ctx as LiteToolContext).run;
  const db = getDb();
  const term = input.trim();
  // A model asks in a phrase ("villa budget dates"); matching the phrase whole
  // finds nothing. Match ANY word of it instead — a crude lexical OR is what a
  // read tool owes its caller, and T0 retrieval proper arrives with the bar.
  const terms = term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3)
    .slice(0, 6);
  const where = (cols: readonly string[]): { sql: string; args: string[] } =>
    terms.length === 0
      ? { sql: "1 = 1", args: [] }
      : {
          sql: `(${terms.map(() => `(${cols.map((c) => `LOWER(${c}) LIKE ?`).join(" OR ")})`).join(" OR ")})`,
          args: terms.flatMap((t) => cols.map(() => `%${t}%`)),
        };
  const lines: string[] = [];

  const spaceWhere = where(["label", "COALESCE(goal, '')"]);
  const spaces = db
    .prepare(
      `SELECT id, label, goal, status FROM spaces
        WHERE status NOT IN ('archived','rejected') AND ${spaceWhere.sql}
        ORDER BY updated_at DESC, created_at DESC LIMIT 6`,
    )
    .all(...spaceWhere.args) as { id: string; label: string; goal: string | null; status: string }[];
  for (const s of spaces) lines.push(`space ${s.id} [${s.status}] "${s.label}"${s.goal ? ` — ${s.goal}` : ""}`);

  const taskWhere = where(["title"]);
  const tasks = db
    .prepare(
      `SELECT id, title, status, due, space_id FROM tasks
        WHERE status NOT IN ('done','cancelled','dismissed') AND ${taskWhere.sql}
        ORDER BY created_at DESC LIMIT 8`,
    )
    .all(...taskWhere.args) as { id: string; title: string; status: string; due: string | null; space_id: string | null }[];
  for (const t of tasks) lines.push(`task ${t.id} [${t.status}] "${t.title}"${t.due ? ` due ${t.due}` : ""}`);

  try {
    const claimWhere = where(["COALESCE(text, '')", "COALESCE(predicate, '')", "COALESCE(object, '')"]);
    const claims = db
      .prepare(
        `SELECT claim_key, kind, text, evidence_json FROM claims_active
          WHERE ${claimWhere.sql} ORDER BY stated_at DESC LIMIT 8`,
      )
      .all(...claimWhere.args) as { claim_key: string; kind: string | null; text: string | null; evidence_json: string | null }[];
    for (const c of claims) {
      const ids: string[] = [];
      if (c.evidence_json) {
        try {
          const parsed: unknown = JSON.parse(c.evidence_json);
          if (Array.isArray(parsed)) {
            for (const ev of parsed) {
              const eids = (ev as { event_ids?: unknown }).event_ids;
              if (Array.isArray(eids)) for (const id of eids) if (typeof id === "string") ids.push(id);
            }
          }
        } catch {
          /* a broken evidence blob reads as no evidence, never a throw */
        }
      }
      // Only what this run actually READ becomes citable (EXE-03).
      for (const id of ids) run.readEventIds.add(id);
      lines.push(`claim ${c.claim_key} [${c.kind ?? "fact"}] ${c.text ?? ""}${ids.length > 0 ? ` (events: ${ids.join(", ")})` : ""}`);
    }
  } catch {
    /* claims_active view absent in a minimal db — spaces and tasks still answer */
  }

  return lines.length > 0 ? lines.join("\n") : `world_read: nothing matches "${term}"`;
}

// ---------------------------------------------------------------------------
// world_write_draft — compose the artifact. A draft is text, never a send.
// ---------------------------------------------------------------------------

async function worldWriteDraft(input: string, ctx: RegistryToolContext): Promise<string> {
  const run = (ctx as LiteToolContext).run;
  const parsed = extractJson(input);
  const draft = parseArtifact(parsed);
  if (!draft) throw new Error("world_write_draft: expected the artifact object of the OUTPUT schema");
  run.draft = draft;
  const dir = join(ctx.workspaceDir, "drafts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft, null, 2), "utf8");
  return `draft stored: "${draft.title}" (${draft.rows.length} rows, ${draft.citations.length} citations). Nothing is sent.`;
}

/** The three tools, and nothing else. Registration itself refuses a risky name. */
export function liteToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "web_fetch",
    description: "Bounded HTTP GET of one public page. No credentials, no forms, no login.",
    risk: "safe",
    handler: liteWebFetch,
  });
  registry.register({
    name: "world_read",
    description: "Read-only world-model slice: spaces, open tasks, active claims with their evidence event ids.",
    risk: "safe",
    handler: worldRead,
  });
  registry.register({
    name: "world_write_draft",
    description: "Store the artifact draft for this prepared action. A draft is text; it is never sent.",
    risk: "safe",
    handler: worldWriteDraft,
  });
  return registry;
}

/** The complete capability surface, for the code assertion in the tests. */
export const LITE_TOOL_NAMES: readonly string[] = Object.freeze(["web_fetch", "world_read", "world_write_draft"]);

// ---------------------------------------------------------------------------
// Thin context — checked BEFORE the call, answered with ONE question card
// ---------------------------------------------------------------------------

/** Slots an action cannot start without. Anything else is checked if named. */
export const REQUIRED_INPUTS: Readonly<Record<string, readonly string[][]>> = Object.freeze({
  // Each entry is an OR-group: one of the names must carry a confident value.
  compare: [["candidates", "query", "url", "urls"], ["dates", "when"], ["budget"]],
  research: [["query", "topic", "candidates", "url", "urls"]],
  draft_reply: [["recipient", "to", "person"]],
  draft_message: [["recipient", "to", "person"]],
  brief: [],
  question: [],
});

const UNSURE_RE = /^(unknown|unclear|tbd|n\/a|none|not sure|maybe|\?)$|\?\s*$/i;

/** A value is "known" only when it is present, non-empty and not doubted. */
function valueState(v: unknown): { known: boolean; prefill: string | null; why: string } {
  if (v === undefined || v === null) return { known: false, prefill: null, why: "not in the action's inputs" };
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return { known: false, prefill: null, why: "empty" };
    if (UNSURE_RE.test(t)) return { known: false, prefill: t.replace(/\?+\s*$/, "").trim() || null, why: `the live pass wrote "${t}"` };
    return { known: true, prefill: t, why: "" };
  }
  if (typeof v === "number" || typeof v === "boolean") return { known: true, prefill: String(v), why: "" };
  if (Array.isArray(v)) {
    return v.length > 0
      ? { known: true, prefill: v.map((x) => String(x)).join(", "), why: "" }
      : { known: false, prefill: null, why: "empty list" };
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // The live pass may hedge a value as {value, confidence} — below the floor
    // it is a QUESTION with the guess prefilled, never a value we act on.
    if ("value" in o) {
      const inner = valueState(o.value);
      const conf = typeof o.confidence === "number" ? o.confidence : 1;
      if (!inner.known) return inner;
      if (conf < 0.7) return { known: false, prefill: inner.prefill, why: `the live pass was ${Math.round(conf * 100)}% sure` };
      return { known: true, prefill: inner.prefill, why: "" };
    }
    return { known: true, prefill: JSON.stringify(o), why: "" };
  }
  return { known: false, prefill: null, why: "unreadable" };
}

/**
 * The thin-context check (EXE-02). Every OR-group the action needs, plus every
 * slot the live pass itself listed in `inputs.needs`, must carry a confident
 * value. What is missing or doubted comes back as gaps — one card, not three.
 */
export function liteGaps(payload: Pick<PreparedActionPayload, "action" | "inputs">): LiteGap[] {
  const inputs = (payload.inputs ?? {}) as Record<string, unknown>;
  const gaps: LiteGap[] = [];
  const seen = new Set<string>();
  const push = (field: string, state: { prefill: string | null; why: string }): void => {
    if (seen.has(field)) return;
    seen.add(field);
    gaps.push({ field, prefill: state.prefill, confirm: state.prefill !== null, why: state.why });
  };

  for (const group of REQUIRED_INPUTS[payload.action] ?? []) {
    let best: { field: string; prefill: string | null; why: string } | null = null;
    let satisfied = false;
    for (const name of group) {
      if (!(name in inputs)) continue;
      const state = valueState(inputs[name]);
      if (state.known) {
        satisfied = true;
        break;
      }
      if (!best) best = { field: name, prefill: state.prefill, why: state.why };
    }
    if (satisfied) continue;
    const field = best?.field ?? group[0]!;
    push(field, { prefill: best?.prefill ?? null, why: best?.why ?? "not in the action's inputs" });
  }

  const needs = Array.isArray(inputs.needs) ? inputs.needs.filter((n): n is string => typeof n === "string") : [];
  for (const name of needs) {
    const state = valueState(inputs[name]);
    if (!state.known) push(name, state);
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// The ONE combined question card
// ---------------------------------------------------------------------------

/** "dates? budget?" — the card's own line, deterministic and combined. */
export function questionLine(gaps: readonly LiteGap[]): string {
  return gaps.map((g) => `${g.field}?`).join(" ");
}

function questionBody(prepared: PreparedActionRow, gaps: readonly LiteGap[], note: string | null): unknown {
  return {
    intent: prepared.payload.intent,
    action: prepared.payload.action,
    ask: questionLine(gaps),
    gaps: gaps.map((g) => ({ field: g.field, prefill: g.prefill, confirm: g.confirm, why: g.why })),
    ...(note ? { note } : {}),
    grounded_in: prepared.payload.groundedEventIds,
  };
}

/**
 * Write the single combined question card: one artifact (what the router
 * shows) and one questions row (where the answer lands). Never one card per
 * gap, and never a value written from a prefill.
 */
export function askCombinedQuestion(
  prepared: PreparedActionRow,
  gaps: readonly LiteGap[],
  opts: { runId?: string | null; note?: string | null; nowMs?: number } = {},
): { artifact: ArtifactRow; questionId: string; created: boolean } {
  const nowMs = opts.nowMs ?? Date.now();
  const line = questionLine(gaps);
  const { artifact, created } = createArtifact({
    kind: "question",
    title: line,
    summary: `${prepared.payload.intent} — I need ${gaps.length === 1 ? "one thing" : `${gaps.length} things`} before I start`,
    body: questionBody(prepared, gaps, opts.note ?? null),
    intent: prepared.payload.intent,
    reasoning: opts.note ?? "thin context: asking beats assuming",
    spaceId: prepared.spaceId,
    taskId: prepared.taskId,
    // Same link the artifact carries — the router routes a question card too.
    topicKey: `prepared:${prepared.id}`,
    contentKey: contentKeyFor({
      topicKey: `prepared:${prepared.id}`,
      intent: prepared.payload.intent,
      action: prepared.payload.action,
      eventHashes: gaps.map((g) => g.field),
    }),
    producer: "executor",
    runId: opts.runId ?? null,
    nowMs,
  });
  const questionId = `q_${randomBytes(9).toString("hex")}`;
  getDb()
    .prepare(
      `INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status, asked_at)
       VALUES (?, 'lite_gap', 'artifact', ?, ?, ?, 'open', ?)`,
    )
    .run(questionId, artifact.id, line, JSON.stringify(gaps), new Date(nowMs).toISOString());
  return { artifact, questionId, created };
}

// ---------------------------------------------------------------------------
// Parsing the final envelope
// ---------------------------------------------------------------------------

const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseArtifact(raw: unknown): LiteArtifact | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const inner = typeof o.artifact === "object" && o.artifact !== null && !Array.isArray(o.artifact) ? (o.artifact as Record<string, unknown>) : o;
  const type = LITE_ARTIFACT_TYPES.includes(inner.type as LiteArtifactType) ? (inner.type as LiteArtifactType) : null;
  const title = typeof inner.title === "string" && inner.title.trim() !== "" ? inner.title.trim() : null;
  if (!type || !title) return null;
  const citations: LiteCitation[] = (Array.isArray(inner.citations) ? inner.citations : [])
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && !Array.isArray(c))
    .map((c) => ({
      url: typeof c.url === "string" && c.url.trim() !== "" ? c.url.trim() : null,
      event_ids: strArray(c.event_ids),
    }));
  return {
    type,
    title,
    body: typeof inner.body === "string" ? inner.body : "",
    rows: Array.isArray(inner.rows) ? inner.rows : [],
    citations,
  };
}

export interface LiteOutput {
  status: LiteStatus;
  artifact: LiteArtifact | null;
  questions: LiteGap[];
  criteria: string[];
  turns: number | null;
  costUsd: number | null;
}

/** Parse the final turn. Returns null when nothing usable came back. */
export function parseLiteOutput(text: string): LiteOutput | null {
  const parsed = extractJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const status = LITE_STATUSES.includes(o.status as LiteStatus) ? (o.status as LiteStatus) : null;
  if (!status) return null;
  const questions: LiteGap[] = (Array.isArray(o.questions) ? o.questions : [])
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null && !Array.isArray(q))
    .map((q) => ({
      field: typeof q.field === "string" ? q.field : "unknown",
      prefill: typeof q.prefill === "string" && q.prefill.trim() !== "" ? q.prefill.trim() : null,
      confirm: q.confirm !== false,
      why: typeof q.why === "string" ? q.why : "the model asked",
    }));
  return {
    status,
    artifact: parseArtifact(o.artifact),
    questions,
    criteria: strArray(o.criteria),
    turns: typeof o.turns === "number" ? o.turns : null,
    costUsd: typeof o.cost_usd === "number" ? o.cost_usd : null,
  };
}

// ---------------------------------------------------------------------------
// Evidence — a citation survives only if this run really saw it
// ---------------------------------------------------------------------------

export interface GroundedArtifact {
  artifact: LiteArtifact;
  dropped: number;
  /** False when nothing citable survived — the artifact is then a partial. */
  ok: boolean;
}

export function groundArtifact(
  artifact: LiteArtifact,
  seen: { fetchedUrls: ReadonlySet<string>; eventIds: ReadonlySet<string> },
): GroundedArtifact {
  let dropped = 0;
  const kept: LiteCitation[] = [];
  for (const c of artifact.citations) {
    const url = c.url !== null && seen.fetchedUrls.has(normaliseUrl(c.url)) ? c.url : null;
    const eventIds = c.event_ids.filter((id) => seen.eventIds.has(id));
    if (url === null && eventIds.length === 0) {
      dropped += 1;
      continue;
    }
    kept.push({ url, event_ids: eventIds });
  }
  return { artifact: { ...artifact, citations: kept }, dropped, ok: kept.length > 0 };
}

// ---------------------------------------------------------------------------
// The bounded loop
// ---------------------------------------------------------------------------

const ZERO_USAGE: Usage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };

const promptFiles = new Map<string, string>();
function systemPromptFileFor(text: string): string {
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  const path = join(tmpdir(), `supertwinv13-lite.v1-${hash}.txt`);
  if (promptFiles.get(path) !== hash) {
    writeFileSync(path, text, "utf8");
    promptFiles.set(path, hash);
  }
  return path;
}

/** The user block: the prepared action, its inputs, its grounding, the clock. */
export function packPreparedAction(prepared: PreparedActionRow, budget: LiteBudget, nowIso: string): string {
  const p = prepared.payload;
  const lines = [
    `PREPARED ACTION ${prepared.id}`,
    `action: ${p.action}`,
    `intent: ${p.intent}`,
    `kind: ${p.kind} · urgency: ${p.urgency}${p.deadline_at ? ` · deadline ${p.deadline_at}` : ""}`,
    `[NOW] ${nowIso}`,
    `budget: ${budget.maxTurns} turns / $${budget.costUsd}`,
  ];
  if (prepared.spaceId) {
    const space = getDb().prepare(`SELECT label, goal FROM spaces WHERE id = ?`).get(prepared.spaceId) as
      | { label: string; goal: string | null }
      | undefined;
    if (space) lines.push(`space: ${space.label}${space.goal ? ` — goal: ${space.goal}` : ""}`);
  }
  lines.push(`inputs: ${JSON.stringify(p.inputs ?? {})}`);
  lines.push(`grounded_in: ${p.groundedEventIds.join(", ") || "(none)"}`);
  lines.push("", "Write your acceptance criteria first, then work. world_read before you assume.");
  return lines.join("\n");
}

/** Per-prepared-action workspace under <home>/executor/lite-<id>/. */
export function liteWorkspaceDir(preparedId: string): string {
  return taskWorkspaceDir(`lite-${preparedId}`);
}

/**
 * Run executor-lite for ONE prepared action.
 *
 * The order is deliberate: the thin check runs FIRST, in code, so a run that
 * cannot succeed never spends a call; then the bounded session; then the
 * evidence check on whatever came back. Whatever happens, the row leaves
 * behind an artifact or a question card, a decisions row and a trace.
 */
export async function runPreparedAction(prepared: PreparedActionRow, deps: LiteRunDeps = {}): Promise<LiteRunResult> {
  const budget = clampLiteBudget(deps.budget);
  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const runId = (deps.newId ?? randomUUID)();
  const workspaceDir = liteWorkspaceDir(prepared.id);
  const registry = deps.registry ?? liteToolRegistry();
  // S4.7 (Build §7.2): tool arguments originating in captured text are
  // validated against the world model before use. Default ON — the check is
  // the product's, not the fixture's.
  const validateToolArg = deps.validateToolArg ?? worldModelToolArgCheck();

  const base = {
    preparedId: prepared.id,
    runId,
    artifactId: null as string | null,
    artifact: null as LiteArtifact | null,
    questionId: null as string | null,
    criteria: [] as string[],
    gaps: [] as string[],
    money: { usd: 0, ceiling: budget.costUsd },
    invocations: [] as ToolInvocation[],
    fetches: [] as FetchRecord[],
    refusals: [] as LiteRefusal[],
    droppedCitations: 0,
    workspaceDir,
  };

  // ---- 1. thin context: ask, do not spend -------------------------------
  const gaps = liteGaps(prepared.payload);
  if (gaps.length > 0) {
    const card = askCombinedQuestion(prepared, gaps, { runId, nowMs, note: "thin context — no fetch made, nothing assumed" });
    resolvePrepared(prepared.id, nowMs);
    writeDecision({
      runId,
      pass: LITE_V1.pass,
      targetKind: "prepared_action",
      targetId: prepared.id,
      action: "ask_combined_question",
      new: { gaps: gaps.map((g) => g.field), artifact: card.artifact.id, question: card.questionId },
      reason: `thin context: ${gaps.map((g) => g.field).join(", ")} — asked once, assumed nothing, spent nothing`,
    });
    return {
      ...base,
      status: "question",
      artifactId: card.artifact.id,
      questionId: card.questionId,
      questions: [...gaps],
      turns: { used: 0, attempted: 0, ceiling: budget.maxTurns },
      modelCalls: 0,
      usage: { ...ZERO_USAGE },
    };
  }

  // ---- 2. the bounded session -------------------------------------------
  const system = stableSystemPrompt(`${LITE_V1.pass}:${budget.maxTurns}c$${budget.costUsd}`, liteSystemPrompt(budget));
  const promptVersion = createHash("sha1").update(system).digest("hex").slice(0, 12);

  const traceMeta = { pass: LITE_V1.pass, caller: "executor/lite", promptVersion, ...(deps.traceSink ? { sink: deps.traceSink } : {}) };

  return withTraceContext(traceMeta, async () => {
    const run: RunState = {
      preparedId: prepared.id,
      payload: prepared.payload,
      fetchImpl: deps.fetchImpl ?? fetch,
      fetches: [],
      fetchedUrls: new Set<string>(),
      readEventIds: new Set<string>(prepared.payload.groundedEventIds),
      loginWall: null,
      draft: null,
      retryDelayMs: deps.fetchImpl ? 0 : 400,
    };
    const ctx: LiteToolContext = { taskId: prepared.taskId ?? prepared.id, workspaceDir, nowMs: deps.nowMs, run };

    const invocations: ToolInvocation[] = [];
    const refusals: LiteRefusal[] = [];
    /**
     * Tool turns run STRICTLY IN ORDER, one promise chained on the last. A
     * bounded loop is sequential by definition, and the guards below only mean
     * anything if they can see what the previous turn learned — a login wall
     * found on turn 2 must refuse turn 3, not race it.
     */
    let chain: Promise<void> = Promise.resolve();
    /** The final turn is one of the ceiling's turns, so tools get ceiling - 1. */
    const toolCeiling = budget.maxTurns - 1;
    /** Turns ADMITTED (the ceiling's unit) and turns actually EXECUTED. */
    let dispatched = 0;
    let toolTurns = 0;
    let attemptedTurns = 0;
    let spentUsd = 0;
    let usage: Usage = { ...ZERO_USAGE };
    let finalText = "";
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let modelCalls = 0;

    const log = (inv: ToolInvocation): void => void invocations.push(inv);
    const refuse = (tool: string, input: string, reason: LiteRefusal["reason"], detail: string): void => {
      refusals.push({ tool, reason, detail, input });
      log({ tool, input, status: "refused", detail, at: new Date(deps.nowMs ?? Date.now()).toISOString() });
    };

    const onEvent = (e: ProviderStreamEvent): void => {
      switch (e.type) {
        case "delta":
          finalText += e.text;
          break;
        case "usage":
          // The adapter reports CUMULATIVE usage, so the ceiling reads the max.
          spentUsd = Math.max(spentUsd, e.usage.costUsd ?? 0);
          break;
        case "tool_use": {
          attemptedTurns += 1;
          const name = e.name;
          const input = typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? "");
          // ADMISSION happens when the model ASKS, on what is known then: the
          // turn count and the money spent so far are both monotonic, so the
          // verdict cannot change while the turn waits its place in the chain.
          if (!registry.get(name)) {
            refuse(name, input, "unknown_tool", `"${name}" is not in executor-lite's table`);
            break;
          }
          // THE CEILINGS, AS REFUSALS. A provider that ignores --max-turns, or
          // a loop that costs more than the action is worth, stops HERE.
          if (dispatched >= toolCeiling) {
            refuse(name, input, "cycle_ceiling", `cycle ceiling ${budget.maxTurns} turns reached`);
            break;
          }
          if (spentUsd >= budget.costUsd) {
            refuse(name, input, "money_ceiling", `money ceiling $${budget.costUsd} reached ($${spentUsd.toFixed(4)} spent)`);
            break;
          }
          // S4.7: a tool argument that ORIGINATED IN CAPTURED TEXT is checked
          // against the world model before the tool runs (INJ-03). The default
          // is the real check; a caller may still install its own.
          const verdict = validateToolArg(name, input);
          if (!verdict.ok) {
            refuse(name, input, "untrusted_argument", verdict.reason ?? "the argument originates in captured text");
            break;
          }
          dispatched += 1;
          chain = chain.then(async () => {
            // The wall is only knowable once the PREVIOUS turn has run, which
            // is why it is checked here and not at admission.
            if (run.loginWall && name === "web_fetch") {
              refuse(name, input, "login_wall", `stopped at a login wall (${run.loginWall.url})`);
              return;
            }
            toolTurns += 1;
            const at = new Date(deps.nowMs ?? Date.now()).toISOString();
            try {
              await invokeTool(registry, name, input, ctx);
              log({ tool: name, input, status: "ok", at });
            } catch (err) {
              log({ tool: name, input, status: "error", detail: (err as Error).message, at });
            }
          });
          break;
        }
        case "done":
          usage = e.usage;
          spentUsd = Math.max(spentUsd, e.usage.costUsd ?? 0);
          stopReason = e.stopReason;
          break;
        case "error":
          errorMessage = `${e.code}: ${e.message}`;
          break;
        default:
          break;
      }
    };

    const provider = deps.provider ?? getProvider(deps.providerId ?? DEFAULT_PROVIDER_ID);
    if (!provider) {
      errorMessage = `provider "${deps.providerId ?? DEFAULT_PROVIDER_ID}" is not registered`;
    } else {
      modelCalls = 1;
      try {
        const res = await provider.send({
          runId,
          message: packPreparedAction(prepared, budget, nowIso),
          sessionId: null,
          cwd: workspaceDir,
          allowedTools: registry.allowedToolNames(),
          systemPromptFile: systemPromptFileFor(system),
          maxTurns: budget.maxTurns,
          ...reasoningForPass(LITE_V1.pass, modelForVersionedPass(LITE_V1)),
          model: modelForVersionedPass(LITE_V1),
          timeoutMs: deps.timeoutMs,
          onEvent,
          signal: deps.signal,
        });
        if (res.status === "error" && !errorMessage) errorMessage = res.errorCode ?? "provider error";
      } catch (err) {
        errorMessage = (err as Error).message;
      }
    }
    await chain;

    // ---- 3. what came back, judged by code ------------------------------
    const out = errorMessage ? null : parseLiteOutput(finalText);
    const gapNotes: string[] = [];
    if (errorMessage) gapNotes.push(`session error: ${errorMessage}`);
    else if (!out) gapNotes.push(stopReason === "max_turns" ? `cycle ceiling ${budget.maxTurns} reached before a final answer` : "no parseable final answer");
    if (refusals.some((r) => r.reason === "cycle_ceiling")) gapNotes.push(`cycle ceiling ${budget.maxTurns} turns`);
    if (refusals.some((r) => r.reason === "money_ceiling")) gapNotes.push(`money ceiling $${budget.costUsd}`);
    for (const f of run.fetches) {
      if (f.outcome === "transient" || f.outcome === "permanent") gapNotes.push(`${f.url}: ${f.detail ?? f.outcome}`);
    }

    let status: LiteStatus = out?.status ?? "partial";
    let artifact = out?.artifact ?? run.draft;
    let dropped = 0;
    if (artifact) {
      const grounded = groundArtifact(artifact, { fetchedUrls: run.fetchedUrls, eventIds: run.readEventIds });
      artifact = grounded.artifact;
      dropped = grounded.dropped;
      if (dropped > 0) gapNotes.push(`${dropped} citation(s) named a page or event this run never opened — dropped`);
      if (!grounded.ok) {
        gapNotes.push("no citation survived: the artifact carries no evidence");
        status = "partial";
      }
    }

    // A login wall always ends in a question, whatever the model claimed.
    const questions: LiteGap[] = [...(out?.questions ?? [])];
    if (run.loginWall) {
      const host = ((): string => {
        try {
          return new URL(run.loginWall.url).hostname;
        } catch {
          return run.loginWall.url;
        }
      })();
      questions.push({
        field: `${host} sign-in`,
        prefill: null,
        confirm: false,
        why: `${run.loginWall.detail} — I never log in, send an OTP or answer a challenge`,
      });
      gapNotes.push(`login wall at ${run.loginWall.url}`);
      status = artifact && artifact.citations.length > 0 ? "partial" : "blocked";
    }
    // S4.7 / INJ-03: an argument the world model could not corroborate is a
    // QUESTION, never a quiet skip — the run says which address it will not
    // open on a message's say-so, and asks.
    for (const r of refusals.filter((x) => x.reason === "untrusted_argument")) {
      const q = untrustedArgumentQuestion(r.detail, r.input);
      if (questions.some((existing) => existing.field === q.field)) continue;
      questions.push({ field: q.field, prefill: null, confirm: true, why: q.why });
      gapNotes.push(`${r.tool}: ${r.detail}`);
      if (status === "done") status = "partial";
    }
    if (status === "question" && questions.length === 0) status = "partial";
    if (questions.length > 0 && status === "done") status = "partial";

    let artifactId: string | null = null;
    let questionId: string | null = null;
    if (artifact) {
      const written = createArtifact({
        kind: artifact.type,
        title: artifact.title,
        summary: `${prepared.payload.intent} — ${status}`,
        body: { ...artifact, status, criteria: out?.criteria ?? [], gaps: gapNotes },
        intent: prepared.payload.intent,
        reasoning: prepared.payload.reasoning,
        spaceId: prepared.spaceId,
        taskId: prepared.taskId,
        // The surface router (S4.3) reads the nudge KIND off the prepared
        // action behind the artifact; `topic_key` is that link.
        topicKey: `prepared:${prepared.id}`,
        contentKey: contentKeyFor({
          topicKey: `prepared:${prepared.id}`,
          intent: prepared.payload.intent,
          action: prepared.payload.action,
          eventHashes: [artifact.title, ...artifact.citations.map((c) => c.url ?? c.event_ids.join("+"))],
        }),
        producer: "executor",
        runId,
        nowMs,
      });
      artifactId = written.artifact.id;
    }
    if (questions.length > 0) {
      const card = askCombinedQuestion(prepared, questions, {
        runId,
        nowMs,
        note: run.loginWall ? "stopped at a login wall" : "the run needs an answer before it can finish",
      });
      questionId = card.questionId;
      if (!artifactId) artifactId = card.artifact.id;
    }

    resolvePrepared(prepared.id, nowMs);
    writeDecision({
      runId,
      pass: LITE_V1.pass,
      targetKind: "prepared_action",
      targetId: prepared.id,
      action: `lite_${status}`,
      new: {
        artifact: artifactId,
        question: questionId,
        turns: toolTurns + 1,
        turn_ceiling: budget.maxTurns,
        cost_usd: spentUsd,
        cost_ceiling: budget.costUsd,
        fetches: run.fetches.map((f) => ({ url: f.url, outcome: f.outcome, attempts: f.attempts })),
        dropped_citations: dropped,
      },
      reason: gapNotes.length > 0 ? gapNotes.join("; ") : `executor-lite ${status}`,
    });

    // Ceilings are RECORDED, not just enforced — EXE-01 reads them here.
    annotateTrace({
      parsedResult: {
        prepared_id: prepared.id,
        action: prepared.payload.action,
        status,
        ceilings: { max_turns: budget.maxTurns, cost_usd: budget.costUsd, doc_max_turns: LITE_MAX_TURNS },
        turns: { used: toolTurns + 1, attempted: attemptedTurns + 1, ceiling: budget.maxTurns },
        money: { usd: spentUsd, ceiling: budget.costUsd },
        refusals: refusals.map((r) => ({ tool: r.tool, reason: r.reason })),
        fetches: run.fetches.map((f) => ({ url: f.url, status: f.status, outcome: f.outcome, attempts: f.attempts })),
        dropped_citations: dropped,
        artifact: artifactId,
        question: questionId,
        gaps: gapNotes,
      },
    });

    writeFileSync(
      join(workspaceDir, "result.json"),
      JSON.stringify({ run_id: runId, status, artifact, questions, gaps: gapNotes, fetches: run.fetches, invocations }, null, 2),
      "utf8",
    );

    return {
      ...base,
      status,
      artifact,
      artifactId,
      questionId,
      questions,
      criteria: out?.criteria ?? [],
      gaps: gapNotes,
      turns: { used: toolTurns + 1, attempted: attemptedTurns + 1, ceiling: budget.maxTurns },
      money: { usd: spentUsd, ceiling: budget.costUsd },
      invocations,
      fetches: run.fetches,
      refusals,
      droppedCitations: dropped,
      modelCalls,
      usage,
    };
  });
}

/**
 * Mark the prepared row handled by this run: the queue is what is LEFT, and
 * the outcome (artifact, question, gaps) lives on the decisions row and the
 * artifact, not on a second status column.
 */
function resolvePrepared(preparedId: string, nowMs: number): void {
  getDb()
    .prepare(
      `UPDATE deferred_outputs SET status = 'activated', resolved_at = ?
        WHERE id = ? AND kind = ?`,
    )
    .run(new Date(nowMs).toISOString(), preparedId, PREPARED_ACTION_KIND);
}

/**
 * Drain the prepared-action queue, oldest first, bounded. The caller decides
 * WHEN (S4.3 wires the router; nothing here starts a timer of its own), so a
 * queue drain can never surprise the user with spend.
 */
export async function runPreparedQueue(deps: LiteRunDeps & { limit?: number } = {}): Promise<LiteRunResult[]> {
  const rows = listPreparedActions({ status: "deferred", limit: deps.limit ?? 5 }).reverse();
  const out: LiteRunResult[] = [];
  for (const row of rows) out.push(await runPreparedAction(row, deps));
  return out;
}

// ===========================================================================
// LEGACY — the P2.2 assist executor-lite. RETIRED WITH `assist/` IN S4.4
// (build §2.3): watcher.ts and evals/executors/assist.ts are its only callers
// and both die with it. Everything ABOVE this banner is the V6 executor-lite;
// everything BELOW is the old evaluator-driven loop, moved here unchanged so
// the file lives at its final address (`executor/lite.ts`) from S4.2 on.
// DELETE THIS SECTION, NOT THE FILE.
// ===========================================================================
// Executor-lite — build P2.2, spec §10.3. The bounded tool loop behind an
// actionable assist evaluation: prepare the user's next step in advance.
//
// SAFETY IS STRUCTURAL, NOT PROMPTED (AST-04): the tool table below is the
// COMPLETE set of capabilities this executor has. There is no send tool, no
// payment tool, no booking tool, no account mutation — they are not gated or
// disabled, they DO NOT EXIST in the table, so no prompt injection or model
// error can reach one. A test asserts this in code.
//
//   packer_read — read-only world-model slices (spaces/tasks/claims).
//   web_fetch   — bounded HTTP GET (size + time capped, count capped).
//   draft       — compose artifact text locally. Drafts are never sent.
//
// The loop is bounded (MAX_STEPS) and deterministic: steps derive from the
// evaluator's proposed action, run in order, and the artifact body is
// assembled from whatever the tools returned — best-partial on budget.

// ---------------------------------------------------------------------------
// The tool table (the WHOLE capability surface — AST-04 asserts on this)
// ---------------------------------------------------------------------------

export interface ToolContext {
  topic: TopicState;
  evaluation: AssistEvaluation;
  /** Injectable fetch (tests stub it; default global fetch, capped). */
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

export type AssistTool = (input: string, ctx: ToolContext) => Promise<string>;

export const WEB_FETCH_TIMEOUT_MS = 8_000;
export const WEB_FETCH_MAX_BYTES = 200_000;
/** Hard ceiling on tool invocations per artifact (the "bounded" in the name). */
export const MAX_STEPS = 6;

async function packerRead(_input: string, _ctx: ToolContext): Promise<string> {
  const db = getDb();
  const spaces = db
    .prepare(
      `SELECT id, label, goal FROM spaces WHERE status = 'active'
       ORDER BY updated_at DESC, created_at DESC LIMIT 4`,
    )
    .all() as { id: string; label: string; goal: string | null }[];
  const tasks = db
    .prepare(`SELECT id, title FROM tasks WHERE status IN ('open','pending') LIMIT 6`)
    .all() as { id: string; title: string }[];
  return [
    ...spaces.map((s) => `space ${s.id} "${s.label}"${s.goal ? ` — ${s.goal}` : ""}`),
    ...tasks.map((t) => `task ${t.id} "${t.title}"`),
  ].join("\n");
}

async function webFetch(input: string, ctx: ToolContext): Promise<string> {
  const url = input.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`web_fetch: not an http(s) url: ${url}`);
  const f = ctx.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await f(url, { signal: ac.signal, redirect: "follow" });
    const text = await res.text();
    return text.slice(0, WEB_FETCH_MAX_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

async function draft(input: string, ctx: ToolContext): Promise<string> {
  // Local composition only — a draft is TEXT in an artifact, never a send.
  return [
    `intent: ${ctx.evaluation.intent}`,
    `draft:`,
    input,
  ].join("\n");
}

/**
 * The complete tool table. Adding a tool here is a REVIEWED act: nothing that
 * sends, pays, books, messages, or mutates an account may ever appear
 * (AST-04 asserts the names against a risky-pattern list in code).
 */
export const ASSIST_TOOL_TABLE: Readonly<Record<string, AssistTool>> = Object.freeze({
  packer_read: packerRead,
  web_fetch: webFetch,
  draft,
});

/**
 * Patterns that must never match a tool NAME in the table above. Kept next to
 * the table so the AST-04 assertion and the table evolve together.
 */
export const RISKY_TOOL_NAME_PATTERNS: readonly RegExp[] = [
  /send/i,
  /pay/i,
  /purchase/i,
  /book/i,
  /order/i,
  /transfer/i,
  /email/i,
  /whatsapp/i,
  /message/i,
  /account/i,
  /checkout/i,
  /submit/i,
  /post/i,
  /write/i,
  /delete/i,
];

// ---------------------------------------------------------------------------
// The bounded loop
// ---------------------------------------------------------------------------

export interface ExecutorStep {
  tool: string;
  input: string;
  ok: boolean;
  /** Tool output (truncated) or the error message. */
  output: string;
}

export interface ExecutorLiteResult {
  steps: ExecutorStep[];
  /** The prepared artifact body (assembled from tool outputs). */
  body: {
    action: string;
    sections: { tool: string; input: string; content: string }[];
    partial: boolean;
  };
}

/** Extract http(s) urls named by the evaluator's proposed action. */
export function urlsInAction(action: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s"'<>)\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(action)) !== null && out.length < 4) out.push(m[0]);
  return out;
}

/**
 * Run the bounded tool loop for one actionable evaluation. Steps derive from
 * the proposed action: a world-model read first, then a capped web fetch per
 * url the action names, then a local draft composing the preparation. Any
 * step failure is recorded and the loop continues — best-partial on budget.
 */
export async function runExecutorLite(
  topic: TopicState,
  evaluation: AssistEvaluation,
  opts: { fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<ExecutorLiteResult> {
  if (!evaluation.action) throw new Error("executor-lite requires an actionable evaluation");
  const ctx: ToolContext = { topic, evaluation, fetchImpl: opts.fetchImpl, nowMs: opts.nowMs };

  const plan: { tool: string; input: string }[] = [{ tool: "packer_read", input: "" }];
  for (const url of urlsInAction(evaluation.action)) plan.push({ tool: "web_fetch", input: url });
  plan.push({ tool: "draft", input: evaluation.action });

  const bounded = plan.slice(0, MAX_STEPS);
  const steps: ExecutorStep[] = [];
  const sections: { tool: string; input: string; content: string }[] = [];
  for (const step of bounded) {
    const tool = ASSIST_TOOL_TABLE[step.tool];
    if (!tool) {
      steps.push({ tool: step.tool, input: step.input, ok: false, output: "unknown tool" });
      continue;
    }
    try {
      const output = await tool(step.input, ctx);
      steps.push({ tool: step.tool, input: step.input, ok: true, output: output.slice(0, 4000) });
      sections.push({ tool: step.tool, input: step.input, content: output.slice(0, 4000) });
    } catch (err) {
      steps.push({
        tool: step.tool,
        input: step.input,
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    steps,
    body: {
      action: evaluation.action,
      sections,
      partial: plan.length > bounded.length || steps.some((s) => !s.ok),
    },
  };
}