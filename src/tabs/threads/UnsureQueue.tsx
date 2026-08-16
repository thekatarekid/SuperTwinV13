// [CODE] The unsure queue — arch §14.4's "❓ NEEDS YOU (adjudicator unsure)",
// build item 2.7.
//
//   ❓ NEEDS YOU (adjudicator unsure)
//     "flight price alerts" episode → arc "Goa trip"?
//     "both mention the same dates but no shared booking or person"
//     [ yes, same trip ][ no, separate ][ later ]
//
// §11.2 rule 5: an `un` verdict GOES TO THE USER. Never a silent new arc, never
// a retry. So this queue is the only place a `un` can be resolved, and while a
// question waits, NOTHING is bound — the episode is not quietly parked in the
// arc it was asked about.
//
// The model's reasoning is rendered verbatim and in full. A one-line reason a
// human is about to act on is the last place to start eliding (brief rule 9).

import type { ArcAnswer, ArcQuestionView } from "../../lib/threads-client";

const ANSWERS: { answer: ArcAnswer; label: string }[] = [
  { answer: "same", label: "yes, same thread" },
  { answer: "separate", label: "no, separate" },
  { answer: "later", label: "later" },
];

export interface UnsureQueueProps {
  items: readonly ArcQuestionView[];
  onAnswer(id: string, answer: ArcAnswer): void;
  busyId?: string | null;
}

export function UnsureQueue({ items, onAnswer, busyId = null }: UnsureQueueProps) {
  if (items.length === 0) return null;

  return (
    <section className="unsureq" aria-label="Unsure queue">
      <header className="unsureq__head">
        <h2 className="unsureq__title">
          <span aria-hidden="true">❓ </span>Needs you (adjudicator unsure)
        </h2>
        <span className="unsureq__count">
          {items.length} waiting · nothing is bound while a question waits
        </span>
      </header>

      <ol className="unsureq__list">
        {items.map((item) => (
          <li key={item.id} className="unsureq__item">
            <p className="unsureq__question">
              “{item.episodeLabel ?? item.episodeId}” episode → thread “
              {item.arcLabel ?? item.arcId}”?
              <span className="unsureq__conf">
                {item.confidence === null
                  ? "no confidence measured"
                  : `unsure ${item.confidence.toFixed(2)}`}
              </span>
            </p>
            {/* Verbatim. See the header comment. */}
            <p className="unsureq__reason">“{item.reasoning}”</p>
            <p className="unsureq__actions">
              {ANSWERS.map(({ answer, label }) => (
                <button
                  key={answer}
                  type="button"
                  className={`unsureq__answer unsureq__answer--${answer}`}
                  disabled={busyId === item.id}
                  onClick={() => onAnswer(item.id, answer)}
                >
                  {label}
                </button>
              ))}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
