// [CODE] The claim conflict queue — arch §14.5, build item 3.10.
//
//   ⚠ CONFLICT — Rahul Arora
//     now  "Lives in Indiranagar."   observed 11 Aug   active
//     was  "Lives in Koramangala."   observed 02 Mar   valid → 01 Sep 2026
//     adjudicator: contradiction 0.90 "the incoming claim is older and …"
//     [ accept ][ both true ][ neither ][ show both quotes ]
//
// The queue is the human loop. Two things it must not do:
//
//   * SUMMARISE THE ADJUDICATOR. P-AG3's sentence renders verbatim (build
//     rule 9) — no truncation, no ellipsis, no "…" added by this component.
//   * HIDE A QUOTE. "show both quotes" expands the evidence for BOTH sides,
//     because a conflict resolved without reading the evidence is a coin toss.

import { useState } from "react";

import type { ClaimConflictView, ClaimView, ConflictAnswer } from "../../lib/claims-client";
import { provenanceLine } from "./chain";

export interface ConflictQueueProps {
  conflicts: readonly ClaimConflictView[];
  onAnswer(id: string, answer: ConflictAnswer): void;
  busyId?: string | null;
}

const ANSWERS: { key: ConflictAnswer; label: string }[] = [
  { key: "accept", label: "accept" },
  { key: "both_true", label: "both true" },
  { key: "neither", label: "neither" },
];

function Side({ role, claim }: { role: "now" | "was"; claim: ClaimView }) {
  return (
    <li className={`conflict__side conflict__side--${role}`}>
      <span className="conflict__role">{role}</span>
      <q className="conflict__text">{claim.text}</q>
      <span className="conflict__observed">stated {claim.statedAt}</span>
      <span className="conflict__status">{claim.status}</span>
      {claim.validTo && <span className="conflict__valid">valid → {claim.validTo}</span>}
      <span className="conflict__provenance">{provenanceLine(claim)}</span>
    </li>
  );
}

export function ConflictQueue({ conflicts, onAnswer, busyId }: ConflictQueueProps) {
  const [shown, setShown] = useState<string | null>(null);

  if (conflicts.length === 0) return null;

  return (
    <section className="conflicts" aria-label="Claim conflicts">
      <h2 className="conflicts__title">⚠ {conflicts.length} conflicts</h2>
      <ol className="conflicts__list">
        {conflicts.map((conflict) => {
          const open = shown === conflict.id;
          return (
            <li key={conflict.id} className="conflict">
              <p className="conflict__subject">⚠ CONFLICT — {conflict.subjectLabel}</p>
              <ul className="conflict__sides">
                <Side role="now" claim={conflict.incoming} />
                <Side role="was" claim={conflict.stored} />
              </ul>

              {/* Verbatim. Never summarised, never truncated (build rule 9). */}
              <p className="conflict__reasoning">
                <span className="conflict__verdict">
                  adjudicator: {conflict.verdict ?? "no verdict"}{" "}
                  {conflict.confidence !== null ? conflict.confidence.toFixed(2) : "—"}
                </span>{" "}
                <q>{conflict.reasoning}</q>
              </p>

              <div className="conflict__actions">
                {ANSWERS.map((answer) => (
                  <button
                    key={answer.key}
                    type="button"
                    disabled={busyId === conflict.id}
                    onClick={() => onAnswer(conflict.id, answer.key)}
                  >
                    {answer.label}
                  </button>
                ))}
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setShown(open ? null : conflict.id)}
                >
                  show both quotes
                </button>
              </div>

              {open && (
                <ul className="conflict__quotes" aria-label="Both quotes">
                  {[conflict.incoming, conflict.stored].flatMap((claim) =>
                    claim.evidence.map((ev) => (
                      <li key={`${claim.id}:${ev.eventId}`}>
                        <span className="conflict__quote-src">{ev.eventId}</span>{" "}
                        <q>{ev.quote}</q>
                      </li>
                    )),
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
