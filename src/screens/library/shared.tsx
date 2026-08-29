// ===========================================================================
// Library subtab shared bits — spec §14.3.2.
//
// The three source views (WhatsApp · Screen · Browser) each render one of two
// things: the source's own data, or — when the source is not connected — a
// real "connect this source" state carrying the actual connect action. This
// file holds that connect card plus the date/label helpers all three share.
// ===========================================================================

import type { ReactNode } from "react";

/** "knows you: Jan 2024 →" — how far back the twin understands this stream. */
export function knowsFromLabel(ts: string | null): string {
  if (!ts) return "not yet understood";
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const twoYears = 2 * 365.25 * 24 * 3600 * 1000;
  const left =
    Date.now() - d.getTime() >= twoYears
      ? String(d.getUTCFullYear())
      : `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `knows you: ${left} →`;
}

export function relative(ts: string | null): string {
  if (!ts) return "";
  const min = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function hhmm(ts: string): string {
  return new Date(ts).toISOString().slice(11, 16);
}

export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface ConnectAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * The disconnected state of a source: what it would capture, why it is off,
 * and the button that actually starts the real connect flow. Never a bare
 * "nothing captured yet" string — a source the user has not connected is a
 * thing to DO, not an empty list.
 */
export function ConnectCard(props: {
  glyph: string;
  title: string;
  body: ReactNode;
  actions?: ConnectAction[];
  note?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className="card connect-card" aria-label={`connect ${props.title}`}>
      <div className="connect-glyph" aria-hidden="true">
        {props.glyph}
      </div>
      <h2 className="connect-title">{props.title}</h2>
      <p className="connect-body">{props.body}</p>
      {props.children}
      {props.actions && props.actions.length > 0 && (
        <div className="btn-row">
          {props.actions.map((a, i) => (
            <button
              key={a.label}
              type="button"
              className={i === 0 ? "btn primary" : "btn"}
              disabled={a.disabled}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {props.note && <p className="connect-note">{props.note}</p>}
    </section>
  );
}
