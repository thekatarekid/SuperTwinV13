// ===========================================================================
// DECIDE pass runner (build P1.4 → P3.1 full scope, spec §6.3 REDUCE + §8.4;
// V6 P1 S3.7 decide.v9 — Prompts_V6_Phase1 P-05, Product_V6_Phase1 §13).
//
// v9 (S3.7) adds, all applied in code:
//   - the space CARD: summary (two lines) + latest (one line, with its
//     instant) written on change (`spaces.summary/latest/latest_ts`).
//   - MILESTONES only when the goal is staged: the model's milestones become
//     chapters rows (done|active|todo); a lone milestone is not a stage and is
//     dropped (DEC-06). Episodes route to their stage by chapter_id (DEC-01).
//   - OWNERSHIP: another person's task is stored as theirs and the USER gets
//     a monitoring follow-up (DEC-05) — never the action itself.
//   - CHECK_AT: one-sided intent schedules a closure check (lookup first,
//     brain/closure-check.ts); the task stays open (DEC-03).
//   - TIM-04: every schedule carries `window_opens_at`; the policy gate
//     (scheduler/v6/schedule-policy) never lets a fire_at precede it.
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
  DECIDE_V9_SYSTEM,
  validateDecideV9Output,
  type DecideClosureV9,
  type DecideOutputV9,
  type DecideTaskV9,
} from "../prompts/decide.v9.js";
import { scheduleClosureCheck } from "./closure-check.js";
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
  /** v9: summary/latest written on the space. */
  cardUpdated: boolean;
  /** v9: milestones the model emitted for an unstaged goal (dropped). */
  milestonesDropped: number;
  /** v9: another person's tasks turned into a monitor for the user. */
  tasksMonitored: number;
  /** v9: closure checks scheduled from check_at verdicts. */
  checksScheduled: number;
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
    cardUpdated: false,
    milestonesDropped: 0,
    tasksMonitored: 0,
    checksScheduled: 0,
  };
}

export interface DecidePassResult {
  status: JsonPassResult<DecideOutputV9>["status"];
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
  // v9 milestones carry done|active|todo; the legacy vocabulary adds dropped.
  const status =
    ref.status === "done" || ref.status === "dropped" || ref.status === "todo" ? ref.status : "active";
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

/** The user, by any of the roster's spellings. */
function isSelf(owner: string): boolean {
  const o = owner.trim().toLowerCase();
  return o === "" || o === "self" || o === "user" || o === "me" || o === "unknown";
}

/** Human-ish name for a roster ref ("contact:karan" → "Karan"). */
function ownerName(owner: string): string {
  const tail = owner.split(":").pop() ?? owner;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/**
 * DEC-05 / P-05 rule 3: another person's task becomes a monitor for the user.
 * The action stays THEIRS (stored with their owner, never as the user's
 * to-do); the user gets one monitoring follow-up naming the person.
 */
function applyMonitorFor(
  spaceId: string,
  task: DecideTask,
  runId: string | null,
  applied: DecideApplied,
): void {
  const db = getDb();
  const who = ownerName(task.owner);
  const title = `Follow up: ${who} — ${task.title}`;
  const open = db
    .prepare(
      `SELECT id FROM tasks
        WHERE space_id = ? AND LOWER(title) = LOWER(?)
          AND status NOT IN ('done','cancelled','dismissed')`,
    )
    .get(spaceId, title) as { id: string } | undefined;
  if (open) return;
  const id = mintId("tsk");
  db.prepare(
    `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, due,
                        evidence_json, created_by, confidence)
     VALUES (?, ?, ?, 'suggested', 'monitoring', 'advise-only', 'self', ?, ?, 'decide', ?)`,
  ).run(
    id,
    spaceId,
    title,
    task.due ?? null,
    JSON.stringify([{ event_ids: [], quote: `because: ${who}'s task — ${task.title}` }, ...task.evidence]),
    task.confidence,
  );
  writeDecision({
    runId,
    pass: "decide",
    targetKind: "task",
    targetId: id,
    action: "create_monitor",
    old: null,
    new: { spaceId, title, monitors: task.owner, riskClass: "advise-only", category: "monitoring" },
    reason: `another person's task (${task.owner}) becomes a monitor for the user`,
    confidence: task.confidence,
  });
  applied.tasksMonitored += 1;
}

function applyTask(
  spaceId: string,
  task: DecideTask,
  chapterIdByLabel: Map<string, string>,
  runId: string | null,
  applied: DecideApplied,
): void {
  const db = getDb();
  const theirs = !isSelf(task.owner);
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
  // Another person's action is never something the twin may run for the
  // user: it is stored as theirs, advise-only, and monitored (DEC-05).
  const riskClass = theirs ? "advise-only" : task.risk_class;
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
    riskClass,
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
      riskClass,
      owner: task.owner,
      due: task.due ?? null,
      ...((task as DecideTaskV9).steps?.length ? { steps: (task as DecideTaskV9).steps } : {}),
    },
    confidence: task.confidence,
  });
  applied.tasksCreated += 1;
  if (theirs) applyMonitorFor(spaceId, task, runId, applied);
}

// ---------------------------------------------------------------------------
// Apply: closures
// ---------------------------------------------------------------------------

function applyClosure(
  spaceId: string,
  closure: DecideClosure | DecideClosureV9,
  runId: string | null,
  applied: DecideApplied,
  now: Date,
): void {
  const db = getDb();
  const task = db
    .prepare(
      `SELECT id, title, status FROM tasks
        WHERE space_id = ? AND (id = ? OR LOWER(title) = LOWER(?))
          AND status NOT IN ('done','cancelled','dismissed')`,
    )
    .get(spaceId, closure.task, closure.task) as { id: string; title: string; status: string } | undefined;
  if (!task) return; // already closed or never ours — nothing to do, idempotent
  const checkAt = "check_at" in closure ? closure.check_at ?? null : null;
  if (checkAt !== null) {
    // P-05 rule 4 / DEC-03: one-sided intent → a check at the expected time,
    // run as a lookup first. The task stays open; no card yet, no call.
    if (
      scheduleClosureCheck({
        taskId: task.id,
        spaceId,
        taskTitle: task.title,
        checkAt: checkAt === "" ? null : checkAt,
        now,
        runId,
        reason: closure.reason ?? null,
      })
    ) {
      applied.checksScheduled += 1;
    }
    return;
  }
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
// Apply: the space card (v9 summary + latest)
// ---------------------------------------------------------------------------

function applyCard(
  spaceId: string,
  out: { summary: string | null; latest: string | null },
  runId: string | null,
  applied: DecideApplied,
  now: Date,
): void {
  if (out.summary === null && out.latest === null) return;
  const db = getDb();
  const row = db.prepare(`SELECT summary, latest FROM spaces WHERE id = ?`).get(spaceId) as
    | { summary: string | null; latest: string | null }
    | undefined;
  if (!row) return;
  const summary = out.summary ?? row.summary;
  const latest = out.latest ?? row.latest;
  if (summary === row.summary && latest === row.latest) return; // nothing moved
  db.prepare(
    `UPDATE spaces SET summary = ?, latest = ?,
            latest_ts = CASE WHEN ? THEN ? ELSE latest_ts END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(summary, latest, latest !== row.latest ? 1 : 0, now.toISOString(), spaceId);
  writeDecision({
    runId,
    pass: "decide",
    targetKind: "space",
    targetId: spaceId,
    action: "update_card",
    old: { summary: row.summary, latest: row.latest },
    new: { summary, latest },
  });
  applied.cardUpdated = true;
}

/**
 * P-05 rule 2 / DEC-06: milestones only if the goal has stages. A single
 * milestone on a space with no chapters is a one-shot goal wearing a label —
 * it is dropped (decision-rowed), never written.
 */
function stagedChapters(spaceId: string, out: DecideOutputV9, runId: string | null, applied: DecideApplied): DecideChapter[] {
  if (out.milestones.length === 0) return out.chapters; // legacy chapters, or none
  const existing = (getDb().prepare(`SELECT COUNT(*) AS n FROM chapters WHERE space_id = ?`).get(spaceId) as { n: number }).n;
  if (out.milestones.length >= 2 || existing > 0) return out.chapters;
  writeDecision({
    runId,
    pass: "decide",
    targetKind: "space",
    targetId: spaceId,
    action: "skip_milestones",
    old: null,
    new: { milestones: out.milestones.map((m) => m.label) },
    reason: "milestones only if the goal has stages — one stage is not staged (DEC-06)",
  });
  applied.milestonesDropped += out.milestones.length;
  return [];
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

  const result = await runJsonPass<DecideOutputV9>(
    {
      pass: "decide",
      system: DECIDE_V9_SYSTEM,
      user,
      role: "decide",
      cohortId: null,
      unit: { kind: "decide_space", id: spaceId },
      validate: validateDecideV9Output,
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

  const now = deps.now?.() ?? new Date();
  applyCard(spaceId, out, runId, applied, now);
  const chapterIdByLabel = new Map<string, string>();
  for (const chapter of stagedChapters(spaceId, out, runId, applied)) {
    const id = applyChapter(spaceId, chapter, runId, applied);
    chapterIdByLabel.set(chapter.label.toLowerCase(), id);
  }
  for (const task of out.tasks) applyTask(spaceId, task, chapterIdByLabel, runId, applied);
  for (const closure of out.closures) applyClosure(spaceId, closure, runId, applied, now);
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
