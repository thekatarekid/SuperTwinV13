// ===========================================================================
// Library › Storage — V6 P1 S1.8 (backlog T5-5/6/7; Product_V6 §590).
//
// Free space FIRST ("1.6 GB · 487 GB free"). Then one track per source with
// two bars on it: searchable (everything kept, disk only) and understood (the
// subset sent to the model, money), each with its byte count. Rows outside
// the understand window are said, in words, to be searchable but to carry no
// episode (T5-7). Then the two disk budgets — events and derived per year,
// media with its own retention — each with its OWN control; the two handles
// never share one (T5-6).
//
// Copy: "Keeping more history costs disk. Understanding more history costs
// money." — served by the worker so the Library and the card agree.
//
// "Change windows" on a source opens the same ConfirmCard the connect flows
// use; the worker counts the log for a re-confirm.
// ===========================================================================

import { useEffect, useRef, useState } from "react";

import {
  LoadFailure,
  PANE_FRESH_MS,
  PanelSkeleton,
  RefreshingHint,
  useLoad,
} from "../../components/LoadState";
import {
  fetchLibraryStorage,
  saveDiskBudgets,
  type DiskBudgets,
  type SourceStorage,
  type TierBar,
} from "../../lib/api";
import { ConfirmCard } from "./ConfirmCard";

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

const GB = 1_000_000_000;

function toGb(bytes: number): string {
  return String(Math.round((bytes / GB) * 10) / 10);
}

function span(bar: TierBar): string {
  if (!bar.from || !bar.to) return "nothing yet";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const f = new Date(bar.from);
  const t = new Date(bar.to);
  const fmt = (d: Date): string => `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const a = fmt(f);
  const b = fmt(t);
  return a === b ? a : `${a} → ${b}`;
}

function windowLabel(s: SourceStorage): string {
  if (!s.consent) return "no consent";
  const idx = s.consent.index_all ? "everything kept" : `kept from ${s.consent.index_from!.slice(0, 10)}`;
  const und = s.consent.understand_from ? `understood from ${s.consent.understand_from.slice(0, 10)}` : "nothing understood";
  return `${idx} · ${und} · ${s.consent.state}`;
}

function SourceTrack(props: { s: SourceStorage; onChange: () => void }): JSX.Element {
  const { s } = props;
  const total = Math.max(s.searchable.events, 1);
  const understoodPct = Math.round((s.understood.events / total) * 100);
  return (
    <div className="storage-source" role="group" aria-label={`${s.label} storage`}>
      <div className="storage-source-head">
        <strong>{s.label}</strong>
        <span className="meta">{windowLabel(s)}</span>
        <span className="inbox-bar-spacer" />
        <button type="button" className="btn" onClick={props.onChange} aria-label={`change ${s.label} windows`}>
          Change windows
        </button>
      </div>
      <div className="storage-track" aria-label={`${s.label} tiers`}>
        <div
          className="storage-bar storage-bar-searchable"
          role="progressbar"
          aria-label={`${s.label} searchable`}
          aria-valuemin={0}
          aria-valuemax={s.searchable.events}
          aria-valuenow={s.searchable.events}
          style={{ width: "100%" }}
        />
        <div
          className="storage-bar storage-bar-understood"
          role="progressbar"
          aria-label={`${s.label} understood`}
          aria-valuemin={0}
          aria-valuemax={s.searchable.events}
          aria-valuenow={s.understood.events}
          style={{ width: `${s.searchable.events === 0 ? 0 : understoodPct}%` }}
        />
      </div>
      <div className="storage-legend">
        <span className="storage-legend-item">
          <i className="storage-swatch storage-swatch-searchable" aria-hidden="true" />
          searchable · {s.searchable.events.toLocaleString("en-US")} events · {formatBytes(s.searchable.bytes)} ·{" "}
          {span(s.searchable)}
        </span>
        <span className="storage-legend-item">
          <i className="storage-swatch storage-swatch-understood" aria-hidden="true" />
          understood · {s.understood.events.toLocaleString("en-US")} events · {formatBytes(s.understood.bytes)} ·{" "}
          {span(s.understood)}
        </span>
      </div>
      {s.searchable_only.events > 0 && (
        <p className="storage-note" role="note">
          {s.searchable_only.events.toLocaleString("en-US")} {s.searchable_only.events === 1 ? "event is" : "events are"}{" "}
          <strong>searchable only</strong> ({formatBytes(s.searchable_only.bytes)}). {s.searchable_only.note}
        </p>
      )}
    </div>
  );
}

function BudgetControl(props: {
  id: string;
  label: string;
  hint: string;
  valueGb: string;
  onSave: (gb: number) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(props.valueGb);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(props.valueGb), [props.valueGb]);
  return (
    <div className="storage-budget" role="group" aria-label={props.label}>
      <label className="connect-field">
        <span>{props.label}</span>
        <input
          aria-label={`${props.label} (GB)`}
          type="number"
          min={0.1}
          step={0.5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <span className="meta">GB</span>
      </label>
      <button
        type="button"
        className="btn"
        disabled={saving || draft === props.valueGb}
        onClick={() => {
          const gb = Number(draft);
          if (!Number.isFinite(gb) || gb <= 0) return;
          setSaving(true);
          void props.onSave(gb).finally(() => setSaving(false));
        }}
      >
        Save
      </button>
      <p className="storage-budget-hint">{props.hint}</p>
    </div>
  );
}

export function StoragePanel(): JSX.Element {
  // The disk read is a sum over the whole event log; on the user's machine it
  // measured 4 s while an import was running. Cached per pane so coming back to
  // the Storage tab repaints the last answer in the same frame (L2).
  const gate = useLoad(fetchLibraryStorage, [], {
    cacheKey: "library.storage",
    freshFor: PANE_FRESH_MS,
  });
  const data = gate.data;
  const load = gate.retry;
  const [changing, setChanging] = useState<string | null>(null);
  const [retention, setRetention] = useState<string>("");
  /** A refused save is not a failed read — it keeps its own dismissible line. */
  const [saveError, setSaveError] = useState<string | null>(null);

  // The retention field follows the worker's number, but never over a draft the
  // user is typing: only a value we have not synced yet replaces it.
  const serverRetention = data ? String(data.budgets.media_retention_days) : "";
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (serverRetention !== "" && synced.current !== serverRetention) {
      synced.current = serverRetention;
      setRetention(serverRetention);
    }
  }, [serverRetention]);

  async function save(patch: Partial<DiskBudgets>): Promise<void> {
    try {
      const { budgets } = await saveDiskBudgets(patch);
      if (data) gate.setData({ ...data, budgets });
      setSaveError(null);
    } catch {
      setSaveError("that budget was not accepted (100 MB – 10 TB; retention 7 – 3650 days)");
    }
  }

  // Unknown is not empty: no claim about the disk until the worker answers one.
  if (gate.unknown) {
    return <PanelSkeleton what="the storage overview" rows={3} className="storage" />;
  }

  if (!data) {
    return (
      <section className="card storage" aria-label="Storage">
        <LoadFailure
          what="the storage overview"
          error={gate.error ?? "the storage overview didn't load"}
          onRetry={load}
          retrying={gate.loading}
        />
      </section>
    );
  }

  const used = data.used.events_derived_bytes + data.used.media_bytes;

  return (
    <section className="card storage" aria-label="Storage">
      <header className="storage-head">
        <p className="storage-lead" aria-label="disk use">
          <strong>{formatBytes(used)}</strong> · {formatBytes(data.disk.free_bytes)} free
        </p>
        <p className="storage-copy">{data.copy.lead}</p>
        <RefreshingHint active={gate.refreshing} what="disk use" />
      </header>

      {gate.error !== null && (
        <p className="meta" role="status">
          showing the last reading — couldn't refresh: {gate.error}{" "}
          <button type="button" className="linklike" onClick={load}>
            try again
          </button>
        </p>
      )}

      {data.sources.length === 0 ? (
        <p className="empty">No source is connected yet. Connect one from its tab and its two bars appear here.</p>
      ) : (
        data.sources.map((s) =>
          changing === s.source ? (
            <div key={s.source} className="storage-source">
              <ConfirmCard
                source={s.source}
                confirmLabel="Confirm new windows"
                onCancel={() => setChanging(null)}
                onConfirmed={() => {
                  setChanging(null);
                  void load();
                }}
              />
            </div>
          ) : (
            <SourceTrack key={s.source} s={s} onChange={() => setChanging(s.source)} />
          ),
        )
      )}

      <div className="storage-budgets" role="group" aria-label="disk budgets">
        <h2>Two disk budgets</h2>
        <BudgetControl
          id="events"
          label="Events and derived, per year"
          hint={`Using ${formatBytes(data.used.events_derived_bytes)} for the log, indexes, episodes and traces.`}
          valueGb={toGb(data.budgets.events_bytes_per_year)}
          onSave={(gb) => save({ events_bytes_per_year: Math.round(gb * GB) })}
        />
        <BudgetControl
          id="media"
          label="Media"
          hint={`Using ${formatBytes(data.used.media_bytes)} of photos, videos, voice notes and documents.`}
          valueGb={toGb(data.budgets.media_bytes)}
          onSave={(gb) => save({ media_bytes: Math.round(gb * GB) })}
        />
        <div className="storage-budget" role="group" aria-label="Media retention">
          <label className="connect-field">
            <span>Keep media for</span>
            <input
              aria-label="media retention (days)"
              type="number"
              min={7}
              max={3650}
              step={1}
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
            />
            <span className="meta">days</span>
          </label>
          <button
            type="button"
            className="btn"
            disabled={retention === String(data.budgets.media_retention_days)}
            onClick={() => void save({ media_retention_days: Number(retention) })}
          >
            Save
          </button>
          <p className="storage-budget-hint">Thumbnails only past the window. Deleting media never touches what was said about it.</p>
        </div>
      </div>

      {saveError && (
        <p className="error" role="alert">
          {saveError}{" "}
          <button type="button" className="linklike" onClick={() => setSaveError(null)}>
            dismiss
          </button>
        </p>
      )}
    </section>
  );
}
