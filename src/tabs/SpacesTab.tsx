// [CODE] The Spaces surface — arch §14.6, build item 3.10.
//
//   SPACES  [active 14][dormant 9][archived 22]      archetype [ all ▾ ]
//
// `/api/spaces` is a FILTERED VIEW OVER ARCS (brief rule 6). Two consequences
// this file exists to honour:
//
//   * `[ view all threads ]` is a link to the Threads surface, not a filter
//     here. An arc that was never promoted is not a space, and it is browsable
//     under "NOT A SPACE" with the reason it did not qualify.
//   * A LIFE PROJECT LINKS SPACES, it does not contain them. It renders as its
//     own strip at the foot, listing the spaces it emerged from — never as a
//     parent card that could be mistaken for a ninth archetype.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import { dismissRetracted, retainProvisional, type Retained } from "../lib/provisional";
import { USER_ACTOR, type MutationReceipt } from "../lib/surfaces-client";
import {
  ARCHETYPES,
  ARCHETYPE_NAMES,
  SPACE_STATUSES,
  spacesClient as defaultClient,
  type Archetype,
  type SpaceQuery,
  type SpaceStatus,
  type SpaceView,
  type SpacesClient,
  type SpacesPage,
} from "../lib/spaces-client";
import { SpaceCard, type SpaceGesture } from "./spaces/SpaceCard";

const SEARCH_DEBOUNCE_MS = 200;
const RECEIPT_LIMIT = 4;

export interface SpacesTabProps {
  client?: SpacesClient;
  coveragePollMs?: number;
  /** The Threads surface — `[ view all threads ]` for unpromoted arcs. */
  onOpenThreads?(): void;
}

function queryKey(q: SpaceQuery): string {
  return `${q.status ?? ""}|${q.archetype ?? ""}|${q.q ?? ""}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SpacesTab({ client = defaultClient, coveragePollMs, onOpenThreads }: SpacesTabProps = {}) {
  const [status, setStatus] = useState<SpaceStatus | null>(null);
  const [archetype, setArchetype] = useState<Archetype | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  const [page, setPage] = useState<SpacesPage | null>(null);
  const [rows, setRows] = useState<Retained<SpaceView>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query: SpaceQuery = useMemo(
    () => ({ status, archetype, q: debounced }),
    [status, archetype, debounced],
  );
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await client.listSpaces(query, signal);
        if (signal?.aborted) return;
        const key = queryKey(query);
        setRows((prev) =>
          retainProvisional(lastKey.current === key ? prev : [], next.spaces, (row) => row.provisional),
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
    async (gesture: SpaceGesture) => {
      setBusyId(gesture.id);
      setGestureError(null);
      try {
        const actor = USER_ACTOR;
        let receipt: MutationReceipt;
        switch (gesture.kind) {
          case "archetype":
            receipt = await client.setArchetype({ id: gesture.id, archetype: gesture.archetype, actor });
            break;
          case "relabel":
            receipt = await client.relabelSpace({ id: gesture.id, label: gesture.label, actor });
            break;
          case "pin":
            receipt = await client.pinSpace({ id: gesture.id, pinned: gesture.pinned, actor });
            break;
          case "archive":
            receipt = await client.archiveSpace({ id: gesture.id, archived: gesture.archived, actor });
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
    <section className="surface surface--spaces" aria-label="Spaces">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">Spaces</h1>

        <ul className="type-filters" aria-label="Space statuses">
          <li>
            <button
              type="button"
              className={"type-filter" + (status === null ? " type-filter--on" : "")}
              aria-pressed={status === null}
              onClick={() => setStatus(null)}
            >
              all
            </button>
          </li>
          {SPACE_STATUSES.map((s) => (
            <li key={s}>
              <button
                type="button"
                className={"type-filter" + (status === s ? " type-filter--on" : "")}
                aria-pressed={status === s}
                onClick={() => setStatus(status === s ? null : s)}
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
              aria-label="Search spaces"
              placeholder="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <label className="surface__filter">
            archetype
            <select
              aria-label="Archetype"
              value={archetype ?? ""}
              onChange={(e) => setArchetype((e.target.value || null) as Archetype | null)}
            >
              <option value="">all</option>
              {ARCHETYPES.map((a) => (
                <option key={a} value={a}>
                  {ARCHETYPE_NAMES[a]}
                </option>
              ))}
            </select>
          </label>

          <span className="surface__count">a space is a promoted arc</span>
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
        <p className="surface__empty">loading spaces…</p>
      ) : rows.length === 0 ? (
        <p className="surface__empty">no spaces match this filter</p>
      ) : (
        <ol className="space-list">
          {rows.map((entry) => (
            <SpaceCard
              key={entry.row.id}
              space={entry.row}
              retracted={entry.retracted}
              onDismissRetracted={(id) => setRows((prev) => dismissRetracted(prev, id))}
              onGesture={(gesture) => void runGesture(gesture)}
              busy={busyId === entry.row.id}
            />
          ))}
        </ol>
      )}

      {(page?.notSpaces.length ?? 0) > 0 && (
        <section className="not-spaces" aria-label="Not a space">
          <h2>○ NOT A SPACE</h2>
          <p className="not-spaces__note">arcs with no live loop — browsable, never surfaced above</p>
          <ul>
            {page?.notSpaces.map((arc) => (
              <li key={arc.arcId}>
                <span className="not-spaces__label">{arc.label}</span>
                <span className="not-spaces__reason">{arc.reason}</span>
              </li>
            ))}
          </ul>
          {onOpenThreads && (
            <button type="button" onClick={onOpenThreads}>
              view all threads
            </button>
          )}
        </section>
      )}

      {(page?.lifeProjects.length ?? 0) > 0 && (
        <section className="life-projects" aria-label="Life projects">
          <h2>🎯 LIFE PROJECT</h2>
          <ul>
            {page?.lifeProjects.map((goal) => (
              <li key={goal.id}>
                <span className="life-project__name">{goal.name}</span>
                <span className="life-project__origin">
                  {goal.emerged ? `emerged, ${goal.spaceIds.length} spaces` : "yours"}
                </span>
                <span className="life-project__spaces">{goal.spaceLabels.join(" · ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
