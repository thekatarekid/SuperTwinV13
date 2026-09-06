// ===========================================================================
// Freshness chip — build P2.4, spec §5.4 / §14.2 ("freshness chip per §5.4
// lives in the header area").
//
// It renders the cross-source "Knows you: X → Y" headline PLUS the one-phrase
// state the worker computes: "up to date", "importing history — 2,569 events
// left", or "catching up — 14 min behind". Hovering shows the per-source
// detail lines.
//
// The 13.4.1 chip replaced the whole headline with a raw lag number the moment
// the promise was breached, and that number was computed over imported history
// — so it read "catching up — 236 min behind" and grew by a minute a minute,
// telling the user nothing they could act on and never settling. The lag math
// is fixed in worker/src/freshness; here the two consequences are: the
// identity line survives alongside the state, and a quiet system says "up to
// date" instead of showing no state at all.
// ===========================================================================

import { useEffect, useState } from "react";
import { fetchFreshness, type FreshnessOverview } from "../lib/api";

const REFRESH_MS = 60_000;

export function FreshnessChip(): JSX.Element | null {
  const [data, setData] = useState<FreshnessOverview | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void fetchFreshness()
        .then((d) => {
          if (alive) setData(d);
        })
        .catch(() => {
          if (alive) setData(null);
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Nothing captured at all: no chip, rather than an empty promise.
  if (!data || data.status === "no_data") return null;

  const lagging = data.status === "catching_up";
  const detail = data.sources
    .filter((s) => s.label)
    .map((s) => `${s.source_id}: ${s.label} — ${s.detail}`)
    .join("\n");

  // L6 — SAY THAT IT IS A ROLL-UP. This chip's range is the union of every
  // source's and its counter is their sum, so with two sources importing it
  // printed "importing history — 11,466 events left" as if that were one
  // thing; it was 6,649 browser + 4,359 WhatsApp, and the range beside it
  // ("2010 → 32 min ago") belonged to neither source whole. Per-source status
  // is the Library's job (each sub-tab owns its own panel); what stays global
  // is honest only if it admits how many sources it is adding up.
  const contributing = data.sources.filter(
    (s) => s.status === data.status && (s.pending_backfill_count > 0 || s.pending_live_count > 0),
  ).length;
  const across = contributing > 1 ? ` across ${contributing} sources` : "";

  return (
    <span
      className={`chip freshness-chip freshness-${data.status}${lagging ? " lagging" : ""}`}
      title={detail || data.status_label}
      aria-label="freshness"
    >
      {data.label ? (
        <>
          {/* Dropped first when the header runs out of room: the state is the
              part the user needs, the identity line is the nice-to-have. */}
          <span className="freshness-knows">{data.label} · </span>
          <span className="freshness-state">
            {data.status_label}
            {across}
          </span>
        </>
      ) : (
        <span className="freshness-state">
          {data.status_label}
          {across}
        </span>
      )}
    </span>
  );
}
