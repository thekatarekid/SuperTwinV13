// ===========================================================================
// Closure rules — the code half (V6 P1 S5.2, Product_V6 §11.12.9–13,
// Product_V6_Phase1 §14.3).
//
//   hard evidence closes          → Decide's "done" verdict (decide-pass) or
//                                   the user's own tap here (answerDone).
//   one-sided intent → timed check → brain/closure-check.ts (check_at).
//   past due, no evidence          → the "done?" card, written BY CODE here
//                                   (sweepPastDue): a lookup first — anything
//                                   new on the space's streams goes back to
//                                   Decide instead; nothing new → ask, zero
//                                   calls. Repeated silence → dormant, never
//                                   deleted.
//   cancellation                   → closes as 'cancelled', never 'done'.
//
// Every mutation writes a decisions row. Everything takes `now`.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { enqueueDecide } from "../brain/decide-queue.js";
import { CLOSURE_CHECK_KIND } from "../brain/closure-check.js";
import { enqueueNextStep } from "../brain/next-step.js";
import { DEFAULT_TZ, dueInstant } from "./priority.js";

/** How long a "done?" card stands before the twin may ask again. */
export const ASK_DONE_COOLDOWN_MS = 24 * 3_600_000;
/** Unanswered "done?" cards before a past-due task goes dormant (never deleted). */
export const ASKS_BEFORE_DORMANT = 3;

export interface PastDueReport {
  /** "done?" cards written by code. */
  asked: number;
  /** Tasks whose streams carried new committed evidence → Decide re-runs. */
  escalated: number;
  /** Tasks downgraded to dormant after repeated silence. */
  dormant: number;
  /** Past-due tasks skipped: a card already stands, or a closure check is pending. */
  cooling: number;
  /** Always 0: this sweep never calls the model. */
  modelCalls: 0;
}

interface DueRow {
  id: string;
  space_id: string | null;
  title: string;
  status: string;
  due: string;
  updated_at: string | null;
  created_at: string;
}

function iso(d: Date): string {
  return d.toISOString();
}

/** When a "done?" card was written, by the writer's own clock (else the row's). */
function askedAtOf(row: { created_at: string; new_json: string | null }): number {
  if (row.new_json !== null) {
    try {
      const parsed = JSON.parse(row.new_json) as { askedAt?: unknown };
      if (typeof parsed.askedAt === "string") {
        const ms = Date.parse(parsed.askedAt);
        if (!Number.isNaN(ms)) return ms;
      }
    } catch {
      /* fall through to created_at */
    }
  }
  return Date.parse(row.created_at);
}

/**
 * Past due with no evidence → ask "done?" by code. Lookup first: new committed
 * evidence on the space since the task last moved goes back to Decide (the
 * model sees evidence, never a clock). Idempotent per cooldown window.
 */
export function sweepPastDue(now: Date, tz: string = DEFAULT_TZ): PastDueReport {
  const db = getDb();
  const report: PastDueReport = { asked: 0, escalated: 0, dormant: 0, cooling: 0, modelCalls: 0 };
  const rows = db
    .prepare(
      `SELECT id, space_id, title, status, due, updated_at, created_at FROM tasks
        WHERE status = 'open' AND due IS NOT NULL
        ORDER BY due, rowid`,
    )
    .all() as DueRow[];
  for (const row of rows) {
    const at = dueInstant(row.due, tz);
    if (!at || at.getTime() > now.getTime()) continue; // not past due

    // A pending timed check owns this task's closure question.
    const pendingCheck = db
      .prepare(`SELECT 1 FROM deferred_outputs WHERE task_id = ? AND kind = ? AND status = 'deferred'`)
      .get(row.id, CLOSURE_CHECK_KIND);
    if (pendingCheck) {
      report.cooling += 1;
      continue;
    }
    // Every "done?" card the twin has already written for this task — the
    // past-due sweep's own and the timed check's. `askedAt` inside the row is
    // the pass's OWN clock (created_at is the wall clock and drifts under a
    // pinned fixture clock), so the cooldown is a pure function of `now`.
    const asks = db
      .prepare(
        `SELECT created_at, new_json FROM decisions
          WHERE target_kind = 'task' AND target_id = ? AND action = 'ask_done' AND reversed_at IS NULL
          ORDER BY rowid DESC`,
      )
      .all(row.id) as { created_at: string; new_json: string | null }[];
    const lastAsk = asks[0] ? askedAtOf(asks[0]) : NaN;
    if (!Number.isNaN(lastAsk) && now.getTime() - lastAsk < ASK_DONE_COOLDOWN_MS) {
      report.cooling += 1;
      continue;
    }

    // Lookup first: anything new on the space's streams since the task last moved?
    const since = row.updated_at ?? row.created_at;
    if (row.space_id !== null) {
      const fresh = db
        .prepare(
          `SELECT DISTINCT ee.episode_id FROM events e
             JOIN episode_events ee ON ee.event_id = e.id
            WHERE e.stream_id IN (SELECT DISTINCT stream_id FROM episodes WHERE space_id = ? AND stream_id IS NOT NULL)
              AND e.ts > ?
            LIMIT 50`,
        )
        .all(row.space_id, since) as { episode_id: string }[];
      if (fresh.length > 0) {
        enqueueDecide(row.space_id, fresh.map((f) => f.episode_id), "live");
        writeDecision({
          runId: null,
          pass: "past_due",
          targetKind: "task",
          targetId: row.id,
          action: "escalate_check",
          old: { status: row.status, due: row.due },
          new: { episodes: fresh.map((f) => f.episode_id) },
          reason: "past due with new evidence on the space — Decide re-runs on the episodes, not on the clock",
        });
        report.escalated += 1;
        continue;
      }
    }

    if (asks.length >= ASKS_BEFORE_DORMANT) {
      // Repeated silence downgrades to dormant. Never deletes.
      db.prepare(`UPDATE tasks SET status = 'dormant', updated_at = ? WHERE id = ? AND status = 'open'`).run(iso(now), row.id);
      writeDecision({
        runId: null,
        pass: "past_due",
        targetKind: "task",
        targetId: row.id,
        action: "dormant",
        old: { status: row.status },
        new: { status: "dormant", asks: asks.length },
        reason: `asked "done?" ${asks.length} times with no answer — dormant, reopenable, never deleted`,
      });
      report.dormant += 1;
      continue;
    }

    writeDecision({
      runId: null,
      pass: "past_due",
      targetKind: "task",
      targetId: row.id,
      action: "ask_done",
      old: { status: row.status, due: row.due },
      new: {
        card: "done?",
        task: row.title,
        due: row.due,
        askedAt: iso(now),
        overdueMs: now.getTime() - at.getTime(),
        ask: asks.length + 1,
        modelCalls: 0,
      },
      reason: "past due with nothing new — asking the user, no model call",
    });
    report.asked += 1;
  }
  return report;
}

export type DoneAnswer = "done" | "not_yet" | "cancelled";

export interface AnswerResult {
  ok: boolean;
  status: string | null;
  /** True when a next-step trigger was written (done only). */
  nextStepQueued: boolean;
  error?: string;
}

/**
 * The one-tap answer to a "done?" card (or any open task's row action). The
 * user's word IS hard evidence: done closes, cancelled closes as cancelled
 * (never done), not-yet keeps it open and resets the ask cooldown.
 */
export function answerDone(taskId: string, answer: DoneAnswer, now: Date = new Date(), by = "user"): AnswerResult {
  const db = getDb();
  const task = db.prepare(`SELECT id, title, status, space_id FROM tasks WHERE id = ?`).get(taskId) as
    | { id: string; title: string; status: string; space_id: string | null }
    | undefined;
  if (!task) return { ok: false, status: null, nextStepQueued: false, error: "unknown task" };
  if (task.status === "done" || task.status === "cancelled") {
    return { ok: true, status: task.status, nextStepQueued: false }; // idempotent
  }
  if (answer === "not_yet") {
    writeDecision({
      runId: null,
      pass: by,
      targetKind: "task",
      targetId: task.id,
      action: "answer_not_yet",
      old: { status: task.status },
      new: { status: task.status, askedAgainAfter: iso(new Date(now.getTime() + ASK_DONE_COOLDOWN_MS)) },
      reason: "the user says not yet — stays open, asked again after the cooldown",
    });
    // Reopen a dormant task the user just touched.
    if (task.status === "dormant") {
      db.prepare(`UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?`).run(iso(now), task.id);
      return { ok: true, status: "open", nextStepQueued: false };
    }
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(iso(now), task.id);
    return { ok: true, status: task.status, nextStepQueued: false };
  }
  db.prepare(`UPDATE tasks SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?`).run(answer, iso(now), iso(now), task.id);
  // A pending timed check on a closed task is moot.
  db.prepare(
    `UPDATE deferred_outputs SET status = 'dismissed', resolved_at = ?
      WHERE task_id = ? AND kind = ? AND status = 'deferred'`,
  ).run(iso(now), task.id, CLOSURE_CHECK_KIND);
  writeDecision({
    runId: null,
    pass: by,
    targetKind: "task",
    targetId: task.id,
    action: "close",
    old: { status: task.status },
    new: { status: answer, by },
    reason: answer === "done" ? "the user says done — hard evidence, closes" : "the user cancelled — closes as cancelled, never done",
    confidence: 1,
  });
  // Follow-ups on close (§11.12.7) — cancellations spawn nothing.
  const nextStepQueued = answer === "done" ? enqueueNextStep(task.id, "closure") : false;
  return { ok: true, status: answer, nextStepQueued };
}
