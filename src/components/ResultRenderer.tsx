// ===========================================================================
// Generative result renderer + component library — build P4.2 (grown from the
// P3.5 basics), spec §14.5 / §11.4 item 4.
//
// Renders the executor's typed {result_type, data} payloads. The model
// composes DATA, never styles: every visual decision lives here in a fixed
// design-system kit (Kit* primitives below), one branch per schema, all
// fields read defensively (a missing field renders as absent, never as a
// crash — the worker validated on emit, but the renderer stays honest about
// drift). Anything outside the seven schemas falls back to a clean document
// card (spec §14.5: "overflow falls back to a clean document card").
// ===========================================================================

import type { ReactNode } from "react";
import type { ExecutorResultView } from "../lib/api";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const muted = { color: "var(--ink-2)" } as const;

// ---- the component kit (fixed design system; the model never reaches it) ---

/** Bold lead line of a result block. */
export function KitTitle({ text }: { text: string | null }): JSX.Element | null {
  return text ? (
    <p>
      <strong>{text}</strong>
    </p>
  ) : null;
}

/** Muted footnote / provenance / policy line. */
export function KitNote({ text, prefix }: { text: string | null; prefix?: string }): JSX.Element | null {
  return text ? (
    <p style={muted}>
      {prefix}
      {text}
    </p>
  ) : null;
}

/** Column table — comparisons, fares, options. */
export function KitTable({ columns, rows }: { columns: string[]; rows: string[][] }): JSX.Element {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Plain bulleted list of composed lines. */
export function KitList({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** label: value rows (approval details, receipts). */
export function KitKeyValue({ pairs }: { pairs: { label: string | null; value: string | null }[] }): JSX.Element {
  return (
    <ul>
      {pairs.map((p, i) => (
        <li key={i}>
          {p.label}: {p.value}
        </li>
      ))}
    </ul>
  );
}

/** Quoted body — drafts, verbatim text. */
export function KitQuote({ text }: { text: string }): JSX.Element {
  return <blockquote>{text}</blockquote>;
}

/**
 * The overflow fallback: any payload the kit has no schema branch for renders
 * as a clean, readable document card — never raw JSON soup, never a crash.
 */
export function DocumentCard({ data, title }: { data: Record<string, unknown>; title?: string | null }): JSX.Element {
  const line = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(line).filter(Boolean).join(" · ");
    return Object.entries(obj(v))
      .map(([k, x]) => `${k}: ${line(x)}`)
      .join(" · ");
  };
  const entries = Object.entries(data).filter(([, v]) => line(v) !== "");
  return (
    <div className="document-card" data-testid="document-card">
      <KitTitle text={title ?? str(data.title)} />
      {entries
        .filter(([k]) => k !== "title")
        .map(([k, v]) => (
          <p key={k}>
            <span style={muted}>{k.replace(/_/g, " ")}</span> — {line(v)}
          </p>
        ))}
      {entries.length === 0 && <p style={muted}>nothing to show</p>}
    </div>
  );
}

// ---- the seven executor result schemas -------------------------------------

const KNOWN_TYPES = new Set([
  "comparison_table",
  "itinerary",
  "draft_preview",
  "approval_card",
  "research_brief",
  "checklist",
  "receipt",
]);

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
      {!KNOWN_TYPES.has(result_type) && <DocumentCard data={data} />}
    </div>
  );
}

function ComparisonTable({ data }: { data: Record<string, unknown> }): JSX.Element {
  const columns = arr(data.columns).map(String);
  const rows = arr(data.rows).map((r) => arr(r).map(String));
  return (
    <div>
      <KitTitle text={str(data.title)} />
      <KitTable columns={columns} rows={rows} />
      <KitNote text={str(data.recommendation)} prefix="← " />
    </div>
  );
}

function Itinerary({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      <KitTitle text={str(data.title)} />
      <KitList
        items={arr(data.legs).map((leg) => {
          const l = obj(leg);
          return (
            <>
              {str(l.when)} — {str(l.what)}
            </>
          );
        })}
      />
      <KitNote text={str(data.notes)} />
    </div>
  );
}

function DraftPreview({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      <p style={muted}>
        draft · {str(data.channel) ?? "message"} → {str(data.to) ?? "?"}
      </p>
      <KitTitle text={str(data.subject)} />
      <KitQuote text={str(data.body) ?? ""} />
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
      <KitKeyValue
        pairs={arr(data.details).map((d) => {
          const row = obj(d);
          return { label: str(row.label), value: str(row.value) };
        })}
      />
      <KitNote text={str(data.cancellation_policy)} />
    </div>
  );
}

function ResearchBrief({ data }: { data: Record<string, unknown> }): JSX.Element {
  return (
    <div>
      <KitTitle text={str(data.title)} />
      {str(data.summary) && <p>{str(data.summary)}</p>}
      <KitList items={arr(data.findings).map((f) => str(obj(f).point))} />
      {arr(data.sources).length > 0 && (
        <KitNote text={arr(data.sources).map(String).join(" · ")} prefix="sources: " />
      )}
    </div>
  );
}

function Checklist({ data }: { data: Record<string, unknown> }): JSX.Element {
  const mark = (state: string | null): string =>
    state === "done" ? "✓" : state === "blocked" ? "✕" : "○";
  return (
    <div>
      <KitTitle text={str(data.title)} />
      <KitList
        items={arr(data.items).map((item) => {
          const row = obj(item);
          return (
            <>
              {mark(str(row.state))} {str(row.label)}
            </>
          );
        })}
      />
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
