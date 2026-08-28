// ===========================================================================
// The one modal system — build P1.7, spec §14.6.
//
// One anatomy for every type: header (title · type chip · space chip), a
// per-type body, and the standard footer (evidence strip · why? · ···).
// Opens over the blurred screen (deeper glass), Esc / click-outside closes
// (Esc is handled globally in App so the stack pops before the window hides).
// ===========================================================================

import { useState, type ReactNode } from "react";
import type { TargetKind } from "../lib/api";
import { DotMenu, type ChipSpec, type DotMenuObjectType } from "./DotMenu";
import { WhyPanel } from "./WhyPanel";

export interface EvidenceQuote {
  quote?: string;
  summary?: string;
  event_ids?: string[];
}

/** Parse an evidence_json / exemplars_json column defensively. */
export function parseEvidence(json: string | null | undefined): EvidenceQuote[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as EvidenceQuote[]) : [];
  } catch {
    return [];
  }
}

export interface ModalFrameProps {
  title: string;
  typeChip: string;
  spaceChip?: string | null;
  objectType: DotMenuObjectType;
  targetKind: TargetKind;
  targetId: string;
  evidence: EvidenceQuote[];
  children?: ReactNode;
  /** Feedback plumbing (spec §14.4): the shell passes one dispatcher down. */
  onCorrection: (structured: Record<string, unknown>) => void;
  onTellTwin: () => void;
  onClose: () => void;
}

export function ModalFrame(props: ModalFrameProps): JSX.Element {
  const [whyOpen, setWhyOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="modal-scrim" onClick={props.onClose} data-testid="modal-scrim">
      <section
        className="modal"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 className="title">{props.title}</h2>
          <span className="chip">{props.typeChip}</span>
          {props.spaceChip && <span className="chip">{props.spaceChip}</span>}
        </header>

        {props.children}

        {props.evidence.length > 0 && (
          <div aria-label="evidence">
            {props.evidence.map((ev, i) => (
              <div className="evidence" key={i}>
                ❝{ev.quote ?? ev.summary ?? "…"}❞
              </div>
            ))}
          </div>
        )}

        <footer>
          <button type="button" className="linklike" onClick={() => setWhyOpen((v) => !v)}>
            why?
          </button>
          <span style={{ position: "relative", marginLeft: "auto" }}>
            <button
              type="button"
              className="linklike"
              aria-label="more"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ···
            </button>
            {menuOpen && (
              <DotMenu
                objectType={props.objectType}
                targetKind={props.targetKind}
                targetId={props.targetId}
                onEdit={props.onTellTwin}
                onRemove={() => props.onCorrection({ type: props.objectType === "task" ? "not_task" : "cancel" })}
                onTellTwin={props.onTellTwin}
                onChip={(chip: ChipSpec) => props.onCorrection(chip.structured)}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </span>
        </footer>
        {whyOpen && <WhyPanel kind={props.targetKind} id={props.targetId} />}
      </section>
    </div>
  );
}
