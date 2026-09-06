// ===========================================================================
// "why?" drill-down — build P1.7, spec §14.1.4/§14.6.1.
//
// Every modal footer carries "why?". Expanding it lists the decision records
// for the object (justification, confidence, pass, prompt/run linkage);
// each decision with a trace exposes "trace →" which pulls the full trace
// (packed context, raw output, parsed result) inline.
// ===========================================================================

import { useState } from "react";

import {
  describeWorkerError,
  fetchTrace,
  fetchWhy,
  type DecisionView,
  type TargetKind,
  type TraceRow,
} from "../lib/api";
import { LoadFallback, useLoad } from "./LoadState";

export function WhyPanel(props: { kind: TargetKind; id: string }): JSX.Element {
  const [traceError, setTraceError] = useState<string | null>(null);
  const [openTrace, setOpenTrace] = useState<TraceRow | null>(null);

  const gate = useLoad<DecisionView[]>(
    async () => (await fetchWhy(props.kind, props.id)).decisions,
    [props.kind, props.id],
  );
  const decisions = gate.data;

  async function showTrace(traceId: string): Promise<void> {
    setTraceError(null);
    try {
      const body = await fetchTrace(traceId);
      setOpenTrace(body.trace);
    } catch (err) {
      setTraceError(`couldn't load that trace — ${describeWorkerError(err)}`);
    }
  }

  if (!decisions) {
    return (
      <div className="why-panel">
        <LoadFallback state={gate} what="the decisions behind this" />
      </div>
    );
  }
  if (decisions.length === 0) return <div className="why-panel">no decisions recorded yet</div>;

  return (
    <div className="why-panel" aria-label="why">
      {decisions.map((d) => (
        <div className="decision" key={d.id}>
          <div>
            <strong>{d.action}</strong> · {d.pass ?? "user"}
            {d.confidence != null && <> · conf {d.confidence.toFixed(2)}</>}
            {d.reversedAt && <> · reversed</>}
          </div>
          {d.reason && <div>{d.reason}</div>}
          <div>
            {d.createdAt}
            {d.traceId && (
              <>
                {" · "}
                <button type="button" className="linklike" onClick={() => void showTrace(d.traceId!)}>
                  trace →
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {traceError && (
        <p className="error" role="alert">
          {traceError}{" "}
          <button type="button" className="linklike" onClick={() => setTraceError(null)}>
            dismiss
          </button>
        </p>
      )}
      {openTrace && (
        <div className="trace-box" aria-label="trace">
          {`trace ${openTrace.id} · ${openTrace.pass ?? "?"} · ${openTrace.model ?? "?"} · ${openTrace.prompt_version ?? "?"}`}
          {"\n\ncontext:\n"}
          {openTrace.packed_context ?? "(none)"}
          {"\n\noutput:\n"}
          {openTrace.raw_output ?? "(none)"}
        </div>
      )}
    </div>
  );
}
