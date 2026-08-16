// [CODE] The Ops surface — build item 4.4, arch §14.0/§14.0c.
//
// Five panels over `ops-client.ts` and the existing runs/latency reads:
//
//   * Import — the coverage meter (worker fractions, never recomputed) and the
//     work-queue backlog by state. Progress is monotonic server-side (§9.7
//     rule 3); this panel only formats it.
//   * Lanes — pause/resume per lane. The pause is the pool's own mechanism, so
//     the countdown here is the same one the scheduler waits on.
//   * Runs — the flat per-call log with the 4-way token split AND its sum
//     (§4.4.4: parts and sum, never either alone), cost verbatim from the CLI,
//     and the undo button. Undo reverses exactly one run.
//   * Quarantine — every unit the import left behind, with replay-after-fix.
//   * Questions — the ladder's terminus. `later` defers; nothing auto-retries
//     out of this queue.
//
// Every gesture re-reads the panel it changed rather than patching local
// state: the worker owns the truth and the surface renders it.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  httpOpsClient,
  type LaneStateView,
  type OpenQuestionView,
  type OpsClient,
  type OpsImportView,
  type QuarantinedUnitView,
} from "../lib/ops-client";
import { listRuns, type RunListItem } from "../lib/worker-client";
import { LatencyPanel } from "./LatencyPanel";

/** Slow on purpose — coverage is monotonic, so a late poll costs nothing. */
export const OPS_POLL_MS = 5000;

const LANE_LABELS: Record<string, string> = {
  "llm:understanding": "Understanding (Lane U)",
  "llm:enrichment": "Enrichment (Lane E)",
  llm: "LLM pool",
  transcribe: "Transcription",
  embed: "Embeddings",
  ffmpeg: "Frames",
  scrape: "Scrape",
};

function pct(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function fmtCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function fmtCost(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(2)}`;
}

export interface OpsTabProps {
  client?: OpsClient;
  /** Injectable runs read; defaults to the worker client's GET /api/runs. */
  listRunsFn?: typeof listRuns;
  /** 0 disables polling (tests). */
  pollMs?: number;
  /** Rendered instead of the latency panel when provided (tests). */
  latencyPanel?: JSX.Element | null;
}

export function OpsTab({
  client = httpOpsClient,
  listRunsFn = listRuns,
  pollMs = OPS_POLL_MS,
  latencyPanel,
}: OpsTabProps = {}) {
  const [importView, setImportView] = useState<OpsImportView | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantinedUnitView[]>([]);
  const [questions, setQuestions] = useState<OpenQuestionView[]>([]);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [imp, q, qs, r] = await Promise.all([
          client.getImport(signal),
          client.listQuarantine(signal),
          client.listQuestions(signal),
          listRunsFn({ limit: 25 }, signal),
        ]);
        if (!mounted.current) return;
        setImportView(imp);
        setQuarantine(q);
        setQuestions(qs);
        setRuns(r);
        setOffline(false);
      } catch {
        if (mounted.current) setOffline(true);
      }
    },
    [client, listRunsFn],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : undefined;
    return () => {
      mounted.current = false;
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [refresh, pollMs]);

  const gesture = useCallback(
    async (run: () => Promise<unknown>, done: string) => {
      try {
        await run();
        setNotice(done);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
      await refresh();
    },
    [refresh],
  );

  return (
    <div className="ops">
      <header className="ops__header">
        <h1>Ops</h1>
        {offline && <span className="ops__offline">worker unreachable</span>}
        {notice && (
          <span className="ops__notice" role="status">
            {notice}
          </span>
        )}
      </header>

      {importView && <ImportPanel view={importView} />}
      {importView && (
        <LanesPanel
          lanes={importView.lanes}
          onPause={(lane) => void gesture(() => client.pauseLane(lane), `${lane} paused`)}
          onResume={(lane) => void gesture(() => client.resumeLane(lane), `${lane} resumed`)}
        />
      )}

      <RunsPanel
        runs={runs}
        onUndo={(id) =>
          void gesture(async () => {
            const r = await client.undoRun(id);
            setNotice(`undid run ${r.runId}: ${r.reversed.length} mutation(s) reversed`);
          }, `undo requested for ${id}`)
        }
      />

      <QuarantinePanel
        items={quarantine}
        onReplay={(id) => void gesture(() => client.replayQuarantined(id), `replayed ${id}`)}
      />

      <QuestionsPanel
        questions={questions}
        onAnswer={(id, answer) =>
          void gesture(() => client.answerQuestion(id, answer), answer === "later" ? "deferred" : `answered: ${answer}`)
        }
      />

      <section className="ops__panel" aria-label="Latency">
        <h2>Latency</h2>
        {latencyPanel === undefined ? <LatencyPanel /> : latencyPanel}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import progress — the meter and the backlog
// ---------------------------------------------------------------------------

function ImportPanel({ view }: { view: OpsImportView }) {
  const depth = view.depth;
  return (
    <section className="ops__panel" aria-label="Import progress">
      <h2>Import</h2>
      {view.coverage.length === 0 ? (
        <p className="ops__empty">No coverage recorded yet.</p>
      ) : (
        <ul className="ops__coverage">
          {view.coverage.map((row) => (
            <li key={`${row.scopeKind}:${row.scopeId}:${row.horizon}`} className="ops__coverage-row">
              <span className="ops__coverage-label">{row.horizon}</span>
              <span
                className="ops__meter"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={row.totalUnits}
                aria-valuenow={row.doneUnits}
                aria-label={`${row.horizon} coverage`}
              >
                <span className="ops__meter-fill" style={{ width: pct(row.fraction) }} />
              </span>
              <span className="ops__coverage-figures">
                {row.doneUnits}/{row.totalUnits} · {pct(row.fraction)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="ops__depth">
        queue: {depth.ready} ready · {depth.running} running · {depth.paused} paused · {depth.quarantined}{" "}
        quarantined · {depth.done} done
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Lanes — pause/resume per lane
// ---------------------------------------------------------------------------

function LanesPanel({
  lanes,
  onPause,
  onResume,
}: {
  lanes: LaneStateView[];
  onPause: (lane: LaneStateView["lane"]) => void;
  onResume: (lane: LaneStateView["lane"]) => void;
}) {
  return (
    <section className="ops__panel" aria-label="Lanes">
      <h2>Lanes</h2>
      <table className="ops__table">
        <thead>
          <tr>
            <th>Lane</th>
            <th>Slots</th>
            <th>State</th>
            <th aria-label="Controls" />
          </tr>
        </thead>
        <tbody>
          {lanes.map((l) => (
            <tr key={l.lane}>
              <td>{LANE_LABELS[l.lane] ?? l.lane}</td>
              <td>{l.limit}</td>
              <td>
                {l.paused ? (
                  <span className="ops__paused">paused — resumes in {fmtCountdown(l.pausedForMs)}</span>
                ) : (
                  "running"
                )}
              </td>
              <td>
                {l.paused ? (
                  <button type="button" onClick={() => onResume(l.lane)}>
                    Resume
                  </button>
                ) : (
                  <button type="button" onClick={() => onPause(l.lane)}>
                    Pause
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Runs — 4-way tokens, cost, undo
// ---------------------------------------------------------------------------

function RunsPanel({ runs, onUndo }: { runs: RunListItem[]; onUndo: (id: string) => void }) {
  return (
    <section className="ops__panel" aria-label="Runs">
      <h2>Runs</h2>
      {runs.length === 0 ? (
        <p className="ops__empty">No runs yet.</p>
      ) : (
        <table className="ops__table">
          <thead>
            <tr>
              <th>Process</th>
              <th>Model</th>
              <th>Input</th>
              <th>Cache create</th>
              <th>Cache read</th>
              <th>Output</th>
              <th>Total in</th>
              <th>Cost</th>
              <th>Status</th>
              <th aria-label="Undo" />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              // §4.4.4: total_input = input + cache_creation + cache_read,
              // rendered beside its parts so they cannot drift apart.
              const totalIn =
                run.input_tokens + run.cache_creation_input_tokens + run.cache_read_input_tokens;
              return (
                <tr key={run.id}>
                  <td>{run.process}</td>
                  <td>{run.model}</td>
                  <td>{run.input_tokens.toLocaleString()}</td>
                  <td>{run.cache_creation_input_tokens.toLocaleString()}</td>
                  <td>{run.cache_read_input_tokens.toLocaleString()}</td>
                  <td>{run.output_tokens.toLocaleString()}</td>
                  <td>{totalIn.toLocaleString()}</td>
                  <td>{fmtCost(run.cost_usd)}</td>
                  <td>{run.status}</td>
                  <td>
                    <button type="button" onClick={() => onUndo(run.id)}>
                      Undo run
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quarantine — replay after a fix
// ---------------------------------------------------------------------------

function QuarantinePanel({
  items,
  onReplay,
}: {
  items: QuarantinedUnitView[];
  onReplay: (id: string) => void;
}) {
  return (
    <section className="ops__panel" aria-label="Quarantine">
      <h2>Quarantine</h2>
      {items.length === 0 ? (
        <p className="ops__empty">Nothing quarantined.</p>
      ) : (
        <table className="ops__table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Unit</th>
              <th>Attempts</th>
              <th>Since</th>
              <th aria-label="Replay" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.stage}</td>
                <td>
                  {item.unitKind} · {item.unitId}
                </td>
                <td>{item.attempts}</td>
                <td>{item.createdAt ?? "—"}</td>
                <td>
                  <button type="button" onClick={() => onReplay(item.id)}>
                    Replay
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Questions — the human end of the ladder
// ---------------------------------------------------------------------------

function QuestionsPanel({
  questions,
  onAnswer,
}: {
  questions: OpenQuestionView[];
  onAnswer: (id: string, answer: string) => void;
}) {
  return (
    <section className="ops__panel" aria-label="Questions">
      <h2>Questions ({questions.length} waiting)</h2>
      {questions.length === 0 ? (
        <p className="ops__empty">No open questions.</p>
      ) : (
        <ul className="ops__questions">
          {questions.map((q) => (
            <li key={q.id} className="ops__question">
              <p className="ops__question-text">{q.question}</p>
              <p className="ops__question-meta">
                {q.kind ?? "question"} · {q.targetKind ?? ""} {q.targetId ?? ""}
              </p>
              <div className="ops__question-actions">
                {(q.options.length > 0 ? q.options : ["yes", "no"]).map((opt) => (
                  <button key={opt} type="button" onClick={() => onAnswer(q.id, opt)}>
                    {opt}
                  </button>
                ))}
                {!q.options.includes("later") && (
                  <button type="button" onClick={() => onAnswer(q.id, "later")}>
                    later
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
