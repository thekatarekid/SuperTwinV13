// Space modal — build P1.7, spec §14.6 (space anatomy, P1 slice: goal, type
// chips, its open tasks with draggable filing, exemplar evidence, why?).
//
// Tasks listed here carry the draggable `→ space` filing chip (spec §14.3/
// §14.4.1): dragging one onto a space card on Home fires the same correction
// pipeline as everything else (FIX-05).

import type { ArtifactRow, SpaceRow, TaskRow } from "../lib/api";
import { ModalFrame, parseEvidence } from "../components/Modal";

export function SpaceModal(props: {
  space: SpaceRow;
  tasks: TaskRow[];
  /** Fresh nudge belonging to THIS space (spec §14.7.8 contextual banner). */
  nudge?: ArtifactRow | null;
  onOpenNudge?: (artifact: ArtifactRow) => void;
  onCorrection: (structured: Record<string, unknown>) => void;
  onTellTwin: () => void;
  onClose: () => void;
  onOpenTask: (task: TaskRow) => void;
}): JSX.Element {
  const { space } = props;
  const tasks = props.tasks.filter((t) => t.space_id === space.id);
  const chips = [space.status, space.cadence, space.life_area].filter(Boolean).join(" · ");
  return (
    <ModalFrame
      title={space.label}
      typeChip={chips || "space"}
      objectType="space"
      targetKind="space"
      targetId={space.id}
      evidence={parseEvidence(space.exemplars_json)}
      onCorrection={props.onCorrection}
      onTellTwin={props.onTellTwin}
      onClose={props.onClose}
    >
      {props.nudge && (
        <button
          type="button"
          className="nudge-banner"
          data-testid="space-nudge-banner"
          onClick={() => props.onOpenNudge?.(props.nudge!)}
        >
          ◆ {props.nudge.title}
          {props.nudge.summary ? ` — ${props.nudge.summary}` : ""} · open
        </button>
      )}
      {space.goal && <p>{space.goal}</p>}
      {tasks.length > 0 ? (
        <div>
          {tasks.map((t) => (
            <button type="button" className="row" key={t.id} onClick={() => props.onOpenTask(t)}>
              <span className="glyph">▸</span>
              <span>{t.title}</span>
              <span className="meta">{t.due ? `due ${t.due}` : t.status}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty">no open tasks</p>
      )}
    </ModalFrame>
  );
}
