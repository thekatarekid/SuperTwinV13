// [CODE] One space — arch §14.6, build item 3.10.
//
//   ▸ 🎯 Goa trip                  EVENT ⚑commitment · active · ends 15 Sep
//     ⏳ 31 days
//     LOOPS   confirm villa to Rohan   open · due 20 Aug   ● you
//     PEOPLE  Rohan · Ana · Kabir
//     CONTEXT (claims, computed at query time — not stored on the space)
//     arc: arc_77 ──▶   [ why a space? ][ pin ][ relabel ][ archetype ]
//
// ONE card layout for all eight archetypes. What differs is the icon, the
// accent class, and the signal strip the worker composed — never the
// structure, because eight bespoke layouts is eight surfaces pretending to be
// one.
//
// `arc: arc_77` is printed on every card on purpose. A space IS an arc (brief
// rule 6); showing the id keeps that true in the reader's head and makes the
// space→thread click-through obvious.

import { useState } from "react";

import { archetypeChrome, orderedContext, signalStrip, stateMarkers } from "./strip";
import {
  ARCHETYPES,
  ARCHETYPE_NAMES,
  PROMOTION_MARKER,
  type Archetype,
  type SpaceView,
} from "../../lib/spaces-client";

export type SpaceGesture =
  | { kind: "archetype"; id: string; archetype: Archetype }
  | { kind: "relabel"; id: string; label: string }
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "archive"; id: string; archived: boolean };

export interface SpaceCardProps {
  space: SpaceView;
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  onGesture(gesture: SpaceGesture): void;
  busy?: boolean;
}

export function SpaceCard({
  space,
  retracted = false,
  onDismissRetracted,
  onGesture,
  busy = false,
}: SpaceCardProps) {
  const [why, setWhy] = useState(false);
  const [relabelling, setRelabelling] = useState(false);
  const [draft, setDraft] = useState(space.label);

  const chrome = archetypeChrome(space.archetype);
  const marker = space.promotionReason ? PROMOTION_MARKER[space.promotionReason] : null;
  const context = orderedContext(space.contextClaims);

  const className = [
    "space",
    chrome.modifier,
    `space--${space.status}`,
    space.provisional ? "space--provisional" : "",
    retracted ? "space--retracted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className} data-space-id={space.id} data-archetype={space.archetype ?? "none"}>
      <div className="space__head">
        <span className="space__icon" aria-hidden="true">
          {chrome.icon}
        </span>
        <h2 className="space__label">{space.label}</h2>
        {space.labelSource === "user" && <span className="space__label-src">your label</span>}
        <span className="space__archetype">
          {chrome.name.toUpperCase()}
          {space.archetypeSource === "user" ? " (yours)" : ""}
        </span>
        {marker && (
          <span className="space__marker" title={marker.name}>
            {marker.glyph}
            {marker.name}
          </span>
        )}
        <span className="space__status">{space.status}</span>
        {space.endsAt && <span className="space__ends">ends {space.endsAt}</span>}
      </div>

      {/* The differentiator. Composed by the worker; never invented here. */}
      <p className="space__strip">{signalStrip(space)}</p>

      {stateMarkers(space).length > 0 && (
        <p className="space__markers">{stateMarkers(space).join(" · ")}</p>
      )}

      {space.provisional && !retracted && (
        <p className="space__provisional">◍ conversation in progress — this space may still change</p>
      )}

      {retracted && (
        <p className="space__retracted" role="status">
          ◍ no longer a space — the loop that promoted it resolved{" "}
          {onDismissRetracted && (
            <button type="button" onClick={() => onDismissRetracted(space.id)}>
              dismiss
            </button>
          )}
        </p>
      )}

      <div className="space__body">
        <section className="space__loops">
          <h3>LOOPS</h3>
          {space.loops.length === 0 ? (
            <p className="space__empty">no loops</p>
          ) : (
            <ul>
              {space.loops.map((loop) => (
                <li key={loop.id} className="space__loop">
                  <span className="space__loop-intent">{loop.intent}</span>
                  <span className="space__loop-state">{loop.state}</span>
                  <span className="space__loop-due">{loop.dueAt ?? "no due"}</span>
                  {/* Whose loop it is, on the face of the row. */}
                  <span className="space__loop-owner">
                    {loop.ownerIsSelf ? "● you" : `○ ${loop.ownerLabel}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space__people">
          <h3>PEOPLE</h3>
          <p>{space.people.length === 0 ? "none" : space.people.map((p) => p.label).join(" · ")}</p>
        </section>

        <section className="space__sources">
          <h3>SOURCES</h3>
          <p>{space.sources.length === 0 ? "none" : space.sources.join(" · ")}</p>
        </section>
      </div>

      <section className="space__context">
        <h3>CONTEXT</h3>
        <p className="space__context-note">
          claims, computed at query time — not stored on the space
        </p>
        {context.length === 0 ? (
          <p className="space__empty">no context claims</p>
        ) : (
          <ul>
            {context.map((claim) => (
              <li key={claim.claimId} className={claim.weighted ? "space__claim space__claim--weighted" : "space__claim"}>
                <span className="space__claim-text">{claim.text}</span>
                <span className="space__claim-kind">{claim.kind}</span>
                <span className="space__claim-conf">
                  {claim.confidence === null ? "—" : claim.confidence.toFixed(2)}
                </span>
                {claim.weighted && <span className="space__claim-why">preference, weighted first</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="space__foot">
        <span className="space__arc">arc: {space.arcId} ──▶</span>
        <button type="button" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
          why a space?
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onGesture({ kind: "pin", id: space.id, pinned: !space.pinned })}
        >
          {space.pinned ? "unpin" : "pin"}
        </button>
        <button type="button" disabled={busy} onClick={() => setRelabelling((v) => !v)}>
          relabel
        </button>
        <label className="space__archetype-pick">
          archetype
          <select
            aria-label={`Archetype for ${space.label}`}
            value={space.archetype ?? ""}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value as Archetype;
              if (next) onGesture({ kind: "archetype", id: space.id, archetype: next });
            }}
          >
            <option value="">unclassified</option>
            {ARCHETYPES.map((a) => (
              <option key={a} value={a}>
                {ARCHETYPE_NAMES[a]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onGesture({ kind: "archive", id: space.id, archived: space.status !== "archived" })
          }
        >
          {space.status === "archived" ? "unarchive" : "archive"}
        </button>
        <span className="space__never-reverts">your choices are permanent — the model never reverts them</span>
      </div>

      {why && (
        <div className="space__why">
          <p className="space__why-rule">{space.promotionRule ?? "no promotion rule recorded"}</p>
          <ul className="space__why-loops" aria-label={`Loops that promoted ${space.label}`}>
            {space.promotingLoopIds.length === 0 ? (
              <li>no promoting loop recorded</li>
            ) : (
              space.promotingLoopIds.map((loopId) => {
                const loop = space.loops.find((l) => l.id === loopId);
                return <li key={loopId}>{loop ? `${loop.intent} (${loopId})` : loopId}</li>;
              })
            )}
          </ul>
        </div>
      )}

      {relabelling && (
        <form
          className="space__form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = draft.trim();
            if (!value) return;
            onGesture({ kind: "relabel", id: space.id, label: value });
            setRelabelling(false);
          }}
        >
          <label>
            new label
            <input
              type="text"
              aria-label={`New label for ${space.label}`}
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
