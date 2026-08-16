// [CODE] One thread (arc), fully explained — arch §14.4, build item 2.7.
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ ▸ Goa trip                    live · 5 sources · 12 episodes       │
//   │   Jun ───●────●─────────●────●────●───────● Sep                     │
//   │   BOUND BY (precedence order)                                       │
//   │    ① url        booking.com/villa-amara   web ↔ wa       exact      │
//   │    ② overlap    0.71                      wa ↔ wa                   │
//   │    ④ adjudicated "same trip, same villa"  mmt ep         conf 0.90  │
//   │   anchors: Rohan · Ana · Villa Amara · Goa   space: "Goa trip" ──▶  │
//   │   ⟳ still growing — 90d+ history queued                             │
//   │   [ why together? ][ remove episode ][ split arc ][ merge ][ pin ]  │
//   └────────────────────────────────────────────────────────────────────┘
//
// The item's acceptance criterion is enforced in TWO places here, because a
// thread has two kinds of membership row:
//
//   * the BOUND BY list — every signal with its measured value, sorted by
//     ladder rung so precedence order is a property of the data (signals.ts);
//   * the EPISODE list — every episode with the strongest signal that admitted
//     it. An episode with no signal on record prints "unbound" rather than an
//     empty cell, because a membership nobody can explain is the single most
//     important thing on this surface.
//
// `[ why together? ]` expands the reasons verbatim: rung ④'s stated reason is
// the model's own sentence, never a paraphrase (brief rule 9).

import { useState } from "react";

import { SourceTimeline } from "./SourceTimeline";
import { RUNG_GLYPH, RUNG_NAME, inPrecedenceOrder, signalValue, strongestBinding } from "./signals";
import type { ArcEpisodeView, ArcView, BindingSignalView } from "../../lib/threads-client";

export type ThreadGesture =
  | { kind: "remove_episode"; id: string; episodeId: string }
  | { kind: "split"; id: string; episodeIds: string[] }
  | { kind: "merge"; id: string; into: string }
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "relabel"; id: string; label: string };

export interface ThreadCardProps {
  arc: ArcView;
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  /** Other loaded threads, offered as merge targets. */
  peers: readonly { id: string; label: string }[];
  onGesture(gesture: ThreadGesture): void;
  busy?: boolean;
}

function Signal({ signal, expanded }: { signal: BindingSignalView; expanded: boolean }) {
  return (
    <li className={`arc-signal arc-signal--rung${signal.rung}`} data-rung={signal.rung}>
      <span className="arc-signal__rung" title={RUNG_NAME[signal.rung]}>
        {RUNG_GLYPH[signal.rung]}
      </span>
      <span className="arc-signal__name">{signal.signal}</span>
      {/* Never blank — "not measured" is an honest value (signals.ts). */}
      <span className="arc-signal__value">{signalValue(signal)}</span>
      <span className="arc-signal__between">{signal.between}</span>
      {expanded && (
        <span className="arc-signal__reason">
          {signal.reason ? `“${signal.reason}”` : `${RUNG_NAME[signal.rung]} — decided in code, no stated reason`}
        </span>
      )}
    </li>
  );
}

function EpisodeRow({
  arc,
  episode,
  onGesture,
  busy,
}: {
  arc: ArcView;
  episode: ArcEpisodeView;
  onGesture(gesture: ThreadGesture): void;
  busy: boolean;
}) {
  const binding = strongestBinding(arc.bindings, episode.episodeId);

  return (
    <li className="arc-episode" data-episode-id={episode.episodeId}>
      <span className="arc-episode__label">“{episode.label ?? "(unlabelled episode)"}”</span>
      <span className="arc-episode__source">{episode.sourceLabel}</span>
      <span className="arc-episode__binding">
        {binding
          ? `${RUNG_GLYPH[binding.rung]} ${binding.signal} · ${signalValue(binding)}`
          : "unbound — no signal on record for this membership"}
      </span>
      <button
        type="button"
        className="arc-episode__remove"
        disabled={busy}
        onClick={() =>
          onGesture({ kind: "remove_episode", id: arc.id, episodeId: episode.episodeId })
        }
      >
        remove episode
      </button>
    </li>
  );
}

function MergeForm({
  arc,
  peers,
  onGesture,
  onClose,
}: {
  arc: ArcView;
  peers: readonly { id: string; label: string }[];
  onGesture(gesture: ThreadGesture): void;
  onClose(): void;
}) {
  const [into, setInto] = useState("");
  const listId = `arc-merge-targets-${arc.id}`;
  return (
    <form
      className="arc-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!into.trim()) return;
        onGesture({ kind: "merge", id: arc.id, into: into.trim() });
        onClose();
      }}
    >
      <label htmlFor={`arc-merge-${arc.id}`}>Merge into</label>
      <input
        id={`arc-merge-${arc.id}`}
        list={listId}
        value={into}
        onChange={(e) => setInto(e.target.value)}
        placeholder="surviving thread id"
      />
      <datalist id={listId}>
        {peers.map((peer) => (
          <option key={peer.id} value={peer.id}>
            {peer.label}
          </option>
        ))}
      </datalist>
      <button type="submit">confirm merge</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

function SplitForm({
  arc,
  onGesture,
  onClose,
}: {
  arc: ArcView;
  onGesture(gesture: ThreadGesture): void;
  onClose(): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <form
      className="arc-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.length === 0) return;
        onGesture({ kind: "split", id: arc.id, episodeIds: picked });
        onClose();
      }}
    >
      <fieldset>
        <legend>Split these episodes into their own thread</legend>
        {arc.episodes.map((episode) => (
          <label key={episode.episodeId} className="arc-form__check">
            <input
              type="checkbox"
              checked={picked.includes(episode.episodeId)}
              onChange={(e) =>
                setPicked((prev) =>
                  e.target.checked
                    ? [...prev, episode.episodeId]
                    : prev.filter((v) => v !== episode.episodeId),
                )
              }
            />
            {episode.label ?? episode.episodeId}
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

function RelabelForm({
  arc,
  onGesture,
  onClose,
}: {
  arc: ArcView;
  onGesture(gesture: ThreadGesture): void;
  onClose(): void;
}) {
  const [label, setLabel] = useState(arc.label ?? "");
  return (
    <form
      className="arc-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        onGesture({ kind: "relabel", id: arc.id, label: label.trim() });
        onClose();
      }}
    >
      <label htmlFor={`arc-relabel-${arc.id}`}>Relabel to</label>
      <input id={`arc-relabel-${arc.id}`} value={label} onChange={(e) => setLabel(e.target.value)} />
      <button type="submit">confirm relabel</button>
      <button type="button" onClick={onClose}>
        cancel
      </button>
    </form>
  );
}

type OpenForm = "merge" | "split" | "relabel" | null;

export function ThreadCard({
  arc,
  retracted = false,
  onDismissRetracted,
  peers,
  onGesture,
  busy = false,
}: ThreadCardProps) {
  const [form, setForm] = useState<OpenForm>(null);
  const [why, setWhy] = useState(false);
  const close = () => setForm(null);
  const signals = inPrecedenceOrder(arc.bindings);
  const others = peers.filter((peer) => peer.id !== arc.id);

  return (
    <li
      className={
        "arc" +
        ` arc--${arc.state}` +
        (arc.provisional ? " arc--provisional" : "") +
        (retracted ? " arc--retracted" : "")
      }
      data-arc-id={arc.id}
    >
      {retracted && (
        <p className="arc__retracted" role="status">
          <span aria-hidden="true">◍ </span>
          no longer listed — reconcile merged or dropped this provisional thread
          <button type="button" onClick={() => onDismissRetracted?.(arc.id)}>
            dismiss
          </button>
        </p>
      )}

      <header className="arc__head">
        <h3 className="arc__label">{arc.label ?? "(unlabelled thread)"}</h3>
        <span className="arc__state">{arc.state}</span>
        <span className="arc__facts">
          {arc.sourceCount} source{arc.sourceCount === 1 ? "" : "s"} · {arc.episodes.length} episode
          {arc.episodes.length === 1 ? "" : "s"}
        </span>
        {arc.pinned && <span className="arc__pin">📌 pinned</span>}
        {arc.provisional && (
          <span className="arc__provisional" title="not yet reconciled — no stable id">
            ◍ provisional
          </span>
        )}
      </header>

      <SourceTimeline contributions={arc.contributions} />

      <div className="arc__block">
        <span className="arc__block-label">Bound by (precedence order)</span>
        <ol className="arc-signal-list" aria-label="Binding signals in precedence order">
          {signals.map((signal) => (
            <Signal key={signal.id} signal={signal} expanded={why} />
          ))}
          {signals.length === 0 && (
            <li className="arc-signal arc-signal--none">
              nothing bound this thread yet — it is a single episode, or reconcile has not run
            </li>
          )}
        </ol>
      </div>

      <div className="arc__block">
        <span className="arc__block-label">Episodes</span>
        <ul className="arc-episode-list" aria-label="Episodes in this thread">
          {arc.episodes.map((episode) => (
            <EpisodeRow
              key={episode.episodeId}
              arc={arc}
              episode={episode}
              onGesture={onGesture}
              busy={busy}
            />
          ))}
          {arc.episodes.length === 0 && <li className="arc-episode">no episodes yet</li>}
        </ul>
      </div>

      <p className="arc__anchors">
        anchors:{" "}
        {arc.anchors.length === 0
          ? "none — nothing anchors this thread"
          : arc.anchors.map((a) => a.label).join(" · ")}
        {" · "}
        {/* Promotion is a field on the arc, not a separate object (brief rule 6). */}
        {arc.promotedSpaceId
          ? `space: “${arc.promotedLabel ?? arc.promotedSpaceId}” ──▶`
          : "space: not promoted"}
      </p>

      {arc.stillGrowing && (
        <p className="arc__growing">
          <span aria-hidden="true">⟳ </span>
          still growing — {arc.growingNote ?? "older history queued"}
        </p>
      )}

      <p className="arc__gestures">
        <button
          type="button"
          className="arc__why"
          aria-expanded={why}
          onClick={() => setWhy((v) => !v)}
        >
          why together?
        </button>
        <button type="button" disabled={busy} onClick={() => setForm("split")}>
          split arc
        </button>
        <button type="button" disabled={busy} onClick={() => setForm("merge")}>
          merge
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onGesture({ kind: "pin", id: arc.id, pinned: !arc.pinned })}
        >
          {arc.pinned ? "unpin" : "pin"}
        </button>
        <button type="button" disabled={busy} onClick={() => setForm("relabel")}>
          relabel
        </button>
      </p>

      {form === "merge" && (
        <MergeForm arc={arc} peers={others} onGesture={onGesture} onClose={close} />
      )}
      {form === "split" && <SplitForm arc={arc} onGesture={onGesture} onClose={close} />}
      {form === "relabel" && <RelabelForm arc={arc} onGesture={onGesture} onClose={close} />}
    </li>
  );
}
