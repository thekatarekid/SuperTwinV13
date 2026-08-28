// ===========================================================================
// "why?" drill-down — build P1.7, spec §14.1.4/§14.6.1.
//
// Every modal footer carries "why?". Expanding it lists the decision records
// for the object (justification, confidence, pass, prompt/run linkage);
// each decision with a trace exposes "trace →" which pulls the full trace
// (packed context, raw output, parsed result) inline.
// ===========================================================================

import { useEffect, useState } from "react";
import {
  fetchTrace,
  fetchWhy,
  type DecisionView,
  type TargetKind,
  type TraceRow,
} from "../lib/api";

export function WhyPanel(props: { kind: TargetKind; id: string }): JSX.Element {
  const [decisions, setDecisions] = useState<DecisionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTrace, setOpenTrace] = useState<TraceRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWhy(props.kind, props.id)
      .then((body) => {
        if (!cancelled) setDecisions(body.decisions);
      })
      .catch(() => {
        if (!cancelled) setError("couldn't load decisions");
      });
    return () => {
      cancelled = true;
    };
  }, [props.kind, props.id]);

  async function showTrace(traceId: string): Promise<void> {
    try {
      const body = await fetchTrace(traceId);
      setOpenTrace(body.trace);
    } catch {
      setError("couldn't load trace");
    }
  }

  if (error) return <div className="why-panel">{error}</div>;
  if (!decisions) return <div className="why-panel">loading decisions…</div>;
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
