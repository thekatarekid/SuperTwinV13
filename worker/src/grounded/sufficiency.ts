// ===========================================================================
// [CODE] Sufficiency per class + the coverage caveat (Product_V6 Phase 1 §19
// rule 4; GoldenEvals BAR-04..06; Build S5.5).
//
// The model never decides whether it knew enough. Code does, per class:
//
//   lookup · relational · multihop   ≥ 1 judged result with a verbatim quote
//   aggregate                        the structured value exists (never top-k);
//                                    partial when typed rows were excluded
//   temporal                         the time window ran and was complete
//   absence                          the window over the named stream ran
//                                    complete — a truncated scan is not a "no"
//   list (aggregate op=list)         complete, else "N so far, list may be
//                                    incomplete" + what is missing
//   general                          always (no retrieval)
//
// Insufficient in P1 → a PARTIAL answer with named gaps and the coverage
// caveat ("I only have WhatsApp back to Jan 2024"). T2 agentic escalation is
// P2. The caveat text comes from the coverage index (coverage/index.ts) —
// the model never sees that index (P-09 note).
// ===========================================================================

import { coverageCaveat, coveredSources, sourceLabel, type CoverageCaveat } from "../coverage/index.js";
import type { RoutePlan } from "../prompts/route.v1.js";
import type { JudgeOutput } from "../prompts/judge.v1.js";
import type { BarRetrieval } from "./retrieval.js";

export interface Sufficiency {
  sufficient: boolean;
  /** The answer is served with "partial" marked and the gaps named. */
  partial: boolean;
  gaps: string[];
  caveat: CoverageCaveat | null;
  /** The method the answer rests on, reported to the user (BAR-04: "structured"). */
  method: string;
  /** Rows the answer scanned / rested on. */
  scanned: number;
}

/** ISO instant or day → YYYY-MM-DD; null for garbage. */
function day(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Which source(s) the caveat is about: the plan's source filter, the stream
 * filter's prefix ("wa:…" → wa), the candidates' sources, else every source
 * with a coverage row.
 */
export function caveatSources(plan: RoutePlan, retrieval: BarRetrieval): string[] {
  if (plan.filters.source) return [plan.filters.source];
  const m = plan.filters.stream ? /^([a-z]+):/i.exec(plan.filters.stream) : null;
  if (m) return [m[1].toLowerCase()];
  const fromKeys = new Set<string>();
  for (const k of retrieval.stream_keys) {
    const mm = /^([a-z]+):/i.exec(k);
    if (mm) fromKeys.add(mm[1].toLowerCase());
  }
  if (fromKeys.size > 0) return [...fromKeys];
  const fromRows = new Set<string>();
  for (const c of retrieval.candidates) if (c.source) fromRows.add(c.source);
  if (fromRows.size > 0) return [...fromRows];
  return coveredSources();
}

/** The first caveat over the asked range, or null when the range is covered. */
export function caveatFor(plan: RoutePlan, retrieval: BarRetrieval, now: Date): CoverageCaveat | null {
  const from = day(plan.time?.from) ?? day(new Date(now.getTime() - 365 * 86_400_000).toISOString())!;
  const to = day(plan.time?.to) ?? day(now.toISOString())!;
  if (to < from) return null;
  for (const source of caveatSources(plan, retrieval)) {
    try {
      const c = coverageCaveat(source, { from, to });
      if (c) return c;
    } catch {
      // a malformed range is no caveat, not a failed answer
    }
  }
  return null;
}

export function checkSufficiency(
  plan: RoutePlan,
  retrieval: BarRetrieval,
  judged: JudgeOutput | null,
  now: Date = new Date(),
): Sufficiency {
  const gaps: string[] = [];
  const results = judged?.results.length ?? 0;
  const entities = plan.entities.length > 0 ? plan.entities.join(" ") : "this";

  switch (plan.class) {
    case "general":
      return { sufficient: true, partial: false, gaps, caveat: null, method: "general knowledge", scanned: 0 };

    case "aggregate": {
      const s = retrieval.structured;
      if (!s) {
        gaps.push(`no typed rows (amount · merchant · date) matched ${entities} — nothing to add up`);
        return { sufficient: false, partial: true, gaps, caveat: caveatFor(plan, retrieval, now), method: "structured", scanned: 0 };
      }
      if (s.op === "list") {
        if (!s.complete) {
          gaps.push(`${s.rows.length} so far, list may be incomplete — ${s.rowCount - s.rows.length} more row(s) past the cap`);
        }
        if (s.excluded.untyped > 0) gaps.push(`${s.excluded.untyped} matching row(s) had no typed value`);
        if (s.excluded.undated > 0) gaps.push(`${s.excluded.undated} matching row(s) had no date`);
        const partial = !s.complete || s.excluded.untyped > 0 || s.excluded.undated > 0;
        return { sufficient: s.rowCount > 0, partial, gaps, caveat: caveatFor(plan, retrieval, now), method: "structured", scanned: s.rowCount };
      }
      if (s.rowCount === 0) {
        gaps.push(`no typed rows matched ${entities} in the asked range`);
        return { sufficient: false, partial: true, gaps, caveat: caveatFor(plan, retrieval, now), method: "structured", scanned: 0 };
      }
      if (s.excluded.untyped > 0) gaps.push(`${s.excluded.untyped} matching row(s) had no amount and are not in the total`);
      if (s.excluded.undated > 0) gaps.push(`${s.excluded.undated} matching row(s) had no date and are not in the total`);
      if (s.op === "sum" && s.value === null && s.byCurrency.length > 1) gaps.push("mixed currencies — totals are per currency");
      return {
        sufficient: true,
        partial: s.excluded.untyped > 0 || s.excluded.undated > 0,
        gaps,
        caveat: caveatFor(plan, retrieval, now),
        method: "structured",
        scanned: s.rowCount,
      };
    }

    case "absence": {
      const tw = retrieval.time_window;
      const caveat = caveatFor(plan, retrieval, now);
      if (!tw) {
        gaps.push(`could not scan a time range for ${entities} — no range resolved`);
        return { sufficient: false, partial: true, gaps, caveat, method: "time_window", scanned: 0 };
      }
      if (!tw.complete) {
        gaps.push(`scanned the first ${tw.events.length} of ${tw.count} messages — the rest were not read, so this is not a confident "no"`);
        return { sufficient: false, partial: true, gaps, caveat, method: "time_window", scanned: tw.events.length };
      }
      return { sufficient: true, partial: false, gaps, caveat, method: "time_window", scanned: tw.count };
    }

    case "temporal": {
      const tw = retrieval.time_window;
      const caveat = caveatFor(plan, retrieval, now);
      if (!tw) {
        gaps.push("no time range resolved from the question");
        return { sufficient: results > 0, partial: results === 0, gaps, caveat, method: "time_window", scanned: 0 };
      }
      if (!tw.complete) gaps.push(`showing the first ${tw.events.length} of ${tw.count} in that window`);
      if (tw.count === 0) gaps.push("nothing captured in that window");
      return { sufficient: tw.count > 0 && tw.complete, partial: !tw.complete || tw.count === 0, gaps, caveat, method: "time_window", scanned: tw.count };
    }

    case "lookup":
    case "relational":
    case "multihop":
    default: {
      const method = plan.class === "lookup" ? "lexical ∪ vector" : "graph → vector";
      if (results > 0) return { sufficient: true, partial: false, gaps, caveat: null, method, scanned: retrieval.candidates.length };
      if (retrieval.candidates.length === 0) gaps.push(`nothing in your data matched ${entities}`);
      else gaps.push(`${retrieval.candidates.length} candidate(s) read, none answered the question`);
      if ((plan.class === "relational" || plan.class === "multihop") && retrieval.graph && retrieval.graph.seeds === 0) {
        gaps.push(`no person or topic named ${plan.seeds.join(", ") || entities} in the graph`);
      }
      return { sufficient: false, partial: true, gaps, caveat: caveatFor(plan, retrieval, now), method, scanned: retrieval.candidates.length };
    }
  }
}

/** "I only have WhatsApp back to Jul 2026" — the one line the answer carries. */
export function caveatLine(c: CoverageCaveat | null): string | null {
  if (!c) return null;
  return c.text;
}

export { sourceLabel };
