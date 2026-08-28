// ===========================================================================
// Home — build P1.7, spec §14.2.
//
// Four sections on liquid glass: Today · Spaces · Review queue · Recent
// understanding. Sections scroll internally; no global feed. Every row opens
// its modal; task rows are draggable and space cards are drop targets —
// drag-move IS a correction (spec §14.4.1, FIX-05).
// ===========================================================================

import { useState, type DragEvent } from "react";
import type { ClaimRow, HomeData, SpaceRow, TaskRow } from "../lib/api";

const DRAG_MIME = "application/x-supertwin-object";

export interface HomeProps {
  data: HomeData | null;
  error: string | null;
  onOpenTask: (task: TaskRow) => void;
  onOpenSpace: (space: SpaceRow) => void;
  onOpenProposal: (proposal: SpaceRow) => void;
  onOpenClaim: (claim: ClaimRow) => void;
  /** Drag-move correction: a dragged object dropped on a space. */
  onDragMove: (target: { kind: "task"; id: string }, toSpaceId: string) => void;
}

export function Home(props: HomeProps): JSX.Element {
  const [dropSpace, setDropSpace] = useState<string | null>(null);
  const { data } = props;

  function handleDrop(e: DragEvent, spaceId: string): void {
    e.preventDefault();
    setDropSpace(null);
    const raw = e.dataTransfer?.getData(DRAG_MIME);
    if (!raw) return;
    try {
      const obj = JSON.parse(raw) as { kind: "task"; id: string };
      if (obj.kind === "task" && obj.id) props.onDragMove(obj, spaceId);
    } catch {
      // Not ours — ignore.
    }
  }

  if (props.error) {
    return (
      <div className="stub">
        <h1>Home</h1>
        <p>{props.error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="home-grid">
        <section className="card" aria-label="Today">
          <h2>Today</h2>
          {!data || data.today.length === 0 ? (
            <p className="empty">nothing needs you right now</p>
          ) : (
            data.today.map((t) => (
              <button
                type="button"
                className="row"
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer?.setData(DRAG_MIME, JSON.stringify({ kind: "task", id: t.id }));
                }}
                onClick={() => props.onOpenTask(t)}
              >
                <span className="glyph">▸</span>
                <span>{t.title}</span>
                <span className="meta">{t.due ? `due ${t.due}` : t.status}</span>
              </button>
            ))
          )}
        </section>

        <section className="card" aria-label="Spaces">
          <h2>Spaces</h2>
          {!data || data.spaces.length === 0 ? (
            <p className="empty">no spaces yet</p>
          ) : (
            data.spaces.map((s) => (
              <button
                type="button"
                className={`row${dropSpace === s.id ? " drop-target" : ""}`}
                key={s.id}
                data-space-id={s.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropSpace(s.id);
                }}
                onDragLeave={() => setDropSpace(null)}
                onDrop={(e) => handleDrop(e, s.id)}
                onClick={() => props.onOpenSpace(s)}
              >
                <span className="glyph">{s.status === "dormant" ? "○" : "●"}</span>
                <span>{s.label}</span>
                {s.life_area && <span className="meta">{s.life_area}</span>}
              </button>
            ))
          )}
        </section>

        <section className="card" aria-label="Review queue">
          <h2>Review queue</h2>
          {!data || data.review.length === 0 ? (
            <p className="empty">nothing to review</p>
          ) : (
            data.review.map((p) => (
              <button type="button" className="row" key={p.id} onClick={() => props.onOpenProposal(p)}>
                <span className="glyph">?</span>
                <span>New space: “{p.label}”</span>
              </button>
            ))
          )}
        </section>

        <section className="card" aria-label="Recent understanding">
          <h2>Recent understanding</h2>
          {!data || data.recent_understanding.length === 0 ? (
            <p className="empty">nothing learned yet</p>
          ) : (
            data.recent_understanding.map((c) => (
              <button type="button" className="row" key={c.id} onClick={() => props.onOpenClaim(c)}>
                <span className="glyph">+</span>
                <span>{c.text ?? c.claim_key}</span>
              </button>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
