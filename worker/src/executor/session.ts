// ===========================================================================
// Executor session runner (build P3.3, spec §11.4).
//
// One task = one Claude Code session via the claude-local CLI adapter, WITH
// tools this time: the registry's names go on --allowedTools and the session
// gets a --max-turns budget. The protocol lives in the executor.v1 prompt
// (criteria first, verify each cycle, attempt log, replan); THIS module owns
// what the prompt cannot be trusted with:
//
//   - TRACED, ALWAYS: the whole run sits in withTraceContext, so the provider
//     records every CLI invocation (TRC-01) and the parse is annotated back.
//   - TOOL CHOKE POINT: every tool_use event dispatches through
//     tools.invokeTool(), where gated tools refuse without a consumed
//     single-use approval token (EXE-04, risky_without_token = 0). Refusals
//     are recorded in the invocation log, never silently swallowed.
//   - SCHEMA ON EMIT: the final {result_type, data} passes emitResult() or is
//     downgraded to an honest partial with the validation errors as gaps.
//   - NEVER SILENT DEATH: budget exhaustion, transport errors and unparseable
//     finals all synthesize a best-partial checklist from the attempt log and
//     park the task at needs_input (EXE-05) — a run always leaves a result,
//     a status and a decisions row behind.
// ===========================================================================

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  ProviderSelectionError,
  requireMaxOutputTokens,
  resolveModelCall,
} from "../providers/selection.js";
import type { Provider, ProviderStreamEvent, ProviderV2, Usage } from "../providers/types.js";
import { annotateTrace, withTraceContext } from "../traces/context.js";
import { extractJson, stableSystemPrompt } from "../brain/llm.js";
import { reasoningRequestForResolvedCall } from "../brain/reasoning.js";
import {
  DEFAULT_EXECUTOR_BUDGET,
  EXECUTOR_V1,
  executorSystemPrompt,
  type ExecutorBudget,
} from "../prompts/executor.v1.js";
import { emitResult, ResultSchemaError, type ExecutorResult } from "./schemas.js";
import {
  defaultToolRegistry,
  GatedToolRefusedError,
  invokeTool,
  taskWorkspaceDir,
  type ToolInvocation,
  type ToolRegistry,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Envelope — the session's machine-readable final message
// ---------------------------------------------------------------------------

export type EnvelopeStatus = "done" | "needs_input" | "needs_approval" | "partial";

export interface AttemptEntry {
  approach: string;
  outcome: string;
}

export interface ExecutorEnvelope {
  status: EnvelopeStatus;
  criteria: string[];
  attempts: AttemptEntry[];
  result: ExecutorResult | null;
  question: string | null;
  approval_request: string | null;
  gaps: string[];
  next: string | null;
}

const ENVELOPE_STATUSES: readonly EnvelopeStatus[] = [
  "done",
  "needs_input",
  "needs_approval",
  "partial",
];

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Parse + normalize the final message into an envelope, enforcing the
 * protocol's structural rules. Returns null when nothing usable parsed
 * (→ best-partial path). The rules enforced here, not just prompted:
 *   - needs_input requires a question; needs_approval an approval_request.
 *   - a result, when present, must pass its schema (validated on emit) — a
 *     schema failure downgrades to partial with the errors as gaps.
 */
export function parseEnvelope(text: string): ExecutorEnvelope | null {
  const parsed = extractJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!ENVELOPE_STATUSES.includes(obj.status as EnvelopeStatus)) return null;
  let status = obj.status as EnvelopeStatus;

  const attemptsRaw = Array.isArray(obj.attempts) ? obj.attempts : [];
  const attempts: AttemptEntry[] = attemptsRaw
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => ({
      approach: typeof a.approach === "string" ? a.approach : "",
      outcome: typeof a.outcome === "string" ? a.outcome : "",
    }));

  let result: ExecutorResult | null = null;
  const gaps = strArray(obj.gaps);
  if (obj.result !== null && obj.result !== undefined) {
    try {
      result = emitResult(obj.result);
    } catch (err) {
      if (err instanceof ResultSchemaError) {
        // An invalid result is DROPPED, and only "done" is demoted by it —
        // done without a typed result is fake completion. needs_approval /
        // needs_input carry their own required field (approval_request /
        // question, enforced below); their approval card and question render
        // from those fields, so a malformed optional attachment must not
        // demote a legitimate payment-boundary stop to "partial".
        if (status === "done") status = "partial";
        gaps.push(...err.errors.map((e) => `result failed schema validation: ${e}`));
      } else {
        throw err;
      }
    }
  }

  const question = typeof obj.question === "string" && obj.question.trim() ? obj.question : null;
  const approval =
    typeof obj.approval_request === "string" && obj.approval_request.trim()
      ? obj.approval_request
      : null;

  // Structural protocol rules (code, not prompt):
  if (status === "needs_input" && !question) {
    status = "partial";
    gaps.push("session paused for input but emitted no question");
  }
  if (status === "needs_approval" && !approval) {
    status = "partial";
    gaps.push("session requested approval but did not state what will happen");
  }
  if (status === "done" && !result) {
    status = "partial";
    gaps.push("session claimed done without a typed result");
  }

  return {
    status,
    criteria: strArray(obj.criteria),
    attempts,
    result,
    question,
    approval_request: approval,
    gaps,
    next: typeof obj.next === "string" && obj.next.trim() ? obj.next : null,
  };
}

/** EXE-05: synthesize an honest best-partial from whatever the run left. */
export function bestPartialEnvelope(
  reason: string,
  invocations: ToolInvocation[],
  partialText: string,
): ExecutorEnvelope {
  const items = invocations.map((inv) => ({
    label: `${inv.tool}: ${inv.input.slice(0, 80)}`,
    state: inv.status === "ok" ? "done" : "blocked",
  }));
  if (items.length === 0) {
    items.push({ label: "no tool progress recorded", state: "blocked" });
  }
  return {
    status: "partial",
    criteria: [],
    attempts: [{ approach: "session transcript (truncated)", outcome: partialText.slice(-500) }],
    result: {
      result_type: "checklist",
      data: { title: "Best partial before stop", items },
    },
    question: null,
    approval_request: null,
    gaps: [reason],
    next: null,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  space_id: string | null;
  title: string;
  category: string | null;
  risk_class: string;
  status: string;
  due: string | null;
  evidence_json: string | null;
}

export interface ExecutorRunDeps {
  /** Exact test seam; production resolves the active provider from settings. */
  provider?: ProviderV2 | Provider;
  registry?: ToolRegistry;
  budget?: ExecutorBudget;
  /** Single-use approval token forwarded to gated tool invocations. */
  approvalToken?: string;
  timeoutMs?: number;
  newId?: () => string;
  nowMs?: number;
  signal?: AbortSignal;
}

export interface ExecutorRunResult {
  taskId: string;
  runId: string;
  /** Final task status written to the tasks row. */
  taskStatus: string;
  envelope: ExecutorEnvelope;
  invocations: ToolInvocation[];
  usage: Usage;
  workspaceDir: string;
  decisionId: string;
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
};

const PROVIDER_HARD_STOPS = new Set([
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "PROVIDER_UNAVAILABLE",
  "BACKEND_UNSUPPORTED",
  "BUDGET_EXCEEDED",
  "MODEL_ACTIVITY_PAUSED",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function providerFailure(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: provider call was refused`), { code });
}

/** Map an envelope status to the tasks.status vocabulary (spec §11.1). */
export function taskStatusFor(status: EnvelopeStatus): string {
  switch (status) {
    case "done":
      return "done";
    case "needs_input":
      return "needs_input";
    case "needs_approval":
      return "needs_approval";
    case "partial":
      return "needs_input"; // parked, visible, reopenable — never silent
  }
}

function loadTask(taskId: string): TaskRow {
  const row = getDb()
    .prepare(
      `SELECT id, space_id, title, category, risk_class, status, due, evidence_json
       FROM tasks WHERE id = ?`,
    )
    .get(taskId) as TaskRow | undefined;
  if (!row) throw new Error(`executor: no such task "${taskId}"`);
  return row;
}

/** Pack the task + its space header as the session's user message. */
export function packTaskContext(task: TaskRow): string {
  const lines = [
    `TASK ${task.id}`,
    `title: ${task.title}`,
    `category: ${task.category ?? "unknown"}`,
    `risk_class: ${task.risk_class}`,
  ];
  if (task.due) lines.push(`due: ${task.due}`);
  if (task.space_id) {
    const space = getDb()
      .prepare(`SELECT label, goal FROM spaces WHERE id = ?`)
      .get(task.space_id) as { label: string; goal: string | null } | undefined;
    if (space) {
      lines.push(`space: ${space.label}${space.goal ? ` — goal: ${space.goal}` : ""}`);
    }
  }
  if (task.evidence_json) lines.push(`evidence: ${task.evidence_json}`);
  lines.push("", "Use world_model_read for more context before acting.");
  return lines.join("\n");
}

/**
 * Execute ONE task in one tool-enabled Claude Code session.
 * Traced end-to-end; tool_use dispatches through the registry choke point;
 * always terminates in a typed envelope + a task-status write + a decision.
 */
export async function runExecutorTask(
  taskId: string,
  deps: ExecutorRunDeps = {},
): Promise<ExecutorRunResult> {
  const task = loadTask(taskId);
  const budget = deps.budget ?? DEFAULT_EXECUTOR_BUDGET;
  const registry = deps.registry ?? defaultToolRegistry();
  // Keyed per budget variant: the budget line is part of the prompt text, so
  // each variant is its own byte-stable, cacheable prefix (spec §8 posture).
  const system = stableSystemPrompt(
    `${EXECUTOR_V1.pass}:${budget.maxTurns}c$${budget.costUsd}`,
    executorSystemPrompt(budget),
  );
  const promptVersion = createHash("sha1").update(system).digest("hex").slice(0, 12);
  const injected = deps.provider && "catalogue" in deps.provider
    ? deps.provider as ProviderV2
    : undefined;
  if (deps.provider && !injected) {
    throw new ProviderSelectionError(
      "PROVIDER_UNAVAILABLE",
      "legacy provider injection is not accepted by the provider-neutral executor",
      { key: EXECUTOR_V1.pass },
    );
  }
  const resolved = resolveModelCall(
    { source: "step", key: EXECUTOR_V1.pass },
    injected ? { provider: injected } : {},
  );
  const maxOutputTokens = requireMaxOutputTokens(resolved);
  if (
    !resolved.provider.capabilities.hostTools ||
    !resolved.modelSnapshot.supportsHostTools ||
    !resolved.modelSnapshot.inputModalities.includes("text")
  ) {
    throw new ProviderSelectionError(
      "CAPABILITY_UNSUPPORTED",
      `model ${resolved.model} cannot perform the executor's required host-tool call`,
      {
        providerId: resolved.providerId,
        key: resolved.key,
        model: resolved.model,
      },
    );
  }

  return withTraceContext(
    { pass: EXECUTOR_V1.pass, caller: "executor/session", promptVersion },
    async () => {
      const runId = (deps.newId ?? randomUUID)();
      const workspaceDir = taskWorkspaceDir(task.id);
      const db = getDb();
      const nowIso = () => new Date(deps.nowMs ?? Date.now()).toISOString();

      db.prepare(`UPDATE tasks SET status = 'executing', updated_at = ? WHERE id = ?`).run(
        nowIso(),
        task.id,
      );

      const invocations: ToolInvocation[] = [];
      const attemptsLog = join(workspaceDir, "attempts.jsonl");
      const logInvocation = (inv: ToolInvocation) => {
        invocations.push(inv);
        try {
          appendFileSync(attemptsLog, JSON.stringify(inv) + "\n", "utf8");
        } catch {
          /* the in-memory log is authoritative for the run result */
        }
      };

      let finalText = "";
      let usage: Usage = { ...ZERO_USAGE };
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let hardStop: unknown;
      const pendingTools: Promise<void>[] = [];

      const onEvent = (e: ProviderStreamEvent): void => {
        switch (e.type) {
          case "delta":
            finalText += e.text;
            break;
          case "tool_use": {
            // THE choke point: every tool the session reaches for goes through
            // invokeTool, where the gated/token check lives. Refusals are
            // recorded — a risky reach without a token is visible, not fatal
            // to the run (the model is told nothing executed).
            const name = e.name;
            const input = typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? "");
            if (!registry.get(name)) {
              logInvocation({ tool: name, input, status: "error", detail: "unknown tool", at: nowIso() });
              break;
            }
            pendingTools.push(
              invokeTool(registry, name, input, {
                taskId: task.id,
                workspaceDir,
                approvalToken: deps.approvalToken,
                nowMs: deps.nowMs,
              }).then(
                () => logInvocation({ tool: name, input, status: "ok", at: nowIso() }),
                (err) =>
                  logInvocation({
                    tool: name,
                    input,
                    status: err instanceof GatedToolRefusedError ? "refused" : "error",
                    detail: (err as Error).message,
                    at: nowIso(),
                  }),
              ),
            );
            break;
          }
          case "done":
            usage = e.usage;
            stopReason = e.stopReason;
            break;
          case "error":
            errorMessage = `${e.code}: ${e.message}`;
            if (PROVIDER_HARD_STOPS.has(e.code)) hardStop = providerFailure(e.code);
            break;
          default:
            break;
        }
      };

      try {
          const res = await resolved.provider.send({
            runId,
            model: resolved.model,
            instructions: system,
            input: [{
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: packTaskContext(task) }],
            }],
            cwd: workspaceDir,
            hostTools: registry.allowedToolNames(),
            toolChoice: "auto",
            maxOutputTokens,
            maxAgentTurns: budget.maxTurns,
            ...reasoningRequestForResolvedCall(resolved),
            timeoutMs: deps.timeoutMs,
            onEvent,
            signal: deps.signal,
          });
          if (res.status === "error" && !errorMessage) {
            errorMessage = res.errorCode ?? "provider error";
          }
          if (res.errorCode && PROVIDER_HARD_STOPS.has(res.errorCode)) {
            hardStop = providerFailure(res.errorCode);
          }
      } catch (err) {
        if (PROVIDER_HARD_STOPS.has(errorCode(err) ?? "")) hardStop = err;
        else errorMessage = (err as Error).message;
      }
      await Promise.all(pendingTools);
      if (hardStop) {
        db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`).run(
          task.status,
          nowIso(),
          task.id,
        );
        throw hardStop;
      }

      // ---- terminate in an envelope, whatever happened ---------------------
      let envelope = errorMessage ? null : parseEnvelope(finalText);
      if (!envelope) {
        const reason = errorMessage
          ? `session error: ${errorMessage}`
          : stopReason === "max_turns"
            ? `budget exhausted (${budget.maxTurns} turns) before a final envelope`
            : "session ended without a parseable final envelope";
        envelope = bestPartialEnvelope(reason, invocations, finalText);
      }

      const taskStatus = taskStatusFor(envelope.status);
      const resultRef = join(workspaceDir, "result.json");
      writeFileSync(
        resultRef,
        JSON.stringify({ run_id: runId, envelope, invocations }, null, 2),
        "utf8",
      );

      db.prepare(
        `UPDATE tasks SET status = @status, result_ref = @ref, updated_at = @now,
                closed_at = CASE WHEN @status = 'done' THEN @now ELSE closed_at END
         WHERE id = @id`,
      ).run({ status: taskStatus, ref: resultRef, now: nowIso(), id: task.id });

      const decisionId = writeDecision({
        pass: "executor",
        runId,
        targetKind: "task",
        targetId: task.id,
        action: "execute",
        old: { status: task.status, result_ref: null },
        new: { status: taskStatus, result_ref: resultRef, envelope_status: envelope.status },
        reason:
          envelope.status === "partial"
            ? `best partial: ${envelope.gaps.join("; ")}`
            : `executor run ${envelope.status}`,
      });

      annotateTrace({
        parsedResult: {
          task_id: task.id,
          status: envelope.status,
          task_status: taskStatus,
          result_type: envelope.result?.result_type ?? null,
          gaps: envelope.gaps,
          invocations: invocations.map((i) => ({ tool: i.tool, status: i.status })),
        },
      });

      return {
        taskId: task.id,
        runId,
        taskStatus,
        envelope,
        invocations,
        usage,
        workspaceDir,
        decisionId,
      };
    },
  );
}
