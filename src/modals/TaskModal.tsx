// Task modal — build P1.7, spec §14.6 (task anatomy, trimmed to what the
// P1 world model holds: status, risk class, due, owner, evidence, why?).

import type { SpaceRow, TaskRow } from "../lib/api";
import { ModalFrame, parseEvidence } from "../components/Modal";

export function TaskModal(props: {
  task: TaskRow;
  spaces: SpaceRow[];
  onCorrection: (structured: Record<string, unknown>) => void;
  onTellTwin: () => void;
  onClose: () => void;
}): JSX.Element {
  const { task } = props;
  const space = props.spaces.find((s) => s.id === task.space_id);
  return (
    <ModalFrame
      title={task.title}
      typeChip={task.category ?? "task"}
      spaceChip={space?.label ?? null}
      objectType="task"
      targetKind="task"
      targetId={task.id}
      evidence={parseEvidence(task.evidence_json)}
      onCorrection={props.onCorrection}
      onTellTwin={props.onTellTwin}
      onClose={props.onClose}
    >
      <p>
        status <strong>{task.status}</strong>
        {task.due && <> · due {task.due}</>}
        {task.owner && task.owner !== "self" && <> · owner {task.owner}</>}
      </p>
      <p style={{ color: "var(--ink-2)" }}>risk: {task.risk_class}</p>
    </ModalFrame>
  );
}
