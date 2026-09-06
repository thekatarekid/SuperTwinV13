// ===========================================================================
// The follow-up radar — V6 P1 R2 (Product_V6 §11.8.3, Product_V6_Phase1 §11.6;
// CRM-01, CRM-02).
//
// S5.4 computed the radar worker-side (people/radar.ts, GET /api/people/radar)
// and nothing rendered it. This is the render.
//
// Two columns of debt, both computed by CODE over the last exchange in each
// stream — no model anywhere on this path:
//
//   you owe        the other party asked and you have not written since
//   waiting on     you asked and nobody has answered
//
// Every entry carries the moment the twin starts acting: asked + the lead time
// for that person's circle (partner 1 day … acquaintances 7), overridable per
// person and remembered. Past that moment the entry is OVERDUE and says so.
// A 180-member broadcast is not a debt and never appears (CRM-02) — that rule
// lives in the worker, so the surface has nothing to filter.
//
// Rows are already ordered by the worker, soonest follow-up first.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import { LoadFailure } from "../../components/LoadState";
import { describeWorkerError, fetchRadar, setRadarLead, type RadarEntryView } from "../../lib/api";
import { circleLabel } from "../../modals/PersonModal";

const DIRECTIONS = [
  { key: "i_owe", title: "You owe a reply", blurb: "they asked, you have not written since" },
  { key: "they_owe", title: "Waiting on them", blurb: "you asked, nobody has answered" },
] as const;

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** "Sameer" · the group's key · "someone" — never a plausible fill. */
function who(e: RadarEntryView): string {
  if (e.personName) return e.personName;
  if (e.isGroup) return e.streamKey;
  return e.personId ?? e.streamKey;
}

function Row(props: { entry: RadarEntryView; onLead: (personId: string, days: number) => void }): JSX.Element {
  const e = props.entry;
  return (
    <div className={`row radar-row${e.overdue ? " overdue" : ""}`} aria-label={`radar ${e.direction} ${who(e)}`}>
      <span className="glyph">{e.direction === "i_owe" ? "◀" : "▶"}</span>
      <span className="radar-who">{who(e)}</span>
      {e.circle && <span className="chip">⦿ {circleLabel(e.circle)}</span>}
      {e.isGroup && <span className="chip">group</span>}
      <span className="meta radar-ask">❝{e.askText}❞</span>
      <span className="meta">asked {day(e.askedAt)}</span>
      <span className={`chip${e.overdue ? " accent" : ""}`}>
        {e.overdue ? `overdue — start was ${day(e.followUpAt)}` : `starts ${day(e.followUpAt)}`}
      </span>
      {e.personId && (
        <label className="meta radar-lead">
          lead{" "}
          <input
            type="number"
            style={{ width: 52 }}
            aria-label={`lead days for ${who(e)}`}
            defaultValue={e.leadDays}
            onBlur={(ev) => {
              const n = Number(ev.target.value);
              if (Number.isFinite(n) && n !== e.leadDays) props.onLead(e.personId!, Math.max(0, Math.round(n)));
            }}
          />{" "}
          d
        </label>
      )}
    </div>
  );
}

export function Radar(props: {
  /** Filter to one person (the person card's half of the radar). */
  person?: string;
  /** Pin the clock — the tests and the person card ask "at what time?". */
  now?: string;
}): JSX.Element {
  const [radar, setRadar] = useState<RadarEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchRadar({
        ...(props.person ? { person: props.person } : {}),
        ...(props.now ? { now: props.now } : {}),
      });
      setRadar(r.radar);
      setError(null);
    } catch (err) {
      setError(describeWorkerError(err));
    } finally {
      setLoading(false);
    }
  }, [props.person, props.now]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onLead = useCallback(
    async (personId: string, days: number) => {
      try {
        setSaveError(null);
        await setRadarLead(personId, days);
        await refresh();
      } catch (err) {
        // A failed save is not a failed READ: the radar on screen is still
        // valid, so it keeps its own line (W3).
        setSaveError(`could not save that lead time — ${describeWorkerError(err)}`);
      }
    },
    [refresh],
  );

  const overdue = (radar ?? []).filter((e) => e.overdue).length;

  return (
    <section className="card radar" aria-label="Follow-up radar">
      <h2>
        Follow-up radar
        {overdue > 0 && <span className="chip accent radar-count">{overdue} overdue</span>}
      </h2>
      <p className="meta">
        Who owes you a reply, and who you owe — read off the last exchange in each chat, by code, with
        no model call. The lead time is when the twin starts acting; it defaults to the circle and is
        remembered per person.
      </p>

      {error && (
        <LoadFailure what="the follow-up radar" error={error} onRetry={() => void refresh()} retrying={loading} />
      )}
      {saveError && (
        <p className="error" role="alert">
          {saveError}{" "}
          <button type="button" className="linklike" onClick={() => setSaveError(null)}>
            dismiss
          </button>
        </p>
      )}
      {!error && radar === null && <p className="empty">loading…</p>}
      {!error && radar !== null && radar.length === 0 && <p className="empty">nothing owed either way</p>}

      {radar !== null &&
        radar.length > 0 &&
        DIRECTIONS.map((d) => {
          const rows = radar.filter((e) => e.direction === d.key);
          if (rows.length === 0) return null;
          return (
            <div key={d.key} className="radar-group" aria-label={`radar ${d.key}`}>
              <h3 className="radar-title">
                {d.title} <span className="meta">{d.blurb}</span>
                <span className="meta"> {rows.length}</span>
              </h3>
              {rows.map((e) => (
                <Row key={`${e.streamKey}:${e.eventId}`} entry={e} onLead={(id, n) => void onLead(id, n)} />
              ))}
            </div>
          );
        })}
    </section>
  );
}
