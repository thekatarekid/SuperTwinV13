// ===========================================================================
// Settings › Assist — V6 P1 R2 (Product_V6_Phase1 §18, §25; Build §7.1 S4.4).
//
// WHAT THIS PANE IS NOW. S4.4 inverted the assist lane. The retired P2.2
// watcher decided at the INPUT — a topic accumulated novelty until a gate said
// "worth a call", and a cooldown, a quiet hour or a suppressed context could
// stop the work from ever being done. The V6 P1 lane does not work that way:
// the state gate (S3.3) decides that this flush matters, the work happens, and
// what is left to decide is what the finished thing earns ON SCREEN. That
// decision is `nudgeVerdict()` (worker/src/surfaces/nudge-verdict.ts) and its
// two inputs — the intent-confidence floor and the blocked kinds — plus the
// behavioural rules are what this pane edits. Until R2 they had no screen that
// said so: the pane printed the numbers with no statement of the rule, next to
// four dead input-side knobs that no longer gate anything.
//
// So the rule is printed in words, above the numbers that feed it, and the
// dead knobs are gone: §18.2 is explicit — "No quiet hours, no cap, no
// cooldown". What is left of the retired lane is per-context suppression rows
// a dismissal once wrote; they are shown only when some exist, named as
// leftovers, and clearable.
//
// FRESHNESS AND BURST STAY, because they are not assist knobs at all — they
// are the cold window and the burst rule of the state gate itself, and picking
// a preset moves the running dispatcher on its next tick (SET-03). The max
// never exceeds 600 s: that is the ten-minute promise, enforced in the worker.
//
// A value the worker will not accept comes back NAMED in `refused` and the old
// value stays. The pane prints that line instead of silently reverting a field.
// ===========================================================================

import { useState } from "react";

import { LoadFallback, useLoad } from "../../components/LoadState";
import {
  describeWorkerError,
  fetchSettingsAssist,
  saveSettingsAssist,
  type AssistPatch,
  type AssistSettings,
} from "../../lib/api";
import { rowStyle, SaveError, Toggle } from "./shared";

/** Spec §10.1 — mirrored by the worker's DEFAULT_NUDGE_INTENT_FLOOR. */
const DEFAULT_INTENT_FLOOR = 0.7;

export function AssistPanel(): JSX.Element {
  const gate = useLoad<AssistSettings>(fetchSettingsAssist);
  const s = gate.data;
  const setS = gate.setData;
  const [rule, setRule] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  if (!s) return <LoadFallback state={gate} what="Assist settings" />;
  const save = async (patch: AssistPatch): Promise<void> => {
    setSaveError(null);
    try {
      setS(await saveSettingsAssist(patch));
    } catch (err) {
      setSaveError(`that change was not saved — ${describeWorkerError(err)}`);
    }
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
  const floor = s.intent_floor ?? DEFAULT_INTENT_FLOOR;
  const blocked = s.blocked_kinds ?? [];
  const rules = s.behavioral_rules ?? [];
  const suppressed = s.suppressed_contexts ?? [];
  return (
    <div>
      <h2>Assist — what a finished thing earns on screen</h2>
      <SaveError error={saveError} onDismiss={() => setSaveError(null)} />
      <p className="meta">
        The twin does not ask permission to understand: the state gate decides that a flush matters and
        the work happens. These rules decide what the finished work earns — a card now, the Prepared
        shelf, or filed and never shown. Nothing here stops work being done, and nothing here deletes
        it.
      </p>
      <Toggle label="Nudge popups (off = Prepared only)" checked={s.enabled} onChange={(v) => void save({ enabled: v })} />

      <h3>The rule</h3>
      <div className="assist-rule" aria-label="the rule">
        <p>
          <span className="chip">blocked kind</span> → filed in its space and on the timeline,{" "}
          <strong>never</strong> carded. Reversible in one click, below.
        </p>
        <p>
          <span className="chip">intent confidence &lt; {floor}</span> → the Prepared shelf. The work is
          kept; it just does not interrupt, because a card that names the wrong goal is worse than no
          card.
        </p>
        <p>
          <span className="chip accent">intent confidence ≥ {floor}</span> → a nudge card, plus the
          panel.
        </p>
        <p className="meta">
          One floor, one reader: the live pass and the surface router both ask the same function, so a
          prepared action at {floor} cannot be shelved by one and carded by the other.
        </p>
      </div>
      {num("Intent-confidence floor (0–1)", s.intent_floor, DEFAULT_INTENT_FLOOR, (intent_floor) => ({ intent_floor }))}

      <h3>Blocked kinds (from &ldquo;don&apos;t do this again&rdquo;)</h3>
      <p className="meta">
        The one kind-level refusal the twin honours. It never withholds anything else, and this is
        always reversible.
      </p>
      {blocked.length === 0 ? (
        <p className="empty">nothing blocked</p>
      ) : (
        blocked.map((k) => (
          <div key={k} style={rowStyle}>
            <span>{k}</span>
            <button
              className="linklike"
              aria-label={`unblock ${k}`}
              onClick={() => void save({ blocked_kinds: blocked.filter((x) => x !== k) })}
            >
              unblock
            </button>
          </div>
        ))
      )}

      <h3>Behavioral rules</h3>
      <p className="meta">
        What you have told the twin about how to behave — from an utterance, a quick chip, or typed
        here. Each one applies to the next router decision, and each one can be taken back.
      </p>
      {rules.length === 0 ? (
        <p className="empty">no rules yet</p>
      ) : (
        rules.map((r) => (
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

      <h3>Burst and the card</h3>
      <p className="meta">
        K content-new events on one stream inside W seconds flush now, without waiting for the window.
        The card&apos;s own life: how long it stays before it auto-closes, and how long two nudges
        about one space merge into one glance.
      </p>
      {num("Burst threshold (events K)", s.burst?.k, 4, (k) => ({ burst: { k } }))}
      {num("Burst window (W, seconds)", s.burst?.window_s, 180, (window_s) => ({ burst: { window_s } }))}
      {num("Nudge card duration (seconds)", s.card_duration_s, 60, (card_duration_s) => ({ card_duration_s }))}
      {num("Merge window (seconds)", s.merge_window_s, 120, (merge_window_s) => ({ merge_window_s }))}

      {(s.refused ?? []).length > 0 && (
        <p className="meta" role="status">
          not saved: {(s.refused ?? []).join(" · ")}
        </p>
      )}

      {suppressed.length > 0 && (
        <>
          <h3>Left over from the retired watcher</h3>
          <p className="meta">
            Per-context suppression rows an old dismissal wrote. They gate nothing now — the twin has
            no cooldown, no cap and no quiet hours — and can be cleared.
          </p>
          {suppressed.map((c) => (
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
