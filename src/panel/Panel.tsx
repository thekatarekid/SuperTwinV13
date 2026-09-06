// ===========================================================================
// Menu-bar panel — build P2.3, spec §14.7. The 360px glass panel, same design
// language as the main window.
//
// Fixed order (§14.7.1): NEEDS YOU (approvals → questions, safe inline
// answers only — risky approvals always open the main window's approval
// modal, never one-tap here) → PREPARED (assist ◆ + executor ◇, newest
// unseen pinned with the ● dot, dismissed in the "older" drawer) → TODAY
// strip → mini ask-bar + version footer. `⏸ ▾` is the capture quick-pause.
//
// The panel polls /api/assist/panel AND /api/capture/state (V6 S1.7) and
// drives the tray glyph from what it sees: ⏸ when capture is paused (a
// private moment, the quick-pause, or every source paused), ● (n) when
// anything needs the user or an unseen nudge waits, ⏺ while something is
// actually being captured, ◉ otherwise. The glyph is the FUNNEL's answer —
// the capture state read reports what the consent rows and the running
// adapters say, not an assist flag (T4-9).
//
// Private moment (15 min) and "forget last 10 min" (preview → confirm) live
// here; the Rust tray menu and the ⌘⇧P hotkey emit `supertwin:capture-command`
// and this panel carries the command out (the menu bar has no HTTP client).
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import { LoadFailure } from "../components/LoadState";
import {
  artifactReopen,
  artifactSeen,
  describeWorkerError,
  endPrivateMoment,
  fetchCaptureState,
  fetchHealth,
  fetchPanel,
  forgetLastMinutes,
  pauseCapture,
  previewForget,
  startPrivateMoment,
  stopAllCapture,
  type ArtifactRow,
  type CascadePreview,
  type CaptureState,
  type PanelData,
} from "../lib/api";
import { hidePanelWindow, onTrayCommand, openMainWindow, setTrayState, type TrayCommand } from "../lib/tauri";

export const PANEL_POLL_MS = 5_000;
export const FORGET_MINUTES = 10;

function clock(ts: string | null): string {
  if (!ts) return "";
  const m = /T(\d{2}):(\d{2})/.exec(ts);
  return m ? `${m[1]}:${m[2]}` : "";
}

/**
 * The tray glyph. Precedence: ⏸ paused (a live pause deadline, or nothing
 * admitted while something is connected) > ● needs-you (counted) > ⏺
 * recording (an admitted, running source) > ◉ idle. `capture` is null while
 * the state read has not answered yet — then only the panel data speaks.
 */
export function trayStateFor(
  data: PanelData,
  capture: CaptureState | null = null,
): {
  state: "idle" | "recording" | "needs_you" | "paused";
  needsYou: number;
} {
  const pausedByDeadline = Boolean(data.capture_paused_until) || Boolean(capture?.paused);
  const allPaused =
    capture !== null &&
    capture.sources.some((s) => s.consent === "paused") &&
    capture.admitted.length === 0;
  if (pausedByDeadline || allPaused) return { state: "paused", needsYou: 0 };
  // V6 P1 S4.3: the icon carries the UNREAD counter — cards shown but not
  // opened — plus whatever still needs a tap. An older worker has no counter,
  // so the pinned nudge stands in for it.
  const unread = typeof data.unread === "number" ? data.unread : data.nudge ? 1 : 0;
  const needs = data.needs_you.approvals.length + data.needs_you.questions.length + unread;
  if (needs > 0) return { state: "needs_you", needsYou: needs };
  if (capture?.capturing) return { state: "recording", needsYou: 0 };
  return { state: "idle", needsYou: 0 };
}

function untilClock(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.ceil(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

export function Panel(): JSX.Element {
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [olderOpen, setOlderOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [ask, setAsk] = useState("");
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [forgetPreview, setForgetPreview] = useState<(CascadePreview & { minutes: number }) | null>(null);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchPanel();
      // The capture read is best-effort: an older worker without it leaves
      // the glyph to the panel data alone.
      const cap = await fetchCaptureState().catch(() => null);
      setData(next);
      setCapture(cap);
      setError(null);
      const tray = trayStateFor(next, cap);
      void setTrayState(tray.state, tray.needsYou);
    } catch (err) {
      setError(describeWorkerError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  async function privateMoment(): Promise<void> {
    setPauseOpen(false);
    await startPrivateMoment().catch(() => {});
    void refresh();
  }

  async function endPrivate(): Promise<void> {
    await endPrivateMoment().catch(() => {});
    void refresh();
  }

  async function stopCapture(): Promise<void> {
    setPauseOpen(false);
    const r = await stopAllCapture().catch(() => null);
    if (r) setNote(r.paused.length > 0 ? `paused ${r.paused.join(", ")}` : "nothing was capturing");
    void refresh();
  }

  async function openForget(): Promise<void> {
    setPauseOpen(false);
    setForgetBusy(true);
    try {
      const r = await previewForget(FORGET_MINUTES);
      setForgetPreview(r.preview);
    } catch {
      setNote("forget preview failed");
    } finally {
      setForgetBusy(false);
    }
  }

  async function confirmForget(): Promise<void> {
    if (!forgetPreview) return;
    setForgetBusy(true);
    try {
      const r = await forgetLastMinutes(forgetPreview.minutes);
      setNote(`forgot ${r.report.events_deleted} events, ${r.report.episodes_deleted} episodes`);
    } catch {
      setNote("forget failed");
    } finally {
      setForgetBusy(false);
      setForgetPreview(null);
      void refresh();
    }
  }

  // Tray menu / hotkey commands (Rust emits, the panel executes).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onTrayCommand((cmd: TrayCommand) => {
      if (cmd === "private-moment") void privateMoment();
      else if (cmd === "stop-capture") void stopCapture();
      else if (cmd === "forget-10") void openForget();
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    fetchHealth()
      .then((h) => setVersion(`v${h.version} · built through ${h.builtThroughPhase}`))
      .catch(() => {});
  }, []);

  // Esc hides the panel (never quits anything).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") void hidePanelWindow();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function open(artifact: ArtifactRow): Promise<void> {
    // Opening clears the ● dot everywhere (spec §14.7.8) and routes into the app.
    if (artifact.status === "new") await artifactSeen(artifact.id).catch(() => {});
    if (artifact.status === "dismissed") await artifactReopen(artifact.id).catch(() => {});
    await openMainWindow();
    await hidePanelWindow();
    void refresh();
  }

  async function quickPause(minutes: number | null): Promise<void> {
    setPauseOpen(false);
    await pauseCapture(minutes).catch(() => {});
    void refresh();
  }

  function submitAsk(): void {
    const q = ask.trim();
    if (q === "") return;
    // The mini ask-bar routes into the grounded bar (spec §14.7.4).
    try {
      window.localStorage.setItem("supertwin.ask", q);
    } catch {
      // Best-effort hand-off; the main window still opens.
    }
    setAsk("");
    void openMainWindow().then(() => hidePanelWindow());
  }

  if (error) {
    return (
      <div className="panel" data-testid="panel">
        <div className="panel-head">
          <span className="panel-title">SuperTwin</span>
        </div>
        <LoadFailure what="the panel" error={error} onRetry={() => void refresh()} retrying={loading} />
      </div>
    );
  }

  const prepared = data?.prepared ?? [];
  const older = data?.older ?? [];
  const privateUntil = capture?.private_until ?? null;
  const paused = Boolean(data?.capture_paused_until) || Boolean(capture?.paused);
  const recording = capture?.recording ?? [];
  const captureLine = privateUntil
    ? `private moment · ${untilClock(privateUntil)} left`
    : paused
      ? "capture paused"
      : recording.length > 0
        ? `capturing ${recording.join(", ")}`
        : capture
          ? "nothing capturing"
          : "";

  return (
    <div className="panel" data-testid="panel">
      <div className="panel-head">
        <span className="panel-title">SuperTwin</span>
        <div className="panel-pause">
          <button
            type="button"
            className="linklike"
            aria-label="capture pause"
            aria-expanded={pauseOpen}
            onClick={() => setPauseOpen((v) => !v)}
          >
            {recording.length > 0 && !paused ? "⏺" : "⏸"} ▾{paused ? " paused" : ""}
          </button>
          {pauseOpen && (
            <div className="panel-pause-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void privateMoment()}>
                private moment · 15 min
              </button>
              <button type="button" role="menuitem" onClick={() => void openForget()}>
                forget last {FORGET_MINUTES} min…
              </button>
              <button type="button" role="menuitem" onClick={() => void stopCapture()}>
                stop capture
              </button>
              <button type="button" role="menuitem" onClick={() => void quickPause(30)}>
                30 min
              </button>
              <button type="button" role="menuitem" onClick={() => void quickPause(120)}>
                2 h
              </button>
              <button type="button" role="menuitem" onClick={() => void quickPause(24 * 60)}>
                today
              </button>
              {paused && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void (privateUntil ? endPrivate() : quickPause(null))}
                >
                  resume
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {captureLine && (
        <p className="panel-capture-line" data-testid="capture-line">
          {captureLine}
        </p>
      )}
      {note && (
        <p className="panel-note" role="status">
          {note}{" "}
          <button type="button" className="linklike" onClick={() => setNote(null)}>
            ok
          </button>
        </p>
      )}
      {forgetPreview && (
        <section className="panel-forget" aria-label="Forget preview" data-testid="forget-preview">
          <h3>FORGET LAST {forgetPreview.minutes} MIN?</h3>
          <p>
            {forgetPreview.events_deleted} events · {forgetPreview.episodes_deleted} episodes ·{" "}
            {forgetPreview.spaces_touched} spaces · {forgetPreview.tasks_deleted} tasks — gone, with cascade. Not
            reversible.
          </p>
          <div className="panel-row">
            <button type="button" className="chip" disabled={forgetBusy} onClick={() => void confirmForget()}>
              forget
            </button>
            <button type="button" className="chip" disabled={forgetBusy} onClick={() => setForgetPreview(null)}>
              keep
            </button>
          </div>
        </section>
      )}

      <section aria-label="Needs you">
        <h3>NEEDS YOU</h3>
        {!data ||
        (data.needs_you.approvals.length === 0 && data.needs_you.questions.length === 0) ? (
          <p className="empty">nothing needs you</p>
        ) : (
          <>
            {data.needs_you.approvals.map((a) => (
              <div className="panel-row" key={a.id}>
                <span className="glyph">▸</span>
                <span className="grow">Approve: {a.title}</span>
                {/* Risky approvals ALWAYS open the approval modal in the app. */}
                <button type="button" className="chip" onClick={() => void openMainWindow()}>
                  view
                </button>
              </div>
            ))}
            {data.needs_you.questions.map((q) => (
              <div className="panel-row" key={q.id}>
                <span className="glyph">▸</span>
                <span className="grow">Q: {q.title}</span>
                <button type="button" className="chip" onClick={() => void openMainWindow()}>
                  answer
                </button>
              </div>
            ))}
          </>
        )}
      </section>

      <section aria-label="Prepared">
        <h3>PREPARED</h3>
        {prepared.length === 0 ? (
          <p className="empty">nothing prepared yet</p>
        ) : (
          prepared.map((a) => (
            <button
              type="button"
              className="panel-row rowlike"
              key={a.id}
              onClick={() => void open(a)}
            >
              <span className="glyph">{a.producer === "assist" ? "◆" : "◇"}</span>
              {a.status === "new" && (
                <span className="dot" aria-label="new" data-testid="new-dot">
                  ●
                </span>
              )}
              <span className="grow">{a.title}</span>
              <span className="meta">{clock(a.createdAt)}</span>
            </button>
          ))
        )}
        {older.length > 0 && (
          <button
            type="button"
            className="panel-row rowlike"
            aria-expanded={olderOpen}
            onClick={() => setOlderOpen((v) => !v)}
          >
            <span className="glyph">◇</span>
            <span className="grow">older (dismissed, kept)</span>
            <span className="meta">{olderOpen ? "▾" : "▸"}</span>
          </button>
        )}
        {olderOpen &&
          older.map((a) => (
            <button
              type="button"
              className="panel-row rowlike dim"
              key={a.id}
              onClick={() => void open(a)}
            >
              <span className="glyph">◇</span>
              <span className="grow">{a.title}</span>
              <span className="meta">{clock(a.createdAt)}</span>
            </button>
          ))}
      </section>

      <section aria-label="Today">
        <h3>TODAY</h3>
        {!data || data.today.length === 0 ? (
          <p className="empty">clear for now</p>
        ) : (
          <p className="panel-today">{data.today.map((t) => t.title).join(" · ")}</p>
        )}
      </section>

      <div className="panel-foot">
        <input
          value={ask}
          placeholder="⌕ ask…"
          aria-label="mini ask"
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitAsk();
          }}
        />
        <button type="button" className="linklike" onClick={() => void openMainWindow()}>
          open SuperTwin ⌘⇧S
        </button>
      </div>
      {version && <div className="panel-version">{version}</div>}
    </div>
  );
}
