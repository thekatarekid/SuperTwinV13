// ===========================================================================
// Library — build P2.4, spec §14.3.2.
//
// Per-source view of what's captured + per-source trust controls, inline
// where the data lives:
//   Chats    streams with tier badges, category, per-chat "knows you" range,
//            live counts, and the per-stream capture ⏸.
//   Browser  today's domains, recent visit chains with dwell + filing chips,
//            and the bookmark shelf.
//   Screen   a day strip (hour histogram) of session cards, plus the privacy
//            controls — including the honest cascading delete: deleting a
//            session hard-deletes its events AND everything derived from
//            them (worker library/delete-cascade.ts).
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  deleteScreenSpan,
  fetchLibraryBrowser,
  fetchLibraryChats,
  fetchLibraryScreen,
  pauseStream,
  type ChatStreamRow,
  type LibraryBrowser,
  type LibraryScreen,
  type ScreenSessionCard,
} from "../lib/api";

function knowsFromLabel(ts: string | null): string {
  if (!ts) return "not yet understood";
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const twoYears = 2 * 365.25 * 24 * 3600 * 1000;
  const left =
    Date.now() - d.getTime() >= twoYears
      ? String(d.getUTCFullYear())
      : `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `knows you: ${left} →`;
}

function relative(ts: string | null): string {
  if (!ts) return "";
  const min = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function hhmm(ts: string): string {
  return new Date(ts).toISOString().slice(11, 16);
}

export function Library(): JSX.Element {
  const [chats, setChats] = useState<ChatStreamRow[] | null>(null);
  const [browser, setBrowser] = useState<LibraryBrowser | null>(null);
  const [screen, setScreen] = useState<LibraryScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScreenSessionCard | null>(null);
  const [deleteSummary, setDeleteSummary] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, b, s] = await Promise.all([
        fetchLibraryChats(),
        fetchLibraryBrowser(),
        fetchLibraryScreen(),
      ]);
      setChats(c.streams);
      setBrowser(b);
      setScreen(s);
      setError(null);
    } catch {
      setError("worker unreachable");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function togglePause(row: ChatStreamRow): Promise<void> {
    try {
      await pauseStream(row.id, row.capture_paused !== 1);
      await refresh();
    } catch {
      setError("pause failed");
    }
  }

  async function runDelete(session: ScreenSessionCard): Promise<void> {
    try {
      const { report } = await deleteScreenSpan({
        start_ts: session.started_at,
        end_ts: session.ended_at,
        stream_key: session.stream_key,
      });
      setConfirmDelete(null);
      setDeleteSummary(
        `deleted ${report.events_deleted} events · ${report.episodes_deleted} episodes · ` +
          `${report.claims_deleted} claims · ${report.tasks_deleted} tasks — gone for good`,
      );
      await refresh();
    } catch {
      setError("delete failed");
    }
  }

  if (error) {
    return (
      <div className="stub">
        <h1>Library</h1>
        <p>{error}</p>
      </div>
    );
  }

  const maxHour = screen ? Math.max(1, ...screen.hours) : 1;

  return (
    <div className="library">
      <section className="card" aria-label="Chats">
        <h2>Chats</h2>
        {!chats || chats.length === 0 ? (
          <p className="empty">no chat streams captured yet</p>
        ) : (
          chats.map((s) => (
            <div className="row static" key={s.id}>
              <span className="glyph">{s.stream_kind === "group" ? "⬡" : "◙"}</span>
              <span>{s.label ?? s.external_key}</span>
              {s.tier && <span className="chip">{s.tier}</span>}
              {s.category && (
                <span className="chip">
                  {s.category === "cat1" ? "Cat-1" : "Cat-2"}
                </span>
              )}
              <span className="meta">
                {s.category === "cat2" && s.knows_from == null
                  ? "never replied (reply promotes)"
                  : knowsFromLabel(s.knows_from)}
              </span>
              <span className="meta">
                {s.today_count > 0 ? `${s.today_count} msgs today` : relative(s.last_ts)}
              </span>
              <button
                type="button"
                className="linklike"
                aria-label={`${s.capture_paused === 1 ? "resume" : "pause"} ${s.label ?? s.external_key}`}
                title={s.capture_paused === 1 ? "resume capture" : "pause capture"}
                onClick={() => void togglePause(s)}
              >
                {s.capture_paused === 1 ? "▶" : "⏸"}
              </button>
            </div>
          ))
        )}
      </section>

      <section className="card" aria-label="Browser">
        <h2>Browser</h2>
        {!browser || (browser.domains_today.length === 0 && browser.chains.length === 0) ? (
          <p className="empty">no browsing captured yet</p>
        ) : (
          <>
            {browser.domains_today.length > 0 && (
              <div className="row static">
                <span className="glyph">today</span>
                <span>
                  {browser.domains_today
                    .slice(0, 5)
                    .map((d) => `${d.domain} ×${d.visits}`)
                    .join(" · ")}
                </span>
                <span className="meta">(visit chains)</span>
              </div>
            )}
            {browser.chains.slice(0, 5).map((c) => (
              <div className="row static" key={c.stream_key}>
                <span className="glyph">chain</span>
                <span>
                  {c.visits
                    .slice(0, 4)
                    .map((v) => v.title ?? v.url)
                    .join(" → ")}
                  {c.visits.length > 4 ? " → …" : ""}
                </span>
                {c.space_label && <span className="chip accent">→ {c.space_label}</span>}
                <span className="meta">
                  {Math.round(c.visits.reduce((a, v) => a + v.dwell_ms, 0) / 60_000)} min
                </span>
              </div>
            ))}
            {browser.bookmarks.length > 0 && (
              <div className="row static">
                <span className="glyph">★ shelf</span>
                <span>
                  {browser.bookmarks
                    .slice(0, 4)
                    .map((b) => b.title ?? b.url)
                    .join(" · ")}
                </span>
                <span className="meta">(filing chips)</span>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card" aria-label="Screen">
        <h2>Screen</h2>
        {!screen || screen.sessions.length === 0 ? (
          <p className="empty">no screen sessions captured yet</p>
        ) : (
          <>
            <div className="day-strip" aria-label="day strip">
              {screen.hours.map((n, h) => (
                <span
                  key={h}
                  className="day-strip-bar"
                  style={{ height: `${4 + Math.round((n / maxHour) * 20)}px` }}
                  title={`${String(h).padStart(2, "0")}:00 — ${n} events`}
                />
              ))}
            </div>
            {screen.sessions.map((s) => (
              <div className="row static" key={`${s.stream_key}-${s.started_at}`}>
                <span className="glyph">⬡</span>
                <span>
                  {hhmm(s.started_at)} {s.app} {s.minutes}m
                </span>
                <span className="meta">{s.event_count} captures</span>
                <button
                  type="button"
                  className="linklike"
                  aria-label={`delete session ${s.app} ${hhmm(s.started_at)}`}
                  onClick={() => setConfirmDelete(s)}
                >
                  delete…
                </button>
              </div>
            ))}
          </>
        )}
        <p className="privacy-line">
          privacy: pause · blocklist app… · delete a span… (honest delete — everything derived
          from deleted captures goes with them)
        </p>
        {deleteSummary && (
          <p className="empty" role="status">
            {deleteSummary}
          </p>
        )}
      </section>

      {confirmDelete && (
        <div className="modal-scrim" role="presentation" onClick={() => setConfirmDelete(null)}>
          <div
            className="modal"
            role="dialog"
            aria-label="confirm honest delete"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span className="title">Delete this screen session?</span>
            </header>
            <p>
              {hhmm(confirmDelete.started_at)} {confirmDelete.app} · {confirmDelete.minutes}m ·{" "}
              {confirmDelete.event_count} captures
            </p>
            <p>
              This is an honest delete: the captures AND everything the twin derived from them —
              episodes, claims, tasks, digests — are removed for good. It cannot be undone.
            </p>
            <div className="btn-row">
              <button type="button" className="btn primary" onClick={() => void runDelete(confirmDelete)}>
                Delete for good
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
