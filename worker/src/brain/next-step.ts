// ===========================================================================
// The NEXT-STEP pass (build P3.1, spec §11.3) — follow-ups on closure.
//
// Two triggers, one pass:
//   (a) executor completion — the executor (P3.3) calls
//       noteExecutorCompletion(taskId) when a run self-closes its task;
//   (b) closure detection — decide-pass enqueues when a closure it applied
//       saw the USER complete something (outcome 'done').
//
// The trigger writes a durable `deferred_outputs` row (kind 'next_step') so
// a crash between closure and pass loses nothing; drainNextStepQueue runs
// the model call later, OUTSIDE the closing transaction. Output: 1–2 next
// tasks with a visible "because:" spine, applied through decide-apply — the
// same code-side auto/confirm policy as every other schedule (FUP-04).
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { FOLLOWUP_V1_SYSTEM, validateFollowupOutput, type FollowupOutput } from "../prompts/followup.v1.js";
import { applyFollowups, emptyScheduleCounts, type ScheduleApplyCounts } from "./decide-apply.js";
import { runJsonPass, type JsonPassDeps, type JsonPassResult } from "./llm.js";
import { packSpaceState } from "./thin-pack.js";

export type NextStepTrigger = "executor_completion" | "closure";

export interface NextStepResult {
  status: JsonPassResult<FollowupOutput>["status"];
  counts: ScheduleApplyCounts;
  runIds: string[];
  error?: { code: string; message: string };
}

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

/**
 * Record that a task's closure wants a next-step pass. Durable and deduped:
 * one pending trigger per task. Returns true when a new trigger was written.
 */
export function enqueueNextStep(taskId: string, trigger: NextStepTrigger): boolean {
  const db = getDb();
  const task = db.prepare(`SELECT space_id FROM tasks WHERE id = ?`).get(taskId) as
    | { space_id: string | null }
    | undefined;
  if (!task || task.space_id === null) return false; // no space, no plan to follow
  const pending = db
    .prepare(
      `SELECT id FROM deferred_outputs
        WHERE task_id = ? AND kind = 'next_step' AND status = 'deferred'`,
    )
    .get(taskId) as { id: string } | undefined;
  if (pending) return false;
  db.prepare(
    `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, created_by)
     VALUES (?, ?, ?, 'next_step', ?, 'next_step')`,
  ).run(mintId("def"), task.space_id, taskId, JSON.stringify({ taskId, trigger }));
  return true;
}

/** The executor's seam (spec §11.3 trigger a): call when a run self-closes. */
export function noteExecutorCompletion(taskId: string): boolean {
  return enqueueNextStep(taskId, "executor_completion");
}

interface ClosedTaskRow {
  id: string;
  space_id: string | null;
  title: string;
  category: string | null;
  status: string;
  closed_at: string | null;
}

/**
 * One next-step call for one closed task: pack the space plan + chapter state
 * + what closed, ask for the 1–2 most helpful next tasks, apply them through
 * the policy-gated appliers. Deterministic around the model: unit tests stub
 * the provider; live behaviour is FUP-01…05's business.
 */
export async function runNextStepPass(
  taskId: string,
  trigger: NextStepTrigger,
  deps: JsonPassDeps = {},
): Promise<NextStepResult> {
  const counts = emptyScheduleCounts();
  const db = getDb();
  const task = db
    .prepare(`SELECT id, space_id, title, category, status, closed_at FROM tasks WHERE id = ?`)
    .get(taskId) as ClosedTaskRow | undefined;
  if (!task || task.space_id === null) {
    return {
      status: "failed",
      counts,
      runIds: [],
      error: { code: "no_task", message: `task ${taskId} has no space or does not exist` },
    };
  }
  const space = packSpaceState(task.space_id);
  if (!space) {
    return {
      status: "failed",
      counts,
      runIds: [],
      error: { code: "no_space", message: `space ${task.space_id} does not exist` },
    };
  }
  const user = [
    space.text,
    "",
    "CLOSED TASK (the trigger):",
    JSON.stringify({
      id: task.id,
      title: task.title,
      category: task.category,
      status: task.status,
      closed_at: task.closed_at,
      trigger,
    }),
  ].join("\n");

  const result = await runJsonPass<FollowupOutput>(
    {
      pass: "followup",
      system: FOLLOWUP_V1_SYSTEM,
      user,
      role: "decide",
      cohortId: null,
      unit: { kind: "next_step", id: taskId },
      validate: validateFollowupOutput,
    },
    deps,
  );
  if (result.output === undefined) {
    return {
      status: result.status,
      counts,
      runIds: result.runIds,
      ...(result.error ? { error: result.error } : {}),
    };
  }
  const runId = result.runIds.length > 0 ? result.runIds[result.runIds.length - 1] : null;
  const now = deps.now?.() ?? new Date();
  applyFollowups(task.space_id, result.output.followups, runId, counts, now, "next_step");
  return { status: result.status, counts, runIds: result.runIds };
}

/**
 * Drain pending next-step triggers, oldest first. A trigger is consumed
 * (status 'activated') only after its pass ran to a usable status; a failed
 * run leaves the row deferred for the next drain.
 */
export async function drainNextStepQueue(
  deps: JsonPassDeps = {},
  limit = 4,
): Promise<{ taskId: string; result: NextStepResult }[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, task_id, payload_json FROM deferred_outputs
        WHERE kind = 'next_step' AND status = 'deferred'
        ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as { id: string; task_id: string | null; payload_json: string }[];
  const out: { taskId: string; result: NextStepResult }[] = [];
  for (const row of rows) {
    if (row.task_id === null) {
      // The task was deleted out from under the trigger (ON DELETE SET NULL)
      // — unrunnable forever, retire instead of spinning.
      db.prepare(
        `UPDATE deferred_outputs
            SET status = 'dismissed', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'deferred'`,
      ).run(row.id);
      let lostTaskId = "(deleted)";
      try {
        const p = JSON.parse(row.payload_json) as { taskId?: unknown };
        if (typeof p.taskId === "string") lostTaskId = p.taskId;
      } catch {
        /* keep the placeholder */
      }
      out.push({
        taskId: lostTaskId,
        result: {
          status: "failed",
          counts: emptyScheduleCounts(),
          runIds: [],
          error: { code: "no_task", message: "trigger's task was deleted" },
        },
      });
      continue;
    }
    let trigger: NextStepTrigger = "closure";
    try {
      const p = JSON.parse(row.payload_json) as { trigger?: unknown };
      if (p.trigger === "executor_completion") trigger = "executor_completion";
    } catch {
      /* default trigger */
    }
    const result = await runNextStepPass(row.task_id, trigger, deps);
    if (result.status === "ok" || result.status === "repaired") {
      db.prepare(
        `UPDATE deferred_outputs
            SET status = 'activated', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'deferred'`,
      ).run(row.id);
    } else if (result.error?.code === "no_task" || result.error?.code === "no_space") {
      // Unrunnable forever — retire rather than spin.
      db.prepare(
        `UPDATE deferred_outputs
            SET status = 'dismissed', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'deferred'`,
      ).run(row.id);
    }
    out.push({ taskId: row.task_id, result });
  }
  return out;
}
