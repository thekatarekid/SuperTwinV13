// ===========================================================================
// Timeline — the event log rendered (build P4.1, spec §14.3.1).
//
// Unified, newest-first: day scrubber, source / person / space filters, rows
// that group micro-events (a message burst, a visit chain) into one line, a
// filing chip (→ space) on every filed row, and click → modal. Twin actions
// (source "twin", incl. bar threads) are first-class rows on the same
// timeline. Paging rides the worker's `next_before` cursor ("show more").
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  fetchTimeline,
  fetchTimelineDays,
  type SpaceRow,
  type TimelineRowView,
} from "../lib/api";

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
  const [rows, setRows] = useState<TimelineRowView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [days, setDays] = useState<{ day: string; count: number }[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [person, setPerson] = useState("");
  const [space, setSpace] = useState("");
  const [jumpDay, setJumpDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<TimelineRowView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (append: boolean, before?: string) => {
      try {
        const page = await fetchTimeline({
          before,
          source: source || undefined,
          person: person || undefined,
          space: space || undefined,
        });
        setRows((prev) => (append ? [...prev, ...page.rows] : page.rows));
        setNextBefore(page.next_before);
        setError(null);
      } catch {
        setError("worker unreachable");
      }
    },
    [source, person, space],
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
  for (const row of rows) {
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

      {error && <p className="error">{error}</p>}
      {!error && rows.length === 0 && <p className="empty">nothing captured yet</p>}

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
