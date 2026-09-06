// ===========================================================================
// [CODE] Grounded-bar handlers (build P4.1, spec §14.8, USR-01…06).
//
// One handler per routed intent:
//
//   search   — retrieval over the event log + space label matches. No model.
//   question — grounded chat: context block → traced answer call → the
//              USR-04 HARD GATE enforced in code (enforceCitations): every
//              claim must carry a citation that resolves to a real event;
//              an uncited answer is REFUSED here, not just discouraged in
//              the prompt.
//   action   — parse via the traced bar-action prompt, then apply through
//              the normal object paths: user-created spaces go ACTIVE with
//              sweep + plan (USR-01), tasks file into existing spaces
//              (USR-02), ambiguity asks once (USR-03), risky asks become
//              tasks behind the executor's approval gate (USR-05) — the bar
//              is a front door, never a side door around approvals.
//
// Every mutation writes a decisions row (single-writer convention); model
// calls go through the prompt runner (traced, accounted); both model calls
// are injectable so unit tests stay offline.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { getSelectedModel } from "../db/settings.js";
import { runJsonPass } from "../brain/llm.js";
import { reasoningForPass } from "../brain/reasoning.js";
// bar-action.v3 — v2 plus the worked example for the ambiguous-space case.
// The S6 sweep found the model picking one of two equally plausible spaces
// ("goa" matching both a December trip and a wedding), which is the hard
// `guess_rate = 0` gate; v2 stated the rule but only ever showed the
// unambiguous example. See the header of bar-action.v3.ts.
import {
  BAR_ACTION_V3_INSTRUCTIONS,
  BAR_ACTION_V3_VERSION,
  packActionInput,
  parseActionOutput,
  type ParsedBarAction,
} from "../prompts/bar-action.v3.js";
import {
  BAR_ANSWER_INSTRUCTIONS,
  BAR_ANSWER_VERSION,
  packAnswerInput,
} from "../prompts/bar-answer.v1.js";
import { writeRunLedger } from "../db/index.js";
import { systemPromptPath } from "../prompts/runner.js";
import { claudeLocalProvider } from "../providers/claude-local/index.js";
import { resourcePool } from "../providers/pool.js";
import { bindTraceContext, withTraceContext } from "../traces/context.js";
import {
  buildContextBlock,
  getEventDetail,
  parseCitationsFromText,
  searchEventHits,
  type Citation,
} from "../server/chat-grounding.js";
import { bornAsked } from "../spaces/birth.js";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** One packed prompt → the model's verbatim text. Injectable for tests. */
export type BarModelCall = (user: string) => Promise<string>;

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// search — retrieval, no model (spec §14.8 state ②'s live results)
// ---------------------------------------------------------------------------

export interface BarSearchHit {
  id: string;
  ts: string | null;
  actor: string | null;
  chat: string | null;
  snippet: string;
}

export interface BarSearchResult {
  events: BarSearchHit[];
  spaces: { id: string; label: string }[];
}

export function handleSearch(text: string, limit = 12): BarSearchResult {
  const events = searchEventHits(text, limit).map((h) => ({
    id: h.id,
    ts: h.ts,
    actor: h.actor,
    chat: h.chat,
    snippet: h.snippet,
  }));
  const words = text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3)
    .slice(0, 4);
  const spaces: { id: string; label: string }[] = [];
  if (words.length > 0) {
    const clauses = words.map(() => `label LIKE ?`).join(" OR ");
    const rows = getDb()
      .prepare(
        `SELECT id, label FROM spaces
          WHERE status IN ('active','dormant') AND (${clauses})
          ORDER BY updated_at DESC LIMIT 4`,
      )
      .all(...words.map((w) => `%${w}%`)) as { id: string; label: string }[];
    spaces.push(...rows);
  }
  return { events, spaces };
}

// ---------------------------------------------------------------------------
// question — grounded chat with the USR-04 hard gate
// ---------------------------------------------------------------------------

/** The honest no-answer the spec mandates over invention. */
export const NOTHING_TEXT = "nothing in your data about this";

export interface BarAnswer {
  answer: string;
  citations: Citation[];
  /** False when the twin declined (no data / refused for missing citations). */
  grounded: boolean;
  /** Set when the gate fired: the model answered but could not cite. */
  refused_uncited: boolean;
}

/** Resolves a cited event id to true when it names a REAL event. */
export type CitationResolver = (id: string) => boolean;

const defaultResolver: CitationResolver = (id) => getEventDetail(id) !== null;

/**
 * The USR-04 hard gate, in code: every claim cites; citations must resolve
 * to real events; an answer with claims but zero resolvable citations is
 * REFUSED — replaced by the honest no-answer, never served as-is. A
 * hallucinated-recall paraphrase with an invented id dies here too.
 */
export function enforceCitations(
  display: string,
  citations: Citation[] | null,
  resolve: CitationResolver = defaultResolver,
): BarAnswer {
  const text = display.trim();
  const valid = (citations ?? []).filter((c) => c.kind === "event" && resolve(c.id));
  const declined = text === "" || text.toLowerCase().includes(NOTHING_TEXT);
  if (declined) {
    return { answer: NOTHING_TEXT, citations: [], grounded: false, refused_uncited: false };
  }
  if (valid.length === 0) {
    // The model asserted something it could not ground. Refuse in code.
    return { answer: NOTHING_TEXT, citations: [], grounded: false, refused_uncited: true };
  }
  return { answer: text, citations: valid, grounded: true, refused_uncited: false };
}

/**
 * The production answer call: one traced plain completion via the local
 * `claude` CLI (Haiku default). The answer is PROSE with a CITATIONS line —
 * not the wire/JSON contract the batch runners validate — so it goes through
 * the provider directly (the same pattern the eval judge uses), inside a
 * trace context (TRC-01) with the versioned prompt as the system file.
 */
export const answerViaModel: BarModelCall = async (user) => {
  const systemFile = systemPromptPath(BAR_ANSWER_VERSION, BAR_ANSWER_INSTRUCTIONS);
  let text = "";
  const runId = mintId("run");
  const model = getSelectedModel("chat") || "haiku";
  const startedAt = new Date().toISOString();
  const result = await withTraceContext(
    { pass: BAR_ANSWER_VERSION, caller: "grounded/handlers", promptVersion: BAR_ANSWER_VERSION },
    async () => {
      // S0.9 / T8-3: through the pool — the bar shares the LLM cap with every
      // other call instead of bypassing it.
      const res = await resourcePool.run(
        "llm",
        bindTraceContext(() =>
          claudeLocalProvider.send({
            runId,
            message: user,
            systemPromptFile: systemFile,
            plainCompletion: true,
            maxTurns: 1,
            ...reasoningForPass("chat", model),
            allowedTools: [],
            model,
            timeoutMs: 120_000,
            onEvent: (ev) => {
              if (ev.type === "delta") text += ev.text;
            },
          }),
        ),
        { lane: "understanding" },
      );
      // S0.9 / T8-1: the bar answer had no ledger row — its spend was invisible.
      const endedAt = new Date().toISOString();
      const status = res.status === "ok" ? "ok" : "error";
      const errorCode = res.errorCode ? String(res.errorCode) : null;
      try {
        writeRunLedger({
          run: {
            id: runId,
            role: "chat",
            model,
            cohortId: null,
            kind: BAR_ANSWER_VERSION,
            pass: BAR_ANSWER_VERSION,
            origin: "live",
            status,
            startedAt,
            endedAt,
            usage: res.usage,
            errorCode,
            ttftMs: null,
          },
          log: {
            provider: claudeLocalProvider.id,
            sessionId: null,
            runId,
            kind: BAR_ANSWER_VERSION,
            promptChars: user.length + BAR_ANSWER_INSTRUCTIONS.length,
            inputTokens: res.usage.inputTokens,
            cacheCreationInputTokens: res.usage.cacheCreationInputTokens,
            cacheReadInputTokens: res.usage.cacheReadInputTokens,
            outputTokens: res.usage.outputTokens,
            costUsd: res.usage.costUsd ?? null,
            durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || 0,
            status,
            errorCode,
            model,
            role: "chat",
          },
        });
      } catch (err) {
        console.error("[bar] run ledger write failed:", err);
      }
      return res;
    },
  );
  if (result.status !== "ok") {
    throw new Error(`bar-answer call failed: ${result.errorCode ?? "unknown"}`);
  }
  return text;
};

export async function handleQuestion(
  text: string,
  history: readonly { role: "user" | "twin"; text: string }[] = [],
  answerCall: BarModelCall = answerViaModel,
  resolve: CitationResolver = defaultResolver,
): Promise<BarAnswer> {
  const block = buildContextBlock(text);
  if (!block) {
    // Nothing retrieved: the honest no-answer without spending a model call.
    return { answer: NOTHING_TEXT, citations: [], grounded: false, refused_uncited: false };
  }
  let raw: string;
  try {
    raw = await answerCall(packAnswerInput(block, text, history));
  } catch {
    return { answer: NOTHING_TEXT, citations: [], grounded: false, refused_uncited: false };
  }
  const { display, citations } = parseCitationsFromText(raw);
  return enforceCitations(display, citations, resolve);
}

// ---------------------------------------------------------------------------
// action — parse, then apply through the normal object paths
// ---------------------------------------------------------------------------

export interface BarActionOutcome {
  status: "done" | "needs_input" | "failed";
  summary: string;
  /** Ask-once (USR-03): question + one-tap options; pending carries the parse. */
  question?: string;
  options?: { id: string; label: string }[];
  pending?: ParsedBarAction;
  space_id?: string;
  task_id?: string;
  /** Inline progress lines the bar renders ("creating space → …"). */
  progress: string[];
}

/**
 * The production action parse: one traced JSON call (Haiku default) through
 * the same runner every V13 JSON pass uses — the bar-action contract is a
 * one-line JSON object, so runJsonPass validates + repair-bounds it.
 */
export const actionViaModel: BarModelCall = async (user) => {
  const result = await runJsonPass<ParsedBarAction>({
    pass: BAR_ACTION_V3_VERSION,
    system: BAR_ACTION_V3_INSTRUCTIONS,
    user,
    role: "classify",
    cohortId: null,
    model: getSelectedModel("classify") || undefined,
    unit: { kind: "bar-action", id: "bar" },
    validate: (parsed) => {
      const action = parseActionOutput(JSON.stringify(parsed));
      if (!action) throw new Error('the object must carry "verb" (known value) and a non-empty "title"');
      return action;
    },
  });
  return result.output ? JSON.stringify(result.output) : "";
};

function activeSpaces(): { id: string; label: string }[] {
  return getDb()
    .prepare(`SELECT id, label FROM spaces WHERE status IN ('active','dormant') ORDER BY updated_at DESC LIMIT 40`)
    .all() as { id: string; label: string }[];
}

/** Resolve a hint that may be a space id or a spoken label fragment. */
function resolveSpace(hint: string): { id: string; label: string } | null {
  const db = getDb();
  const byId = db.prepare(`SELECT id, label FROM spaces WHERE id = ?`).get(hint) as
    | { id: string; label: string }
    | undefined;
  if (byId) return byId;
  const byLabel = db
    .prepare(
      `SELECT id, label FROM spaces WHERE label LIKE ? AND status != 'rejected' ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(`%${hint}%`) as { id: string; label: string } | undefined;
  return byLabel ?? null;
}

/**
 * Apply one parsed action. Every write goes through the normal object shapes
 * (spaces/chapters/tasks rows + decisions rows). Risky work NEVER executes
 * here: it becomes a task whose risk class routes it through the executor's
 * approval gate — risky_without_token stays 0 by construction.
 */
/** What the bar knows about the utterance itself — the evidence a birth cites. */
export interface BarActionContext {
  /** The sentence the user typed; stored verbatim as an asked-for space's birth evidence (SPC-05). */
  utterance?: string;
  /** The bar thread it lives in — "why?" on the space reopens it. */
  threadId?: string | null;
}

/** The dedupe answer that means "start a new one anyway" (SPC-03's second tap). */
export const NEW_SPACE_ANYWAY = "__new_space__";

export function applyAction(
  action: ParsedBarAction,
  sweep: readonly BarSearchHit[],
  ctx: BarActionContext = {},
): BarActionOutcome {
  const db = getDb();
  const progress: string[] = [];

  // Ask-once (USR-03): the parse surfaced competing spaces — hold the object,
  // ask ONE targeted question with one-tap answers, never coin-flip.
  if (
    !action.space_hint &&
    action.space_candidates &&
    action.space_candidates.length >= 2 &&
    action.verb !== "create_space"
  ) {
    const options = action.space_candidates
      .map((c) => resolveSpace(c))
      .filter((s): s is { id: string; label: string } => s !== null);
    if (options.length >= 2) {
      return {
        status: "needs_input",
        summary: "which space is this for?",
        question: `File "${action.title}" under which?`,
        options,
        pending: action,
        progress,
      };
    }
  }

  switch (action.verb) {
    case "create_space": {
      // USR-01 / SPC-02: user-created skips the proposal queue — ACTIVE
      // immediately, created_by 'user', born_via 'asked', the utterance as
      // its birth evidence, the sweep attached and the plan drafted.
      // SPC-03: deduped first — a live near-match ASKS (attach, or start a
      // new one anyway); it never mints a second space with the same goal.
      const exemplars = sweep.slice(0, 3).map((h) => ({
        summary: h.snippet,
        event_ids: [h.id],
      }));
      const forceNew = action.space_hint === NEW_SPACE_ANYWAY;
      if (action.space_hint && !forceNew) {
        // The user tapped "add to <existing>": file the first tasks there.
        const target = resolveSpace(action.space_hint);
        if (target) {
          for (const title of action.first_tasks ?? []) {
            const taskId = mintId("t");
            db.prepare(
              `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, created_by, status)
               VALUES (?, ?, ?, 'explicit', 'advise-only', 'self', 'user', 'open')`,
            ).run(taskId, target.id, title);
            writeDecision({
              pass: "user",
              targetKind: "task",
              targetId: taskId,
              action: "create",
              new: { title, space_id: target.id },
              reason: `filed into "${target.label}" instead of a duplicate space`,
            });
          }
          writeDecision({
            pass: "user",
            targetKind: "space",
            targetId: target.id,
            action: "dedupe_birth",
            new: { proposedLabel: action.title, via: "user_answer", utterance: ctx.utterance ?? null },
            reason: `user chose to add "${action.title}" to the existing space`,
          });
          progress.push(`adding to "${target.label}" ✓`);
          return {
            status: "done",
            summary: `added to "${target.label}"`,
            space_id: target.id,
            progress,
          };
        }
      }
      const born = bornAsked({
        label: action.title,
        goal: action.goal ?? null,
        utterance: ctx.utterance ?? action.title,
        threadId: ctx.threadId ?? null,
        exemplars,
        forceNew,
      });
      if (born.outcome === "ask") {
        return {
          status: "needs_input",
          summary: `you already have "${born.duplicate.label}"`,
          question: `You already have "${born.duplicate.label}" — add "${action.title}" to it, or start a new space?`,
          options: [
            { id: born.duplicate.spaceId, label: `Add to "${born.duplicate.label}"` },
            { id: NEW_SPACE_ANYWAY, label: "Start a new space anyway" },
          ],
          pending: action,
          progress,
        };
      }
      const spaceId = born.spaceId;
      progress.push("creating space ✓");
      if (born.preview.count > 0) progress.push(`sweeping: ${born.preview.line} ✓`);
      else if (sweep.length > 0) progress.push(`sweeping ${sweep.length} related item(s) ✓`);
      for (const chapter of action.chapters ?? []) {
        db.prepare(`INSERT INTO chapters (id, space_id, label) VALUES (?, ?, ?)`).run(
          mintId("ch"),
          spaceId,
          chapter,
        );
      }
      if ((action.chapters ?? []).length > 0) {
        progress.push(`drafting ${action.chapters!.length} chapter(s) ✓`);
      }
      let firstTaskId: string | undefined;
      for (const title of action.first_tasks ?? []) {
        const taskId = mintId("t");
        firstTaskId = firstTaskId ?? taskId;
        db.prepare(
          `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, created_by, status)
           VALUES (?, ?, ?, 'explicit', 'advise-only', 'self', 'user', 'open')`,
        ).run(taskId, spaceId, title);
        writeDecision({
          pass: "user",
          targetKind: "task",
          targetId: taskId,
          action: "create",
          new: { title, space_id: spaceId },
          reason: "first task drafted for user-created space",
        });
      }
      if ((action.first_tasks ?? []).length > 0) {
        progress.push(`drafting ${action.first_tasks!.length} first task(s) ✓`);
      }
      return {
        status: "done",
        summary: `created space "${action.title}"`,
        space_id: spaceId,
        task_id: firstTaskId,
        progress,
      };
    }
    case "create_task":
    case "remind":
    case "execute": {
      // USR-02: file into the matching existing space, never a duplicate.
      const space = action.space_hint ? resolveSpace(action.space_hint) : null;
      const taskId = mintId("t");
      // Actions follow task rules (spec §14.8.3): risky work gets a risk
      // class that forces the approval gate; nothing executes from here.
      const riskClass = action.risky || action.verb === "execute" ? "approve-final" : "advise-only";
      db.prepare(
        `INSERT INTO tasks (id, space_id, title, type, risk_class, owner, due, created_by, status)
         VALUES (?, ?, ?, 'explicit', ?, 'self', ?, 'user', 'open')`,
      ).run(taskId, space?.id ?? null, action.title, riskClass, action.due ?? null);
      writeDecision({
        pass: "user",
        targetKind: "task",
        targetId: taskId,
        action: "create",
        new: { title: action.title, space_id: space?.id ?? null, due: action.due ?? null, risk_class: riskClass },
        reason: `user-created via grounded bar (${action.verb})`,
      });
      progress.push("creating task ✓");
      const where = space ? ` in ${space.label}` : "";
      const gate = riskClass === "approve-final" ? " — needs your approval to run" : "";
      return {
        status: "done",
        summary: `task "${action.title}"${where}${action.due ? ` · due ${action.due}` : ""}${gate}`,
        space_id: space?.id,
        task_id: taskId,
        progress,
      };
    }
    default:
      return {
        status: "failed",
        summary: "couldn't work out what to do with that",
        progress,
      };
  }
}

export async function handleAction(
  text: string,
  actionCall: BarModelCall = actionViaModel,
  now: Date = new Date(),
  ctx: BarActionContext = {},
): Promise<BarActionOutcome> {
  // Sweep first (USR-01): the parse sees what already exists, so its plan
  // builds on the user's history instead of an empty shell.
  const sweep = handleSearch(text, 6).events;
  const packed = packActionInput({
    text,
    today: now.toISOString().slice(0, 10),
    spaces: activeSpaces(),
    sweep: sweep.map((h) => `[evt ${h.id}] ${h.ts ?? ""} ${h.actor ?? ""}: ${h.snippet}`),
  });
  let raw: string;
  try {
    raw = await actionCall(packed);
  } catch {
    return { status: "failed", summary: "couldn't reach the model", progress: [] };
  }
  const parsed = parseActionOutput(raw);
  if (!parsed) {
    return { status: "failed", summary: "couldn't work out what to do with that", progress: [] };
  }
  return applyAction(parsed, sweep, { utterance: text, threadId: ctx.threadId ?? null });
}

/** The ask-once answer path: the user tapped a space — apply the held parse. */
export function applyPendingAction(
  pending: ParsedBarAction,
  spaceId: string,
  ctx: BarActionContext = {},
): BarActionOutcome {
  return applyAction({ ...pending, space_hint: spaceId, space_candidates: undefined }, [], ctx);
}
