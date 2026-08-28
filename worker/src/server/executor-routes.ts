// ===========================================================================
// Task run + approval routes (build P3.5, spec §14.6 / §11.4).
//
// The glue between the task modal's live states and the executor/approval
// machinery. Four routes under /api/tasks/:id:
//
//   GET  /run      → task row + the latest run's envelope (parsed from
//                    result_ref) — the modal's live generative result region,
//                    question card and approval card all read this one shape.
//   POST /execute  → run the executor for this task (optionally carrying an
//                    approval token for gated tools). Refused with 409 while
//                    the task is already executing — the double-fire guard.
//   POST /answer   → a question card's reply: recorded as evidence + a
//                    decisions row, task reopened so the next run sees it.
//   POST /send     → the approval modal's ONLY path to the WhatsApp send:
//                    the draft comes from the stored run envelope (never from
//                    the client — the token authorizes exactly what the modal
//                    displayed), Ingestion.sendMessage consumes the single-use
//                    token (invalid/used ⇒ 403, adapter never called), and a
//                    receipt envelope + done status land on the task.
//
// The approval token itself is minted by POST /api/approvals/mint
// (whatsapp-routes.ts) when the user taps Approve — spec §14.6: "the approve
// button is the ONLY path to the risky step; tapping mints the token".
// ===========================================================================

import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import type { Ingestion } from "../ingest/index.js";
import {
  defaultToolRegistry,
  runExecutorTask,
  taskWorkspaceDir,
  type ExecutorEnvelope,
  type ExecutorRunDeps,
  type ToolRegistry,
} from "../executor/index.js";
import { registerBrowserTools } from "../browser/index.js";
import type { BrowserHarness } from "../browser/harness.js";

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const TASK_PATH = /^\/api\/tasks\/([^/]+)\/(run|execute|answer|send)$/;

interface DbTaskRow {
  id: string;
  space_id: string | null;
  chapter_id: string | null;
  title: string;
  category: string | null;
  risk_class: string;
  owner: string | null;
  status: string;
  due: string | null;
  evidence_json: string | null;
  result_ref: string | null;
  confidence: number | null;
}

function loadTask(id: string): DbTaskRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, space_id, chapter_id, title, category, risk_class, owner,
              status, due, evidence_json, result_ref, confidence
       FROM tasks WHERE id = ?`,
    )
    .get(id) as DbTaskRow | undefined;
}

/** The stored run file a task's result_ref points at (session.ts writes it). */
interface StoredRun {
  run_id: string;
  envelope: ExecutorEnvelope;
  invocations: { tool: string; input?: string; status: string; detail?: string; at?: string }[];
}

/** Parse the task's latest run defensively — a missing/garbled file is null. */
export function readTaskRun(task: DbTaskRow): StoredRun | null {
  if (!task.result_ref) return null;
  try {
    const parsed = JSON.parse(readFileSync(task.result_ref, "utf8")) as StoredRun;
    if (!parsed || typeof parsed !== "object" || !parsed.envelope) return null;
    return {
      run_id: typeof parsed.run_id === "string" ? parsed.run_id : "",
      envelope: parsed.envelope,
      invocations: Array.isArray(parsed.invocations)
        ? parsed.invocations.map((i) => ({ tool: i.tool, status: i.status }))
        : [],
    };
  } catch {
    return null;
  }
}

/** The one shape every modal state reads. */
function runView(task: DbTaskRow): { task: DbTaskRow; run: StoredRun | null } {
  return { task, run: readTaskRun(task) };
}

// ---------------------------------------------------------------------------
// Deps (tests inject a stubbed provider; index.ts passes nothing)
// ---------------------------------------------------------------------------

/**
 * The shape of BrowserManager this route needs (structural — routes.ts's
 * singleton satisfies it; tests pass a fake). Kept minimal so executor-routes
 * never launches Chromium itself: `available` is a cheap staged-binary check,
 * and `ensure()` is only entered when it is true.
 */
export interface BrowserToolSource {
  readonly available: boolean;
  ensure(): { harness: BrowserHarness };
}

export interface ExecutorRouteDeps {
  /** Forwarded into runExecutorTask — tests stub the provider here. */
  executor?: ExecutorRunDeps;
  /**
   * When provided AND available, the executor session's registry is the
   * default tool table PLUS the browser tool surface (P3.4 seam: browser
   * tools ride the same invokeTool choke point). An explicit
   * deps.executor.registry always wins — tests keep full control.
   */
  browser?: BrowserToolSource | null;
  nowMs?: number;
}

/**
 * Build the registry for one /execute run: the injected registry verbatim if
 * the caller supplied one; otherwise the default table, augmented with the
 * browser tools when a browser is available. A browser launch failure never
 * fails the run — the session simply gets no browser tools.
 */
export function executeRegistryFor(deps: ExecutorRouteDeps): ToolRegistry | undefined {
  if (deps.executor?.registry) return deps.executor.registry;
  if (!deps.browser?.available) return undefined;
  try {
    const { harness } = deps.browser.ensure();
    const registry = defaultToolRegistry();
    registerBrowserTools(registry, harness);
    return registry;
  } catch {
    return undefined; // browser could not launch — run without browser tools
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle one /api/tasks/:id/* request. Returns true if handled.
 * `ingestion` may be null (no WhatsApp adapter) — /send answers 503 then.
 */
export async function handleExecutorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ingestion: Ingestion | null,
  deps: ExecutorRouteDeps = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = TASK_PATH.exec(url.pathname);
  if (!match) return false;
  const method = req.method ?? "GET";
  const taskId = decodeURIComponent(match[1]);
  const action = match[2];

  const task = loadTask(taskId);
  if (!task) {
    sendJson(res, 404, { error: `unknown task ${JSON.stringify(taskId)}` });
    return true;
  }

  const nowIso = () => new Date(deps.nowMs ?? Date.now()).toISOString();

  // ---- GET /run — the modal's poll target ---------------------------------
  if (method === "GET" && action === "run") {
    sendJson(res, 200, runView(task));
    return true;
  }

  // ---- POST /execute { approval_token? } ----------------------------------
  if (method === "POST" && action === "execute") {
    if (task.status === "executing") {
      sendJson(res, 409, { error: "task is already executing" });
      return true;
    }
    const body = (await readJsonBody(req)) as { approval_token?: unknown } | undefined;
    const approvalToken =
      body && typeof body.approval_token === "string" && body.approval_token.trim()
        ? body.approval_token
        : undefined;
    try {
      const registry = executeRegistryFor(deps);
      const result = await runExecutorTask(taskId, {
        ...(deps.executor ?? {}),
        ...(registry ? { registry } : {}),
        ...(approvalToken ? { approvalToken } : {}),
      });
      sendJson(res, 200, {
        run_id: result.runId,
        task_status: result.taskStatus,
        envelope: result.envelope,
        decision_id: result.decisionId,
      });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  // ---- POST /answer { answer } — the question card ------------------------
  if (method === "POST" && action === "answer") {
    const body = (await readJsonBody(req)) as { answer?: unknown } | undefined;
    const answer = body && typeof body.answer === "string" ? body.answer.trim() : "";
    if (!answer) {
      sendJson(res, 400, { error: "answer required" });
      return true;
    }
    // The answer rides the task's evidence so the NEXT executor session packs
    // it into context (packTaskContext reads evidence_json) — no side channel.
    let evidence: unknown[] = [];
    try {
      const parsed = JSON.parse(task.evidence_json ?? "[]");
      if (Array.isArray(parsed)) evidence = parsed;
    } catch {
      /* start fresh over a garbled column */
    }
    evidence.push({ summary: `you answered: ${answer}` });
    const db = getDb();
    db.prepare(
      `UPDATE tasks SET status = 'open', evidence_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(evidence), nowIso(), taskId);
    const decisionId = writeDecision({
      pass: "executor",
      targetKind: "task",
      targetId: taskId,
      action: "answer",
      old: { status: task.status },
      new: { status: "open", answer },
      reason: "question card answered",
    });
    sendJson(res, 200, { ...runView(loadTask(taskId)!), decision_id: decisionId });
    return true;
  }

  // ---- POST /send { approval_token } — approved WhatsApp draft send -------
  if (method === "POST" && action === "send") {
    if (!ingestion) {
      sendJson(res, 503, { error: "source adapter not initialized" });
      return true;
    }
    const body = (await readJsonBody(req)) as { approval_token?: unknown } | undefined;
    const token =
      body && typeof body.approval_token === "string" ? body.approval_token : "";
    if (!token) {
      sendJson(res, 400, { error: "approval_token required" });
      return true;
    }
    // The draft comes from the STORED run envelope, never the request body:
    // the token authorizes exactly what the approval modal displayed.
    const run = readTaskRun(task);
    const result = run?.envelope.result;
    if (!result || result.result_type !== "draft_preview") {
      sendJson(res, 400, { error: "task has no draft_preview to send" });
      return true;
    }
    const to = typeof result.data.to === "string" ? result.data.to : "";
    const text = typeof result.data.body === "string" ? result.data.body : "";
    const channel = typeof result.data.channel === "string" ? result.data.channel : "";
    if (channel !== "whatsapp" || !to || !text) {
      sendJson(res, 400, { error: "draft is not a sendable whatsapp draft" });
      return true;
    }
    try {
      // Ingestion consumes the single-use token (worker gate) and the daemon
      // refuses independently (P0.6) — this route adds no third gate, it just
      // routes the approved draft into the ONLY send path.
      await ingestion.sendMessage({ to, text, approvalToken: token });
    } catch (err) {
      sendJson(res, 403, { error: (err as Error).message });
      return true;
    }

    // Receipt: the run file gains a done envelope so the modal's result region
    // flips from the draft to the record of what was performed.
    const receiptEnvelope: ExecutorEnvelope = {
      status: "done",
      criteria: run.envelope.criteria,
      attempts: run.envelope.attempts,
      result: {
        result_type: "receipt",
        data: {
          action: "whatsapp.send",
          summary: `sent to ${to}: ${text}`,
          performed_at: nowIso(),
        },
      },
      question: null,
      approval_request: null,
      gaps: [],
      next: run.envelope.next,
    };
    const resultRef = join(taskWorkspaceDir(taskId), "result.json");
    writeFileSync(
      resultRef,
      JSON.stringify(
        { run_id: run.run_id, envelope: receiptEnvelope, invocations: run.invocations },
        null,
        2,
      ),
      "utf8",
    );
    const db = getDb();
    db.prepare(
      `UPDATE tasks SET status = 'done', result_ref = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
    ).run(resultRef, nowIso(), nowIso(), taskId);
    const decisionId = writeDecision({
      pass: "executor",
      runId: run.run_id || null,
      targetKind: "task",
      targetId: taskId,
      action: "approved_send",
      old: { status: task.status },
      new: { status: "done", to },
      reason: "approval modal: token minted on approve, draft sent via whatsapp",
    });
    sendJson(res, 200, { ...runView(loadTask(taskId)!), decision_id: decisionId });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
