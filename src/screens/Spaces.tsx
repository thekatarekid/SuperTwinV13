// ===========================================================================
// Spaces view — V6 P1 S5.1 (Build §8 lane A; Product_V6_Phase1 §13.5).
//
// A top-level nav destination. Two panes:
//
//   LIST   every active space grouped by LIFE AREA, in spec order with
//          "Other" last and a dormant bucket of its own. Direct manipulation
//          IS the correction: dragging a space card onto another life-area
//          group posts /api/spaces/:id/refile — applied at once, a decisions
//          row, undoable from the why-panel like every other change. A
//          dormant space carries a "wake" button (the WOKEN birth by hand;
//          the calendar's lead time does the same thing on its own).
//
//   VIEW   one space: goal · summary · latest · plan · the milestone rail
//          (only when the goal is staged) · tasks · follow-ups · people ·
//          enrichment · the evidence timeline · and HOW IT WAS BORN, with
//          the utterance or messages that justified it.
//
//          Every element carries a "why?" — one panel per element, fetched
//          from the decisions ledger for that (kind, id), never a modal per
//          object. Dragging an episode out of the timeline re-files it: onto
//          another space, or onto "unsorted" to take it back out.
//
// Drag state lives in React (not dataTransfer) so the interaction — and its
// tests — run identically under jsdom and the real webview.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  describeWorkerError,
  fetchSpaceView,
  fetchSpacesList,
  refileEpisode,
  refileSpace,
  wakeSpace,
  LIFE_AREAS,
  OTHER_AREA,
  type SpaceListRow,
  type SpaceView,
  type SpacesList,
} from "../lib/api";
import { LoadFailure } from "../components/LoadState";
import { WhyPanel } from "../components/WhyPanel";
import type { TargetKind } from "../lib/api";

const AREAS: string[] = [...LIFE_AREAS, OTHER_AREA];

/** The one open why-panel: which element it belongs to. */
interface WhyTarget {
  kind: TargetKind;
  id: string;
  label: string;
}

function Why(props: { target: WhyTarget | null; on: WhyTarget; open: (t: WhyTarget | null) => void }): JSX.Element {
  const isOpen = props.target?.kind === props.on.kind && props.target?.id === props.on.id;
  return (
    <>
      <button
        type="button"
        className="linklike"
        aria-label={`why ${props.on.label}`}
        aria-expanded={isOpen}
        onClick={() => props.open(isOpen ? null : props.on)}
      >
        why?
      </button>
      {isOpen && <WhyPanel kind={props.on.kind} id={props.on.id} />}
    </>
  );
}

function birthLine(view: SpaceView): string {
  switch (view.birth.via) {
    case "asked":
      return "you asked for this in the bar";
    case "woken":
      return `woken${view.birth.woken_at ? ` ${view.birth.woken_at.slice(0, 10)}` : ""} — reactivated with its old evidence`;
    case "inferred":
      return "the twin inferred this from what it saw";
    default:
      return "born before the twin recorded how";
  }
}

export function Spaces(props: {
  /** Context-locks the grounded bar to a space ("Tell the twin"). */
  onTellTwin?: (spaceId: string, label: string) => void;
}): JSX.Element {
  const [list, setList] = useState<SpacesList | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<SpaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState<SpaceListRow | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [dragEpisode, setDragEpisode] = useState<string | null>(null);
  const [overSpace, setOverSpace] = useState<string | null>(null);
  const [why, setWhy] = useState<WhyTarget | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setList(await fetchSpacesList());
      setError(null);
    } catch (err) {
      setError(describeWorkerError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (openId === null) {
      setView(null);
      return;
    }
    let cancelled = false;
    fetchSpaceView(openId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`couldn't open that space — ${describeWorkerError(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [openId]);

  async function dropOnArea(area: string): Promise<void> {
    const space = dragging;
    setDragging(null);
    setOver(null);
    if (!space || space.area === area) return;
    try {
      const r = await refileSpace(space.id, area);
      setNote(r.moved ? `${space.label} → ${area}` : (r.reason ?? "nothing moved"));
      await refresh();
    } catch (err) {
      setError(`re-file failed — ${describeWorkerError(err)}`);
    }
  }

  async function dropEpisodeOn(toSpaceId: string | null): Promise<void> {
    const episodeId = dragEpisode;
    const from = openId;
    setDragEpisode(null);
    setOverSpace(null);
    if (!episodeId || !from || toSpaceId === from) return;
    try {
      const r = await refileEpisode(from, episodeId, toSpaceId);
      setNote(r.moved ? `episode → ${toSpaceId ?? "unsorted"}` : (r.reason ?? "nothing moved"));
      setView(await fetchSpaceView(from));
      await refresh();
    } catch (err) {
      setError(`re-file failed — ${describeWorkerError(err)}`);
    }
  }

  async function wake(space: SpaceListRow): Promise<void> {
    try {
      const r = await wakeSpace(space.id, "user");
      setNote(r.woke ? `${space.label} is awake` : (r.reason ?? "already awake"));
      await refresh();
    } catch (err) {
      setError(`couldn't wake that space — ${describeWorkerError(err)}`);
    }
  }

  if (error && list === null) {
    return (
      <div className="spaces-screen">
        <section className="card" aria-label="Spaces">
          <h2>Spaces</h2>
          <LoadFailure what="Spaces" error={error} onRetry={() => void refresh()} retrying={loading} />
        </section>
      </div>
    );
  }

  const byArea = new Map<string, SpaceListRow[]>();
  for (const a of AREAS) byArea.set(a, []);
  for (const group of list?.areas ?? []) {
    byArea.set(group.area, [...(byArea.get(group.area) ?? []), ...group.spaces]);
  }
  const total = (list?.areas ?? []).reduce((n, a) => n + a.spaces.length, 0);

  return (
    <div className="spaces-screen">
      <section className="card spaces" aria-label="Spaces">
        <h2>Spaces</h2>
        {list !== null && total === 0 && (list?.dormant.length ?? 0) === 0 && (
          <p className="empty">no spaces yet — ask for one in the bar, or wait for the twin to propose one</p>
        )}

        {AREAS.map((area) => {
          const rows = byArea.get(area) ?? [];
          // Empty areas stay as drop targets only while a card is in the air.
          if (rows.length === 0 && dragging === null) return null;
          return (
            <div
              key={area}
              className={`area-group${over === area ? " drop-target" : ""}`}
              aria-label={`life area ${area}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragging) setOver(area);
              }}
              onDragLeave={() => setOver((v) => (v === area ? null : v))}
              onDrop={() => void dropOnArea(area)}
            >
              <h3 className="area-title">
                ▤ {area}
                <span className="meta"> {rows.length}</span>
              </h3>
              {rows.map((s) => (
                <div
                  key={s.id}
                  className="row space"
                  role="button"
                  tabIndex={0}
                  draggable
                  aria-label={`space ${s.label}`}
                  onDragStart={() => setDragging(s)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onClick={() => setOpenId(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setOpenId(s.id);
                  }}
                >
                  <span className="glyph">◈</span>
                  <span>{s.label}</span>
                  {s.task_count > 0 && <span className="chip">{s.task_count} open</span>}
                  {s.next_action && <span className="meta"> next: {s.next_action}</span>}
                  {s.born_via === "asked" && <span className="chip">you asked</span>}
                </div>
              ))}
              {rows.length === 0 && <p className="empty">drop a space here</p>}
            </div>
          );
        })}

        {(list?.dormant.length ?? 0) > 0 && (
          <div className="area-group dormant" aria-label="dormant spaces">
            <h3 className="area-title">
              ◌ Dormant<span className="meta"> {list!.dormant.length}</span>
            </h3>
            {list!.dormant.map((s) => (
              <div key={s.id} className="row space" aria-label={`dormant space ${s.label}`}>
                <span className="glyph">◌</span>
                <button type="button" className="linklike" onClick={() => setOpenId(s.id)}>
                  {s.label}
                </button>
                <button type="button" className="linklike" aria-label={`wake ${s.label}`} onClick={() => void wake(s)}>
                  wake
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {view && (
        <section className="card space-view" aria-label={`space view ${view.space.label}`}>
          <h2>{view.space.label}</h2>
          <button type="button" className="linklike" aria-label="close space" onClick={() => setOpenId(null)}>
            close
          </button>

          <p className="meta">
            {view.area}
            {view.space.status !== "active" && ` · ${view.space.status}`}
          </p>
          {view.space.goal && <p aria-label="goal">{view.space.goal}</p>}
          {view.space.summary && <p aria-label="summary">{view.space.summary}</p>}
          {view.space.latest && <p aria-label="latest">latest: {view.space.latest}</p>}
          <Why target={why} on={{ kind: "space", id: view.space.id, label: "this space" }} open={setWhy} />

          <div aria-label="born">
            <h3>Born</h3>
            <p>{birthLine(view)}</p>
            {view.birth.evidence.map((e, i) => (
              <blockquote key={i} aria-label="birth evidence">
                “{e.quote}”
              </blockquote>
            ))}
            {view.birth.thread_id && (
              <button
                type="button"
                className="linklike"
                aria-label="open the bar thread"
                onClick={() => props.onTellTwin?.(view.space.id, view.space.label)}
              >
                open the thread
              </button>
            )}
          </div>

          {view.milestones.length > 0 && (
            <div aria-label="milestones">
              <h3>Milestones</h3>
              {view.milestones.map((m) => (
                <div className="row" key={m.id}>
                  <span>{m.label}</span>
                  <span className="meta"> {m.target_date}</span>
                  <span className="chip">{m.status}</span>
                </div>
              ))}
            </div>
          )}

          <div aria-label="tasks">
            <h3>Tasks</h3>
            {view.tasks.length === 0 && <p className="empty">nothing open</p>}
            {view.tasks.map((t) => (
              <div className="row" key={t.id} aria-label={`task ${t.title}`}>
                <span>{t.title}</span>
                {t.due && <span className="meta"> due {t.due}</span>}
                <span className="chip">{t.status}</span>
                <Why target={why} on={{ kind: "task", id: t.id, label: t.title }} open={setWhy} />
              </div>
            ))}
          </div>

          {view.people.length > 0 && (
            <div aria-label="people">
              <h3>People</h3>
              <p>{view.people.join(" · ")}</p>
            </div>
          )}

          {view.enrichments.length > 0 && (
            <div aria-label="enrichment">
              <h3>Enrichment</h3>
              {view.enrichments.map((e) => (
                <div className="row" key={e.id}>
                  <span>
                    {e.kind}: {e.summary}
                  </span>
                  <span className="meta"> changed {e.changed_at.slice(0, 10)}</span>
                </div>
              ))}
            </div>
          )}

          <div aria-label="evidence">
            <h3>Evidence</h3>
            {view.episodes.length === 0 && <p className="empty">nothing filed here yet</p>}
            {view.episodes.map((ep) => (
              <div
                className="row episode"
                key={ep.id}
                draggable
                aria-label={`episode ${ep.summary ?? ep.id}`}
                onDragStart={() => setDragEpisode(ep.id)}
                onDragEnd={() => {
                  setDragEpisode(null);
                  setOverSpace(null);
                }}
              >
                <span>{ep.summary ?? ep.id}</span>
                {ep.last_ts && <span className="meta"> {ep.last_ts.slice(0, 10)}</span>}
                {ep.quotes[0]?.text && <blockquote>“{ep.quotes[0].text}”</blockquote>}
                <Why target={why} on={{ kind: "episode", id: ep.id, label: ep.summary ?? ep.id }} open={setWhy} />
              </div>
            ))}
          </div>

          {dragEpisode && (
            <div aria-label="re-file targets">
              <h3>Move it to</h3>
              {(list?.areas ?? [])
                .flatMap((a) => a.spaces)
                .filter((s) => s.id !== view.space.id)
                .map((s) => (
                  <div
                    key={s.id}
                    className={`row drop${overSpace === s.id ? " drop-target" : ""}`}
                    aria-label={`re-file into ${s.label}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOverSpace(s.id);
                    }}
                    onDragLeave={() => setOverSpace((v) => (v === s.id ? null : v))}
                    onDrop={() => void dropEpisodeOn(s.id)}
                  >
                    {s.label}
                  </div>
                ))}
              <div
                className={`row drop${overSpace === "unsorted" ? " drop-target" : ""}`}
                aria-label="re-file into unsorted"
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverSpace("unsorted");
                }}
                onDragLeave={() => setOverSpace((v) => (v === "unsorted" ? null : v))}
                onDrop={() => void dropEpisodeOn(null)}
              >
                unsorted
              </div>
            </div>
          )}
        </section>
      )}

      {note && (
        <div className="undo-toast" role="status">
          <span>{note}</span>
          <button type="button" className="linklike" aria-label="dismiss" onClick={() => setNote(null)}>
            ✕
          </button>
        </div>
      )}
      {error && list !== null && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" className="linklike" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}
    </div>
  );
}
