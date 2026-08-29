// ===========================================================================
// Settings › Runs & Traces (spec §17) — filter by pass/day, open a run to the
// EXACT system prompt / packed context / raw output, diff two runs, cost
// rollup, quarantine browser, and UNDO RUN.
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
  fetchRunUndoPreview,
  fetchTraceFull,
  fetchTraces,
  undoRun,
  type FullTraceRecord,
  type QuarantineRow,
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

  const refresh = useCallback(async () => {
    const r = await fetchTraces({
      pass: pass || undefined,
      day: day || undefined,
      limit: 50,
    });
    setRows(r.traces);
    setCosts(r.costs);
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
