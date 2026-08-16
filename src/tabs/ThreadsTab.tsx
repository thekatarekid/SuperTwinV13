// [CODE] The Threads surface — arch §14.4 (arcs), build item 2.7.
//
//   THREADS  [live 18][dormant 24][archived 61]              🔍   📌 pinned
//
// ALL arcs, promoted or not. Promotion is a field on the arc (brief rule 6), so
// there is no filter that hides the unpromoted ones — an unpromoted thread
// simply says "space: not promoted". The source-contribution timeline is the
// core visual, the binding signals are shown in precedence order with their
// measured values, and `[ why together? ]` expands the stated reasons verbatim.
//
// The unsure queue is the human loop for P-AG2's `un` verdicts (§11.2 rule 5):
// while a question waits, nothing is bound.
//
// The surface carries the coverage meter, like all eight (§14.0). A provisional
// thread that disappears from a refresh is kept and labelled, not silently
// dropped (§14.0b, lib/provisional.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import {
  dismissRetracted,
  livingRows,
  retainProvisional,
  type Retained,
} from "../lib/provisional";
import { USER_ACTOR, type MutationReceipt } from "../lib/surfaces-client";
import {
  ARC_STATES,
  threadsClient as defaultClient,
  type ArcAnswer,
  type ArcQuery,
  type ArcQuestionView,
  type ArcState,
  type ArcView,
  type ArcsPage,
  type ThreadsClient,
} from "../lib/threads-client";
import { ThreadCard, type ThreadGesture } from "./threads/ThreadCard";
import { UnsureQueue } from "./threads/UnsureQueue";

const SEARCH_DEBOUNCE_MS = 200;
const RECEIPT_LIMIT = 4;

export interface ThreadsTabProps {
  client?: ThreadsClient;
  coveragePollMs?: number;
}

function queryKey(query: ArcQuery): string {
  return `${query.state ?? ""}|${query.q ?? ""}|${query.pinnedOnly ? "1" : ""}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ThreadsTab({ client = defaultClient, coveragePollMs }: ThreadsTabProps = {}) {
  const [state, setState] = useState<ArcState | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);

  const [page, setPage] = useState<ArcsPage | null>(null);
  const [rows, setRows] = useState<Retained<ArcView>[]>([]);
  const [queue, setQueue] = useState<ArcQuestionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query: ArcQuery = useMemo(
    () => ({ state, q: debounced, pinnedOnly }),
    [state, debounced, pinnedOnly],
  );
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [next, waiting] = await Promise.all([
          client.listArcs(query, signal),
          client.listArcQuestions(signal),
        ]);
        if (signal?.aborted) return;
        const key = queryKey(query);
        setRows((prev) =>
          retainProvisional(
            lastKey.current === key ? prev : [],
            next.arcs,
            (row) => row.provisional,
          ),
        );
        lastKey.current = key;
        setPage(next);
        setQueue(waiting);
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
    async (gesture: ThreadGesture) => {
      setBusyId(gesture.id);
      setGestureError(null);
      try {
        const actor = USER_ACTOR;
        let receipt: MutationReceipt;
        switch (gesture.kind) {
          case "remove_episode":
            receipt = await client.removeArcEpisode({
              id: gesture.id,
              episodeId: gesture.episodeId,
              actor,
            });
            break;
          case "split":
            receipt = await client.splitArc({
              id: gesture.id,
              episodeIds: gesture.episodeIds,
              actor,
            });
            break;
          case "merge":
            receipt = await client.mergeArc({ id: gesture.id, into: gesture.into, actor });
            break;
          case "pin":
            receipt = await client.pinArc({ id: gesture.id, pinned: gesture.pinned, actor });
            break;
          case "relabel":
            receipt = await client.relabelArc({ id: gesture.id, label: gesture.label, actor });
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

  const answer = useCallback(
    async (questionId: string, verdict: ArcAnswer) => {
      setBusyId(questionId);
      setGestureError(null);
      try {
        record(await client.answerArcQuestion({ id: questionId, answer: verdict, actor: USER_ACTOR }));
        await load();
      } catch (err) {
        setGestureError(`answer failed — ${message(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [client, load, record],
  );

  const peers = useMemo(
    () => livingRows(rows).map((row) => ({ id: row.id, label: row.label ?? row.id })),
    [rows],
  );
  const counts = page?.counts;

  return (
    <section className="surface surface--threads" aria-label="Threads">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">Threads</h1>

        <ul className="type-filters" aria-label="Thread states">
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
          {ARC_STATES.map((s) => (
            <li key={s}>
              <button
                type="button"
                className={"type-filter" + (state === s ? " type-filter--on" : "")}
                aria-pressed={state === s}
                onClick={() => setState(state === s ? null : s)}
              >
                {s} {counts?.[s] ?? 0}
              </button>
            </li>
          ))}
        </ul>

        <div className="surface__tools">
          <label className="surface__search">
            <span className="surface__search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              type="search"
              aria-label="Search threads"
              placeholder="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <button
            type="button"
            className={"surface__toggle" + (pinnedOnly ? " surface__toggle--on" : "")}
            aria-pressed={pinnedOnly}
            onClick={() => setPinnedOnly((v) => !v)}
          >
            <span aria-hidden="true">📌 </span>pinned only
          </button>

          {/* §14.4 lists ALL arcs; promotion is a field, never a filter. */}
          <span className="surface__count">promoted and unpromoted alike</span>
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

      <UnsureQueue items={queue} onAnswer={(id, v) => void answer(id, v)} busyId={busyId} />

      {error ? (
        <p className="surface__error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="surface__empty">loading threads…</p>
      ) : rows.length === 0 ? (
        <p className="surface__empty">no threads match this filter</p>
      ) : (
        <ol className="arc-list">
          {rows.map((entry) => (
            <ThreadCard
              key={entry.row.id}
              arc={entry.row}
              retracted={entry.retracted}
              onDismissRetracted={(arcId) => setRows((prev) => dismissRetracted(prev, arcId))}
              peers={peers}
              onGesture={(gesture) => void runGesture(gesture)}
              busy={busyId === entry.row.id}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
