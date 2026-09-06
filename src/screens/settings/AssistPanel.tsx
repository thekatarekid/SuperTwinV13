// ===========================================================================
// Settings › Assist — when the twin steps in: nudge popups on/off, the
// per-category novelty thresholds, cooldown, quiet hours, and the contexts
// your own dismissals have suppressed.
//
// V6 P1 S5.6 adds the rest of what Product_V6 §25 lists under Assist:
// FRESHNESS — which is the cold window itself, not a hint about it. Picking a
// preset moves the running dispatcher's idle/max on its next tick (SET-03),
// so the three options print the seconds they mean rather than a mood word.
// The max never exceeds 600 s: that is the ten-minute promise, and it is
// enforced in the worker, not here. Then burst K/W, nudge card duration, the
// merge window, the intent-confidence floor, the kinds "don't do this again"
// switched off (reversible, one click), and the behavioral rules list.
//
// A value the worker will not accept comes back NAMED in `refused` and the old
// value stays. The pane prints that line instead of silently reverting a field.
// ===========================================================================

import { useEffect, useState } from "react";

import {
  fetchSettingsAssist,
  saveSettingsAssist,
  type AssistPatch,
  type AssistSettings,
} from "../../lib/api";
import { rowStyle, Toggle } from "./shared";

export function AssistPanel(): JSX.Element {
  const [s, setS] = useState<AssistSettings | null>(null);
  const [rule, setRule] = useState("");
  useEffect(() => {
    void fetchSettingsAssist().then(setS).catch(() => {});
  }, []);
  if (!s) return <p className="empty">loading…</p>;
  const save = async (patch: AssistPatch): Promise<void> => {
    setS(await saveSettingsAssist(patch));
  };
  const num = (label: string, value: number | undefined, dflt: number, onSave: (n: number) => AssistPatch): JSX.Element => (
    <div style={rowStyle}>
      <span>{label}</span>
      <input
        type="number"
        style={{ width: 80 }}
        aria-label={label}
        defaultValue={value ?? dflt}
        onBlur={(e) => void save(onSave(Number(e.target.value)))}
      />
    </div>
  );
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
      <h3>Freshness — the cold window</h3>
      <p className="meta">
        How long a quiet stream waits before the twin reads it. This IS the window: pick one and
        the running dispatcher uses it from its next tick — no restart. The max never goes past
        600 s, whatever else changes.
      </p>
      <div style={rowStyle} role="radiogroup" aria-label="Freshness">
        {Object.entries(s.freshness_presets ?? {}).map(([id, w]) => (
          <label key={id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="radio"
              name="freshness"
              checked={s.freshness === id}
              onChange={() => void save({ freshness: id })}
            />
            <span>
              {id} <span className="meta">{w.idle_s} / {w.max_s} s</span>
            </span>
          </label>
        ))}
      </div>
      {s.freshness_window && (
        <p className="meta">
          in force: idle {s.freshness_window.idle_s} s · max {s.freshness_window.max_s} s
        </p>
      )}

      <h3>Burst, cards and the floor</h3>
      {num("Burst threshold (events K)", s.burst?.k, 4, (k) => ({ burst: { k } }))}
      {num("Burst window (W, seconds)", s.burst?.window_s, 180, (window_s) => ({ burst: { window_s } }))}
      {num("Nudge card duration (seconds)", s.card_duration_s, 60, (card_duration_s) => ({ card_duration_s }))}
      {num("Merge window (seconds)", s.merge_window_s, 120, (merge_window_s) => ({ merge_window_s }))}
      {num("Intent-confidence floor (0–1)", s.intent_floor, 0.6, (intent_floor) => ({ intent_floor }))}

      <h3>Blocked kinds (from &ldquo;don&apos;t do this again&rdquo;)</h3>
      {(s.blocked_kinds ?? []).length === 0 ? (
        <p className="empty">nothing blocked</p>
      ) : (
        (s.blocked_kinds ?? []).map((k) => (
          <div key={k} style={rowStyle}>
            <span>{k}</span>
            <button
              className="linklike"
              aria-label={`unblock ${k}`}
              onClick={() => void save({ blocked_kinds: (s.blocked_kinds ?? []).filter((x) => x !== k) })}
            >
              unblock
            </button>
          </div>
        ))
      )}

      <h3>Behavioral rules</h3>
      <p className="meta">
        What you have told the twin about how to behave. Each one applies to the next router
        decision, and each one can be taken back.
      </p>
      {(s.behavioral_rules ?? []).length === 0 ? (
        <p className="empty">no rules yet</p>
      ) : (
        (s.behavioral_rules ?? []).map((r) => (
          <div key={r.id} style={rowStyle}>
            <span>{r.text}</span>
            <span className="meta">
              {r.source}{" "}
              <button className="linklike" aria-label={`remove rule ${r.text}`} onClick={() => void save({ remove_rule: r.id })}>
                remove
              </button>
            </span>
          </div>
        ))
      )}
      <div style={rowStyle}>
        <input
          aria-label="new behavioral rule"
          placeholder="e.g. never nudge me about deliveries"
          value={rule}
          style={{ flex: 1 }}
          onChange={(e) => setRule(e.target.value)}
        />
        <button
          className="btn"
          disabled={rule.trim() === ""}
          onClick={() => {
            const text = rule.trim();
            setRule("");
            void save({ add_rule: text });
          }}
        >
          add rule
        </button>
      </div>

      {(s.refused ?? []).length > 0 && (
        <p className="meta" role="status">
          not saved: {(s.refused ?? []).join(" · ")}
        </p>
      )}

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
