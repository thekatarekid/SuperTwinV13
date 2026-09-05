// ===========================================================================
// Schedule + follow-up application (build P3.1, spec §8.4.3/8.4.5, §11.2–11.3).
//
// P1 held these outputs in `deferred_outputs`; P3 activates them. This module
// is the ONLY place a model-emitted schedule or follow-up becomes rows, and
// every path goes through `evaluateSchedulePolicy` (scheduler/schedule-policy)
// — the auto-vs-confirm decision is a CODE check on the pass output:
//
//   auto    → task.schedule_json {mode:"auto"} + status 'scheduled' (the
//             timer service fires it) + an announce decision row.
//   confirm → task.schedule_json {mode:"confirm", proposed:true}; the task
//             stays where it was — a suggestion card, never a silent start.
//   reject  → a decisions row only (e.g. SCH-06 past fire time).
//
// A schedule that cannot be matched to a task creates a conservative carrier
// task (advise-only ⇒ the policy can never say auto for it). Follow-ups are
// tasks with a visible "because:" spine (FUP-05), capped at 2 per trigger
// (FUP-01 followup-flood), deduped by open title, and their inline schedules
// obey the exact same policy (FUP-04). Everything writes decision rows and is
// mutation-idempotent: a re-run over identical state changes nothing.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { RISK_CLASSES } from "../prompts/decide.v1.js";
import type { DecideFollowupV8, DecideScheduleV8 } from "../prompts/decide.v8.js";
import {
  evaluateSchedulePolicy,
  normalizePolling,
  type PollingSpec,
} from "../scheduler/v6/schedule-policy.js";

/** Follow-up proposals cap per trigger (spec §11.3: "1–2 most helpful"). */
export const FOLLOWUPS_PER_TRIGGER = 2;

export interface ScheduleApplyCounts {
  schedulesAuto: number;
  schedulesProposed: number;
  schedulesRejected: number;
  schedulesSkipped: number;
  followupsCreated: number;
  followupsSkipped: number;
}

export function emptyScheduleCounts(): ScheduleApplyCounts {
  return {
    schedulesAuto: 0,
    schedulesProposed: 0,
    schedulesRejected: 0,
    schedulesSkipped: 0,
    followupsCreated: 0,
    followupsSkipped: 0,
  };
}

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

interface TaskRow {
  id: string;
  title: string;
  risk_class: string;
  status: string;
  due: string | null;
  confidence: number | null;
  schedule_json: string | null;
}

function findTask(spaceId: string, ref: string): TaskRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, title, risk_class, status, due, confidence, schedule_json FROM tasks
        WHERE space_id = ? AND (id = ? OR LOWER(title) = LOWER(?))
          AND status NOT IN ('done','cancelled','dismissed')`,
    )
    .get(spaceId, ref, ref) as TaskRow | undefined;
}

/** The persisted task.schedule_json shape (spec §11.1). */
export interface ScheduleJson {
  fire_at: string | null;
  recurrence: string | null;
  mode: "auto" | "confirm";
  source: "inferred" | "user";
  polling: PollingSpec | null;
  reason: string | null;
  /** Present (true) while a confirm-mode schedule awaits the user. */
  proposed?: boolean;
  /** Set by the timer service when this schedule's fire was consumed. */
  fired_at?: string;
  /** Set by the timer service: this fire executed past its window start. */
  late?: boolean;
  /** Poll fires consumed so far (timer service bookkeeping). */
  polls_done?: number;
}

/**
 * Apply one schedule candidate to a KNOWN task row. Returns what happened.
 * Idempotent: a task that already carries a schedule_json is skipped.
 */
export function applyScheduleToTask(
  task: TaskRow,
  sched: DecideScheduleV8,
  runId: string | null,
  counts: ScheduleApplyCounts,
  now: Date,
  createdBy: string,
): "auto" | "confirm" | "reject" | "skip" {
  if (task.schedule_json !== null) {
    counts.schedulesSkipped += 1;
    return "skip";
  }
  const verdict = evaluateSchedulePolicy({
    requestedMode: sched.mode,
    riskClass: task.risk_class,
    confidence: sched.confidence ?? task.confidence ?? 0,
    fireAt: sched.fire_at ?? null,
    recurrence: sched.recurrence ?? null,
    now,
  });
  if (verdict.decision === "reject") {
    writeDecision({
      runId,
      pass: createdBy,
      targetKind: "task",
      targetId: task.id,
      action: "reject_schedule",
      old: null,
      new: { fireAt: sched.fire_at ?? null, recurrence: sched.recurrence ?? null },
      reason: verdict.reasons.join("; "),
    });
    counts.schedulesRejected += 1;
    return "reject";
  }
  const db = getDb();
  const scheduleJson: ScheduleJson = {
    fire_at: verdict.fireAt !== null ? verdict.fireAt.toISOString() : null,
    recurrence: sched.recurrence ?? null,
    mode: verdict.decision,
    source: "inferred",
    polling: normalizePolling(sched.polling),
    reason: sched.reason ?? null,
    ...(verdict.decision === "confirm" ? { proposed: true } : {}),
  };
  const status = verdict.decision === "auto" ? "scheduled" : task.status;
  db.prepare(
    `UPDATE tasks SET schedule_json = ?, status = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(JSON.stringify(scheduleJson), status, task.id);
  writeDecision({
    runId,
    pass: createdBy,
    targetKind: "task",
    targetId: task.id,
    action: verdict.decision === "auto" ? "schedule" : "propose_schedule",
    old: { status: task.status, scheduleJson: null },
    new: {
      status,
      scheduleJson,
      ...(verdict.decision === "auto"
        ? { announce: `Scheduled: ${task.title} ${scheduleJson.fire_at ?? ""} — tap to change` }
        : {}),
    },
    reason: verdict.reasons.join("; "),
  });
  if (verdict.decision === "auto") counts.schedulesAuto += 1;
  else counts.schedulesProposed += 1;
  return verdict.decision;
}

/**
 * Apply one schedule candidate by task REFERENCE (id or exact title) within a
 * space. An unmatched reference gets a conservative advise-only carrier task
 * — unknown risk can never be auto — created ONLY when the policy would keep
 * the candidate at all (never for a reject).
 */
export function applySchedule(
  spaceId: string,
  sched: DecideScheduleV8,
  runId: string | null,
  counts: ScheduleApplyCounts,
  now: Date,
  createdBy = "decide",
): void {
  const existing = findTask(spaceId, sched.task);
  if (existing) {
    applyScheduleToTask(existing, sched, runId, counts, now, createdBy);
    return;
  }
  // Probe the policy with unknown risk before minting a carrier row.
  const probe = evaluateSchedulePolicy({
    requestedMode: sched.mode,
    riskClass: null,
    confidence: sched.confidence ?? 0,
    fireAt: sched.fire_at ?? null,
    recurrence: sched.recurrence ?? null,
    now,
  });
  if (probe.decision === "reject") {
    writeDecision({
      runId,
      pass: createdBy,
      targetKind: "schedule_candidate",
      targetId: `sched:${sched.task}`,
      action: "reject_schedule",
      old: null,
      new: { task: sched.task, fireAt: sched.fire_at ?? null },
      reason: probe.reasons.join("; "),
    });
    counts.schedulesRejected += 1;
    return;
  }
  const id = mintId("tsk");
  getDb()
    .prepare(
      `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner,
                          evidence_json, created_by, confidence)
       VALUES (?, ?, ?, 'implicit', 'scheduling', 'advise-only', 'self', '[]', ?, ?)`,
    )
    .run(id, spaceId, sched.task, createdBy, sched.confidence ?? 0.5);
  writeDecision({
    runId,
    pass: createdBy,
    targetKind: "task",
    targetId: id,
    action: "create",
    old: null,
    new: { spaceId, title: sched.task, type: "implicit", riskClass: "advise-only" },
    reason: "carrier task for an unmatched schedule candidate (risk unknown → conservative)",
  });
  const carrier = findTask(spaceId, id);
  if (carrier) applyScheduleToTask(carrier, sched, runId, counts, now, createdBy);
}

/**
 * Apply follow-up proposals for a space: at most FOLLOWUPS_PER_TRIGGER tasks,
 * each with its "because:" provenance in evidence (FUP-05), deduped by open
 * title (a re-proposed follow-up is a no-op), inline schedules through the
 * same policy gate.
 */
export function applyFollowups(
  spaceId: string,
  followups: readonly DecideFollowupV8[],
  runId: string | null,
  counts: ScheduleApplyCounts,
  now: Date,
  createdBy = "decide_followup",
): void {
  const db = getDb();
  let created = 0;
  for (const f of followups) {
    if (created >= FOLLOWUPS_PER_TRIGGER) {
      counts.followupsSkipped += 1;
      continue;
    }
    const open = db
      .prepare(
        `SELECT id FROM tasks
          WHERE space_id = ? AND LOWER(title) = LOWER(?)
            AND status NOT IN ('done','cancelled','dismissed')`,
      )
      .get(spaceId, f.title) as { id: string } | undefined;
    if (open) {
      counts.followupsSkipped += 1;
      continue;
    }
    const risk = (RISK_CLASSES as readonly string[]).includes(f.risk_class ?? "")
      ? (f.risk_class as string)
      : "advise-only";
    const because = f.because ?? null;
    const id = mintId("tsk");
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, due,
                          evidence_json, created_by, confidence)
       VALUES (?, ?, ?, 'suggested', ?, ?, 'self', ?, ?, ?, ?)`,
    ).run(
      id,
      spaceId,
      f.title,
      f.category ?? null,
      risk,
      f.due ?? null,
      JSON.stringify(because === null ? [] : [{ event_ids: [], quote: `because: ${because}` }]),
      createdBy,
      f.confidence ?? 0.6,
    );
    writeDecision({
      runId,
      pass: createdBy,
      targetKind: "task",
      targetId: id,
      action: "create_followup",
      old: null,
      new: { spaceId, title: f.title, riskClass: risk, due: f.due ?? null },
      reason: because,
      confidence: f.confidence ?? 0.6,
    });
    counts.followupsCreated += 1;
    created += 1;
    if (f.schedule) {
      const row = findTask(spaceId, id);
      if (row) applyScheduleToTask(row, f.schedule, runId, counts, now, createdBy);
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred-output replay (the P1 pen opens)
// ---------------------------------------------------------------------------

export interface ReplayReport {
  replayed: number;
  counts: ScheduleApplyCounts;
}

/**
 * Activate every schedule/follow-up the P1 Decide pass held in
 * `deferred_outputs`: replay each payload through the live appliers (same
 * policy gate — a stale fire time rejects cleanly) and mark the row
 * 'activated'. Safe to call repeatedly; consumed rows never replay twice.
 */
export function replayDeferredOutputs(now: Date = new Date()): ReplayReport {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, space_id, kind, payload_json FROM deferred_outputs
        WHERE status = 'deferred' AND kind IN ('schedule','followup')
        ORDER BY created_at`,
    )
    .all() as { id: string; space_id: string | null; kind: string; payload_json: string }[];
  const counts = emptyScheduleCounts();
  let replayed = 0;
  for (const row of rows) {
    if (row.space_id !== null) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        payload = null;
      }
      if (typeof payload === "object" && payload !== null) {
        const p = payload as Record<string, unknown>;
        if (row.kind === "schedule" && typeof p.task === "string") {
          applySchedule(
            row.space_id,
            {
              task: p.task,
              fire_at: typeof p.fire_at === "string" ? p.fire_at : null,
              recurrence: typeof p.recurrence === "string" ? p.recurrence : null,
              mode: p.mode === "auto" ? "auto" : "confirm",
              reason: typeof p.reason === "string" ? p.reason : null,
            },
            null,
            counts,
            now,
            "deferred_replay",
          );
        } else if (row.kind === "followup" && typeof p.title === "string") {
          applyFollowups(
            row.space_id,
            [{ title: p.title, because: typeof p.because === "string" ? p.because : null }],
            null,
            counts,
            now,
            "deferred_replay",
          );
        }
      }
    }
    db.prepare(
      `UPDATE deferred_outputs
          SET status = 'activated', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'deferred'`,
    ).run(row.id);
    replayed += 1;
  }
  return { replayed, counts };
}
