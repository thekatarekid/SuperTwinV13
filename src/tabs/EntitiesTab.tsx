// [CODE] The Entities surface — arch §14.1, build item 1.11.
//
// Type filters with counts, search, an unresolved filter, and per entity: its
// identities with `decided_by` and confidence, its 1-hop relation graph with
// subtype labels and evidence quotes, and its session/episode/arc counts. The
// six gestures (merge, split, rename, pin, add relation, reject edge) all write
// `mutations(actor:user)` — the tab issues every one of those writes and prints
// the receipt, so no gesture can be believed to have happened without a row.
//
// Provisional entities are marked (§14.0b), and a provisional entity that
// disappears from a refresh is kept, struck through and labelled instead of
// silently vanishing — see lib/provisional.ts.
//
// Like the Inbox, the client is injectable so tests drive a fake worker.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import {
  dismissRetracted,
  livingRows,
  retainProvisional,
  type Retained,
} from "../lib/provisional";
import {
  ENTITY_TYPES,
  USER_ACTOR,
  surfacesClient as defaultClient,
  type EntitiesPage,
  type EntityQuery,
  type EntityType,
  type EntityView,
  type MutationReceipt,
  type ResolutionQueueItem,
  type ResolutionVerdict,
  type SurfacesClient,
} from "../lib/surfaces-client";
import { EntityCard, type EntityGesture } from "./entities/EntityCard";
import { ResolutionQueue } from "./entities/ResolutionQueue";

/** Typing is a filter, not a submit; long enough to not fetch per keystroke. */
const SEARCH_DEBOUNCE_MS = 200;

/** How many receipts stay on screen. Enough to see a burst of answers. */
const RECEIPT_LIMIT = 4;

export interface EntitiesTabProps {
  client?: SurfacesClient;
  /** Passed through to the coverage meter; 0 disables its polling. */
  coveragePollMs?: number;
}

function queryKey(query: EntityQuery): string {
  return `${query.type ?? ""}|${query.q ?? ""}|${query.unresolvedOnly ? "1" : ""}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function EntitiesTab({ client = defaultClient, coveragePollMs }: EntitiesTabProps = {}) {
  const [type, setType] = useState<EntityType | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);

  const [page, setPage] = useState<EntitiesPage | null>(null);
  const [rows, setRows] = useState<Retained<EntityView>[]>([]);
  const [queue, setQueue] = useState<ResolutionQueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query: EntityQuery = useMemo(
    () => ({ type, q: debounced, unresolvedOnly }),
    [type, debounced, unresolvedOnly],
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
          client.listEntities(query, signal),
          client.listResolutionQueue(signal),
        ]);
        if (signal?.aborted) return;
        const key = queryKey(query);
        // A filter change is not a retraction: start the retention window over
        // whenever the question itself changed.
        setRows((prev) =>
          retainProvisional(
            lastKey.current === key ? prev : [],
            next.entities,
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
    async (gesture: EntityGesture) => {
      setBusyId(gesture.id);
      setGestureError(null);
      try {
        const actor = USER_ACTOR;
        let receipt: MutationReceipt;
        switch (gesture.kind) {
          case "merge":
            receipt = await client.mergeEntity({ id: gesture.id, into: gesture.into, actor });
            break;
          case "split":
            receipt = await client.splitEntity({
              id: gesture.id,
              identityIds: gesture.identityIds,
              actor,
            });
            break;
          case "rename":
            receipt = await client.renameEntity({
              id: gesture.id,
              canonical: gesture.canonical,
              actor,
            });
            break;
          case "pin":
            receipt = await client.pinEntity({ id: gesture.id, pinned: gesture.pinned, actor });
            break;
          case "add_relation":
            receipt = await client.addRelation({
              id: gesture.id,
              kind: gesture.edgeKind,
              subtype: gesture.subtype,
              dstEntityId: gesture.dstEntityId,
              actor,
            });
            break;
          case "reject_edge":
            receipt = await client.rejectEdge({ edgeId: gesture.edgeId, actor });
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
    async (questionId: string, verdict: ResolutionVerdict) => {
      setBusyId(questionId);
      setGestureError(null);
      try {
        record(
          await client.answerResolution({ id: questionId, verdict, actor: USER_ACTOR }),
        );
        await load();
      } catch (err) {
        setGestureError(`resolution failed — ${message(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [client, load, record],
  );

  const peers = useMemo(
    () => livingRows(rows).map((row) => ({ id: row.id, label: row.label })),
    [rows],
  );
  const counts = page?.counts ?? {};
  const unresolvedCount = page?.unresolvedCount ?? 0;

  return (
    <section className="surface surface--entities" aria-label="Entities">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">Entities</h1>

        <ul className="type-filters" aria-label="Entity types">
          <li>
            <button
              type="button"
              className={"type-filter" + (type === null ? " type-filter--on" : "")}
              aria-pressed={type === null}
              onClick={() => setType(null)}
            >
              all
            </button>
          </li>
          {ENTITY_TYPES.filter((t) => (counts[t] ?? 0) > 0 || t === type).map((t) => (
            <li key={t}>
              <button
                type="button"
                className={"type-filter" + (type === t ? " type-filter--on" : "")}
                aria-pressed={type === t}
                onClick={() => setType(type === t ? null : t)}
              >
                {t} {counts[t] ?? 0}
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
              aria-label="Search entities"
              placeholder="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <button
            type="button"
            className={"surface__toggle" + (unresolvedOnly ? " surface__toggle--on" : "")}
            aria-pressed={unresolvedOnly}
            onClick={() => setUnresolvedOnly((v) => !v)}
          >
            <span aria-hidden="true">⚠ </span>
            {unresolvedCount} need resolution
          </button>
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

      <ResolutionQueue items={queue} onAnswer={(id, v) => void answer(id, v)} busyId={busyId} />

      {error ? (
        <p className="surface__error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="surface__empty">loading entities…</p>
      ) : rows.length === 0 ? (
        <p className="surface__empty">no entities match this filter</p>
      ) : (
        <ol className="entity-list">
          {rows.map((entry) => (
            <EntityCard
              key={entry.row.id}
              entity={entry.row}
              retracted={entry.retracted}
              onDismissRetracted={(entityId) =>
                setRows((prev) => dismissRetracted(prev, entityId))
              }
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
