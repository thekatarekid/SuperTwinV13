// ===========================================================================
// Settings › Calendar (Product_V6 §25; V6 P1 S5.6, served by the calendar
// lane's own route).
//
// The only calendar setting P1 has is the one that decides whether a date
// becomes WORK. Plan: a space opens at T minus the lead time, so a birthday
// two weeks out is something you can act on rather than something you find out
// about on the day. Wish: the date just shows on the people layer and nothing
// opens. Defaults are per circle — partner and family 14 days, close friends
// 7, everyone else wish-only — and a snooze on a real card ("10 days before")
// overrides them for that person, which is why this pane says so instead of
// pretending it is the only place the number can come from.
//
// Connected calendars and write-back are P3. They are named here, once, so the
// absence reads as a phase rather than as a missing feature.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import {
  fetchSettingsCalendar,
  saveSettingsCalendar,
  type CalendarSettings,
  type CirclePolicy,
} from "../../lib/api";
import { rowStyle } from "./shared";

/** partner → "partner", close_friends → "close friends". */
function circleLabel(id: string): string {
  return id.replace(/_/g, " ");
}

export function CalendarPanel(): JSX.Element {
  const [s, setS] = useState<CalendarSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setS(await fetchSettingsCalendar());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) return <p className="meta">calendar settings unavailable — {error}</p>;
  if (!s) return <p className="empty">loading…</p>;

  const save = (circle: string, patch: Partial<CirclePolicy>): void => {
    void saveSettingsCalendar({ [circle]: patch }).then(setS).catch(() => {});
  };
  const rows = Object.entries(s.circles ?? {});

  return (
    <div>
      <h2>Calendar</h2>
      <p className="meta">
        A person&apos;s date is either a PLAN — a space opens this many days before — or a WISH,
        which shows on the day and opens nothing. Snoozing a real card (&ldquo;10 days
        before&rdquo;) sets that person&apos;s own lead time and beats the circle default.
      </p>

      <h3>Lead time by circle</h3>
      {rows.length === 0 ? (
        <p className="empty">no circles</p>
      ) : (
        rows.map(([circle, p]) => (
          <div key={circle} style={rowStyle}>
            <span>{circleLabel(circle)}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select
                aria-label={`${circleLabel(circle)} mode`}
                value={p.mode}
                onChange={(e) => save(circle, { mode: e.target.value as CirclePolicy["mode"] })}
              >
                <option value="plan">plan — open a space</option>
                <option value="wish">wish — show only</option>
              </select>
              <input
                type="number"
                style={{ width: 70 }}
                aria-label={`${circleLabel(circle)} lead days`}
                disabled={p.mode !== "plan"}
                defaultValue={p.leadDays}
                key={`${circle}-${p.mode}-${p.leadDays}`}
                onBlur={(e) => save(circle, { leadDays: Number(e.target.value) })}
              />
              <span className="meta">days before</span>
            </span>
          </div>
        ))
      )}

      <h3>Connected calendars</h3>
      <p className="meta">
        P1&apos;s calendar is DERIVED — built from what your streams already say, not synced from
        anywhere. Connecting a real calendar, and writing back to it, arrives in P3.
      </p>
    </div>
  );
}
