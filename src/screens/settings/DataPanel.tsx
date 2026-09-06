// ===========================================================================
// Settings › Data — storage per store, the export path, trace retention, and
// the honest-delete statement (the cascading delete itself lives in
// Library › Screen).
// ===========================================================================

import { useState } from "react";

import { LoadFallback, useLoad } from "../../components/LoadState";
import {
  describeWorkerError,
  fetchSettingsData,
  saveTracesRetention,
  type DataSettings,
} from "../../lib/api";
import { mb, rowStyle, SaveError } from "./shared";

export function DataPanel(): JSX.Element {
  const gate = useLoad<DataSettings>(fetchSettingsData);
  const s = gate.data;
  const setS = gate.setData;
  // A save that silently did nothing is the same lie as a spinner that never
  // resolves: the field springs back and the user is told nothing (W3).
  const [saveError, setSaveError] = useState<string | null>(null);
  if (!s) return <LoadFallback state={gate} what="Data settings" />;
  return (
    <div>
      <h2>Data</h2>
      <h3>Storage</h3>
      <div style={rowStyle}>
        <span>Database</span>
        <span className="meta">{mb(s.storage.db_bytes)}</span>
      </div>
      <div style={rowStyle}>
        <span>Traces</span>
        <span className="meta">{mb(s.storage.traces_bytes)}</span>
      </div>
      <div style={rowStyle}>
        <span>Media</span>
        <span className="meta">{mb(s.storage.media_bytes)}</span>
      </div>
      <div style={rowStyle}>
        <span>Logs</span>
        <span className="meta">{mb(s.storage.logs_bytes)}</span>
      </div>
      {s.events_per_source.map((r) => (
        <div key={r.source} style={rowStyle}>
          <span className="meta">{r.source}</span>
          <span className="meta">{r.events} events</span>
        </div>
      ))}
      <h3>Export</h3>
      <p className="meta">Everything lives under {s.home} — SQLite + JSON, yours to copy.</p>
      <h3>Retention</h3>
      <div style={rowStyle}>
        <span>Trace detail kept (days; index rows keep forever)</span>
        <input
          type="number"
          style={{ width: 80 }}
          defaultValue={s.retention.traces_days}
          onBlur={(e) => {
            setSaveError(null);
            void saveTracesRetention(Number(e.target.value))
              .then(() => fetchSettingsData().then(setS))
              .catch((err: unknown) => setSaveError(`retention not saved — ${describeWorkerError(err)}`));
          }}
        />
      </div>
      <SaveError error={saveError} onDismiss={() => setSaveError(null)} />
      <h3>Honest delete</h3>
      <p className="meta">
        Deleting a span (Library › Screen) hard-deletes the events AND everything derived from
        them — episodes, claims, tasks. No soft hides.
      </p>
    </div>
  );
}
