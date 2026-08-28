// ===========================================================================
// DECIDE pass runner (build P1.4 → P3.1 full scope, spec §6.3 REDUCE + §8.4).
//
// Runs for ONE space over its newly-committed episodes. P3.1: EVERY section
// of the output now acts — chapters, tasks, closures, plan, AND schedules +
// follow-ups (spec §8.4.3/8.4.5, §11.2–11.3). The P1 `deferred_outputs` pen
// is retired for new emissions; held rows replay via replayDeferredOutputs
// (decide-apply.ts) when the timer service boots.
//
// Application discipline (all in code, never trusted from the model):
//   - IDEMPOTENT: chapters upsert by id-or-label within the space; tasks
//     dedupe by open title within the space; the plan only writes on change;
//     a task that already carries a schedule keeps it. A second run on
//     identical state changes nothing (CON-08 / CHP-06).
//   - closures: verdict "close" needs confidence ≥ 0.85 to touch the task
//     (false_auto_close = 0 is a hard gate); anything less is recorded as a
//     suggest_close decision and mutates nothing. A real 'done' close
//     enqueues the next-step pass (spec §11.3 trigger b).
//   - schedules: auto-vs-confirm is evaluateSchedulePolicy — a CODE check
//     (auto only for auto-class + high confidence + time-bound; recurring
//     always confirms; past fire times reject).
//   - suggested tasks: ≤ 2 per day per space; follow-ups ≤ 2 per trigger.
//   - every mutation writes a decisions row with the old state (reversible).
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  type DecideChapter,
  type DecideClosure,
  type DecideTask,
} from "../prompts/decide.v1.js";
import {
  DECIDE_V8_SYSTEM,
  validateDecideV8Output,
  type DecideOutputV8,
} from "../prompts/decide.v8.js";
import { applyFollowups, applySchedule, emptyScheduleCounts } from "./decide-apply.js";
import { enqueueNextStep } from "./next-step.js";
import { runJsonPass, type JsonPassDeps, type JsonPassResult } from "./llm.js";
import { packEpisodes, packSpaceState } from "./thin-pack.js";

/** Hard floor for an auto-applied closure (spec §8.4.4; false_auto_close = 0). */
export const CLOSE_CONFIDENCE_FLOOR = 0.85;
/** Suggested-task budget (spec §8.4.2): ≤ 2 per day per space. */
export const SUGGESTED_PER_DAY = 2;

export interface DecideApplied {
  chaptersCreated: number;
  chaptersUpdated: number;
  tasksCreated: number;
  tasksSkipped: number;
  tasksClosed: number;
  closeSuggestions: number;
  schedulesAuto: number;
  schedulesProposed: number;
  schedulesRejected: number;
  schedulesSkipped: number;
  followupsCreated: number;
  followupsSkipped: number;
  nextStepsEnqueued: number;
  planUpdated: boolean;
}

export function emptyDecideApplied(): DecideApplied {
  return {
    chaptersCreated: 0,
    chaptersUpdated: 0,
    tasksCreated: 0,
    tasksSkipped: 0,
    tasksClosed: 0,
    closeSuggestions: 0,
    ...emptyScheduleCounts(),
    nextStepsEnqueued: 0,
    planUpdated: false,
  };
}

export interface DecidePassResult {
  status: JsonPassResult<DecideOutputV8>["status"];
  applied: DecideApplied;
  runIds: string[];
  error?: { code: string; message: string };
}

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Apply: chapters
// ---------------------------------------------------------------------------

interface ChapterRow {
  id: string;
  label: string;
  status: string;
  target_date: string | null;
}

function findChapter(spaceId: string, ref: DecideChapter): ChapterRow | undefined {
  const db = getDb();
  if (ref.id != null) {
    const byId = db
      .prepare(`SELECT id, label, status, target_date FROM chapters WHERE id = ? AND space_id = ?`)
      .get(ref.id, spaceId) as ChapterRow | undefined;
    if (byId) return byId;
  }
  return db
    .prepare(
      `SELECT id, label, status, target_date FROM chapters
        WHERE space_id = ? AND LOWER(label) = LOWER(?)`,
    )
    .get(spaceId, ref.label) as ChapterRow | undefined;
}

function applyChapter(
  spaceId: string,
  ref: DecideChapter,
  runId: string | null,
  applied: DecideApplied,
): string {
  const db = getDb();
  const existing = findChapter(spaceId, ref);
  const status = ref.status === "done" || ref.status === "dropped" ? ref.status : "active";
  if (!existing) {
    const id = mintId("ch");
    db.prepare(
      `INSERT INTO chapters (id, space_id, label, status, target_date, created_by)
       VALUES (?, ?, ?, ?, ?, 'decide')`,
    ).run(id, spaceId, ref.label, status, ref.target ?? null);
    writeDecision({
      runId,
      pass: "decide",
      targetKind: "chapter",
      targetId: id,
      action: "create",
      old: null,
      new: { spaceId, label: ref.label, status, target: ref.target ?? null },
    });
    applied.chaptersCreated += 1;
    attachChapterEpisodes(spaceId, id, ref.episodes, runId);
    return id;
  }
  const target = ref.target ?? existing.target_date;
  if (existing.status !== status || existing.target_date !== target) {
    db.prepare(
      `UPDATE chapters SET status = ?, target_date = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(status, target, existing.id);
    writeDecision({
      runId,
      pass: "decide",
      targetKind: "chapter",
      targetId: existing.id,
      action: "update",
      old: { status: existing.status, target: existing.target_date },
      new: { status, target },
    });
    applied.chaptersUpdated += 1;
  }
  attachChapterEpisodes(spaceId, existing.id, ref.episodes, runId);
  return existing.id;
}

function attachChapterEpisodes(
  spaceId: string,
  chapterId: string,
  episodeIds: readonly string[],
  runId: string | null,
): void {
  const db = getDb();
  for (const epId of episodeIds) {
    const row = db
      .prepare(`SELECT space_id, chapter_id FROM episodes WHERE id = ?`)
      .get(epId) as { space_id: string | null; chapter_id: string | null } | undefined;
    // Only episodes of THIS space move; a foreign id from the model is noise.
    if (!row || row.space_id !== spaceId || row.chapter_id === chapterId) continue;
    db.prepare(
      `UPDATE episodes SET chapter_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(chapterId, epId);
    writeDecision({
      runId,
      pass: "decide",
      targetKind: "episode",
      targetId: epId,
      action: "link_chapter",
      old: { chapterId: row.chapter_id },
      new: { chapterId },
    });
  }
}

// ---------------------------------------------------------------------------
// Apply: tasks
// ---------------------------------------------------------------------------

function suggestedToday(spaceId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE space_id = ? AND type = 'suggested'
          AND created_by = 'decide'
          AND created_at >= strftime('%Y-%m-%dT00:00:00Z','now')`,
    )
    .get(spaceId) as { n: number };
  return row.n;
}

function applyTask(
  spaceId: string,
  task: DecideTask,
  chapterIdByLabel: Map<string, string>,
  runId: string | null,
  applied: DecideApplied,
): void {
  const db = getDb();
  const open = db
    .prepare(
      `SELECT id FROM tasks
        WHERE space_id = ? AND LOWER(title) = LOWER(?)
          AND status NOT IN ('done','cancelled','dismissed')`,
    )
    .get(spaceId, task.title) as { id: string } | undefined;
  if (open) {
    applied.tasksSkipped += 1;
    return;
  }
  if (task.type === "suggested" && suggestedToday(spaceId) >= SUGGESTED_PER_DAY) {
    applied.tasksSkipped += 1;
    return;
  }
  let chapterId: string | null = null;
  if (task.chapter != null) {
    chapterId =
      chapterIdByLabel.get(task.chapter.toLowerCase()) ??
      ((db
        .prepare(`SELECT id FROM chapters WHERE space_id = ? AND (id = ? OR LOWER(label) = LOWER(?))`)
        .get(spaceId, task.chapter, task.chapter) as { id: string } | undefined)?.id ?? null);
  }
  const id = mintId("tsk");
  db.prepare(
    `INSERT INTO tasks (id, space_id, chapter_id, title, type, category, risk_class,
                        owner, due, evidence_json, created_by, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'decide', ?)`,
  ).run(
    id,
    spaceId,
    chapterId,
    task.title,
    task.type,
    task.category,
    task.risk_class,
    task.owner,
    task.due ?? null,
    JSON.stringify(task.evidence),
    task.confidence,
  );
  writeDecision({
    runId,
    pass: "decide",
    targetKind: "task",
    targetId: id,
    action: "create",
    old: null,
    new: {
      spaceId,
      title: task.title,
      type: task.type,
      riskClass: task.risk_class,
      owner: task.owner,
      due: task.due ?? null,
    },
    confidence: task.confidence,
  });
  applied.tasksCreated += 1;
}

// ---------------------------------------------------------------------------
// Apply: closures
// ---------------------------------------------------------------------------

function applyClosure(
  spaceId: string,
  closure: DecideClosure,
  runId: string | null,
  applied: DecideApplied,
): void {
  const db = getDb();
  const task = db
    .prepare(
      `SELECT id, status FROM tasks
        WHERE space_id = ? AND (id = ? OR LOWER(title) = LOWER(?))
          AND status NOT IN ('done','cancelled','dismissed')`,
    )
    .get(spaceId, closure.task, closure.task) as { id: string; status: string } | undefined;
  if (!task) return; // already closed or never ours — nothing to do, idempotent
  const wantsClose = closure.verdict === "close" && closure.confidence >= CLOSE_CONFIDENCE_FLOOR;
  if (!wantsClose) {
    // A proposal, never a mutation. Cancellation intent still closes as
    // cancelled IF it graduates — here it just waits for approval.
    writeDecision({
      runId,
      pass: "decide",
      targetKind: "task",
      targetId: task.id,
      action: "suggest_close",
      old: { status: task.status },
      new: { status: closure.outcome, proposed: true },
      reason: closure.reason ?? null,
      confidence: closure.confidence,
    });
    applied.closeSuggestions += 1;
    return;
  }
  db.prepare(
    `UPDATE tasks SET status = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(closure.outcome, task.id);
  writeDecision({
    runId,
    pass: "decide",
    targetKind: "task",
    targetId: task.id,
    action: "close",
    old: { status: task.status },
    new: { status: closure.outcome },
    reason: closure.reason ?? null,
    confidence: closure.confidence,
  });
  applied.tasksClosed += 1;
  // Spec §11.3 trigger (b): closure detection saw something completed → the
  // next-step pass proposes what follows. Cancellations spawn nothing.
  if (closure.outcome === "done" && enqueueNextStep(task.id, "closure")) {
    applied.nextStepsEnqueued += 1;
  }
}

// ---------------------------------------------------------------------------
// Apply: plan
// ---------------------------------------------------------------------------

function applyPlan(spaceId: string, plan: unknown, runId: string | null, applied: DecideApplied): void {
  if (plan === null || plan === undefined) return;
  const db = getDb();
  const row = db.prepare(`SELECT plan_json FROM spaces WHERE id = ?`).get(spaceId) as
    | { plan_json: string | null }
    | undefined;
  if (!row) return;
  const next = JSON.stringify(plan);
  if (row.plan_json === next) return; // materially unchanged
  db.prepare(
    `UPDATE spaces SET plan_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(next, spaceId);
  writeDecision({
    runId,
    pass: "decide",
    targetKind: "space",
    targetId: spaceId,
    action: "update_plan",
    old: { planJson: row.plan_json },
    new: { planJson: next },
  });
  applied.planUpdated = true;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * One Decide call for one space over its pending committed episodes, then
 * apply under the P1 rules above. LLM transport injectable via deps.
 */
export async function runDecidePass(
  spaceId: string,
  episodeIds: readonly string[],
  deps: JsonPassDeps = {},
): Promise<DecidePassResult> {
  const applied = emptyDecideApplied();
  const space = packSpaceState(spaceId);
  if (!space) {
    return {
      status: "failed",
      applied,
      runIds: [],
      error: { code: "no_space", message: `space ${spaceId} does not exist` },
    };
  }
  const episodes = packEpisodes(episodeIds);
  const user = [
    space.text,
    "",
    "NEW COMMITTED EPISODES (all sources, time-ordered):",
    ...episodes.map((p) => p.text),
  ].join("\n\n");

  const result = await runJsonPass<DecideOutputV8>(
    {
      pass: "decide",
      system: DECIDE_V8_SYSTEM,
      user,
      role: "decide",
      cohortId: null,
      unit: { kind: "decide_space", id: spaceId },
      validate: validateDecideV8Output,
    },
    deps,
  );
  if (result.output === undefined) {
    return {
      status: result.status,
      applied,
      runIds: result.runIds,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  const runId = result.runIds.length > 0 ? result.runIds[result.runIds.length - 1] : null;
  const out = result.output;

  const chapterIdByLabel = new Map<string, string>();
  for (const chapter of out.chapters) {
    const id = applyChapter(spaceId, chapter, runId, applied);
    chapterIdByLabel.set(chapter.label.toLowerCase(), id);
  }
  const now = deps.now?.() ?? new Date();
  for (const task of out.tasks) applyTask(spaceId, task, chapterIdByLabel, runId, applied);
  for (const closure of out.closures) applyClosure(spaceId, closure, runId, applied);
  // P3.1: schedules + follow-ups ACT — through the code-side policy gate.
  for (const schedule of out.schedules) applySchedule(spaceId, schedule, runId, applied, now);
  applyFollowups(spaceId, out.followups, runId, applied, now);
  applyPlan(spaceId, out.plan, runId, applied);

  return {
    status: result.status,
    applied,
    runIds: result.runIds,
    ...(result.error ? { error: result.error } : {}),
  };
}
