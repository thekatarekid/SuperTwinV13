// [CODE] The Claims surface — arch §14.5, build item 3.10.
//
//   CLAIMS  [fact 144][preference 57][belief 51]…        ⚠ 6 conflicts
//   subject [ all ▾ ]  🔍 search              ○ active ○ superseded
//
// Grouped by SUBJECT ENTITY, because a claim without a subject is a sentence
// and the surface is about people and things. Filters are kind, confidence,
// attribution and status — all four are §14.5's, and none of them can hide a
// conflict: the queue sits above the list and is not filtered, since an
// unresolved contradiction is the most important thing on the page.
//
// The coverage meter is on it, like all eight surfaces (§14.0), and a
// provisional claim that vanishes between polls is kept and struck through
// rather than silently retracted (§14.0b, lib/provisional.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import {
  dismissRetracted,
  retainProvisional,
  type Retained,
} from "../lib/provisional";
import { USER_ACTOR, type MutationReceipt } from "../lib/surfaces-client";
import {
  CLAIM_ATTRIBUTIONS,
  CLAIM_KINDS,
  ATTRIBUTION_LABEL,
  claimsClient as defaultClient,
  type ClaimAttribution,
  type ClaimConflictView,
  type ClaimKind,
  type ClaimQuery,
  type ClaimStatus,
  type ClaimView,
  type ClaimsClient,
  type ClaimsPage,
  type ConflictAnswer,
} from "../lib/claims-client";
import { ClaimRow, type ClaimGesture } from "./claims/ClaimRow";
import { ConflictQueue } from "./claims/ConflictQueue";

const SEARCH_DEBOUNCE_MS = 200;
const RECEIPT_LIMIT = 4;
const CONFIDENCE_STEPS = [0, 0.5, 0.7, 0.9] as const;

export interface ClaimsTabProps {
  client?: ClaimsClient;
  coveragePollMs?: number;
}

function queryKey(q: ClaimQuery): string {
  return [q.kind ?? "", q.subjectId ?? "", q.attribution ?? "", q.status ?? "", q.minConfidence ?? 0, q.q ?? ""].join("|");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rows are flattened for retention (ids are global) and regrouped for display. */
function regroup(
  rows: readonly Retained<ClaimView>[],
  labels: ReadonlyMap<string, string>,
): { key: string; label: string; entries: Retained<ClaimView>[] }[] {
  const groups = new Map<string, { key: string; label: string; entries: Retained<ClaimView>[] }>();
  for (const entry of rows) {
    const key = entry.row.subjectId ?? `hint:${entry.row.subjectLabel}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: labels.get(key) ?? entry.row.subjectLabel, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

export function ClaimsTab({ client = defaultClient, coveragePollMs }: ClaimsTabProps = {}) {
  const [kind, setKind] = useState<ClaimKind | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [attribution, setAttribution] = useState<ClaimAttribution | null>(null);
  const [status, setStatus] = useState<ClaimStatus | null>(null);
  const [minConfidence, setMinConfidence] = useState(0);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  const [page, setPage] = useState<ClaimsPage | null>(null);
  const [rows, setRows] = useState<Retained<ClaimView>[]>([]);
  const [conflicts, setConflicts] = useState<ClaimConflictView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query: ClaimQuery = useMemo(
    () => ({ kind, subjectId, attribution, status, minConfidence, q: debounced }),
    [kind, subjectId, attribution, status, minConfidence, debounced],
  );
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [next, queue] = await Promise.all([
          client.listClaims(query, signal),
          client.listConflicts(signal),
        ]);
        if (signal?.aborted) return;
        const key = queryKey(query);
        const flat = next.groups.flatMap((group) => group.claims);
        setRows((prev) =>
          retainProvisional(lastKey.current === key ? prev : [], flat, (row) => row.provisional),
        );
        lastKey.current = key;
        setPage(next);
        setConflicts(queue);
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
    async (gesture: ClaimGesture) => {
      setBusyId(gesture.id);
      setGestureError(null);
      try {
        const actor = USER_ACTOR;
        let receipt: MutationReceipt;
        switch (gesture.kind) {
          case "pin":
            receipt = await client.pinClaim({ id: gesture.id, pinned: gesture.pinned, actor });
            break;
          case "reject":
            receipt = await client.rejectClaim({ id: gesture.id, reason: gesture.reason, actor });
            break;
          case "correct":
            receipt = await client.correctClaim({ id: gesture.id, text: gesture.text, actor });
            break;
          case "split":
            receipt = await client.splitClaim({ id: gesture.id, texts: gesture.texts, actor });
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

  const answerConflict = useCallback(
    async (id: string, answer: ConflictAnswer) => {
      setBusyId(id);
      setGestureError(null);
      try {
        record(await client.answerConflict({ id, answer, actor: USER_ACTOR }));
        await load();
      } catch (err) {
        setGestureError(`conflict answer failed — ${message(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [client, load, record],
  );

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of page?.groups ?? []) {
      map.set(group.subjectId ?? `hint:${group.subjectLabel}`, group.subjectLabel);
    }
    return map;
  }, [page]);

  const groups = useMemo(() => regroup(rows, labels), [rows, labels]);

  return (
    <section className="surface surface--claims" aria-label="Claims">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">Claims</h1>

        <ul className="type-filters" aria-label="Claim kinds">
          <li>
            <button
              type="button"
              className={"type-filter" + (kind === null ? " type-filter--on" : "")}
              aria-pressed={kind === null}
              onClick={() => setKind(null)}
            >
              all
            </button>
          </li>
          {CLAIM_KINDS.map((k) => (
            <li key={k}>
              <button
                type="button"
                className={"type-filter" + (kind === k ? " type-filter--on" : "")}
                aria-pressed={kind === k}
                onClick={() => setKind(kind === k ? null : k)}
              >
                {k} {page?.counts?.[k] ?? 0}
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
              aria-label="Search claims"
              placeholder="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <label className="surface__filter">
            subject
            <select
              aria-label="Subject"
              value={subjectId ?? ""}
              onChange={(e) => setSubjectId(e.target.value || null)}
            >
              <option value="">all</option>
              {(page?.subjects ?? []).map((subject) => (
                <option key={subject.id ?? subject.label} value={subject.id ?? ""}>
                  {subject.label}
                </option>
              ))}
            </select>
          </label>

          <label className="surface__filter">
            attribution
            <select
              aria-label="Attribution"
              value={attribution ?? ""}
              onChange={(e) => setAttribution((e.target.value || null) as ClaimAttribution | null)}
            >
              <option value="">all</option>
              {CLAIM_ATTRIBUTIONS.map((a) => (
                <option key={a} value={a}>
                  {ATTRIBUTION_LABEL[a]}
                </option>
              ))}
            </select>
          </label>

          <label className="surface__filter">
            status
            <select
              aria-label="Status"
              value={status ?? ""}
              onChange={(e) => setStatus((e.target.value || null) as ClaimStatus | null)}
            >
              <option value="">active and superseded</option>
              <option value="active">active</option>
              <option value="superseded">superseded</option>
            </select>
          </label>

          <label className="surface__filter">
            confidence ≥
            <select
              aria-label="Minimum confidence"
              value={String(minConfidence)}
              onChange={(e) => setMinConfidence(Number(e.target.value))}
            >
              {CONFIDENCE_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step === 0 ? "any" : step.toFixed(2)}
                </option>
              ))}
            </select>
          </label>

          <span className="surface__count">⚠ {conflicts.length} conflicts</span>
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

      {/* Not filtered: an unresolved contradiction outranks the filter bar. */}
      <ConflictQueue conflicts={conflicts} onAnswer={(id, a) => void answerConflict(id, a)} busyId={busyId} />

      {error ? (
        <p className="surface__error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="surface__empty">loading claims…</p>
      ) : groups.length === 0 ? (
        <p className="surface__empty">no claims match this filter</p>
      ) : (
        <ol className="claim-groups">
          {groups.map((group) => (
            <li key={group.key} className="claim-group">
              <h2 className="claim-group__subject">
                {group.label} <span className="claim-group__count">{group.entries.length} claims</span>
              </h2>
              <ul className="claim-group__claims">
                {group.entries.map((entry) => (
                  <ClaimRow
                    key={entry.row.id}
                    claim={entry.row}
                    retracted={entry.retracted}
                    onDismissRetracted={(id) => setRows((prev) => dismissRetracted(prev, id))}
                    onGesture={(gesture) => void runGesture(gesture)}
                    busy={busyId === entry.row.id}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
