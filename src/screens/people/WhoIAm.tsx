// ===========================================================================
// The "Who I am" card — V6 P1 R2 (Product_V6 §8.3.2, §11.7; Product_V6_Phase1
// §3.6 "fills from processing over the first hour. No form").
//
// S5.4 built the card worker-side (people/who-i-am.ts, GET /api/people/who-i-am)
// and nothing rendered it. This is the render.
//
// The whole point of the card is what it is NOT: there is no form, no field to
// fill, no confirmation step. Every line is a claim the processing lane wrote
// about the self entity, so every line arrives with its evidence quote and its
// confidence, and "the user edits any line" means a correction on that claim —
// the same pipeline as every chip and drag, undo included. Lines the record
// derives rather than claims (the circle roster, the tone registers) say so and
// are not editable here; they are edited where they live, in People and in the
// person card.
//
// Empty is a state, not a failure: before the first hour is up the card prints
// the worker's own note and offers nothing to fill in.
// ===========================================================================

import { useEffect, useState } from "react";

import { fetchWhoIAm, type WhoIAmCardView, type WhoIAmLine } from "../../lib/api";

/** The five sections, in the order the card reads. */
const SECTIONS = [
  { key: "basics", title: "Basics", blurb: "name · where you live · how you are reached" },
  { key: "life", title: "Life", blurb: "work · study · the people around you" },
  { key: "narrative", title: "Narrative", blurb: "the story so far, newest first" },
  { key: "traits", title: "Traits", blurb: "preferences · habits · patterns · values" },
  { key: "voice", title: "Voice", blurb: "how you write, per audience — DMs and groups kept apart" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

/** The two claim chips (Product_V6_Phase1 §21) — chips ARE corrections. */
const CLAIM_CHIPS: { label: string; structured: Record<string, unknown> }[] = [
  { label: "Not true", structured: { type: "not_true" } },
  { label: "Outdated", structured: { type: "outdated" } },
];

function confidenceLabel(c: number | null): string | null {
  return typeof c === "number" && Number.isFinite(c) ? `${Math.round(c * 100)}%` : null;
}

function Line(props: {
  line: WhoIAmLine;
  onCorrection?: (claimKey: string, structured: Record<string, unknown>) => void;
  onTellTwin?: (claimKey: string, label: string) => void;
  onOpenEvent?: (eventId: string) => void;
}): JSX.Element {
  const { line } = props;
  const conf = confidenceLabel(line.confidence);
  const quote = line.evidence[0];
  const editable = line.editable && line.claimKey !== null;
  return (
    <div className="row whoiam-line" aria-label={`who i am line ${line.text}`}>
      <span className="whoiam-text">{line.text}</span>
      {conf && <span className="meta whoiam-conf">{conf}</span>}
      {!editable && <span className="chip derived">from {line.source === "tone" ? "tone" : "circles"}</span>}
      {quote && (
        <button
          type="button"
          className="chip evidence-chip"
          title="open the evidence on the timeline"
          aria-label={`evidence for ${line.text}`}
          onClick={() => quote.event_ids[0] && props.onOpenEvent?.(quote.event_ids[0])}
        >
          ❝{quote.quote}❞
        </button>
      )}
      {editable &&
        CLAIM_CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            className="chip"
            aria-label={`${c.label.toLowerCase()} ${line.text}`}
            onClick={() => props.onCorrection?.(line.claimKey!, c.structured)}
          >
            {c.label}
          </button>
        ))}
      {editable && (
        <button
          type="button"
          className="linklike"
          aria-label={`tell the twin about ${line.text}`}
          onClick={() => props.onTellTwin?.(line.claimKey!, line.text)}
        >
          Tell the twin
        </button>
      )}
    </div>
  );
}

export function WhoIAm(props: {
  /** A claim correction — People's one dispatcher, so undo works here too. */
  onCorrection?: (claimKey: string, structured: Record<string, unknown>) => void;
  /** Context-locks the grounded bar to the claim behind a line. */
  onTellTwin?: (claimKey: string, label: string) => void;
  onOpenEvent?: (eventId: string) => void;
}): JSX.Element {
  const [card, setCard] = useState<WhoIAmCardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchWhoIAm()
      .then((c) => {
        if (alive) setCard(c);
      })
      .catch(() => {
        if (alive) setError("worker unreachable");
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="card whoiam" aria-label="Who I am">
      <h2>
        Who I am
        <button
          type="button"
          className="linklike whoiam-toggle"
          aria-label={open ? "collapse Who I am" : "expand Who I am"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "hide" : "show"}
        </button>
      </h2>
      <p className="meta">
        Built by processing, not by onboarding — there is no form and no confirmation step. Every line
        is a claim with its evidence; correcting one goes through the same pipeline as every other
        correction.
      </p>

      {error && <p className="empty">{error}</p>}
      {!error && card === null && <p className="empty">loading…</p>}

      {open && card !== null && card.empty && (
        <p className="empty">{card.emptyNote ?? "nothing yet — this card fills from processing."}</p>
      )}

      {open &&
        card !== null &&
        !card.empty &&
        SECTIONS.map((s) => {
          const lines = card[s.key as SectionKey];
          if (lines.length === 0) return null;
          return (
            <div key={s.key} className="whoiam-section" aria-label={`who i am ${s.key}`}>
              <h3 className="whoiam-title">
                {s.title} <span className="meta">{s.blurb}</span>
              </h3>
              {lines.map((line, i) => (
                <Line
                  key={line.claimKey ?? `${s.key}-${i}`}
                  line={line}
                  {...(props.onCorrection ? { onCorrection: props.onCorrection } : {})}
                  {...(props.onTellTwin ? { onTellTwin: props.onTellTwin } : {})}
                  {...(props.onOpenEvent ? { onOpenEvent: props.onOpenEvent } : {})}
                />
              ))}
            </div>
          );
        })}

      {open && card !== null && !card.empty && (
        <p className="meta whoiam-counts">
          {card.counts.claims} claim{card.counts.claims === 1 ? "" : "s"} · {card.counts.people} person
          {card.counts.people === 1 ? "" : "s"} placed in a circle
        </p>
      )}
    </section>
  );
}
