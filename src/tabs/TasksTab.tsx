// [CODE] The Tasks surface — arch §14.7, build item 3.10.
//
//   TASKS   ● 7 you said you'd do   ○ 4 suggested   ⏳ 2 need a check
//
// The surface's one hard guarantee: **no loop owned by another person appears
// in Tasks.** It is enforced by `partitionTasks` (tasks/partition.ts) over the
// FULL list the worker returned — not by trusting the worker's own sectioning.
// Anything the partition rejects goes to "WAITING ON OTHERS", which is context
// and is labelled as context.
//
// Everything else follows §14.7: two lists with different verbs, a one-tap
// "did you do this?" carrying the evidence quote, lapsed rows that say why,
// and grouping by space inside each list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SurfaceCoverage } from "../components/SurfaceCoverage";
import { dismissRetracted, retainProvisional, type Retained } from "../lib/provisional";
import { USER_ACTOR, type MutationReceipt } from "../lib/surfaces-client";
import {
  tasksClient as defaultClient,
  type TaskQuery,
  type TaskView,
  type TasksClient,
  type TasksPage,
} from "../lib/tasks-client";
import { TaskCard, type TaskGesture } from "./tasks/TaskCard";
import { exclusionReason, groupBySpace, partitionTasks } from "./tasks/partition";

const SEARCH_DEBOUNCE_MS = 200;
const RECEIPT_LIMIT = 4;

export interface TasksTabProps {
  client?: TasksClient;
  coveragePollMs?: number;
  onOpenSpace?(spaceId: string): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function TaskList({
  title,
  note,
  verbs,
  rows,
  onGesture,
  onDismissRetracted,
  onOpenSpace,
  busyId,
  empty,
}: {
  title: string;
  note: string;
  verbs: "explicit" | "implicit";
  rows: Retained<TaskView>[];
  onGesture(gesture: TaskGesture): void;
  onDismissRetracted(id: string): void;
  onOpenSpace?(spaceId: string): void;
  busyId: string | null;
  empty: string;
}) {
  const groups = groupBySpace(rows);
  return (
    <section className="task-list" aria-label={title}>
      <h2 className="task-list__title">
        {title} <span className="task-list__note">{note}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="surface__empty">{empty}</p>
      ) : (
        <ol className="task-list__groups">
          {groups.map((group) => (
            <li key={group.spaceId ?? "none"} className="task-group">
              <h3 className="task-group__space">{group.spaceLabel}</h3>
              <ul className="task-group__tasks">
                {group.entries.map((entry) => (
                  <TaskCard
                    key={entry.row.id}
                    task={entry.row}
                    verbs={verbs}
                    retracted={entry.retracted}
                    onDismissRetracted={onDismissRetracted}
                    onGesture={onGesture}
                    onOpenSpace={onOpenSpace}
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

export function TasksTab({ client = defaultClient, coveragePollMs, onOpenSpace }: TasksTabProps = {}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  const [page, setPage] = useState<TasksPage | null>(null);
  const [rows, setRows] = useState<Retained<TaskView>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<MutationReceipt[]>([]);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query: TaskQuery = useMemo(() => ({ q: debounced }), [debounced]);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await client.listTasks(query, signal);
        if (signal?.aborted) return;
        const key = query.q ?? "";
        setRows((prev) =>
          retainProvisional(lastKey.current === key ? prev : [], next.tasks, (row) => row.provisional),
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
    async (gesture: TaskGesture) => {
      setBusyId(gesture.id);
      setGestureError(null);
      try {
        const actor = USER_ACTOR;
        let receipt: MutationReceipt;
        switch (gesture.kind) {
          case "mark":
            receipt = await client.markTask({ id: gesture.id, gesture: gesture.gesture, actor });
            break;
          case "accept":
            receipt = await client.acceptSuggestion({ id: gesture.id, actor });
            break;
          case "reject":
            receipt = await client.rejectSuggestion({ id: gesture.id, actor });
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

  const answerDoneCheck = useCallback(
    async (id: string, done: boolean) => {
      setBusyId(id);
      setGestureError(null);
      try {
        record(await client.answerDoneCheck({ id, done, actor: USER_ACTOR }));
        await load();
      } catch (err) {
        setGestureError(`done check failed — ${message(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [client, load, record],
  );

  const partition = useMemo(() => partitionTasks(rows), [rows]);
  const dismiss = useCallback((id: string) => setRows((prev) => dismissRetracted(prev, id)), []);
  const gesture = useCallback((g: TaskGesture) => void runGesture(g), [runGesture]);

  const doneChecks = page?.doneChecks ?? [];
  const waiting = page?.waitingOnOthers ?? [];

  return (
    <section className="surface surface--tasks" aria-label="Tasks">
      <SurfaceCoverage client={client} pollMs={coveragePollMs} />

      <header className="surface__head">
        <h1 className="surface__title">Tasks</h1>
        <div className="surface__tools">
          <label className="surface__search">
            <span className="surface__search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              type="search"
              aria-label="Search tasks"
              placeholder="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span className="surface__count">● {partition.explicit.length} you said you'd do</span>
          <span className="surface__count">○ {partition.implicit.length} suggested</span>
          <span className="surface__count">⏳ {doneChecks.length} need a check</span>
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
        <p className="surface__empty">loading tasks…</p>
      ) : (
        <>
          <TaskList
            title="YOU SAID YOU'D DO THIS"
            note="(origin: explicit)"
            verbs="explicit"
            rows={partition.explicit}
            onGesture={gesture}
            onDismissRetracted={dismiss}
            onOpenSpace={onOpenSpace}
            busyId={busyId}
            empty="nothing you committed to is open"
          />

          <TaskList
            title="SUGGESTED BY YOUR TWIN"
            note="(origin: implicit)"
            verbs="implicit"
            rows={partition.implicit}
            onGesture={gesture}
            onDismissRetracted={dismiss}
            onOpenSpace={onOpenSpace}
            busyId={busyId}
            empty="no suggestions"
          />

          {partition.lapsed.length > 0 && (
            <TaskList
              title="LAPSED"
              note="(kept, and each says why)"
              verbs="explicit"
              rows={partition.lapsed}
              onGesture={gesture}
              onDismissRetracted={dismiss}
              onOpenSpace={onOpenSpace}
              busyId={busyId}
              empty="nothing lapsed"
            />
          )}

          {doneChecks.length > 0 && (
            <section className="done-checks" aria-label="Did you do this?">
              <h2>⏳ DID YOU DO THIS?</h2>
              <ul>
                {doneChecks.map((check) => (
                  <li key={check.id} className="done-check">
                    <span className="done-check__intent">{check.intent}</span>
                    <span className="done-check__observation">— {check.observation}</span>
                    <q className="done-check__quote">{check.quote}</q>
                    <button
                      type="button"
                      disabled={busyId === check.id}
                      onClick={() => void answerDoneCheck(check.id, true)}
                    >
                      yes
                    </button>
                    <button
                      type="button"
                      disabled={busyId === check.id}
                      onClick={() => void answerDoneCheck(check.id, false)}
                    >
                      no
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="waiting" aria-label="Waiting on others">
            <h2>WAITING ON OTHERS</h2>
            <p className="waiting__note">not your tasks — context only</p>
            <ul>
              {waiting.map((item) => (
                <li key={item.id} className="waiting__item">
                  <span className="waiting__who">{item.personLabel}:</span> {item.intent}
                  {item.dueLabel ? ` · ${item.dueLabel}` : ""}
                </li>
              ))}
              {/* A loop the worker sent as a task but that is NOT yours lands
                  here, with the reason it was excluded. The guard is visible. */}
              {partition.notYours.map((entry) => (
                <li key={entry.row.id} className="waiting__item waiting__item--excluded">
                  <span className="waiting__who">{entry.row.ownerLabel}:</span> {entry.row.intent}
                  <span className="waiting__reason">{exclusionReason(entry.row)}</span>
                </li>
              ))}
              {waiting.length === 0 && partition.notYours.length === 0 && (
                <li className="waiting__item">nothing outstanding from anyone else</li>
              )}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
