// ===========================================================================
// Settings › General — hotkeys, launch/notify, brief times, appearance, the
// SPACE CREATION switch, the last deep-pass line, and the version footer.
//
// Space creation reads honestly for the shipped default: the twin CREATES new
// spaces, and propose-only is the setting you turn on if you would rather vet
// each one first. The over-creation streak is still shown — it is a health
// read now, not a gate anything is waiting on (worker consolidation/
// graduation.ts).
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import {
  fetchHealth,
  fetchSettingsGeneral,
  fetchSettingsGraduation,
  fetchSettingsT3,
  saveGraduationMode,
  saveSettingsGeneral,
  type GeneralSettings,
  type GraduationSettings,
  type T3Status,
} from "../../lib/api";
import { rowStyle, Toggle } from "./shared";

export function GeneralPanel(): JSX.Element {
  const [s, setS] = useState<GeneralSettings | null>(null);
  const [grad, setGrad] = useState<GraduationSettings | null>(null);
  const [t3, setT3] = useState<T3Status | null>(null);
  const [footer, setFooter] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setS(await fetchSettingsGeneral());
    setGrad(await fetchSettingsGraduation());
    setT3(await fetchSettingsT3());
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
              ? "Auto-create is the default. Every creation is a reversible decision — open a space and undo it, or switch to propose-only to approve each one first."
              : "New spaces queue for your approval in Review. Switch back to auto-create whenever you like; anything already waiting stays in the queue either way."}
          </p>
          <p className="meta">
            Filing health: gates green {grad.consecutive_green}/{grad.required_days} days
            {grad.window_proposals !== undefined && ` · ${grad.window_proposals} in the window`}. For
            your information — it no longer gates this switch.
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
