// ===========================================================================
// Settings › Sources — one line per connected source: stream count, pause
// state, whether the backfill finished, and when the last event landed.
// ===========================================================================

import { LoadFallback, useLoad } from "../../components/LoadState";
import { fetchSettingsSources, type SourceStatusRow } from "../../lib/api";
import { rowStyle } from "./shared";

export function SourcesPanel(): JSX.Element {
  const gate = useLoad<SourceStatusRow[]>(async () => (await fetchSettingsSources()).sources);
  const rows = gate.data;
  if (!rows) return <LoadFallback state={gate} what="the source list" />;
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
