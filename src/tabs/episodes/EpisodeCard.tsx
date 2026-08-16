// [CODE] One episode, fully explained — arch §14.3, build item 2.7.
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ ▸ "villa shortlist for Goa"   open · WhatsApp/Rohan · 3 sessions    │
//   │    ├ Mon 09:12  seed · code:1v1 · conf 1.00            [ why? ]     │
//   │    ├ Wed 20:40  ATTACHED · agent:p-ep2 · conf 0.93     [ why? ]     │
//   │    └ Fri 08:15  ATTACHED · agent:p-ep2 · conf 0.88     [ why? ]     │
//   │    entities: Rohan · Villa Amara · Goa    arc: "Goa trip" ──▶       │
//   │    [ detach session ][ split ][ relabel ][ close ]                  │
//   └────────────────────────────────────────────────────────────────────┘
//
// `[ why? ]` renders the PERSISTED verdict — §14.3: "the exact candidates the
// model saw and its stated reason". So the panel prints the candidate list in
// the model's own order, and the reason verbatim. A row whose decision was a
// code rule has no verdict, and says so rather than offering an empty panel;
// the button is still there, because "no model was asked" is itself the answer
// to "why?" and hiding it would make a code decision look unexplained.
//
// Gestures are RAISED, not performed — the tab owns the writes and prints the
// `mutations(actor:user)` receipts, exactly like the Entities surface.

import { useState } from "react";

import { provenanceLine, whenLabel } from "./provenance";
import type { EpisodeSessionView, EpisodeView } from "../../lib/episodes-client";

export type EpisodeGesture =
  | { kind: "detach"; id: string; sessionId: string }
  | { kind: "split"; id: string; sessionIds: string[] }
  | { kind: "merge_back"; id: string; into: string }
  | { kind: "relabel"; id: string; label: string }
  | { kind: "close"; id: string; outcome: string };

export interface EpisodeCardProps {
  episode: EpisodeView;
  /** Vanished from a refresh while provisional — kept and labelled (§14.0b). */
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  onGesture(gesture: EpisodeGesture): void;
  busy?: boolean;
}

/** `open` · `closed·concluded` · `closed·faded` — the outcome is never dropped. */
export function stateLabel(episode: EpisodeView): string {
  if (episode.state === "open") return "open";
  return episode.outcome ? `closed·${episode.outcome}` : "closed";
}

function Verdict({ verdict }: { verdict: NonNullable<EpisodeSessionView["verdict"]> }) {
  return (
    <div className="episode__verdict" role="note">
      <p className="episode__verdict-head">
        persisted verdict {verdict.id} · decision <code>{verdict.decision}</code>
        {verdict.confidence !== null ? ` · conf ${verdict.confidence.toFixed(2)}` : ""}
        {verdict.model ? ` · ${verdict.model}` : " · model not recorded"}
      </p>
      <p className="episode__verdict-candidates">
        candidates the model saw ({verdict.candidates.length}):{" "}
        {verdict.candidates.length === 0
          ? "none — it was asked to open a new episode"
          : verdict.candidates
              .map((c) => `${c.label ?? "(unlabelled)"} [${c.episodeId}]`)
              .join(" · ")}
      </p>
      {/* Verbatim. Order model output, never censor it (brief rule 9). */}
      <p className="episode__verdict-reason">“{verdict.reason}”</p>
    </div>
  );
}

function SessionRow({
  row,
  episode,
  onGesture,
  busy,
}: {
  row: EpisodeSessionView;
  episode: EpisodeView;
  onGesture(gesture: EpisodeGesture): void;
  busy: boolean;
}) {
  const [why, setWhy] = useState(false);

  return (
    <li className={`episode-session episode-session--${row.provenance}`} data-session-id={row.sessionId}>
      <span className="episode-session__when">{whenLabel(row.startedAt)}</span>
      <span className="episode-session__stream">{row.streamLabel}</span>
      {/* Signal AND value, always both — see provenance.ts. */}
      <span className="episode-session__provenance">{provenanceLine(row)}</span>
      {row.reason !== "" && <span className="episode-session__reason">“{row.reason}”</span>}
      {row.sessionOpen && (
        <span className="episode-session__live">
          <span aria-hidden="true">◍ </span>conversation in progress
        </span>
      )}
      <button
        type="button"
        className="episode-session__why"
        aria-expanded={why}
        onClick={() => setWhy((v) => !v)}
      >
        why?
      </button>
      <button
        type="button"
        className="episode-session__detach"
        disabled={busy}
        onClick={() => onGesture({ kind: "detach", id: episode.id, sessionId: row.sessionId })}
      >
        detach session
      </button>
      {why &&
        (row.verdict ? (
          <Verdict verdict={row.verdict} />
        ) : (
          <p className="episode__verdict episode__verdict--none" role="note">
            no model was asked — {row.decidedBy ?? "unattributed"} decided this in code, so there
            is no persisted verdict to show.
          </p>
        ))}
    </li>
  );
}

function RelabelForm({
  episode,
  onGesture,
  onClose,
}: {
  episode: EpisodeView;
  onGesture(gesture: EpisodeGesture): void;
  onClose(): void;
}) {
  const [label, setLabel] = useState(episode.label ?? "");
  return (
    <form
      className="episode-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        onGesture({ kind: "relabel", id: episode.id, label: label.trim() });
        onClose();
      }}
    >
      <label htmlFor={`relabel-${episode.id}`}>Relabel to</label>
      <input
        id={`relabel-${episode.id}`}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button type="submit">confirm relabel</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

function SplitForm({
  episode,
  onGesture,
  onClose,
}: {
  episode: EpisodeView;
  onGesture(gesture: EpisodeGesture): void;
  onClose(): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <form
      className="episode-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.length === 0) return;
        onGesture({ kind: "split", id: episode.id, sessionIds: picked });
        onClose();
      }}
    >
      <fieldset>
        <legend>Split these sessions into their own episode</legend>
        {episode.sessions.map((row) => (
          <label key={row.sessionId} className="episode-form__check">
            <input
              type="checkbox"
              checked={picked.includes(row.sessionId)}
              onChange={(e) =>
                setPicked((prev) =>
                  e.target.checked
                    ? [...prev, row.sessionId]
                    : prev.filter((v) => v !== row.sessionId),
                )
              }
            />
            {whenLabel(row.startedAt)} {row.sessionId}
          </label>
        ))}
      </fieldset>
      <button type="submit">confirm split</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

function CloseForm({
  episode,
  onGesture,
  onClose,
}: {
  episode: EpisodeView;
  onGesture(gesture: EpisodeGesture): void;
  onClose(): void;
}) {
  const [outcome, setOutcome] = useState("concluded");
  return (
    <form
      className="episode-form"
      onSubmit={(e) => {
        e.preventDefault();
        onGesture({ kind: "close", id: episode.id, outcome });
        onClose();
      }}
    >
      <label htmlFor={`close-${episode.id}`}>Outcome</label>
      <input
        id={`close-${episode.id}`}
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
      />
      <button type="submit">confirm close</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

type OpenForm = "relabel" | "split" | "close" | null;

export function EpisodeCard({
  episode,
  retracted = false,
  onDismissRetracted,
  onGesture,
  busy = false,
}: EpisodeCardProps) {
  const [form, setForm] = useState<OpenForm>(null);
  const close = () => setForm(null);
  const live = episode.sessions.some((row) => row.sessionOpen);

  return (
    <li
      className={
        "episode" +
        (episode.state === "open" ? " episode--open" : "") +
        (episode.provisional ? " episode--provisional" : "") +
        (retracted ? " episode--retracted" : "")
      }
      data-episode-id={episode.id}
    >
      {retracted && (
        <p className="episode__retracted" role="status">
          <span aria-hidden="true">◍ </span>
          no longer listed — a later pass merged or re-cut this episode
          <button type="button" onClick={() => onDismissRetracted?.(episode.id)}>
            dismiss
          </button>
        </p>
      )}

      <header className="episode__head">
        <h3 className="episode__label">“{episode.label ?? "(unlabelled episode)"}”</h3>
        <span className="episode__state">{stateLabel(episode)}</span>
        <span className="episode__where">
          {episode.sourceLabel}/{episode.streamLabel}
        </span>
        <span className="episode__count">
          {episode.sessions.length} session{episode.sessions.length === 1 ? "" : "s"}
        </span>
        {episode.provisional && (
          <span className="episode__provisional" title="not yet reconciled — this may change">
            ◍ provisional
          </span>
        )}
      </header>

      {live && (
        <p className="episode__live">
          <span aria-hidden="true">◍ </span>
          conversation in progress — a session in this episode is still open and may change
        </p>
      )}

      {episode.state === "closed" && episode.outcome === "faded" && (
        <p className="episode__faded">
          faded — quiet for{" "}
          {episode.quietDays === null ? "an unmeasured stretch" : `${episode.quietDays} days`}, not
          concluded
        </p>
      )}

      <ol className="episode-session-list" aria-label="Sessions in this episode">
        {episode.sessions.map((row) => (
          <SessionRow
            key={row.sessionId}
            row={row}
            episode={episode}
            onGesture={onGesture}
            busy={busy}
          />
        ))}
        {episode.sessions.length === 0 && (
          <li className="episode-session">no sessions — this episode is empty</li>
        )}
      </ol>

      <p className="episode__entities">
        entities:{" "}
        {episode.entities.length === 0
          ? "none extracted"
          : episode.entities.map((e) => e.label).join(" · ")}
      </p>

      <p className="episode__arc">
        {episode.arc
          ? `arc: “${episode.arc.label ?? episode.arc.id}” ──▶`
          : "arc: not bound yet — the ladder has not placed this episode"}
      </p>

      <p className="episode__gestures">
        <button type="button" disabled={busy} onClick={() => setForm("split")}>
          split
        </button>
        {episode.splitFromEpisodeId && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onGesture({
                kind: "merge_back",
                id: episode.id,
                into: episode.splitFromEpisodeId as string,
              })
            }
          >
            merge back
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => setForm("relabel")}>
          relabel
        </button>
        <button
          type="button"
          disabled={busy || episode.state === "closed"}
          onClick={() => setForm("close")}
        >
          close
        </button>
      </p>

      {form === "relabel" && (
        <RelabelForm episode={episode} onGesture={onGesture} onClose={close} />
      )}
      {form === "split" && <SplitForm episode={episode} onGesture={onGesture} onClose={close} />}
      {form === "close" && <CloseForm episode={episode} onGesture={onGesture} onClose={close} />}
    </li>
  );
}
