// ===========================================================================
// Library › Screen — what the twin read off your screen (spec §14.3.2, §4.2.2).
//
// Sessions are grouped BY APP (bundle id) and then by the document/window
// inside it, because that is how a day is actually remembered — "Figma, 40
// minutes, the v13 mocks" — not as forty four-minute rows. The day strip keeps
// the hour histogram, and every privacy control stays inline where the data
// lives: pause capture, and the honest cascading delete (deleting a session
// removes its captures AND everything the twin derived from them).
//
// Not connected is the Accessibility permission flow, not an empty list.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import { LoadFailure } from "../../components/LoadState";
import {
  deleteScreenSpan,
  describeWorkerError,
  fetchLibraryScreen,
  fetchScreenStatus,
  pauseScreen,
  type LibraryScreen,
  type ScreenAppGroup,
  type ScreenSessionCard,
  type ScreenStatus,
} from "../../lib/api";
import { openExternal } from "../../lib/tauri";
import { ConnectCard, hhmm, minutesLabel } from "./shared";

/** Roll flat session cards up by app when the worker predates the grouping. */
function groupByApp(data: LibraryScreen): ScreenAppGroup[] {
  if (data.apps) return data.apps;
  const apps = new Map<string, ScreenAppGroup>();
  for (const s of data.sessions) {
    const bundle = s.bundle_id ?? s.stream_key;
    let app = apps.get(bundle);
    if (!app) {
      app = { bundle_id: bundle, app: s.app, minutes: 0, event_count: 0, session_count: 0, docs: [] };
      apps.set(bundle, app);
    }
    app.minutes += s.minutes;
    app.event_count += s.event_count;
    app.session_count++;
    const doc = s.doc ?? null;
    let group = app.docs.find((d) => d.doc === doc);
    if (!group) {
      group = { doc, minutes: 0, event_count: 0, sessions: [] };
      app.docs.push(group);
    }
    group.minutes += s.minutes;
    group.event_count += s.event_count;
    group.sessions.push(s);
  }
  return [...apps.values()].sort((a, b) => b.minutes - a.minutes);
}

export function ScreenLibrary(): JSX.Element {
  const [data, setData] = useState<LibraryScreen | null>(null);
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScreenSessionCard | null>(null);
  const [deleteSummary, setDeleteSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Action failures keep their own line: the library on screen is still valid.
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchLibraryScreen());
      setError(null);
    } catch (err) {
      setError(describeWorkerError(err));
    }
    try {
      setStatus(await fetchScreenStatus());
    } catch {
      setStatus(null); // the sidecar may simply not be installed
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    } catch (err) {
      setActionError(`delete failed — ${describeWorkerError(err)}`);
    }
  }

  if (error && !data) {
    return (
      <ConnectCard
        glyph="⬡"
        title="Screen"
        body="The worker isn't answering, so SuperTwin can't tell what it has read off your screen."
        actions={[{ label: loading ? "retrying…" : "Retry", onClick: () => void refresh(), disabled: loading }]}
        note={error}
      />
    );
  }

  // Permission missing is the reason to show the connect flow — but only while
  // there is nothing to show. Captures already on disk are the user's own
  // history; hiding them behind a permission card would be the same mistake as
  // hiding them behind an empty string. With data present the permission ask
  // rides on top of the data instead (the notice below).
  const needsPermission =
    !!status && (status.state === "need_permission" || status.permission === false);
  const captured = (data?.event_count ?? data?.sessions.length ?? 0) > 0;

  if (needsPermission && !captured) {
    return (
      <ConnectCard
        glyph="⬡"
        title="Grant screen understanding"
        body="SuperTwin reads what's on your screen through the macOS Accessibility API — no screenshots, no recording. It needs the Accessibility permission before it can capture anything."
        actions={[
          {
            label: "Open System Settings",
            onClick: () => void openExternal(status.settingsUrl),
          },
          { label: "Check again", onClick: () => void refresh() },
        ]}
        note="System Settings › Privacy & Security › Accessibility — tick SuperTwin, then capture starts on its own."
      />
    );
  }

  if (!captured) {
    return (
      <ConnectCard
        glyph="⬡"
        title="Nothing read off your screen yet"
        body={
          status?.running
            ? "Screen capture is on and waiting — the first app you work in shows up here as a session."
            : "The screen watcher isn't running, so nothing is being read. It starts with the app; if it stays off, check the Accessibility permission."
        }
        actions={
          status
            ? [{ label: "Open System Settings", onClick: () => void openExternal(status.settingsUrl) }]
            : undefined
        }
        note="privacy: pause any time · blocklist an app · delete a span (honest delete)"
      />
    );
  }

  const apps = data ? groupByApp(data) : [];
  const maxHour = data ? Math.max(1, ...data.hours) : 1;

  return (
    <section className="card" aria-label="Screen">
      <header className="inbox-bar">
        <h2>Screen · {data?.day}</h2>
        <span className="inbox-bar-spacer" />
        <button
          type="button"
          className="btn"
          aria-label={data?.paused ? "resume screen capture" : "pause screen capture"}
          onClick={() =>
            void pauseScreen(!data?.paused)
              .then(refresh)
              .catch((err: unknown) => setActionError(`pause failed — ${describeWorkerError(err)}`))
          }
        >
          {data?.paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      </header>

      {needsPermission && status && (
        <p className="source-notice" role="status">
          Capture is blocked: the macOS Accessibility permission is off, so nothing new is being
          read. What's below is what was captured before.{" "}
          <button
            type="button"
            className="linklike"
            onClick={() => void openExternal(status.settingsUrl)}
          >
            Open System Settings
          </button>
        </p>
      )}

      <div className="day-strip" aria-label="day strip">
        {(data?.hours ?? []).map((n, h) => (
          <span
            key={h}
            className="day-strip-bar"
            style={{ height: `${4 + Math.round((n / maxHour) * 20)}px` }}
            title={`${String(h).padStart(2, "0")}:00 — ${n} events`}
          />
        ))}
      </div>

      {apps.length === 0 ? (
        <p className="empty">nothing captured on this day</p>
      ) : (
        apps.map((app) => (
          <div className="app-group" key={app.bundle_id}>
            <button
              type="button"
              className="row app-head"
              aria-label={`app ${app.app}`}
              aria-expanded={open === app.bundle_id}
              onClick={() => setOpen((v) => (v === app.bundle_id ? null : app.bundle_id))}
            >
              <span className="glyph">{open === app.bundle_id ? "▾" : "▸"}</span>
              <span className="app-name">{app.app}</span>
              <span className="chip">{app.bundle_id}</span>
              <span className="meta">
                {minutesLabel(app.minutes)} · {app.session_count} sessions · {app.event_count} captures
              </span>
            </button>
            {open === app.bundle_id &&
              app.docs.map((doc) => (
                <div className="doc-group" key={doc.doc ?? "—"}>
                  <p className="doc-title">
                    {doc.doc ?? "(no document)"} <span className="meta">{minutesLabel(doc.minutes)}</span>
                  </p>
                  {doc.sessions.map((s) => (
                    <div className="row static" key={`${s.stream_key}-${s.started_at}`}>
                      <span className="glyph">·</span>
                      <span>
                        {hhmm(s.started_at)} — {minutesLabel(s.minutes)}
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
                </div>
              ))}
          </div>
        ))
      )}

      <p className="privacy-line">
        privacy: pause · blocklist app… · delete a span… (honest delete — everything derived from
        deleted captures goes with them)
      </p>
      {deleteSummary && (
        <p className="empty" role="status">
          {deleteSummary}
        </p>
      )}
      {error && (
        <LoadFailure what="the screen library" error={error} onRetry={() => void refresh()} retrying={loading} />
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}{" "}
          <button type="button" className="linklike" onClick={() => setActionError(null)}>
            dismiss
          </button>
        </p>
      )}

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
              <button
                type="button"
                className="btn primary"
                onClick={() => void runDelete(confirmDelete)}
              >
                Delete for good
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
