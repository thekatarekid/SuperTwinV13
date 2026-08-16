// [CODE] One person — arch §14.1/§14.8, build item 3.10.
//
// The card is a relationship, not a to-do list. Item 3.10 is explicit: a
// person has THEIR THREADS — no tasks, no priority. Open loops appear, but
// split by direction and labelled as context in both halves, because "Rohan
// owes you a villa confirmation" is something to know, never something on
// your list (that is the Tasks surface's guarantee, and it stands here too).
//
// The tier badge always shows its arithmetic (people/tier.ts). If the worker's
// stored tier and the browser's derivation disagree, the card says so rather
// than quietly picking one.

import { useState } from "react";

import { deriveTier, reciprocityLabel, tierAgreement } from "./tier";
import { TIER_LABEL, type PersonView } from "../../lib/people-client";

export type PersonGesture =
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "rename"; id: string; canonical: string };

export interface PersonCardProps {
  person: PersonView;
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  onGesture(gesture: PersonGesture): void;
  busy?: boolean;
}

export function PersonCard({
  person,
  retracted = false,
  onDismissRetracted,
  onGesture,
  busy = false,
}: PersonCardProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(person.label);

  const derived = deriveTier(person.stats);
  const disagreement = tierAgreement(person.tier, person.stats);
  const reciprocity = reciprocityLabel(person.stats);

  const youOwe = person.openLoops.filter((l) => l.direction === "you_owe_them");
  const theyOwe = person.openLoops.filter((l) => l.direction === "they_owe_you");

  const className = [
    "person",
    `person--${person.tier}`,
    person.provisional ? "person--provisional" : "",
    retracted ? "person--retracted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className} data-person-id={person.id}>
      <div className="person__head">
        <h2 className="person__name">{person.label}</h2>
        <span className="person__tier">{TIER_LABEL[person.tier]}</span>
        {/* The arithmetic, always. A badge with no numbers explains nothing. */}
        <span className="person__tier-why">{derived.because}</span>
        {person.relationship && <span className="person__relationship">{person.relationship}</span>}
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "less" : "more"}
        </button>
      </div>

      {disagreement && <p className="person__disagreement">⚠ {disagreement}</p>}

      {person.relationshipQuote && (
        <p className="person__relationship-quote">
          <q>{person.relationshipQuote}</q>
        </p>
      )}

      <p className="person__rhythm">
        {person.stats.rhythmLabel ?? "no rhythm measured"}
        {reciprocity ? ` · ${reciprocity}` : ""}
        {person.stats.daysSinceContact !== null
          ? ` · last contact ${person.stats.daysSinceContact}d ago`
          : " · no contact on record"}
      </p>

      {person.provisional && !retracted && (
        <p className="person__provisional">◍ conversation in progress — this may still change</p>
      )}

      {retracted && (
        <p className="person__retracted" role="status">
          ◍ no longer returned — the identity was merged or withdrawn{" "}
          {onDismissRetracted && (
            <button type="button" onClick={() => onDismissRetracted(person.id)}>
              dismiss
            </button>
          )}
        </p>
      )}

      {open && (
        <div className="person__detail">
          <section className="person__identities">
            <h3>IDENTITIES</h3>
            <ul>
              {person.identities.map((identity) => (
                <li key={identity.id}>
                  <span className="person__identity-kind">{identity.kind}</span>
                  <span className="person__identity-value">{identity.value}</span>
                  <span className="person__identity-src">{identity.decidedBy ?? "decided_by —"}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="person__claims">
            <h3>CLAIMS</h3>
            <ul>
              {person.claims.map((claim) => (
                <li key={claim.id} className="person__claim">
                  <span className="person__claim-kind">{claim.kind}</span>
                  <span className="person__claim-text">{claim.text}</span>
                  <span className="person__claim-prov">
                    {claim.confidence === null ? "—" : claim.confidence.toFixed(2)} ·{" "}
                    {claim.attribution ?? "attribution —"} · {claim.decidedBy ?? "decided_by —"}
                  </span>
                  <q className="person__claim-quote">{claim.quote}</q>
                </li>
              ))}
            </ul>
          </section>

          <section className="person__threads">
            <h3>THEIR THREADS</h3>
            <p className="person__threads-note">threads only — no tasks, no priority</p>
            <ul>
              {person.threads.map((thread) => (
                <li key={thread.arcId}>
                  {thread.label} <span className="person__thread-state">{thread.state}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="person__spaces">
            <h3>SHARED SPACES</h3>
            <ul>
              {person.sharedSpaces.map((space) => (
                <li key={space.spaceId}>
                  {space.label} <span className="person__space-archetype">{space.archetype ?? "unclassified"}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="person__loops">
            <h3>OPEN LOOPS — BOTH DIRECTIONS</h3>
            <p className="person__loops-note">context, in both directions — never a task list</p>
            <ul className="person__loops-you">
              {youOwe.map((loop) => (
                <li key={loop.id}>
                  you → {person.label}: {loop.intent}
                  {loop.dueLabel ? ` · ${loop.dueLabel}` : ""} <q>{loop.quote}</q>
                </li>
              ))}
            </ul>
            <ul className="person__loops-them">
              {theyOwe.map((loop) => (
                <li key={loop.id}>
                  {person.label} → you: {loop.intent}
                  {loop.dueLabel ? ` · ${loop.dueLabel}` : ""} <q>{loop.quote}</q>
                </li>
              ))}
            </ul>
          </section>

          <section className="person__recommendations">
            <h3>THEY RECOMMENDED</h3>
            <ul>
              {person.recommendations.map((rec) => (
                <li key={rec.claimId}>
                  {rec.text} <q>{rec.quote}</q>
                </li>
              ))}
            </ul>
          </section>

          <section className="person__timeline">
            <h3>TIMELINE</h3>
            <ol>
              {person.timeline.map((entry) => (
                <li key={`${entry.at}:${entry.label}`}>
                  <span className="person__timeline-at">{entry.at}</span> {entry.label}
                  {entry.sourceLabel ? ` · ${entry.sourceLabel}` : ""}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      <div className="person__gestures">
        <button
          type="button"
          disabled={busy}
          onClick={() => onGesture({ kind: "pin", id: person.id, pinned: !person.pinned })}
        >
          {person.pinned ? "unpin" : "pin"}
        </button>
        <button type="button" disabled={busy} onClick={() => setRenaming((v) => !v)}>
          rename
        </button>
      </div>

      {renaming && (
        <form
          className="person__form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = draft.trim();
            if (!value) return;
            onGesture({ kind: "rename", id: person.id, canonical: value });
            setRenaming(false);
          }}
        >
          <label>
            canonical name
            <input
              type="text"
              aria-label={`Canonical name for ${person.label}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
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
