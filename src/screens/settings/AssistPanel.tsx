// ===========================================================================
// Settings › Assist — when the twin steps in: nudge popups on/off, the
// per-category novelty thresholds, cooldown, quiet hours, and the contexts
// your own dismissals have suppressed.
// ===========================================================================

import { useEffect, useState } from "react";

import { fetchSettingsAssist, saveSettingsAssist, type AssistSettings } from "../../lib/api";
import { rowStyle, Toggle } from "./shared";

export function AssistPanel(): JSX.Element {
  const [s, setS] = useState<AssistSettings | null>(null);
  useEffect(() => {
    void fetchSettingsAssist().then(setS).catch(() => {});
  }, []);
  if (!s) return <p className="empty">loading…</p>;
  const save = async (
    patch: Partial<AssistSettings> & { clear_suppressed?: boolean },
  ): Promise<void> => {
    setS(await saveSettingsAssist(patch));
  };
  const threshold = (cat: string, label: string): JSX.Element => (
    <div style={rowStyle}>
      <span>{label}</span>
      <input
        type="number"
        style={{ width: 60 }}
        defaultValue={s.thresholds[cat] ?? 5}
        onBlur={(e) => void save({ thresholds: { [cat]: Number(e.target.value) } })}
      />
    </div>
  );
  return (
    <div>
      <h2>Assist — when the twin steps in</h2>
      <Toggle label="Nudge popups (off = Prepared only)" checked={s.enabled} onChange={(v) => void save({ enabled: v })} />
      <h3>Novelty threshold (distinct events before an assist pass may run)</h3>
      {threshold("default", "default")}
      {threshold("transaction", "transactions")}
      {threshold("research", "research")}
      {threshold("communication", "communication")}
      <div style={rowStyle}>
        <span>Cooldown per context (min)</span>
        <input
          type="number"
          style={{ width: 60 }}
          defaultValue={s.cooldown_min}
          onBlur={(e) => void save({ cooldown_min: Number(e.target.value) })}
        />
      </div>
      <div style={rowStyle}>
        <span>Quiet hours</span>
        <span>
          <input
            style={{ width: 64 }}
            defaultValue={s.quiet_hours.start}
            onBlur={(e) => void save({ quiet_hours: { start: e.target.value, end: s.quiet_hours.end } })}
          />
          {" – "}
          <input
            style={{ width: 64 }}
            defaultValue={s.quiet_hours.end}
            onBlur={(e) => void save({ quiet_hours: { start: s.quiet_hours.start, end: e.target.value } })}
          />
        </span>
      </div>
      <h3>Suppressed contexts (from your dismissals)</h3>
      {s.suppressed_contexts.length === 0 ? (
        <p className="empty">none</p>
      ) : (
        <>
          {s.suppressed_contexts.map((c) => (
            <div key={c.topic_key} style={rowStyle}>
              <span>{c.topic_key}</span>
              <span className="meta">until {c.suppressed_until.slice(0, 10)}</span>
            </div>
          ))}
          <button className="btn" onClick={() => void save({ clear_suppressed: true })}>
            clear…
          </button>
        </>
      )}
    </div>
  );
}
