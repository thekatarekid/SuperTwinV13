// ===========================================================================
// Approval modal — build P3.5, spec §14.6 ("what a one-tap approval card
// expands into").
//
// The Approve button is the ONLY path to the risky step: tapping it mints the
// single-use token (POST /api/approvals/mint) and hands it to the caller's
// gated call — the token is never pre-minted, never reused, and lives only in
// this tap's closure. "Change…" drops into the context-locked bar thread with
// the executor; "Discard" walks away without minting anything.
// ===========================================================================

import { useState } from "react";
import { mintApproval } from "../lib/api";

export interface ApprovalSpec {
  /** Modal headline, e.g. "Approve send" / "Approve payment". */
  title: string;
  /** Gated action the token is minted for, e.g. "whatsapp.send". */
  action: string;
  /** What happens on approve — shown verbatim, the token authorizes this. */
  lines: string[];
  /** Why this is ready (the executor's stated approval_request). */
  why: string | null;
  amount?: string | null;
  approveLabel: string;
}

export function ApprovalModal(props: {
  spec: ApprovalSpec;
  /** Perform the gated call with the freshly minted token. */
  onApprove: (token: string) => Promise<void>;
  onChange: () => void;
  onDiscard: () => void;
  onClose: () => void;
}): JSX.Element {
  const { spec } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Mint AT tap-time (spec §14.6 note 2), then straight into the gated call.
      const minted = await mintApproval(spec.action);
      await props.onApprove(minted.token);
    } catch {
      setError("approval failed — nothing was sent");
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <div className="modal-scrim" onClick={props.onClose} data-testid="approval-scrim">
      <section
        className="modal"
        role="dialog"
        aria-label={spec.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 className="title">{spec.title}</h2>
          {spec.amount && <span className="chip">{spec.amount}</span>}
        </header>

        <p>What happens on approve:</p>
        <ul aria-label="what happens">
          {spec.lines.map((line, i) => (
            <li key={i}>· {line}</li>
          ))}
        </ul>
        {spec.why && <p style={{ color: "var(--ink-2)" }}>Why this is ready: {spec.why}</p>}
        {error && <p role="alert">{error}</p>}

        <footer>
          <button type="button" disabled={busy} onClick={() => void approve()}>
            {busy ? "approving…" : spec.approveLabel}
          </button>
          <button type="button" className="linklike" onClick={props.onChange}>
            Change…
          </button>
          <button type="button" className="linklike" onClick={props.onDiscard}>
            Discard
          </button>
        </footer>
      </section>
    </div>
  );
}
