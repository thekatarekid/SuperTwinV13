// [CODE] One task — arch §14.7 and §14.0b, build item 3.10.
//
//   ⚠ Send Pranjali the Goa villa link       due today · Goa trip
//      "i'll send you that villa link tonight" · 12 Aug        [ why? ]
//      ◍ conversation in progress · updated 12s ago
//      [ done ][ drop ][ snooze ][ open space ]
//
// The verbs differ by origin (§14.7 rule 1), so the card takes the list it is
// in rather than deciding for itself: explicit rows get done/drop/snooze,
// implicit rows get "yes, track it" / "not useful". The implicit verbs are
// deliberately NOT a delete — rejecting writes a user preference claim, and
// the row says so.
//
// A provisional row carries §14.0b's marker and its "updated Ns ago", and a
// retracted one is struck through rather than removed: an item may change or
// disappear as a conversation resolves, and the reader is told when it does.

import { useState } from "react";

import { lapsedExplanation } from "./partition";
import type { TaskGestureKind, TaskView } from "../../lib/tasks-client";

export type TaskGesture =
  | { kind: "mark"; id: string; gesture: TaskGestureKind }
  | { kind: "accept"; id: string }
  | { kind: "reject"; id: string };

export interface TaskCardProps {
  task: TaskView;
  /** Which set of verbs to show — the list decides, not the card. */
  verbs: "explicit" | "implicit";
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  onGesture(gesture: TaskGesture): void;
  onOpenSpace?(spaceId: string): void;
  busy?: boolean;
}

export function TaskCard({
  task,
  verbs,
  retracted = false,
  onDismissRetracted,
  onGesture,
  onOpenSpace,
  busy = false,
}: TaskCardProps) {
  const [why, setWhy] = useState(false);
  const lapsed = task.state === "lapsed";

  const className = [
    "task",
    `task--${verbs}`,
    `task--${task.state}`,
    task.provisional ? "task--provisional" : "",
    retracted ? "task--retracted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className} data-task-id={task.id}>
      <div className="task__line">
        <span className="task__glyph" aria-hidden="true">
          {lapsed ? "⏱" : verbs === "explicit" ? "⚠" : "○"}
        </span>
        <span className="task__intent">{task.intent}</span>
        <span className="task__due">{task.dueLabel ?? (task.dueAt ? task.dueAt : "no due")}</span>
        {task.spaceLabel && <span className="task__space">{task.spaceLabel}</span>}
        <button type="button" className="task__why" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
          why?
        </button>
      </div>

      {/* Evidence quote on the face of the row — §14.7 rule 3's "one tap". */}
      {task.evidence[0] && (
        <p className="task__quote">
          <q>{task.evidence[0].quote}</q>{" "}
          <span className="task__quote-at">{task.evidence[0].at ?? ""}</span>
        </p>
      )}

      {verbs === "implicit" && task.inferredFrom && (
        <p className="task__inferred">inferred from: {task.inferredFrom}</p>
      )}

      {lapsed && <p className="task__lapsed">LAPSED — {lapsedExplanation(task)}</p>}

      {task.provisional && !retracted && (
        <p className="task__provisional">
          ◍ conversation in progress{task.updatedAt ? ` · updated ${task.updatedAt}` : ""}
        </p>
      )}

      {/* §14.0b rule 5: a partially-read conversation never looks complete. */}
      {task.pendingNote && <p className="task__pending">◍ {task.pendingNote}</p>}

      {retracted && (
        <p className="task__retracted" role="status">
          ◍ withdrawn as the conversation resolved — it is no longer a task{" "}
          {onDismissRetracted && (
            <button type="button" onClick={() => onDismissRetracted(task.id)}>
              dismiss
            </button>
          )}
        </p>
      )}

      {why && (
        <ul className="task__evidence" aria-label={`Evidence for ${task.intent}`}>
          {task.evidence.length === 0 ? (
            <li className="task__gap">no evidence on record</li>
          ) : (
            task.evidence.map((ev) => (
              <li key={ev.eventId}>
                <span className="task__evidence-id">{ev.eventId}</span> <q>{ev.quote}</q>
              </li>
            ))
          )}
          <li className="task__origin">
            origin {task.origin} · triage {task.triage} · owner {task.ownerLabel}
            {task.confidence !== null ? ` · confidence ${task.confidence.toFixed(2)}` : ""}
          </li>
        </ul>
      )}

      <div className="task__actions">
        {verbs === "explicit" ? (
          <>
            <button type="button" disabled={busy} onClick={() => onGesture({ kind: "mark", id: task.id, gesture: "done" })}>
              done
            </button>
            <button type="button" disabled={busy} onClick={() => onGesture({ kind: "mark", id: task.id, gesture: "drop" })}>
              drop
            </button>
            <button type="button" disabled={busy} onClick={() => onGesture({ kind: "mark", id: task.id, gesture: "snooze" })}>
              snooze
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => onGesture({ kind: "accept", id: task.id })}>
              yes, track it
            </button>
            <button type="button" disabled={busy} onClick={() => onGesture({ kind: "reject", id: task.id })}>
              not useful
            </button>
            <span className="task__teaches">← rejection teaches, permanently</span>
          </>
        )}
        {task.spaceId && onOpenSpace && (
          <button type="button" onClick={() => onOpenSpace(task.spaceId as string)}>
            open space
          </button>
        )}
      </div>
    </li>
  );
}
