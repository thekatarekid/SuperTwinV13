// [CODE] What may appear in a task list — arch §14.7, build item 3.10.
//
// The item's acceptance criterion is a negative: **no loop owned by another
// person appears in Tasks.** A negative is only shippable if some single
// function owns it, so this one does, and the surface has no other way in.
//
// Three filters, in order, and all three are non-negotiable:
//
//   1. OWNERSHIP. `ownerIsSelf` false → the loop is context. It joins the
//      "waiting on others" reading, and it is never a to-do. Belt and braces:
//      `triage: "context"` is also excluded, because §9.5.1 makes `cx` mean
//      exactly "not yours to act on" and a worker that sets the triage but
//      forgets the owner flag must not be able to leak a row through.
//   2. STATE. Only `open` and `latent` are live work. `done`, `dropped` and
//      `lapsed` are history — lapsed items are shown, but in their own list,
//      with the reason they lapsed (§14.7 rule 4).
//   3. ORIGIN. Explicit and implicit are separate lists with different verbs
//      (§14.7 rule 1), so the split is structural, not a filter chip.
//
// `possibly_done` does not exist (phase-3 gate). There is no third bucket
// here and no state that means "maybe".

import { TASK_STATES, type LoopOrigin, type TaskView } from "../../lib/tasks-client";
import type { Retained } from "../../lib/provisional";

/** The one predicate that decides whether a loop is YOURS. */
export function isOwnTask(task: TaskView): boolean {
  return task.ownerIsSelf === true && task.triage !== "context";
}

/** Why a loop was kept out of the task lists — rendered, never swallowed. */
export function exclusionReason(task: TaskView): string | null {
  if (!task.ownerIsSelf) return `owned by ${task.ownerLabel} — context, not a task`;
  if (task.triage === "context") return "triaged as context — not yours to act on";
  return null;
}

export function isLive(task: TaskView): boolean {
  return TASK_STATES.includes(task.state);
}

export interface TaskPartition {
  /** "YOU SAID YOU'D DO THIS" — origin explicit, yours, live. */
  explicit: Retained<TaskView>[];
  /** "SUGGESTED BY YOUR TWIN" — origin implicit, yours, live. */
  implicit: Retained<TaskView>[];
  /** Lapsed, yours. Shown with the reason, never silently dropped. */
  lapsed: Retained<TaskView>[];
  /** Not yours. Context only — the surface renders it as such or not at all. */
  notYours: Retained<TaskView>[];
}

function forOrigin(
  rows: readonly Retained<TaskView>[],
  origin: LoopOrigin,
): Retained<TaskView>[] {
  return rows.filter(
    (entry) => isOwnTask(entry.row) && isLive(entry.row) && entry.row.origin === origin,
  );
}

/**
 * Split one flat list of loops into the sections §14.7 draws.
 *
 * Retained rows (§14.0b retractions) keep their place: a provisional task that
 * disappeared is still yours, still explicit, and still owed a struck-through
 * line in the list it was in — dropping it here would be the silent retraction
 * the whole mechanism exists to prevent.
 */
export function partitionTasks(rows: readonly Retained<TaskView>[]): TaskPartition {
  return {
    explicit: forOrigin(rows, "explicit"),
    implicit: forOrigin(rows, "implicit"),
    lapsed: rows.filter((entry) => isOwnTask(entry.row) && entry.row.state === "lapsed"),
    notYours: rows.filter((entry) => !isOwnTask(entry.row)),
  };
}

export interface SpaceGroup {
  spaceId: string | null;
  spaceLabel: string;
  entries: Retained<TaskView>[];
}

/**
 * §14.7 groups tasks by space. Loose tasks (no promoted arc behind them) are
 * still tasks and get their own group at the end — never dropped, and never
 * silently filed under someone else's space.
 */
export function groupBySpace(rows: readonly Retained<TaskView>[]): SpaceGroup[] {
  const groups = new Map<string, SpaceGroup>();
  for (const entry of rows) {
    const key = entry.row.spaceId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = {
        spaceId: entry.row.spaceId,
        spaceLabel: entry.row.spaceLabel ?? "no space",
        entries: [],
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.spaceId !== null), ...all.filter((g) => g.spaceId === null)];
}

/**
 * §14.7 rule 4: a lapsed task says WHY, and "born lapsed" is the honest answer
 * for a backfilled one. The worker's own note wins; this is the fallback so a
 * lapsed row is never bare.
 */
export function lapsedExplanation(task: TaskView): string {
  if (task.stateNote) return task.stateNote;
  if (task.stateReason === "born_lapsed") {
    return "born lapsed — the due date had passed when it was found";
  }
  if (task.stateReason === "past_due_no_recurrence") {
    return "past due, and there is no next occurrence";
  }
  return task.stateReason ?? "lapsed — reason not recorded";
}
