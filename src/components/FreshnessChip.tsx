// ===========================================================================
// Freshness chip — build P2.4, spec §5.4 / §14.2 ("freshness chip per §5.4
// lives in the header area"). Renders the cross-source "Knows you: X → Y"
// headline; hovering shows the per-source detail lines; a lag variant
// ("catching up — 14 min behind") appears only when the 10-minute promise is
// breached somewhere.
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

  if (!data?.label) return null;
  const lagging = data.lag_minutes != null;
  const detail = data.sources
    .filter((s) => s.label)
    .map((s) => `${s.source_id}: ${s.label} — ${s.detail}`)
    .join("\n");
  return (
    <span
      className={`chip freshness-chip${lagging ? " lagging" : ""}`}
      title={detail}
      aria-label="freshness"
    >
      {lagging ? `catching up — ${data.lag_minutes} min behind` : data.label}
    </span>
  );
}
