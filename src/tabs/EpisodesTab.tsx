// [CODE] The Episodes surface — arch §14.3, build item 2.7.
//
//   EPISODES  [open 22][closed·concluded 61][closed·faded 31]  stream [▾]
//
// State filters, and per episode the session list with attach/split provenance,
// confidence and reason. `[ why? ]` renders the persisted verdict. The gestures
// — detach, split, merge back, relabel, close — all write
// `mutations(actor:user)`, and the tab prints every receipt, so a gesture that
// wrote nothing cannot look like one that wrote a row.
//
// The surface carries the coverage meter, like all eight (§14.0), and an
// episode built on a still-open session is live, provisional output (§14.0b):
// marked, updated in place, and — if it stops coming back — kept and labelled
// rather than silently retracted.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import {
  EPISODE_STATE_FILTERS,
  EPISODE_STATE_LABEL,
  episodesClient as defaultClient,
  type EpisodeQuery,
  type EpisodeStateFilter,
  type EpisodeView,
  type EpisodesClient,
  type EpisodesPage,
} from "../lib/episodes-client";
import { dismissRetracted, retainProvisional, type Retained } from "../lib/provisional";
import { USER_ACTOR, type MutationReceipt } from "../lib/surfaces-client";
import { EpisodeCard, type EpisodeGesture } from "./episodes/EpisodeCard";

const RECEIPT_LIMIT = 4;

export interface EpisodesTabProps {
  client?: EpisodesClient;
  /** Passed to the coverage meter; 0 disables its polling. */
  coveragePollMs?: number;
}

function queryKey(query: EpisodeQuery): string {
  return `${query.state ?? ""}|${query.streamId ?? ""}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An episode is live while any of its sessions is open, or while it is itself
 * provisional. Both are §14.0b output, so both are worth retaining when they
 * disappear from a refresh.
 */
function isProvisional(episode: EpisodeView): boolean {
  return episode.provisional || episode.sessions.some((row) => row.sessionOpen);
}

export function EpisodesTab({ client = defaultClient, coveragePollMs }: EpisodesTabProps = {}) {
  const [state, setState] = useState<EpisodeStateFilter | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);

  const [page, setPage] = useState<EpisodesPage | null>(null);
  const [rows, setRows] = useState<Retained<EpisodeView>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query: EpisodeQuery = useMemo(() => ({ state, streamId }), [state, streamId]);
  const lastKey = useRef<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await client.listEpisodes(query, signal);
        if (signal?.aborted) return;
        const key = queryKey(query);
        // A filter change is not a retraction: the retention window restarts
        // whenever the question itself changed.
        setRows((prev) =>
          retainProvisional(lastKey.current === key ? prev : [], next.episodes, isProvisional),
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

  const record = useCallback((receipt: MutationReceipt) => {
    setReceipts((prev) => [receipt, ...prev].slice(0, RECEIPT_LIMIT));
  }, []);

  const runGesture = useCallback(
    async (gesture: EpisodeGesture) => {
      setBusyId(gesture.id);
      setGestureError(null);
      try {
        const actor = USER_ACTOR;
        let receipt: MutationReceipt;
        switch (gesture.kind) {
          case "detach":
            receipt = await client.detachSession({
              id: gesture.id,
              sessionId: gesture.sessionId,
              actor,
            });
            break;
          case "split":
            receipt = await client.splitEpisode({
              id: gesture.id,
              sessionIds: gesture.sessionIds,
              actor,
            });
            break;
          case "merge_back":
            receipt = await client.mergeEpisode({ id: gesture.id, into: gesture.into, actor });
            break;
          case "relabel":
            receipt = await client.relabelEpisode({ id: gesture.id, label: gesture.label, actor });
            break;
          case "close":
            receipt = await client.closeEpisode({
              id: gesture.id,
              outcome: gesture.outcome,
              actor,
            });
            break;
        }
        record(receipt);
        await load();
      } catch (err) {
        setGestureError(`${gesture.kind} failed — ${message(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [client, load, record],
  );

  const counts = page?.counts;

  return (
    <section className="surface surface--episodes" aria-label="Episodes">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">Episodes</h1>

        <ul className="type-filters" aria-label="Episode states">
          <li>
            <button
              type="button"
              className={"type-filter" + (state === null ? " type-filter--on" : "")}
              aria-pressed={state === null}
              onClick={() => setState(null)}
            >
              all
            </button>
          </li>
          {EPISODE_STATE_FILTERS.map((s) => (
            <li key={s}>
              <button
                type="button"
                className={"type-filter" + (state === s ? " type-filter--on" : "")}
                aria-pressed={state === s}
                onClick={() => setState(state === s ? null : s)}
              >
                {EPISODE_STATE_LABEL[s]} {counts?.[s] ?? 0}
              </button>
            </li>
          ))}
        </ul>

        <div className="surface__tools">
          <label className="surface__filter">
            <span>stream</span>
            <select
              aria-label="Filter by stream"
              value={streamId ?? ""}
              onChange={(e) => setStreamId(e.target.value || null)}
            >
              <option value="">all</option>
              {(page?.streams ?? []).map((stream) => (
                <option key={stream.id} value={stream.id}>
                  {stream.label}
                </option>
              ))}
            </select>
          </label>
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

      {gestureError && (
        <p className="surface__error" role="alert">
          {gestureError}
        </p>
      )}

      {error ? (
        <p className="surface__error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="surface__empty">loading episodes…</p>
      ) : rows.length === 0 ? (
        <p className="surface__empty">no episodes match this filter</p>
      ) : (
        <ol className="episode-list">
          {rows.map((entry) => (
            <EpisodeCard
              key={entry.row.id}
              episode={entry.row}
              retracted={entry.retracted}
              onDismissRetracted={(episodeId) =>
                setRows((prev) => dismissRetracted(prev, episodeId))
              }
              onGesture={(gesture) => void runGesture(gesture)}
              busy={busyId === entry.row.id}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
