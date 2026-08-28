// ===========================================================================
// Generative result renderer basics — build P3.5, spec §14.5 / §11.4 item 4.
//
// Renders the executor's typed {result_type, data} payloads. The model
// composes DATA, never styles: every visual decision lives here, one branch
// per schema, all fields read defensively (a missing field renders as absent,
// never as a crash — the worker validated on emit, but the renderer stays
// honest about drift). P4.2 grows this into the full component library.
// ===========================================================================

import type { ExecutorResultView } from "../lib/api";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const muted = { color: "var(--ink-2)" } as const;

export function ResultRenderer(props: { result: ExecutorResultView }): JSX.Element {
  const { result_type, data } = props.result;

  return (
    <div className="result-region" data-testid="result-region" aria-label="live result">
      {result_type === "comparison_table" && <ComparisonTable data={data} />}
      {result_type === "itinerary" && <Itinerary data={data} />}
      {result_type === "draft_preview" && <DraftPreview data={data} />}
      {result_type === "approval_card" && <ApprovalCard data={data} />}
      {result_type === "research_brief" && <ResearchBrief data={data} />}
      {result_type === "checklist" && <Checklist data={data} />}
      {result_type === "receipt" && <Receipt data={data} />}
    </div>
  );
}

function ComparisonTable({ data }: { data: Record<string, unknown> }): JSX.Element {
  const columns = arr(data.columns).map(String);
  const rows = arr(data.rows).map((r) => arr(r).map(String));
  return (
    <div>
      {str(data.title) && <p><strong>{str(data.title)}</strong></p>}
      <table>
        <thead>
          <tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>{cells.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {str(data.recommendation) && <p style={muted}>← {str(data.recommendation)}</p>}
    </div>
  );
}

function Itinerary({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      {str(data.title) && <p><strong>{str(data.title)}</strong></p>}
      <ul>
        {arr(data.legs).map((leg, i) => {
          const l = obj(leg);
          return (
            <li key={i}>
              {str(l.when)} — {str(l.what)}
            </li>
          );
        })}
      </ul>
      {str(data.notes) && <p style={muted}>{str(data.notes)}</p>}
    </div>
  );
}

function DraftPreview({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      <p style={muted}>
        draft · {str(data.channel) ?? "message"} → {str(data.to) ?? "?"}
      </p>
      {str(data.subject) && <p><strong>{str(data.subject)}</strong></p>}
      <blockquote>{str(data.body) ?? ""}</blockquote>
    </div>
  );
}

function ApprovalCard({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      <p>
        <strong>{str(data.summary) ?? str(data.action) ?? "approval"}</strong>
        {str(data.amount) && <> · {str(data.amount)}</>}
      </p>
      <ul>
        {arr(data.details).map((d, i) => {
          const row = obj(d);
          return (
            <li key={i}>
              {str(row.label)}: {str(row.value)}
            </li>
          );
        })}
      </ul>
      {str(data.cancellation_policy) && <p style={muted}>{str(data.cancellation_policy)}</p>}
    </div>
  );
}

function ResearchBrief({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      {str(data.title) && <p><strong>{str(data.title)}</strong></p>}
      {str(data.summary) && <p>{str(data.summary)}</p>}
      <ul>
        {arr(data.findings).map((f, i) => (
          <li key={i}>{str(obj(f).point)}</li>
        ))}
      </ul>
      {arr(data.sources).length > 0 && (
        <p style={muted}>sources: {arr(data.sources).map(String).join(" · ")}</p>
      )}
    </div>
  );
}

function Checklist({ data }: { data: Record<string, unknown> }): JSX.Element {
  const mark = (state: string | null): string =>
    state === "done" ? "✓" : state === "blocked" ? "✕" : "○";
  return (
    <div>
      {str(data.title) && <p><strong>{str(data.title)}</strong></p>}
      <ul>
        {arr(data.items).map((item, i) => {
          const row = obj(item);
          return (
            <li key={i}>
              {mark(str(row.state))} {str(row.label)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Receipt({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      <p>
        ✓ <strong>{str(data.summary) ?? str(data.action) ?? "performed"}</strong>
      </p>
      <p style={muted}>
        {str(data.performed_at)}
        {str(data.reference) && <> · ref {str(data.reference)}</>}
      </p>
    </div>
  );
}
