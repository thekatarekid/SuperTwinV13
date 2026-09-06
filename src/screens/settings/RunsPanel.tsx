// ===========================================================================
// Settings › Runs & Traces (spec §17, Product_V6 §25) — filter by pass/day,
// open a run to the EXACT system prompt / packed context / raw output, diff
// two runs, cost rollup, quarantine, and UNDO RUN.
//
// V6 P1 S5.6 adds the level §25 actually names. A trace is one model call; a
// RUN is the unit undo reverses, so it is the unit worth listing, diffing and
// quarantining. The run index sits above the trace list with the counts that
// make a run legible without opening it — traces spent, decisions written, how
// many are already reversed — and picking two gives the diff that matters:
// not two blobs of text, but the header fields that could explain a behaviour
// change (model, prompt version, status, cost) and the TARGETS the two runs
// decided differently. That last list is what "the new model files things
// elsewhere" looks like in the ledger.
//
// Quarantine is not undo, and the pane says so. Quarantine marks a run's
// output as not-to-be-trusted — instant, reversible, recorded as a decision
// row — and leaves the data where it is. Undo reverses. A quarantined run
// stays in the list and in the cost rollup: hiding it would hide real spend.
//
// Undo run, honestly:
//   The 13.4.1 build rendered a bare "undo run" link next to every trace with
//   a run id. The route behind it (`POST /api/ops/runs/:id/undo`) was never
//   implemented, so the click 404'd and the pane printed "undo failed" — a
//   destructive-looking link that could only ever fail. The route exists now,
//   and so does the thing that was missing either way: a READ before the
//   WRITE. Clicking opens a confirm that names the blast radius line by line —
//   what would be reverted, and what would deliberately be left alone (your
//   own edits, rows already reversed, shapes this build cannot restore).
//
//   The bound worth knowing: undo restores what a run MOVED — attach/detach,
//   close, merge, dormant, archive, plan edits. It does not delete what a run
//   CREATED, because reversal.ts refuses to guess at cascades; hard deletion
//   has its own honest path in Library › Screen. So a pure understanding run
//   ("created 3 episodes") honestly reports nothing to revert instead of
//   pretending. The confirm says exactly that rather than failing silently.
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import {
  fetchQuarantine,
  fetchRunDiff,
  fetchRunUndoPreview,
  fetchRuns,
  fetchTraceFull,
  fetchTraces,
  quarantineRun,
  undoRun,
  type FullTraceRecord,
  type QuarantineRow,
  type RunDiff,
  type RunIndex,
  type RunUndoPreview,
  type TraceIndexRow,
  type TracePassCost,
} from "../../lib/api";
import { rowStyle } from "./shared";

function diffMarks(a: string, b: string): { onlyA: number; onlyB: number } {
  const setA = new Set(a.split("\n"));
  const setB = new Set(b.split("\n"));
  let onlyA = 0;
  let onlyB = 0;
  for (const l of setA) if (!setB.has(l)) onlyA++;
  for (const l of setB) if (!setA.has(l)) onlyB++;
  return { onlyA, onlyB };
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2) ?? "";
}

export function RunsPanel(): JSX.Element {
  const [pass, setPass] = useState("");
  const [day, setDay] = useState("");
  const [rows, setRows] = useState<TraceIndexRow[]>([]);
  const [costs, setCosts] = useState<TracePassCost[]>([]);
  const [open, setOpen] = useState<FullTraceRecord | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [diff, setDiff] = useState<[FullTraceRecord, FullTraceRecord] | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantineRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<RunUndoPreview | null>(null);
  const [undoing, setUndoing] = useState(false);
  // ---- the RUN level (V6 P1 S5.6) ----
  const [runs, setRuns] = useState<RunIndex | null>(null);
  const [pickedRuns, setPickedRuns] = useState<string[]>([]);
  const [runDiffView, setRunDiffView] = useState<RunDiff | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetchTraces({
      pass: pass || undefined,
      day: day || undefined,
      limit: 50,
    });
    setRows(r.traces);
    setCosts(r.costs);
    try {
      setRuns(await fetchRuns({ pass: pass || undefined, day: day || undefined, limit: 50 }));
    } catch {
      setRuns(null);
    }
    try {
      setQuarantine((await fetchQuarantine()).items);
    } catch {
      setQuarantine([]);
    }
  }, [pass, day]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const pick = (id: string): void => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  };
  const runDiff = async (): Promise<void> => {
    if (picked.length !== 2) return;
    const [a, b] = await Promise.all(picked.map((id) => fetchTraceFull(id)));
    setDiff([a!.trace, b!.trace]);
  };

  const pickRun = (id: string): void => {
    setPickedRuns((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  };
  const openRunDiff = async (): Promise<void> => {
    if (pickedRuns.length !== 2) return;
    setNote(null);
    try {
      setRunDiffView(await fetchRunDiff(pickedRuns[0]!, pickedRuns[1]!));
    } catch {
      setNote("couldn't read that diff — nothing was changed");
    }
  };
  /** Reversible, instant, recorded. NOT an undo: the data stays where it is. */
  const toggleQuarantine = async (runId: string, on: boolean): Promise<void> => {
    setNote(null);
    try {
      await quarantineRun(runId, on);
      await refresh();
    } catch {
      setNote(`couldn't ${on ? "quarantine" : "release"} run ${runId}`);
    }
  };

  /** Step 1 of undo: READ. Nothing is changed until the confirm is accepted. */
  const askUndo = async (runId: string): Promise<void> => {
    setNote(null);
    try {
      setConfirmUndo(await fetchRunUndoPreview(runId));
    } catch {
      setNote(`couldn't read what run ${runId} changed — nothing was touched`);
    }
  };

  /** Step 2: WRITE, only from inside the confirm. */
  const applyUndo = async (preview: RunUndoPreview): Promise<void> => {
    setUndoing(true);
    try {
      const result = await undoRun(preview.runId);
      setNote(
        `run ${preview.runId}: ${result.reversed} change${result.reversed === 1 ? "" : "s"} reverted` +
          (result.skipped > 0 ? `, ${result.skipped} left alone` : ""),
      );
      setConfirmUndo(null);
      await refresh().catch(() => {});
    } catch {
      setNote(`undo failed for run ${preview.runId} — nothing was changed`);
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div>
      <h2>Runs &amp; Traces</h2>
      <div style={rowStyle}>
        <input placeholder="filter by pass" value={pass} onChange={(e) => setPass(e.target.value)} />
        <input placeholder="day (YYYY-MM-DD)" value={day} onChange={(e) => setDay(e.target.value)} />
        <button className="btn" disabled={picked.length !== 2} onClick={() => void runDiff()}>
          diff selected
        </button>
      </div>

      {costs.length > 0 && (
        <p className="meta">
          cost:{" "}
          {costs.map((c) => `${c.pass} $${c.cost_usd.toFixed(2)} (${c.calls})`).join(" · ")}
        </p>
      )}

      <h3>Runs</h3>
      <p className="meta">
        A run is the unit undo reverses. Pick two to diff them. Quarantine marks a run&apos;s
        output as not to be trusted — reversible, and not the same as undoing it.
      </p>
      <div style={rowStyle}>
        <span className="meta">{runs ? `${runs.total} run(s)` : "run index unavailable"}</span>
        <button className="btn" disabled={pickedRuns.length !== 2} onClick={() => void openRunDiff()}>
          diff runs
        </button>
      </div>
      {runs && runs.runs.length === 0 && <p className="empty">no runs match</p>}
      {runs?.runs.map((r) => (
        <div key={r.id} style={rowStyle}>
          <span>
            <input
              type="checkbox"
              aria-label={`select run ${r.id}`}
              checked={pickedRuns.includes(r.id)}
              onChange={() => pickRun(r.id)}
            />{" "}
            {r.pass ?? "?"} · {r.model ?? "default"} · {r.started_at?.slice(0, 16) ?? "—"}
            {r.quarantine?.quarantined && <span className="meta"> · quarantined</span>}
          </span>
          <span className="meta">
            {r.traces} call(s) · {r.decisions} decision(s)
            {r.reversed > 0 ? `, ${r.reversed} reverted` : ""} · ${r.cost_usd.toFixed(4)}{" "}
            <button
              className="linklike"
              aria-label={`${r.quarantine?.quarantined ? "release" : "quarantine"} run ${r.id}`}
              onClick={() => void toggleQuarantine(r.id, !r.quarantine?.quarantined)}
            >
              {r.quarantine?.quarantined ? "release" : "quarantine"}
            </button>{" "}
            <button
              className="linklike"
              aria-label={`undo run ${r.id}`}
              title="Reverse every change this run made to your spaces, episodes and tasks. You'll see the full list before anything happens."
              onClick={() => void askUndo(r.id)}
            >
              undo run…
            </button>
          </span>
        </div>
      ))}

      {runDiffView && (
        <div className="trace-box">
          <div style={rowStyle}>
            <strong>
              run diff: {runDiffView.a.id} vs {runDiffView.b.id}
            </strong>
            <button className="btn" onClick={() => setRunDiffView(null)}>
              close
            </button>
          </div>
          {runDiffView.fields
            .filter((f) => !f.same)
            .map((f) => (
              <div key={f.field} style={rowStyle}>
                <span>{f.field}</span>
                <span className="meta">
                  {String(f.a ?? "—")} → {String(f.b ?? "—")}
                </span>
              </div>
            ))}
          {runDiffView.fields.every((f) => f.same) && (
            <p className="meta">every header field is identical</p>
          )}
          <h4>what they decided differently</h4>
          {runDiffView.decisions.changed.length === 0 &&
          runDiffView.decisions.only_a.length === 0 &&
          runDiffView.decisions.only_b.length === 0 ? (
            <p className="meta">
              same {runDiffView.decisions.same} target(s), same action on each — nothing decided
              differently
            </p>
          ) : (
            <>
              {runDiffView.decisions.changed.map((t) => (
                <div key={`c-${t.target_kind}-${t.target_id}`} style={rowStyle}>
                  <span>
                    {t.target_kind} {t.target_id}
                  </span>
                  <span className="meta">
                    {t.a_action} → {t.b_action}
                  </span>
                </div>
              ))}
              {runDiffView.decisions.only_a.map((t) => (
                <div key={`a-${t.target_kind}-${t.target_id}`} style={rowStyle}>
                  <span>
                    {t.target_kind} {t.target_id}
                  </span>
                  <span className="meta">only A · {t.a_action}</span>
                </div>
              ))}
              {runDiffView.decisions.only_b.map((t) => (
                <div key={`b-${t.target_kind}-${t.target_id}`} style={rowStyle}>
                  <span>
                    {t.target_kind} {t.target_id}
                  </span>
                  <span className="meta">only B · {t.b_action}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <h3>Traces</h3>

      {rows.length === 0 ? (
        <p className="empty">no runs match</p>
      ) : (
        rows.map((t) => (
          <div key={t.id} style={rowStyle}>
            <span>
              <input
                type="checkbox"
                aria-label={`select ${t.id}`}
                checked={picked.includes(t.id)}
                onChange={() => pick(t.id)}
              />{" "}
              <button
                className="linklike"
                onClick={() => void fetchTraceFull(t.id).then((r) => setOpen(r.trace))}
              >
                {t.pass ?? "?"} · {t.model ?? "default"} · {t.created_at?.slice(0, 16)}
              </button>
            </span>
            <span className="meta">
              {t.cost_usd != null && `$${t.cost_usd.toFixed(4)}`} · {t.latency_ms ?? "—"}ms
              {t.run_id && (
                <>
                  {" "}
                  <button
                    className="linklike"
                    aria-label={`undo run ${t.run_id}`}
                    title="Reverse every change this run made to your spaces, episodes and tasks. You'll see the full list before anything happens."
                    onClick={() => void askUndo(t.run_id!)}
                  >
                    undo run…
                  </button>
                </>
              )}
            </span>
          </div>
        ))
      )}
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}

      {confirmUndo && (
        <div className="modal-scrim" role="presentation" onClick={() => setConfirmUndo(null)}>
          <div
            className="modal"
            role="dialog"
            aria-label="confirm undo run"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span className="title">Undo run {confirmUndo.runId}?</span>
            </header>
            {confirmUndo.reversible === 0 ? (
              <p>
                Nothing in this run can be reverted
                {confirmUndo.items.length > 0 &&
                  ` — all ${confirmUndo.items.length} of its changes are listed below`}
                . Undo puts back what a run MOVED, closed, merged or archived; it never deletes
                something the run created — that is what Library&nbsp;› Screen&apos;s honest delete
                is for. Closing this changes nothing.
              </p>
            ) : (
              <p>
                This reverses {confirmUndo.reversible} change
                {confirmUndo.reversible === 1 ? "" : "s"} this run made to your spaces, episodes and
                tasks — putting each one back the way it was before the run. Nothing is deleted,
                your own edits are never touched, and each reversal is itself recorded in the
                ledger.
              </p>
            )}
            <div className="undo-run-items">
              {confirmUndo.items.length === 0 ? (
                <p className="empty">this run changed nothing</p>
              ) : (
                confirmUndo.items.map((i) => (
                  <div key={i.decisionId} style={rowStyle}>
                    <span>
                      {i.reversible ? "↩ " : "· "}
                      {i.targetKind} {i.action} · {i.targetId}
                    </span>
                    <span className="meta">
                      {i.reversible ? (i.reason ?? "will be reverted") : `kept: ${i.skipReason}`}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="btn-row">
              <button
                type="button"
                className="btn primary"
                disabled={confirmUndo.reversible === 0 || undoing}
                onClick={() => void applyUndo(confirmUndo)}
              >
                {undoing
                  ? "reverting…"
                  : `Revert ${confirmUndo.reversible} change${confirmUndo.reversible === 1 ? "" : "s"}`}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmUndo(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div className="trace-box">
          <div style={rowStyle}>
            <strong>
              {open.pass} · {open.prompt_version ?? ""} · {open.model ?? "default model"}
            </strong>
            <button className="btn" onClick={() => setOpen(null)}>
              close
            </button>
          </div>
          <h4>system prompt</h4>
          <pre>{str(open.system_prompt)}</pre>
          <h4>packed context (byte-what-the-model-saw)</h4>
          <pre>{str(open.packed_context)}</pre>
          <h4>raw output</h4>
          <pre>{str(open.raw_output)}</pre>
        </div>
      )}

      {diff && (
        <div className="trace-box">
          <div style={rowStyle}>
            <strong>
              diff: {diff[0].trace_id} vs {diff[1].trace_id}
            </strong>
            <button className="btn" onClick={() => setDiff(null)}>
              close
            </button>
          </div>
          {(() => {
            const d = diffMarks(str(diff[0].packed_context), str(diff[1].packed_context));
            return (
              <p className="meta">
                packed context: {d.onlyA} line(s) only in A · {d.onlyB} only in B
              </p>
            );
          })()}
          <div style={{ display: "flex", gap: 8 }}>
            <pre style={{ flex: 1 }}>{str(diff[0].packed_context)}</pre>
            <pre style={{ flex: 1 }}>{str(diff[1].packed_context)}</pre>
          </div>
        </div>
      )}

      <h3>Quarantine</h3>
      {quarantine.length === 0 ? (
        <p className="empty">nothing quarantined</p>
      ) : (
        quarantine.map((q) => (
          <div key={String(q.id)} style={rowStyle}>
            <span>{String(q.kind ?? "unit")}</span>
            <span className="meta">{String(q.reason ?? "")}</span>
          </div>
        ))
      )}
    </div>
  );
}
