// ===========================================================================
// Timeline — the event log rendered (build P4.1, spec §14.3.1).
//
// Unified, newest-first: day scrubber, source / person / space filters, rows
// that group micro-events (a message burst, a visit chain) into one line, a
// filing chip (→ space) on every filed row, and click → modal. Twin actions
// (source "twin", incl. bar threads) are first-class rows on the same
// timeline. Paging rides the worker's `next_before` cursor ("show more").
//
// ---------------------------------------------------------------------------
// FIX-C4 — "NOTHING CAPTURED YET" OVER A LOG WITH THOUSANDS OF ROWS.
//
// `rows` started as `[]`, and `[]` was rendered as the verdict: the screen's
// first frame said "nothing captured yet" while /api/timeline was still on the
// wire. On the user's own worker that read took ~15 s (better-sqlite3 is
// synchronous and a WhatsApp import held the database), and it answered 200
// with rows — so the screen spent fifteen seconds denying an event log it was
// about to render.
//
// Two changes, both from the L2 contract in components/LoadState.tsx:
//
//   * `null` is NO ANSWER YET and paints a skeleton; `[]` is the answer
//     "nothing", and only that prints the empty line.
//   * the answered page is kept in the pane cache, so coming back to the tab
//     repaints the last timeline in the same frame and re-reads underneath —
//     the main tabs stop costing a cold aggregate every time they are opened.
//     Only the UNFILTERED first page is cached: a filtered view is a different
//     question and must not be served from the base view's answer.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { LoadFailure, PanelSkeleton, RefreshingHint, useCachedRead } from "../components/LoadState";
import {
  describeWorkerError,
  fetchTimeline,
  fetchTimelineDays,
  type SpaceRow,
  type TimelineRowView,
} from "../lib/api";

/** What the pane cache holds for the base (unfiltered, un-jumped) view. */
interface TimelinePage {
  rows: TimelineRowView[];
  next_before: string | null;
}

const TIMELINE_CACHE_KEY = "timeline.page";

const SOURCE_GLYPHS: Record<string, string> = {
  wa: "⬡ WhatsApp",
  browser: "⬡ browser",
  screen: "⬡ screen",
  twin: "◆ twin",
};

function sourceLabel(source: string): string {
  return SOURCE_GLYPHS[source] ?? `⬡ ${source}`;
}

function timeOf(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayOf(ts: string): string {
  return ts.slice(0, 10);
}

function dayHeading(day: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (day === today) return "TODAY";
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (day === yesterday) return "YESTERDAY";
  return day;
}

export function Timeline(props: {
  spaces: SpaceRow[];
  /** Filing chip click → the space modal (spec §14.3.1). */
  onOpenSpace: (spaceId: string) => void;
}): JSX.Element {
  const cache = useCachedRead<TimelinePage>(TIMELINE_CACHE_KEY);
  // null is "no answer yet" — the whole point. [] is the answer "nothing".
  const [rows, setRows] = useState<TimelineRowView[] | null>(cache.seed?.rows ?? null);
  const [nextBefore, setNextBefore] = useState<string | null>(cache.seed?.next_before ?? null);
  const [days, setDays] = useState<{ day: string; count: number }[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [person, setPerson] = useState("");
  const [space, setSpace] = useState("");
  const [jumpDay, setJumpDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<TimelineRowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The rows on screen belong to the base view, so a base-view read may cache
  // its answer. A filtered read must not (it is a different question), and
  // "show more" must not either (the cache holds the first page).
  const filtered = source !== "" || person !== "" || space !== "" || jumpDay !== null;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const load = useCallback(
    async (append: boolean, before?: string) => {
      setLoading(true);
      const cacheable = !append && !filteredRef.current;
      // Newest issue wins: a slow first reply must not overwrite the answer a
      // later read already delivered, on screen or in the cache (L2).
      const token = cache.begin();
      try {
        const page = await fetchTimeline({
          before,
          source: source || undefined,
          person: person || undefined,
          space: space || undefined,
        });
        if (!cache.accept(token)) return;
        setRows((prev) => (append ? [...(prev ?? []), ...page.rows] : page.rows));
        setNextBefore(page.next_before);
        setError(null);
        if (cacheable) cache.publish(token, { rows: page.rows, next_before: page.next_before });
      } catch (err) {
        if (!cache.accept(token)) return;
        setError(describeWorkerError(err));
      } finally {
        setLoading(false);
      }
    },
    [source, person, space, cache],
  );

  useEffect(() => {
    // Jumping to a scrubber day pages from that day's end; otherwise the top.
    void load(false, jumpDay ? `${jumpDay}T23:59:59.999Z` : undefined);
  }, [load, jumpDay]);

  useEffect(() => {
    void fetchTimelineDays()
      .then((d) => {
        setDays(d.days);
        setSources(d.sources);
      })
      .catch(() => {});
  }, []);

  // Group rows under day headings.
  const grouped: { day: string; rows: TimelineRowView[] }[] = [];
  for (const row of rows ?? []) {
    const day = dayOf(row.ts);
    const last = grouped[grouped.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else grouped.push({ day, rows: [row] });
  }

  return (
    <div className="timeline" aria-label="Timeline">
      <div className="timeline-filters">
        <select aria-label="source filter" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          aria-label="person filter"
          placeholder="person"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
        />
        <select aria-label="space filter" value={space} onChange={(e) => setSpace(e.target.value)}>
          <option value="">any space</option>
          {props.spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="day-scrubber" aria-label="day scrubber">
        {days.map((d) => (
          <button
            key={d.day}
            type="button"
            className={jumpDay === d.day ? "scrub-day active" : "scrub-day"}
            title={`${d.day} · ${d.count} events`}
            onClick={() => setJumpDay(jumpDay === d.day ? null : d.day)}
          >
            {d.day.slice(8, 10)}
          </button>
        ))}
      </div>

      {error && (
        <LoadFailure
          what="the timeline"
          error={error}
          onRetry={() => void load(false, jumpDay ? `${jumpDay}T23:59:59.999Z` : undefined)}
          retrying={loading}
        />
      )}
      {/* Unknown is not empty: no answer yet means a skeleton, and the empty
          line only once the worker has actually said "nothing" (FIX-C4). */}
      {!error && rows === null && <PanelSkeleton what="your timeline" rows={5} />}
      {!error && rows !== null && rows.length === 0 && (
        <p className="empty">nothing captured yet</p>
      )}
      {rows !== null && <RefreshingHint active={loading} what="the timeline" />}

      {grouped.map((group) => (
        <section key={group.day} aria-label={dayHeading(group.day)}>
          <h3 className="day-heading">{dayHeading(group.day)}</h3>
          {group.rows.map((row) => (
            <div key={row.id} className="timeline-row">
              <button
                type="button"
                className="timeline-row-main"
                aria-label={`event ${row.id}`}
                onClick={() => setSelected(row)}
              >
                <span className="time">{timeOf(row.ts)}</span>
                <span className="source">{sourceLabel(row.source)}</span>
                <span className="who">{row.chat ?? row.actor ?? ""}</span>
                <span className="text">
                  {row.text}
                  {row.count > 1 ? ` ×${row.count}` : ""}
                </span>
              </button>
              {row.space_id ? (
                <button
                  type="button"
                  className="chip filing-chip"
                  aria-label={`filed under ${row.space_label ?? row.space_id}`}
                  onClick={() => props.onOpenSpace(row.space_id!)}
                >
                  → {row.space_label ?? row.space_id}
                </button>
              ) : (
                <span className="chip filing-chip unsorted">→ unsorted ⚑</span>
              )}
            </div>
          ))}
        </section>
      ))}

      {nextBefore && (
        <button type="button" className="linklike" onClick={() => void load(true, nextBefore)}>
          show more
        </button>
      )}

      {selected && (
        <div className="modal-scrim" onClick={() => setSelected(null)} data-testid="modal-scrim">
          <section
            className="modal"
            role="dialog"
            aria-label={`event ${selected.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2 className="title">{sourceLabel(selected.source)}</h2>
              <span className="chip">{selected.kind ?? "event"}</span>
              {selected.space_label && <span className="chip">→ {selected.space_label}</span>}
            </header>
            <p style={{ color: "var(--ink-2)" }}>
              {selected.ts}
              {selected.count > 1 ? ` — ${selected.count} events to ${selected.end_ts}` : ""}
              {selected.chat ? ` · ${selected.chat}` : ""}
              {selected.actor ? ` · ${selected.actor}` : ""}
            </p>
            <p>{selected.text}</p>
            <footer>
              {selected.space_id && (
                <button
                  type="button"
                  className="linklike"
                  onClick={() => {
                    setSelected(null);
                    props.onOpenSpace(selected.space_id!);
                  }}
                >
                  open space
                </button>
              )}
              <button type="button" className="linklike" onClick={() => setSelected(null)}>
                close
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
