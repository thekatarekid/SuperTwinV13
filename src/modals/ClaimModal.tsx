// ===========================================================================
// Claim modal — build P4.2, spec §14.6.
//
// The claim, kind chip, confidence, validity window, the full evidence list,
// the supersede history ("replaced 'vegetarian' — Aug 2026"), and the two
// quick-chips [Not true] [Outdated] — which fire the SAME structured
// corrections as the ··· sheet (spec §14.4: chips ARE corrections).
// History is fetched from GET /api/claims/:key; a fetch failure renders the
// row we already had, never a blank dialog.
// ===========================================================================

import { useEffect, useState } from "react";
import { fetchClaimHistory, type ClaimRow, type ClaimVersionView } from "../lib/api";
import { ModalFrame, parseEvidence, type EvidenceQuote } from "../components/Modal";

function monthYear(ts: string | null): string {
  if (!ts) return "?";
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function ClaimModal(props: {
  claim: ClaimRow;
  onCorrection: (structured: Record<string, unknown>) => void;
  onTellTwin: () => void;
  onClose: () => void;
}): JSX.Element {
  const { claim } = props;
  const [active, setActive] = useState<ClaimVersionView | null>(null);
  const [history, setHistory] = useState<ClaimVersionView[]>([]);

  useEffect(() => {
    let alive = true;
    fetchClaimHistory(claim.claim_key)
      .then((r) => {
        if (!alive) return;
        setActive(r.active);
        setHistory(r.history);
      })
      .catch(() => {
        /* render from the row we were opened with */
      });
    return () => {
      alive = false;
    };
  }, [claim.claim_key]);

  const evidence: EvidenceQuote[] =
    active?.evidence && active.evidence.length > 0
      ? active.evidence.map((e) => ({ quote: e.quote, event_ids: e.event_ids }))
      : parseEvidence(claim.evidence_json);

  // Supersede history: every non-active version, newest first (old versions
  // get validity ends, never deletion — FIX-03).
  const superseded = history.filter((v) => v.id !== (active?.id ?? claim.id));

  const validFrom = active?.validFrom ?? active?.statedAt ?? claim.stated_at;
  const validTo = active?.validTo ?? null;

  return (
    <ModalFrame
      title={active?.text ?? claim.text ?? claim.claim_key}
      typeChip={active?.kind ?? claim.kind ?? "claim"}
      objectType="claim"
      targetKind="claim"
      targetId={claim.claim_key}
      evidence={evidence}
      onCorrection={props.onCorrection}
      onTellTwin={props.onTellTwin}
      onClose={props.onClose}
    >
      <p style={{ color: "var(--ink-2)" }}>
        conf {(active?.confidence ?? claim.confidence ?? 0).toFixed(2)} · valid {monthYear(validFrom)} →{" "}
        {validTo ? monthYear(validTo) : "open"}
      </p>

      {superseded.length > 0 && (
        <div aria-label="history">
          {superseded.map((v) => (
            <p key={v.id} style={{ color: "var(--ink-2)" }}>
              history&nbsp; replaced “{v.text ?? v.claimKey}” — {monthYear(v.validTo ?? v.statedAt)}
            </p>
          ))}
        </div>
      )}

      <div className="btn-row">
        <button type="button" className="btn" onClick={() => props.onCorrection({ type: "not_true" })}>
          Not true
        </button>
        <button type="button" className="btn" onClick={() => props.onCorrection({ type: "outdated" })}>
          Outdated
        </button>
      </div>
    </ModalFrame>
  );
}
