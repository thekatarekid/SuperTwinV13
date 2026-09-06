// ===========================================================================
// Closure checks — the "check_at" verdict's code half (V6 P1 S3.7, P-05 rule
// 4, GoldenEvals DEC-03 / SCH-02).
//
// One-sided intent ("paying tonight") is never a closure. Decide emits
// {"verdict":"check_at","check_at":<ISO>}; the pass writes a durable
// `deferred_outputs` row (kind 'closure_check') and the task stays open.
//
// When the check comes due it is a LOOKUP FIRST, never a model call:
//   - new evidence in the space's streams since the check was set → the
//     episodes holding it go back to Decide (enqueueDecide); the model sees
//     the evidence, not a clock.
//   - no new evidence → the "done?" card, written by code as a decisions row
//     (action 'ask_done'), zero calls. `clock_only_call = 0` by construction.
//   - evidence not yet committed to an episode → the check waits for commit.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { enqueueDecide } from "./decide-queue.js";

export const CLOSURE_CHECK_KIND = "closure_check";
/** Default lead when the model says "check_at" without an instant: next morning. */
export const DEFAULT_CHECK_DELAY_MS = 24 * 3_600_000;

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

export interface ClosureCheckPayload {
  taskId: string;
  taskTitle: string;
  spaceId: string;
  /** When the check fires (ISO). */
  checkAt: string;
  /** Evidence newer than this instant counts as "something changed". */
  sinceTs: string;
  reason: string | null;
}

/** Schedule one closure check for an open task. Idempotent per pending task. */
export function scheduleClosureCheck(input: {
  taskId: string;
  spaceId: string;
  taskTitle: string;
  checkAt: string | null;
  now: Date;
  runId: string | null;
  reason?: string | null;
  createdBy?: string;
}): boolean {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT id FROM deferred_outputs
        WHERE task_id = ? AND kind = ? AND status = 'deferred'`,
    )
    .get(input.taskId, CLOSURE_CHECK_KIND) as { id: string } | undefined;
  if (pending) return false;
  const parsed = input.checkAt !== null ? Date.parse(input.checkAt) : NaN;
  const checkAt = Number.isNaN(parsed)
    ? new Date(input.now.getTime() + DEFAULT_CHECK_DELAY_MS).toISOString()
    : new Date(parsed).toISOString();
  const payload: ClosureCheckPayload = {
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    spaceId: input.spaceId,
    checkAt,
    sinceTs: input.now.toISOString(),
    reason: input.reason ?? null,
  };
  db.prepare(
    `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(mintId("def"), input.spaceId, input.taskId, CLOSURE_CHECK_KIND, JSON.stringify(payload), input.createdBy ?? "decide");
  writeDecision({
    runId: input.runId,
    pass: input.createdBy ?? "decide",
    targetKind: "task",
    targetId: input.taskId,
    action: "check_at",
    old: null,
    new: { checkAt, lookupFirst: true },
    reason: input.reason ?? "one-sided intent is not closure; check at the expected time",
  });
  return true;
}

export interface ClosureCheckReport {
  /** Checks that found no new evidence → "done?" card written by code. */
  asked: number;
  /** Checks whose new evidence went back to Decide (episodes enqueued). */
  escalated: number;
  /** Checks with uncommitted new events — left pending for the next tick. */
  waiting: number;
  /** Checks whose task is already closed/deleted — retired. */
  retired: number;
  /** Always 0: a closure check never calls the model itself. */
  modelCalls: 0;
}

interface CheckRow {
  id: string;
  space_id: string | null;
  task_id: string | null;
  payload_json: string;
}

function resolve(db: ReturnType<typeof getDb>, id: string, status: "activated" | "dismissed"): void {
  db.prepare(
    `UPDATE deferred_outputs
        SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'deferred'`,
  ).run(status, id);
}

/**
 * Run every due closure check against the clock given. Pure lookup: reads
 * the space's streams for events newer than the check's anchor and either
 * enqueues Decide or asks the user. Zero model calls, by construction.
 */
export function runClosureChecks(now: Date): ClosureCheckReport {
  const db = getDb();
  const report: ClosureCheckReport = { asked: 0, escalated: 0, waiting: 0, retired: 0, modelCalls: 0 };
  const rows = db
    .prepare(
      `SELECT id, space_id, task_id, payload_json FROM deferred_outputs
        WHERE kind = ? AND status = 'deferred' ORDER BY created_at`,
    )
    .all(CLOSURE_CHECK_KIND) as CheckRow[];
  for (const row of rows) {
    let payload: ClosureCheckPayload | null = null;
    try {
      payload = JSON.parse(row.payload_json) as ClosureCheckPayload;
    } catch {
      payload = null;
    }
    if (payload === null || row.task_id === null || row.space_id === null) {
      resolve(db, row.id, "dismissed");
      report.retired += 1;
      continue;
    }
    if (Date.parse(payload.checkAt) > now.getTime()) continue; // not due

    const task = db
      .prepare(`SELECT id, title, status FROM tasks WHERE id = ?`)
      .get(row.task_id) as { id: string; title: string; status: string } | undefined;
    if (!task || task.status === "done" || task.status === "cancelled" || task.status === "dismissed") {
      resolve(db, row.id, "dismissed");
      report.retired += 1;
      continue;
    }

    // Lookup first: anything new on this space's streams since the check was set?
    const fresh = db
      .prepare(
        `SELECT e.id FROM events e
          WHERE e.stream_id IN (SELECT DISTINCT stream_id FROM episodes WHERE space_id = ? AND stream_id IS NOT NULL)
            AND e.ts > ?
          ORDER BY e.ts LIMIT 200`,
      )
      .all(row.space_id, payload.sinceTs) as { id: string }[];
    // SCH-03: a check slept through fires on wake, with the delay shown.
    const lateByMs = Math.max(0, now.getTime() - Date.parse(payload.checkAt));
    if (fresh.length === 0) {
      writeDecision({
        runId: null,
        pass: "closure_check",
        targetKind: "task",
        targetId: task.id,
        action: "ask_done",
        old: { status: task.status },
        new: {
          card: "done?",
          task: task.title,
          checkAt: payload.checkAt,
          askedAt: now.toISOString(),
          lateByMs,
          modelCalls: 0,
        },
        reason: "closure check fired with nothing new — asking the user, no model call",
      });
      resolve(db, row.id, "activated");
      report.asked += 1;
      continue;
    }
    const ph = fresh.map(() => "?").join(",");
    const episodes = db
      .prepare(
        `SELECT DISTINCT episode_id FROM episode_events
          WHERE event_id IN (${ph})`,
      )
      .all(...fresh.map((f) => f.id)) as { episode_id: string }[];
    if (episodes.length === 0) {
      report.waiting += 1; // captured but not yet committed — Decide cannot see it yet
      continue;
    }
    enqueueDecide(
      row.space_id,
      episodes.map((e) => e.episode_id),
      "live",
    );
    writeDecision({
      runId: null,
      pass: "closure_check",
      targetKind: "task",
      targetId: task.id,
      action: "escalate_check",
      old: { status: task.status },
      new: { episodes: episodes.map((e) => e.episode_id), events: fresh.length, lateByMs },
      reason: "closure check found new evidence — Decide re-runs on the episodes, not on the clock",
    });
    resolve(db, row.id, "activated");
    report.escalated += 1;
  }
  return report;
}
