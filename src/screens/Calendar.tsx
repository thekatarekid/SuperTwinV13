// ===========================================================================
// Calendar — DERIVED (V6 P1 S5.3; Product_V6 §11.9, Product_V6_Phase1 §16).
//
// P1 reads no external calendar and writes none back. Everything on this tab
// is built from what the twin already knows, in four layers:
//
//   ◼ my events    chat-derived events (tentative until confirmed) + the ones
//                  the user or the bar created + confirmed recurrence rules
//   ◻ my tasks     the user's own open tasks with a due date
//   ◆ twin's tasks the twin's scheduled steps (their fire_at)
//   ● people       people's dates (with their lead-time plan) and the tasks
//                  other people own
//
// "Every layer can be shown alone or together. 'My tasks' and 'twin's tasks'
// are separate views" (§11.9.1, CAL-05) — hence four independent toggles, and
// a count chip per layer that is the worker's, never re-derived here.
//
// The worker renders at VIEW time: "in 3 days" / "2 days overdue" and the
// day each instant falls on are computed per request against the viewer's
// zone, and nothing relative is stored (TIM-02). This screen therefore paints
// exactly what it was given and re-fetches when the range changes.
//
// ---------------------------------------------------------------------------
// FIX-C4 — "NOTHING DATED IN THIS WINDOW", SAID BEFORE ASKING.
//
// `shown` is derived from `view?.items ?? []`, and the empty line was gated on
// `shown.length === 0` alone — so a pending read painted the verdict, and the
// four layer chips painted `0` next to it (`view?.counts?.[l] ?? 0`). On the
// user's own worker /api/calendar answered with items after ~15 s while an
// import held the database; the screen said the window was empty for all of
// it, with four confident zeroes.
//
// `view === null` is now NO ANSWER YET: skeleton, no empty line, and the layer
// chips show a dash rather than a count they do not have. The answered view is
// kept per range in the pane cache (components/LoadState.tsx), so returning to
// the tab repaints instantly and re-reads underneath.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";
import { LoadFailure, PanelSkeleton, RefreshingHint, useCachedRead } from "../components/LoadState";
import {
  CALENDAR_LAYERS,
  cancelCalendarEvent,
  confirmCalendarEvent,
  describeWorkerError,
  fetchCalendar,
  snoozeCalendarPlan,
  stopCalendarPlan,
  type CalendarItemView,
  type CalendarLayer,
  type CalendarSnoozeChoice,
  type CalendarViewResponse,
} from "../lib/api";

const LAYER_LABEL: Record<CalendarLayer, string> = {
  my_events: "◼ my events",
  my_tasks: "◻ my tasks",
  twin_tasks: "◆ twin's tasks",
  people: "● people",
};

const RANGES = [
  { id: "week", label: "week", days: 7 },
  { id: "month", label: "month", days: 30 },
  { id: "quarter", label: "3 months", days: 90 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

const SNOOZE: { id: CalendarSnoozeChoice; label: string }[] = [
  { id: "next_week", label: "next week" },
  { id: "10_days_before", label: "10 days before" },
  { id: "3_days_before", label: "3 days before" },
];

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The plan row the people layer hangs a snooze on, when there is one. */
function planOf(item: CalendarItemView): { id: string; status: string } | null {
  const plan = item.detail?.plan;
  if (!plan || typeof plan !== "object") return null;
  const p = plan as Record<string, unknown>;
  return typeof p.id === "string" ? { id: p.id, status: typeof p.status === "string" ? p.status : "pending" } : null;
}

export function Calendar(props: {
  /** Filing chip click → the space modal, as everywhere else. */
  onOpenSpace?: (spaceId: string) => void;
}): JSX.Element {
  const [range, setRange] = useState<RangeId>("month");
  const [on, setOn] = useState<Record<CalendarLayer, boolean>>({
    my_events: true,
    my_tasks: true,
    twin_tasks: true,
    people: true,
  });
  // One cached answer per range — flipping week/month/quarter and back is a
  // re-visit, not a reason to make a busy worker re-run the derivation.
  const cache = useCachedRead<CalendarViewResponse>(`calendar.${range}`);
  const [view, setView] = useState<CalendarViewResponse | null>(cache.seed);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const from = localToday();
    const days = RANGES.find((r) => r.id === range)?.days ?? 30;
    setLoading(true);
    const token = cache.begin();
    try {
      // Ask for every layer: the counts chip must show what a layer HOLDS,
      // not what is currently toggled on. Filtering is local and instant.
      const r = await fetchCalendar({ from, to: addDays(from, days) });
      // A reply from an older read never overwrites a newer answer (L2).
      if (!cache.accept(token)) return;
      setView(r);
      setError(null);
      cache.publish(token, r);
    } catch (err) {
      if (!cache.accept(token)) return;
      setError(describeWorkerError(err));
    } finally {
      setLoading(false);
    }
  }, [range, cache]);

  // A new range is a new question: re-seed from THAT range's cached answer
  // (usually nothing) instead of leaving the previous range's items on screen
  // under the new heading. Same shape as useLoad's key change.
  const [seededRange, setSeededRange] = useState(range);
  if (range !== seededRange) {
    setSeededRange(range);
    setView(cache.seed);
    setError(null);
    setLoading(true);
  }

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>, said: string) => {
      setBusy(key);
      setActionError(null);
      try {
        await fn();
        setNote(said);
        await load();
      } catch (err) {
        // An action that failed is not a failed LOAD — the calendar on screen
        // is still valid, so it gets its own line and does not replace the
        // view with a retry-the-read state (W3).
        setActionError(`that did not go through — ${describeWorkerError(err)}`);
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const shown = (view?.items ?? []).filter((i) => on[i.layer]);
  const grouped: { day: string; items: CalendarItemView[] }[] = [];
  for (const item of shown) {
    const last = grouped[grouped.length - 1];
    if (last && last.day === item.day) last.items.push(item);
    else grouped.push({ day: item.day, items: [item] });
  }

  return (
    <div className="calendar" aria-label="Calendar">
      <div className="calendar-controls">
        <div className="calendar-layers" role="group" aria-label="layers">
          {CALENDAR_LAYERS.map((l) => (
            <button
              key={l}
              type="button"
              className={on[l] ? "chip layer-chip active" : "chip layer-chip"}
              aria-pressed={on[l]}
              aria-label={`${LAYER_LABEL[l]} layer`}
              onClick={() => setOn((prev) => ({ ...prev, [l]: !prev[l] }))}
            >
              {LAYER_LABEL[l]}
              {/* A count of 0 is a claim about the layer. Until the read has
                  answered there is no count, so the chip says so. */}
              <span className="layer-count"> {view === null ? "–" : view.counts?.[l] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="calendar-range" role="group" aria-label="range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={range === r.id ? "chip active" : "chip"}
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <LoadFailure what="the calendar" error={error} onRetry={() => void load()} retrying={loading} />
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}{" "}
          <button type="button" className="linklike" onClick={() => setActionError(null)}>
            dismiss
          </button>
        </p>
      )}
      {note && (
        <p className="calendar-note" role="status">
          {note}
        </p>
      )}
      {/* Unknown is not empty (FIX-C4): the skeleton until the derivation has
          answered, and only then the window's verdict. */}
      {!error && view === null && <PanelSkeleton what="the calendar" rows={4} />}
      {!error && view !== null && shown.length === 0 && (
        <p className="empty">nothing dated in this window</p>
      )}
      {view !== null && <RefreshingHint active={loading} what="the calendar" />}

      {grouped.map((group) => (
        <section key={group.day} aria-label={group.day}>
          <h3 className="day-heading">
            {group.day} <span className="relative">{group.items[0]?.relative}</span>
          </h3>
          {group.items.map((item) => {
            const plan = planOf(item);
            return (
              <div key={`${item.kind}:${item.refId}`} className={`calendar-row layer-${item.layer}`}>
                <span className="layer-glyph" aria-label={item.layer}>
                  {LAYER_LABEL[item.layer].slice(0, 1)}
                </span>
                <span className="when">{item.allDay ? "all day" : item.rendered}</span>
                <span className="text">{item.title}</span>
                {item.status === "tentative" && (
                  <span className="chip tentative" aria-label="tentative">
                    tentative
                  </span>
                )}
                {item.phrase && (
                  <span className="chip phrase" title="the words this came from">
                    “{item.phrase}”
                  </span>
                )}
                {item.sourceTz && (
                  <span className="chip source-tz" aria-label={`stated in ${item.sourceTz}`}>
                    {item.sourceTz}
                  </span>
                )}
                {item.spaceId && (
                  <button
                    type="button"
                    className="chip filing-chip"
                    aria-label={`filed under ${item.spaceLabel ?? item.spaceId}`}
                    onClick={() => props.onOpenSpace?.(item.spaceId!)}
                  >
                    → {item.spaceLabel ?? item.spaceId}
                  </button>
                )}
                {item.kind === "event" && item.status === "tentative" && (
                  <>
                    <button
                      type="button"
                      className="chip act"
                      disabled={busy === item.refId}
                      aria-label={`confirm ${item.title}`}
                      onClick={() => void act(item.refId, () => confirmCalendarEvent(item.refId), `“${item.title}” is confirmed`)}
                    >
                      confirm
                    </button>
                    <button
                      type="button"
                      className="chip act"
                      disabled={busy === item.refId}
                      aria-label={`drop ${item.title}`}
                      onClick={() => void act(item.refId, () => cancelCalendarEvent(item.refId), `“${item.title}” dropped`)}
                    >
                      not happening
                    </button>
                  </>
                )}
                {plan && plan.status === "opened" && (
                  <span className="calendar-snooze" role="group" aria-label={`snooze ${item.title}`}>
                    {SNOOZE.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="chip act"
                        disabled={busy === plan.id}
                        aria-label={`snooze ${item.title} — ${s.label}`}
                        onClick={() =>
                          void act(plan.id, () => snoozeCalendarPlan(plan.id, s.id), `snoozed — the twin will use "${s.label}" next time`)
                        }
                      >
                        {s.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="chip act"
                      disabled={busy === plan.id}
                      aria-label={`stop planning ${item.title}`}
                      onClick={() => void act(plan.id, () => stopCalendarPlan(plan.id), "planning stopped for this one")}
                    >
                      don't plan this
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
