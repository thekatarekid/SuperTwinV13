// [CODE] The resolution queue — arch §14.1, build items 1.10 (UI) and 1.11.
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ ⚠ RESOLUTION QUEUE            (batched during import · 12 waiting)   │
//   │  "Papa (new number Jio)" ↔ "Papa"        agent: same 0.88            │
//   │    "same group, same address term, old number went silent"           │
//   │    [ same ][ different ][ later ]        [ answer all 12 → ]         │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Two things this component refuses to do:
//
//  1. IT NEVER SUMMARISES THE AGENT. The reasoning is rendered verbatim, in
//     full. Rule 9 of the build brief — order model output, never censor it —
//     and a one-line reason a human is about to act on is the last place to
//     start eliding.
//  2. "ANSWER ALL" IS A STEPPER, NOT A BULK VERDICT. The affordance in §14.1
//     is a way through twelve questions, not a way to answer twelve questions
//     at once: a blanket "same" would merge twelve pairs on one click, and a
//     merge is the write that is hardest to walk back.

import { useState } from "react";

import type { ResolutionQueueItem, ResolutionVerdict } from "../../lib/surfaces-client";

const VERDICTS: { verdict: ResolutionVerdict; label: string }[] = [
  { verdict: "same", label: "same" },
  { verdict: "different", label: "different" },
  { verdict: "later", label: "later" },
];

export interface ResolutionQueueProps {
  items: readonly ResolutionQueueItem[];
  onAnswer(id: string, verdict: ResolutionVerdict): void;
  /** The question whose answer is in flight, if any. */
  busyId?: string | null;
}

function agentLine(item: ResolutionQueueItem): string {
  if (!item.agentVerdict) return "no agent verdict — escalated unresolved";
  const confidence = item.confidence === null ? "" : ` ${item.confidence.toFixed(2)}`;
  return `agent: ${item.agentVerdict}${confidence}`;
}

function Question({
  item,
  onAnswer,
  busy,
}: {
  item: ResolutionQueueItem;
  onAnswer(id: string, verdict: ResolutionVerdict): void;
  busy: boolean;
}) {
  return (
    <li className="resq__item">
      <p className="resq__pair">
        <span className="resq__side">“{item.left.label}”</span>
        <span className="resq__vs" aria-hidden="true">
          ↔
        </span>
        <span className="resq__side">“{item.right.label}”</span>
        <span className="resq__agent">{agentLine(item)}</span>
      </p>
      {/* Verbatim. See the header comment. */}
      <p className="resq__reason">“{item.reasoning}”</p>
      <p className="resq__actions">
        {VERDICTS.map(({ verdict, label }) => (
          <button
            key={verdict}
            type="button"
            className={`resq__verdict resq__verdict--${verdict}`}
            disabled={busy}
            onClick={() => onAnswer(item.id, verdict)}
          >
            {label}
          </button>
        ))}
      </p>
    </li>
  );
}

export function ResolutionQueue({ items, onAnswer, busyId = null }: ResolutionQueueProps) {
  const [stepping, setStepping] = useState(false);
  const [cursor, setCursor] = useState(0);

  if (items.length === 0) return null;

  // Answers remove questions, so the cursor is clamped rather than tracked.
  const index = Math.min(cursor, items.length - 1);
  const shown = stepping ? [items[index]] : items;

  return (
    <section className="resq" aria-label="Resolution queue">
      <header className="resq__head">
        <h2 className="resq__title">
          <span aria-hidden="true">⚠ </span>Resolution queue
        </h2>
        <span className="resq__count">
          batched during import · {items.length} waiting
        </span>
        {stepping ? (
          <span className="resq__stepper">
            <button
              type="button"
              className="resq__step"
              disabled={index === 0}
              onClick={() => setCursor(Math.max(0, index - 1))}
            >
              ‹ back
            </button>
            <span className="resq__progress">
              {index + 1} of {items.length}
            </span>
            <button
              type="button"
              className="resq__step"
              disabled={index >= items.length - 1}
              onClick={() => setCursor(Math.min(items.length - 1, index + 1))}
            >
              next ›
            </button>
            <button type="button" className="resq__step" onClick={() => setStepping(false)}>
              show all
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="resq__all"
            onClick={() => {
              setCursor(0);
              setStepping(true);
            }}
          >
            answer all {items.length} →
          </button>
        )}
      </header>

      {stepping && (
        <p className="resq__note">
          One pair at a time — there is no bulk verdict. A merge is the write
          that is hardest to walk back.
        </p>
      )}

      <ol className="resq__list">
        {shown.map((item) => (
          <Question
            key={item.id}
            item={item}
            onAnswer={onAnswer}
            busy={busyId === item.id}
          />
        ))}
      </ol>
    </section>
  );
}
