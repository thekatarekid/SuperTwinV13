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
// The panel polls /api/assist/panel and drives the tray glyph from what it
// sees: ⏸ when capture is paused, ● (n) when anything needs the user or an
// unseen nudge waits, ◉ otherwise.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import {
  artifactReopen,
  artifactSeen,
  fetchHealth,
  fetchPanel,
  pauseCapture,
  type ArtifactRow,
  type PanelData,
} from "../lib/api";
import { hidePanelWindow, openMainWindow, setTrayState } from "../lib/tauri";

export const PANEL_POLL_MS = 5_000;

function clock(ts: string | null): string {
  if (!ts) return "";
  const m = /T(\d{2}):(\d{2})/.exec(ts);
  return m ? `${m[1]}:${m[2]}` : "";
}

export function trayStateFor(data: PanelData): {
  state: "idle" | "needs_you" | "paused";
  needsYou: number;
} {
  if (data.capture_paused_until) return { state: "paused", needsYou: 0 };
  const needs =
    data.needs_you.approvals.length +
    data.needs_you.questions.length +
    (data.nudge ? 1 : 0);
  return needs > 0 ? { state: "needs_you", needsYou: needs } : { state: "idle", needsYou: 0 };
}

export function Panel(): JSX.Element {
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [olderOpen, setOlderOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [ask, setAsk] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await fetchPanel();
      setData(next);
      setError(null);
      const tray = trayStateFor(next);
      void setTrayState(tray.state, tray.needsYou);
    } catch {
      setError("worker unreachable");
    }
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
        <p className="empty">{error}</p>
      </div>
    );
  }

  const prepared = data?.prepared ?? [];
  const older = data?.older ?? [];
  const paused = Boolean(data?.capture_paused_until);

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
            ⏸ ▾{paused ? " paused" : ""}
          </button>
          {pauseOpen && (
            <div className="panel-pause-menu" role="menu">
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
                <button type="button" role="menuitem" onClick={() => void quickPause(null)}>
                  resume
                </button>
              )}
            </div>
          )}
        </div>
      </div>

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
