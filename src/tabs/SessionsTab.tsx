// [CODE] The Sessions surface — arch §14.2, build item 1.11.
//
// Filter by source, stream and date; then per session BOTH boundaries with the
// rule and the measured value, its `seal_mode`, participants, hash, enrichment
// state and reprocess history. `[ replay stream ]` opens the re-segmentation
// panel, which diffs candidate params and refuses to apply them until a human
// confirms (see sessions/ReplayPanel.tsx).
//
// An open session is live, provisional output (§14.0b): marked as in progress,
// updated in place, and — if it stops coming back from the worker — kept and
// labelled rather than silently retracted.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import { dismissRetracted, retainProvisional, type Retained } from "../lib/provisional";
import {
  surfacesClient as defaultClient,
  type MutationReceipt,
  type SessionQuery,
  type SessionView,
  type SessionsPage,
  type SurfacesClient,
} from "../lib/surfaces-client";
import { ReplayPanel } from "./sessions/ReplayPanel";
import { SessionCard } from "./sessions/SessionCard";

const RECEIPT_LIMIT = 4;

export interface SessionsTabProps {
  client?: SurfacesClient;
  coveragePollMs?: number;
}

function queryKey(query: SessionQuery): string {
  return `${query.sourceId ?? ""}|${query.streamId ?? ""}|${query.date ?? ""}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SessionsTab({ client = defaultClient, coveragePollMs }: SessionsTabProps = {}) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [date, setDate] = useState<string>("");

  const [page, setPage] = useState<SessionsPage | null>(null);
  const [rows, setRows] = useState<Retained<SessionView>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [replayStreamId, setReplayStreamId] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);

  const query: SessionQuery = useMemo(
    () => ({ sourceId, streamId, date: date || null }),
    [sourceId, streamId, date],
  );
  const lastKey = useRef<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await client.listSessions(query, signal);
        if (signal?.aborted) return;
        const key = queryKey(query);
        setRows((prev) =>
          retainProvisional(
            lastKey.current === key ? prev : [],
            next.sessions,
            (row) => row.status === "open",
          ),
        );
        lastKey.current = key;
        setPage(next);
        setError(null);
      } catch (err) {
        if (!signal?.aborted) setError(message(err));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [client, query],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const record = useCallback(
    (receipt: MutationReceipt) => {
      setReceipts((prev) => [receipt, ...prev].slice(0, RECEIPT_LIMIT));
      void load();
    },
    [load],
  );

  // A stream filter that no longer matches its source would silently return
  // nothing, so the stream list is narrowed with the source.
  const streams = (page?.streams ?? []).filter(
    (stream) => !sourceId || stream.sourceId === sourceId,
  );

  return (
    <section className="surface surface--sessions" aria-label="Sessions">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">Sessions</h1>

        <div className="surface__tools">
          <label className="surface__filter">
            <span>source</span>
            <select
              aria-label="Filter by source"
              value={sourceId ?? ""}
              onChange={(e) => {
                setSourceId(e.target.value || null);
                setStreamId(null);
              }}
            >
              <option value="">all</option>
              {(page?.sources ?? []).map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>

          <label className="surface__filter">
            <span>stream</span>
            <select
              aria-label="Filter by stream"
              value={streamId ?? ""}
              onChange={(e) => setStreamId(e.target.value || null)}
            >
              <option value="">all</option>
              {streams.map((stream) => (
                <option key={stream.id} value={stream.id}>
                  {stream.label}
                </option>
              ))}
            </select>
          </label>

          <label className="surface__filter">
            <span>date</span>
            <input
              type="date"
              aria-label="Filter by date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>

          <span className="surface__count">{page?.sealedCount ?? 0} sealed</span>
        </div>
      </header>

      {receipts.length > 0 && (
        <ul className="receipts" aria-label="Recent writes">
          {receipts.map((receipt) => (
            <li key={receipt.mutationId} className="receipt">
              ✓ {receipt.field ?? receipt.targetKind} · mutation {receipt.mutationId} · actor{" "}
              {receipt.actor}
            </li>
          ))}
        </ul>
      )}

      {replayStreamId && (
        <ReplayPanel
          client={client}
          streamId={replayStreamId}
          onReceipt={record}
          onClose={() => setReplayStreamId(null)}
        />
      )}

      {error ? (
        <p className="surface__error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="surface__empty">loading sessions…</p>
      ) : rows.length === 0 ? (
        <p className="surface__empty">no sessions match this filter</p>
      ) : (
        <ol className="session-list">
          {rows.map((entry) => (
            <SessionCard
              key={entry.row.id}
              session={entry.row}
              retracted={entry.retracted}
              onDismissRetracted={(id) => setRows((prev) => dismissRetracted(prev, id))}
              onReplayStream={setReplayStreamId}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
