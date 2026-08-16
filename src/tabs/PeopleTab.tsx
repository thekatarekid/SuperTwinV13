// [CODE] The People surface — arch §14.1/§14.8, build item 3.10.
//
//   PEOPLE  [inner circle 6][active 24][dormant 41][archived 88]   🔍
//
// The tier chips are the filter, and the tier is COMPUTED — the rule and the
// numbers behind it are printed on every card (people/tier.ts), because a
// social ranking the reader cannot audit is exactly the kind of thing this
// product must not do silently.
//
// The surface carries the coverage meter (§14.0), and a provisional person —
// one minted from an unreconciled identity on an open session — is marked and
// kept if it later vanishes (§14.0b).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import { dismissRetracted, retainProvisional, type Retained } from "../lib/provisional";
import { USER_ACTOR, type MutationReceipt } from "../lib/surfaces-client";
import {
  PERSON_TIERS,
  TIER_LABEL,
  peopleClient as defaultClient,
  type PeopleClient,
  type PeoplePage,
  type PeopleQuery,
  type PersonTier,
  type PersonView,
} from "../lib/people-client";
import { PersonCard, type PersonGesture } from "./people/PersonCard";
import { INNER_CIRCLE_WEEKS, INNER_CIRCLE_WINDOW_WEEKS } from "./people/tier";

const SEARCH_DEBOUNCE_MS = 200;
const RECEIPT_LIMIT = 4;

export interface PeopleTabProps {
  client?: PeopleClient;
  coveragePollMs?: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PeopleTab({ client = defaultClient, coveragePollMs }: PeopleTabProps = {}) {
  const [tier, setTier] = useState<PersonTier | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  const [page, setPage] = useState<PeoplePage | null>(null);
  const [rows, setRows] = useState<Retained<PersonView>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query: PeopleQuery = useMemo(() => ({ tier, q: debounced }), [tier, debounced]);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await client.listPeople(query, signal);
        if (signal?.aborted) return;
        const key = `${query.tier ?? ""}|${query.q ?? ""}`;
        setRows((prev) =>
          retainProvisional(lastKey.current === key ? prev : [], next.people, (row) => row.provisional),
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
    async (gesture: PersonGesture) => {
      setBusyId(gesture.id);
      setGestureError(null);
      try {
        const actor = USER_ACTOR;
        const receipt =
          gesture.kind === "pin"
            ? await client.pinPerson({ id: gesture.id, pinned: gesture.pinned, actor })
            : await client.renamePerson({ id: gesture.id, canonical: gesture.canonical, actor });
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
    <section className="surface surface--people" aria-label="People">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">People</h1>

        <ul className="type-filters" aria-label="Contact tiers">
          <li>
            <button
              type="button"
              className={"type-filter" + (tier === null ? " type-filter--on" : "")}
              aria-pressed={tier === null}
              onClick={() => setTier(null)}
            >
              all
            </button>
          </li>
          {PERSON_TIERS.map((t) => (
            <li key={t}>
              <button
                type="button"
                className={"type-filter" + (tier === t ? " type-filter--on" : "")}
                aria-pressed={tier === t}
                onClick={() => setTier(tier === t ? null : t)}
              >
                {TIER_LABEL[t]} {counts?.[t] ?? 0}
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
              aria-label="Search people"
              placeholder="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {/* The rule itself, on the surface that applies it. */}
          <span className="surface__count">
            tier is computed — inner circle is both ways in ≥{INNER_CIRCLE_WEEKS} of{" "}
            {INNER_CIRCLE_WINDOW_WEEKS} weeks
          </span>
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
        <p className="surface__empty">loading people…</p>
      ) : rows.length === 0 ? (
        <p className="surface__empty">no people match this filter</p>
      ) : (
        <ol className="person-list">
          {rows.map((entry) => (
            <PersonCard
              key={entry.row.id}
              person={entry.row}
              retracted={entry.retracted}
              onDismissRetracted={(id) => setRows((prev) => dismissRetracted(prev, id))}
              onGesture={(gesture) => void runGesture(gesture)}
              busy={busyId === entry.row.id}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
