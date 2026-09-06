// ===========================================================================
// Settings › General — hotkeys, launch/notify, brief times, appearance, the
// STOP ALL MODEL ACTIVITY switch (V6 P1 S0.8, SPD-03), the SPACE CREATION
// switch, the last deep-pass line, and the version footer.
//
// The kill switch is a persisted app_state row the worker checks before every
// `claude` spawn. It does not expire, it survives restart, and only this
// switch releases it. In-flight work finishes; nothing new starts.
//
// Space creation (V6 P1 S5.1): PROPOSE-ONLY is the default — inferred spaces
// wait in Review until approved — and the install graduates to auto-create
// after two clean weeks on the gates (no false merges, no over-creation). A
// false merge afterwards resets the clock. The switch is still yours either
// way, and a hand-set choice is sticky (worker consolidation/graduation.ts).
// ===========================================================================

import { useEffect, useState } from "react";

import { LoadFallback, PanelSkeleton, useLoad } from "../../components/LoadState";
import {
  describeWorkerError,
  fetchHealth,
  fetchSettingsGeneral,
  fetchSettingsGraduation,
  fetchSettingsT3,
  fetchSpend,
  resetBudgetLatch,
  saveGraduationMode,
  saveSettingsGeneral,
  setModelActivityPaused,
  type GeneralSettings,
  type GraduationSettings,
  type SpendStatus,
  type T3Status,
} from "../../lib/api";
import { rowStyle, SaveError, Toggle } from "./shared";

export function GeneralPanel(): JSX.Element {
  const [grad, setGrad] = useState<GraduationSettings | null>(null);
  const [t3, setT3] = useState<T3Status | null>(null);
  const [footer, setFooter] = useState<string | null>(null);
  const [spend, setSpend] = useState<SpendStatus | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The general settings row is what the pane IS: it gates the render, so its
  // failure is the one the user must see and be able to retry (W3). The other
  // four reads are decorations — graduation, deep-pass, spend, version — and
  // each degrades to "not shown" on its own without hiding the pane.
  // FIX-C5: General is the pane Settings opens on, so its read is the one that
  // decides how fast the Settings tab feels — and on the user's machine it was
  // the slowest read in the app (37.3 s for 198 bytes, queued behind the
  // importer). Keyed into the pane cache, a return to Settings repaints the
  // saved row in the same frame and re-reads underneath.
  //
  // `cacheKey` WITHOUT `freshFor`, deliberately: the cache is here to kill the
  // blank frame, not the request. Settings is where a value can be changed by
  // something other than this pane, so it re-asks every time it mounts and
  // shows the last answer while it waits. The repeat-fetch-on-flip that
  // `freshFor` exists to prevent is already gone — App.tsx keeps the pane
  // mounted, so a flip does not re-mount it at all.
  const gate = useLoad<GeneralSettings>(fetchSettingsGeneral, [], {
    cacheKey: "settings.general",
  });
  const s = gate.data;
  const setS = gate.setData;
  const attempt = gate.attempt;

  useEffect(() => {
    void fetchSettingsGraduation().then(setGrad).catch(() => setGrad(null));
    void fetchSettingsT3().then(setT3).catch(() => setT3(null));
    void fetchSpend().then(setSpend).catch(() => setSpend(null));
    void fetchHealth()
      .then((h) => setFooter(`v${h.version} · built through ${h.builtThroughPhase}`))
      .catch(() => setFooter(null));
  }, [attempt]);

  // UNKNOWN IS NOT EMPTY: a failed read shows the failure and a Retry; a read
  // still in flight shows the SHAPE of the pane, not a bare "loading…" line
  // that is indistinguishable from a panel that has given up.
  if (!s) {
    return gate.error !== null ? (
      <LoadFallback state={gate} what="General settings" />
    ) : (
      <PanelSkeleton what="General settings" rows={6} />
    );
  }
  const save = async (patch: Partial<GeneralSettings>): Promise<void> => {
    setSaveError(null);
    try {
      setS(await saveSettingsGeneral(patch));
    } catch (err) {
      setSaveError(`that change was not saved — ${describeWorkerError(err)}`);
    }
  };
  /** One reporter for the switches that are their own POST, not a settings patch. */
  const said = (what: string) => (err: unknown) => setSaveError(`${what} — ${describeWorkerError(err)}`);
  const auto = grad?.mode === "auto";
  return (
    <div>
      <h2>General</h2>
      <SaveError error={saveError} onDismiss={() => setSaveError(null)} />
      <div style={rowStyle}>
        <span>Summon hotkey</span>
        <span className="chip">{s.hotkey_summon}</span>
      </div>
      <div style={rowStyle}>
        <span>Bar hotkey</span>
        <span className="chip">{s.hotkey_bar}</span>
      </div>
      <Toggle
        label="Launch at login"
        checked={s.launch_at_login}
        onChange={(v) => void save({ launch_at_login: v })}
      />
      <Toggle
        label="macOS notifications"
        checked={s.notifications_enabled}
        onChange={(v) => void save({ notifications_enabled: v })}
      />
      <div style={rowStyle}>
        <span>Brief times</span>
        <input
          defaultValue={s.brief_times.join(", ")}
          onBlur={(e) =>
            void save({
              brief_times: e.target.value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
      <div style={rowStyle}>
        <span>Appearance</span>
        <select value={s.appearance} onChange={(e) => void save({ appearance: e.target.value })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <h3>Model activity</h3>
      <Toggle
        label="Stop all model activity"
        checked={spend?.modelActivityPausedAt != null}
        onChange={(v) =>
          void setModelActivityPaused(v)
            .then((next) => {
              setSpend(next);
              setSaveError(null);
            })
            .catch(said("the model-activity switch did not move"))
        }
      />
      <p className="meta">
        {spend?.modelActivityPausedAt
          ? `Stopped since ${spend.modelActivityPausedAt.slice(0, 16).replace("T", " ")}. Nothing new is sent to the model — not the bar, not chat — until you switch this off. It stays off across restarts.`
          : "A hard stop: no new model call starts anywhere until you switch it back. Work already running finishes. Persists across restarts."}
      </p>
      {spend && (
        <p className="meta">
          Last hour {spend.hour.calls} calls · ~${spend.hour.usd.toFixed(2)} of ${spend.ceilings.usdPerHour}
          {" · "}today {spend.day.calls} calls · ~${spend.day.usd.toFixed(2)} of ${spend.ceilings.usdPerDay}
        </p>
      )}
      {spend?.trippedAt && (
        <div style={rowStyle}>
          <span>
            Spend ceiling reached {spend.trippedAt.slice(0, 16).replace("T", " ")}
            {spend.trippedReason ? ` — ${spend.trippedReason}` : ""}. Background work is paused; the bar still answers.
          </span>
          <button
            className="btn"
            onClick={() => void resetBudgetLatch().then(setSpend).catch(said("could not resume background work"))}
          >
            Resume background work
          </button>
        </div>
      )}

      <h3>Space creation</h3>
      {grad && (
        <>
          <div style={rowStyle}>
            <span>
              {auto
                ? "Auto-create — the twin files a new space the moment it sees one"
                : "Propose-only — new spaces wait in Review until you approve them"}
            </span>
            <button
              className="btn"
              onClick={() =>
                void saveGraduationMode(auto ? "propose" : "auto")
                  .then(setGrad)
                  .catch(said("the space-creation mode did not change"))
              }
            >
              {auto ? "Switch to propose-only" : "Switch to auto-create"}
            </button>
          </div>
          <p className="meta">
            {auto
              ? "Every creation is a reversible decision — open a space and undo it, or switch to propose-only to approve each one first. A false merge sends the twin back to propose-only on its own."
              : "New spaces the twin infers queue for your approval in Review; anything you ask for in the bar is created at once. After two clean weeks the twin graduates to auto-create — or switch now."}
          </p>
          <p className="meta">
            Filing health: gates green {grad.consecutive_green}/{grad.required_days} days
            {grad.window_proposals !== undefined && ` · ${grad.window_proposals} in the window`}.
            {auto ? " A false auto-merge resets the clock." : " Fourteen clean days flips the switch for you."}
          </p>
        </>
      )}

      {t3?.last_report && (
        <p className="meta">
          Last deep pass {t3.last_report.ranAt.slice(0, 16)}: {t3.last_report.crossLinks} links ·{" "}
          {t3.last_report.claimVersionsCompressed} claim versions compressed ·{" "}
          {t3.last_report.ephemeralArchived} ephemeral spaces archived
        </p>
      )}
      {footer && (
        <p className="version-footer" style={{ color: "var(--ink-2)", fontSize: 12 }}>
          {footer}
        </p>
      )}
    </div>
  );
}
