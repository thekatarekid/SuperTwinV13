// ===========================================================================
// The ··· menu — build P1.7, spec §14.4.2/§14.4.4 (eval FIX-06).
//
// The menu is EXACTLY three items, everywhere: Edit · Remove · Tell the twin.
// Under them, contextual quick-chips — max 2-3, per object type:
//   task     → Not mine · Already done
//   claim    → Not true · Outdated
//   proposal → Merge into…
// Never a mega-menu, never another type's chips.
// ===========================================================================

import type { TargetKind } from "../lib/api";

export type DotMenuObjectType = "task" | "claim" | "proposal" | "space" | "episode" | "person";

export interface ChipSpec {
  label: string;
  /** The structured correction the chip fires (spec §14.4: chips ARE corrections). */
  structured: Record<string, unknown>;
}

/** The per-type quick-chips (FIX-06: contextual, capped, never crossed). */
export function chipsFor(type: DotMenuObjectType): ChipSpec[] {
  switch (type) {
    case "task":
      return [
        { label: "Not mine", structured: { type: "wrong_person", owner: "them" } },
        { label: "Already done", structured: { type: "already_done" } },
      ];
    case "claim":
      return [
        { label: "Not true", structured: { type: "not_true" } },
        { label: "Outdated", structured: { type: "outdated" } },
      ];
    case "proposal":
      return [{ label: "Merge into…", structured: { type: "merge_into" } }];
    default:
      return [];
  }
}

/** Which correction "Remove" maps to, per object type (soft, reversible). */
export function removeStructured(type: DotMenuObjectType): Record<string, unknown> {
  if (type === "task") return { type: "not_task" };
  if (type === "person") return { type: "stop_tracking" }; // recorded, honest, never a delete
  return { type: "cancel" };
}

export interface DotMenuProps {
  objectType: DotMenuObjectType;
  targetKind: TargetKind;
  targetId: string;
  onEdit: () => void;
  onRemove: () => void;
  onTellTwin: () => void;
  onChip: (chip: ChipSpec) => void;
  onClose: () => void;
}

export function DotMenu(props: DotMenuProps): JSX.Element {
  const chips = chipsFor(props.objectType);
  const item = (label: string, fn: () => void): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        fn();
        props.onClose();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="dot-menu" role="menu" aria-label="object menu" onClick={(e) => e.stopPropagation()}>
      {item("Edit", props.onEdit)}
      {item("Remove", props.onRemove)}
      {item("Tell the twin", props.onTellTwin)}
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className="chip"
              onClick={(e) => {
                e.stopPropagation();
                props.onChip(chip);
                props.onClose();
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
