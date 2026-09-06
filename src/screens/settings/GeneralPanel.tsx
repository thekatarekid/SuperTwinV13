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

import { useCallback, useEffect, useState } from "react";

import {
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
import { rowStyle, Toggle } from "./shared";

export function GeneralPanel(): JSX.Element {
  const [s, setS] = useState<GeneralSettings | null>(null);
  const [grad, setGrad] = useState<GraduationSettings | null>(null);
  const [t3, setT3] = useState<T3Status | null>(null);
  const [footer, setFooter] = useState<string | null>(null);
  const [spend, setSpend] = useState<SpendStatus | null>(null);

  const refresh = useCallback(async () => {
    setS(await fetchSettingsGeneral());
    setGrad(await fetchSettingsGraduation());
    setT3(await fetchSettingsT3());
    // Spend is its own read so a worker without the ops routes still renders
    // the rest of the panel.
    await fetchSpend()
      .then(setSpend)
      .catch(() => setSpend(null));
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
    void fetchHealth()
      .then((h) => setFooter(`v${h.version} · built through ${h.builtThroughPhase}`))
      .catch(() => {});
  }, [refresh]);

  if (!s) return <p className="empty">loading…</p>;
  const save = async (patch: Partial<GeneralSettings>): Promise<void> => {
    setS(await saveSettingsGeneral(patch));
  };
  const auto = grad?.mode === "auto";
  return (
    <div>
      <h2>General</h2>
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
        onChange={(v) => void setModelActivityPaused(v).then(setSpend).catch(() => {})}
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
          <button className="btn" onClick={() => void resetBudgetLatch().then(setSpend).catch(() => {})}>
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
              onClick={() => void saveGraduationMode(auto ? "propose" : "auto").then(setGrad)}
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
