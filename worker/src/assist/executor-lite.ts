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
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { AssistEvaluation } from "./evaluator.js";
import type { TopicState } from "./gate.js";

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
