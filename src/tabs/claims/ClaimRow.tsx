// [CODE] One claim, fully explained — arch §14.5, build item 3.10.
//
//   habit  Attends bhangra classes on Saturdays.        0.95  1st-person
//          ev_9001 "i've started bhangra classes…"           [ why? ]
//
// Everything on the row is provenance. `[ why? ]` expands the verbatim quotes
// with their click-through, and — when there is one — the supersede chain,
// newest first. Gestures are pin / reject / correct / split (§14.8); rejection
// TEACHES (it writes a user claim), so the button never says "delete".

import { useState } from "react";

import { chainNewestFirst, hasChain, missingProvenance, provenanceLine } from "./chain";
import type { ClaimView } from "../../lib/claims-client";

export type ClaimGesture =
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "reject"; id: string; reason: string }
  | { kind: "correct"; id: string; text: string }
  | { kind: "split"; id: string; texts: string[] };

export interface ClaimRowProps {
  claim: ClaimView;
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  onGesture(gesture: ClaimGesture): void;
  onOpenEvidence?(eventId: string): void;
  busy?: boolean;
}

export function ClaimRow({
  claim,
  retracted = false,
  onDismissRetracted,
  onGesture,
  onOpenEvidence,
  busy = false,
}: ClaimRowProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"none" | "correct" | "split">("none");

  const gaps = missingProvenance(claim);
  const chain = chainNewestFirst(claim);

  const className = [
    "claim",
    `claim--${claim.kind}`,
    claim.status === "superseded" ? "claim--superseded" : "",
    claim.provisional ? "claim--provisional" : "",
    retracted ? "claim--retracted" : "",
    gaps.length > 0 ? "claim--incomplete" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className} data-claim-id={claim.id}>
      <div className="claim__line">
        <span className="claim__kind">{claim.kind}</span>
        <span className="claim__text">{claim.text}</span>
        <span className="claim__provenance">{provenanceLine(claim)}</span>
        <button
          type="button"
          className="claim__why"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          why?
        </button>
      </div>

      {claim.status === "superseded" && (
        <p className="claim__status">superseded — kept, never deleted</p>
      )}

      {/* §14.0b: provisional output is MARKED, and it is not withheld. */}
      {claim.provisional && !retracted && (
        <p className="claim__provisional">◍ conversation in progress — this may still change</p>
      )}

      {retracted && (
        <p className="claim__retracted" role="status">
          ◍ withdrawn as the conversation resolved — it is no longer claimed{" "}
          {onDismissRetracted && (
            <button type="button" onClick={() => onDismissRetracted(claim.id)}>
              dismiss
            </button>
          )}
        </p>
      )}

      {/* An incomplete claim SAYS which piece is missing rather than going blank. */}
      {gaps.length > 0 && (
        <p className="claim__gap">⚠ unexplained — missing {gaps.join(", ")}</p>
      )}

      {open && (
        <div className="claim__detail">
          <ul className="claim__evidence" aria-label={`Evidence for ${claim.text}`}>
            {claim.evidence.length === 0 ? (
              <li className="claim__gap">no evidence on record</li>
            ) : (
              claim.evidence.map((ev) => (
                <li key={ev.eventId}>
                  <button
                    type="button"
                    className="claim__evidence-link"
                    onClick={() => onOpenEvidence?.(ev.eventId)}
                  >
                    {ev.eventId}
                  </button>{" "}
                  <q className="claim__quote">{ev.quote}</q>
                </li>
              ))
            )}
          </ul>

          {hasChain(claim) && (
            <ol className="claim__chain" aria-label={`History of ${claim.text}`}>
              {chain.map((version) => (
                <li key={version.id} className={`claim__version claim__version--${version.status}`}>
                  <span className="claim__version-no">v{version.version}</span>
                  <span className="claim__version-status">{version.status}</span>
                  <span className="claim__version-at">{version.statedAt}</span>
                  <span className="claim__version-text">{version.text}</span>
                  <span className="claim__version-reason">{version.reason ?? "no reason recorded"}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="claim__gestures">
        <button
          type="button"
          disabled={busy}
          onClick={() => onGesture({ kind: "pin", id: claim.id, pinned: !claim.pinned })}
        >
          {claim.pinned ? "unpin" : "pin"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onGesture({ kind: "reject", id: claim.id, reason: "rejected on the Claims surface" })
          }
        >
          reject
        </button>
        <button type="button" disabled={busy} onClick={() => setMode(mode === "correct" ? "none" : "correct")}>
          correct
        </button>
        <button type="button" disabled={busy} onClick={() => setMode(mode === "split" ? "none" : "split")}>
          split
        </button>
        <span className="claim__teaches">rejection teaches — it writes your claim, it never deletes</span>
      </div>

      {mode !== "none" && (
        <form
          className="claim__form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = draft.trim();
            if (!value) return;
            onGesture(
              mode === "correct"
                ? { kind: "correct", id: claim.id, text: value }
                : { kind: "split", id: claim.id, texts: value.split("|").map((t) => t.trim()).filter(Boolean) },
            );
            setDraft("");
            setMode("none");
          }}
        >
          <label>
            {mode === "correct" ? "corrected claim" : "split into (separate with |)"}
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={mode === "correct" ? "Corrected claim" : "Split claim into"}
            />
          </label>
          <button type="submit" disabled={busy}>
            save
          </button>
        </form>
      )}
    </li>
  );
}
