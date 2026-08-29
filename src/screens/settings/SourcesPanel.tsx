// ===========================================================================
// Settings › Sources — one line per connected source: stream count, pause
// state, whether the backfill finished, and when the last event landed.
// ===========================================================================

import { useEffect, useState } from "react";

import { fetchSettingsSources, type SourceStatusRow } from "../../lib/api";
import { rowStyle } from "./shared";

export function SourcesPanel(): JSX.Element {
  const [rows, setRows] = useState<SourceStatusRow[] | null>(null);
  useEffect(() => {
    void fetchSettingsSources()
      .then((r) => setRows(r.sources))
      .catch(() => {});
  }, []);
  if (!rows) return <p className="empty">loading…</p>;
  if (rows.length === 0) return <p className="empty">No sources connected yet.</p>;
  return (
    <div>
      <h2>Sources</h2>
      {rows.map((r) => (
        <div key={r.source} style={rowStyle}>
          <span>
            {r.source} · {r.streams} stream{r.streams === 1 ? "" : "s"}
            {r.paused_streams > 0 && ` (${r.paused_streams} paused)`}
          </span>
          <span className="meta">
            {r.paused ? "source paused" : r.import_done ? "backfilled" : "importing"}
            {r.last_event_at && ` · last ${r.last_event_at.slice(0, 16)}`}
          </span>
        </div>
      ))}
    </div>
  );
}
