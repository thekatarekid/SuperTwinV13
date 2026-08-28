// Proposal modal — build P1.7, spec §14.6 (review queue expansion).
//
// Proposed label + life-area/type chips, the evidence episodes, and the
// three verdicts: Approve · Merge into… · Dismiss. Approve is the ONLY path
// that activates a proposed space (propose-only, spec §9/§2).

import type { SpaceRow } from "../lib/api";
import { ModalFrame, parseEvidence } from "../components/Modal";

export function ProposalModal(props: {
  proposal: SpaceRow;
  onApprove: () => void;
  onDismiss: () => void;
  onCorrection: (structured: Record<string, unknown>) => void;
  onTellTwin: () => void;
  onClose: () => void;
}): JSX.Element {
  const { proposal } = props;
  const chips = [proposal.life_area, proposal.horizon, proposal.cadence]
    .filter(Boolean)
    .join(" · ");
  return (
    <ModalFrame
      title={`New space: ${proposal.label}`}
      typeChip={chips || "proposed"}
      objectType="proposal"
      targetKind="space"
      targetId={proposal.id}
      evidence={parseEvidence(proposal.exemplars_json)}
      onCorrection={props.onCorrection}
      onTellTwin={props.onTellTwin}
      onClose={props.onClose}
    >
      {proposal.goal && <p>{proposal.goal}</p>}
      {proposal.confidence != null && (
        <p style={{ color: "var(--ink-2)" }}>confidence {proposal.confidence.toFixed(2)}</p>
      )}
      <div className="btn-row">
        <button type="button" className="btn primary" onClick={props.onApprove}>
          Approve
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => props.onCorrection({ type: "merge_into" })}
        >
          Merge into…
        </button>
        <button type="button" className="btn" onClick={props.onDismiss}>
          Dismiss
        </button>
      </div>
    </ModalFrame>
  );
}
