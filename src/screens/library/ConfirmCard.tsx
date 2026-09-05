// ===========================================================================
// The confirm card — V6 P1 S1.8 (Product P1 §3.3–3.4; backlog T4-10).
//
// Two windows per source, then four numbers, each with ITS OWN accuracy
// label: events (exact where the source counted) · cost (estimate ±40%) ·
// time (estimate ±30%, one call after another) · disk (about). Nothing goes
// to a model before Confirm; the card text the user saw is what the worker
// stores verbatim in `decisions` (consents.decision_id).
//
// The numbers come from the worker (POST /api/consent/card) on every window
// change — the UI never computes a figure of its own, so the card can never
// show a number the code cannot back. Confirm posts the same body to
// /api/consent/confirm.
//
// Reused by the connect flows (S1.4 browser, S1.5 WhatsApp, S1.6 screen) with
// the adapter's pre-consent `counts`, and by the Library › Storage panel for a
// re-confirm (no counts: the worker counts the log).
// ===========================================================================

import { useEffect, useMemo, useState } from "react";

import {
  confirmConsent,
  previewConsentCard,
  type CardCounts,
  type CardNumber,
  type ConfirmCardData,
  type ConfirmConsentResult,
} from "../../lib/api";

const DAY_MS = 86_400_000;

/** How far back the model reads. `null` = nothing is understood. */
export const UNDERSTAND_OPTIONS = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "1y", label: "1 year", days: 365 },
  { id: "2y", label: "2 years", days: 730 },
  { id: "5y", label: "5 years", days: 1825 },
  { id: "none", label: "nothing", days: null },
] as const;
export type UnderstandOption = (typeof UNDERSTAND_OPTIONS)[number]["id"];

/** How far back is kept and searchable. `null` days = everything. */
export const INDEX_OPTIONS = [
  { id: "all", label: "everything", days: null },
  { id: "90d", label: "90 days", days: 90 },
  { id: "1y", label: "1 year", days: 365 },
  { id: "2y", label: "2 years", days: 730 },
  { id: "5y", label: "5 years", days: 1825 },
] as const;
export type IndexOption = (typeof INDEX_OPTIONS)[number]["id"];

function daysOf<T extends { id: string; days: number | null }>(opts: readonly T[], id: string): number | null {
  return opts.find((o) => o.id === id)?.days ?? null;
}

/** ISO floor `days` before `nowMs`, at the start of that UTC day; null = no floor. */
export function floorIso(days: number | null, nowMs: number): string | null {
  if (days === null) return null;
  const d = new Date(nowMs - days * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Understand can never reach further back than Index (CNS-03). When the user
 * picks a bounded Index shorter than the Understand span, the Understand pick
 * is clamped to the Index — never silently widened.
 */
export function clampUnderstand(understand: UnderstandOption, index: IndexOption): UnderstandOption {
  const u = daysOf(UNDERSTAND_OPTIONS, understand);
  const i = daysOf(INDEX_OPTIONS, index);
  if (u === null || i === null || u <= i) return understand;
  const fit = [...UNDERSTAND_OPTIONS].reverse().find((o) => o.days !== null && o.days <= i);
  return fit?.id ?? "none";
}

export interface ConfirmCardProps {
  source: string;
  /** What the source flow counted before consent; omit on a re-confirm. */
  counts?: CardCounts | null;
  scope?: unknown;
  initialUnderstand?: UnderstandOption;
  initialIndex?: IndexOption;
  confirmLabel?: string;
  onConfirmed?: (result: ConfirmConsentResult) => void;
  onCancel?: () => void;
  /** Injected by tests; production uses the wall clock. */
  nowMs?: () => number;
}

function Number_({ name, n }: { name: string; n: CardNumber }): JSX.Element {
  return (
    <div className="confirm-number" role="group" aria-label={name}>
      <span className="confirm-number-name">{name}</span>
      <span className="confirm-number-value">{n.display}</span>
      <span className="confirm-number-accuracy chip">{n.accuracy}</span>
      {n.note && <span className="confirm-number-note">{n.note}</span>}
    </div>
  );
}

export function ConfirmCard(props: ConfirmCardProps): JSX.Element {
  const [understand, setUnderstand] = useState<UnderstandOption>(props.initialUnderstand ?? "30d");
  const [index, setIndex] = useState<IndexOption>(props.initialIndex ?? "all");
  const [card, setCard] = useState<ConfirmCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = props.nowMs ?? Date.now;

  const body = useMemo(() => {
    const nowMs = now();
    const indexDays = daysOf(INDEX_OPTIONS, index);
    return {
      source: props.source,
      index_all: indexDays === null,
      index_from: floorIso(indexDays, nowMs),
      understand_from: floorIso(daysOf(UNDERSTAND_OPTIONS, understand), nowMs),
      counts: props.counts ?? undefined,
      scope: props.scope,
    };
    // `now` is a stable function prop; re-run on window changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.source, props.counts, props.scope, understand, index]);

  useEffect(() => {
    let alive = true;
    setError(null);
    previewConsentCard(body)
      .then((r) => {
        if (alive) setCard(r.card);
      })
      .catch(() => {
        if (alive) setError("the worker could not compute the card");
      });
    return () => {
      alive = false;
    };
  }, [body]);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await confirmConsent(body);
      props.onConfirmed?.(result);
    } catch {
      setError("confirm failed — nothing was changed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card confirm-card" aria-label={`confirm ${props.source}`}>
      <div className="confirm-windows">
        <label className="connect-field">
          <span>understand</span>
          <select
            aria-label="understand window"
            value={understand}
            onChange={(e) => setUnderstand(clampUnderstand(e.target.value as UnderstandOption, index))}
          >
            {UNDERSTAND_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="confirm-window-hint">sent to the model · costs money</span>
        </label>
        <label className="connect-field">
          <span>keep searchable</span>
          <select
            aria-label="index window"
            value={index}
            onChange={(e) => {
              const next = e.target.value as IndexOption;
              setIndex(next);
              setUnderstand((u) => clampUnderstand(u, next));
            }}
          >
            {INDEX_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="confirm-window-hint">kept on this Mac · costs disk</span>
        </label>
      </div>

      {card ? (
        <div className="confirm-numbers">
          <Number_ name="Events" n={card.events} />
          <Number_ name="Cost" n={card.cost} />
          <Number_ name="Time" n={card.time} />
          <Number_ name="Disk" n={card.disk} />
        </div>
      ) : (
        <p className="empty" role="status">
          {error ?? "computing the card…"}
        </p>
      )}

      {card && (
        <pre className="confirm-text" aria-label="card text">
          {card.text}
        </pre>
      )}

      {card && error && <p className="empty">{error}</p>}

      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !card}
          onClick={() => void confirm()}
        >
          {props.confirmLabel ?? "Confirm"}
        </button>
        {props.onCancel && (
          <button type="button" className="btn" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
      <p className="connect-note">Nothing is sent to a model before you confirm. This card is kept, word for word, with your consent.</p>
    </section>
  );
}
