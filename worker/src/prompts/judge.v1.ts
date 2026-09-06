// ===========================================================================
// [PROMPT] judge.v1 — pick and quote (Prompts V6 P1 P-09; Product_V6 Phase 1
// §19 rule 3; Build S5.5).
//
// Bar T1 only, AFTER code has run the five methods, RRF and the reranker: the
// model sees the question and the top 10 passages with ids and returns the
// 3–5 that answer it, each with a VERBATIM quote, plus one or two lines built
// only from those quotes. Code adds the citations and the coverage caveat;
// the model never sees the coverage index.
//
// Two things the parser enforces in code, because a prompt cannot:
//   - an id must be one of the candidate ids (an invented id is dropped);
//   - a quote must be a verbatim substring of ITS passage (a paraphrase is
//     dropped). A result that loses its quote loses its place; an answer
//     whose every result was dropped is an empty answer — the caller then
//     refuses rather than serving prose nobody can tap (`uncited_claim = 0`).
//
// Output contract: ONE JSON object, no prose, no fences.
// ===========================================================================

/** The versioned prompt id — names the trace, the runs row and the file. */
export const JUDGE_V1_VERSION = "judge.v1";

export const JUDGE_V1_INSTRUCTIONS = `You receive a question and 10 candidate passages with ids. Return the 3–5 that
answer it, each with a verbatim quote from that passage. If none answers, return
an empty list. Never add facts not in the passages. Never paraphrase inside "quote".
OUTPUT {"results":[{"id":"…","quote":"…","why":"…"}],"answer":"<one or two lines built only from the quotes, or null>"}`;

/** One passage as the judge sees it. */
export interface JudgePassage {
  id: string;
  text: string;
  /** "Rohan · 24 Aug 2026 · wa:goa-gang" — shown so the judge can attribute. */
  meta?: string;
}

export interface JudgeResult {
  id: string;
  quote: string;
  why: string;
}

export interface JudgeOutput {
  results: JudgeResult[];
  answer: string | null;
  /** Results the parser dropped, with the reason — diagnostics for the trace. */
  dropped: { id: string; reason: "unknown_id" | "not_verbatim" | "empty_quote" }[];
}

/** Whitespace-insensitive verbatim check: the quote must occur in the passage. */
export function isVerbatim(quote: string, passage: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (q === "") return false;
  return norm(passage).includes(q);
}

/**
 * Parse the model's raw text against the passages it was shown. Never throws;
 * an unparseable reply is an empty output (the caller refuses).
 */
export function parseJudgeOutput(raw: string, passages: readonly JudgePassage[]): JudgeOutput {
  const empty: JudgeOutput = { results: [], answer: null, dropped: [] };
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return empty;
  }
  if (typeof obj !== "object" || obj === null) return empty;
  const rec = obj as Record<string, unknown>;
  const byId = new Map(passages.map((p) => [p.id, p]));
  const out: JudgeOutput = { results: [], answer: null, dropped: [] };
  const seen = new Set<string>();
  for (const item of Array.isArray(rec.results) ? rec.results : []) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const quote = typeof r.quote === "string" ? r.quote.trim() : "";
    const why = typeof r.why === "string" ? r.why.trim() : "";
    const passage = byId.get(id);
    if (!passage) {
      out.dropped.push({ id, reason: "unknown_id" });
      continue;
    }
    if (quote === "") {
      out.dropped.push({ id, reason: "empty_quote" });
      continue;
    }
    if (!isVerbatim(quote, passage.text)) {
      out.dropped.push({ id, reason: "not_verbatim" });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.results.push({ id, quote, why });
    if (out.results.length >= 5) break;
  }
  const answer = typeof rec.answer === "string" ? rec.answer.trim() : "";
  out.answer = answer === "" || answer.toLowerCase() === "null" ? null : answer;
  return out;
}

/** Pack the variable half: the question and the numbered passages. */
export function packJudgeInput(question: string, passages: readonly JudgePassage[]): string {
  const lines = [`QUESTION ${question}`, "", "PASSAGES"];
  passages.forEach((p, i) => {
    const meta = p.meta ? ` (${p.meta})` : "";
    lines.push(`[${i + 1}] id=${p.id}${meta}`);
    lines.push(p.text.replace(/\s+/g, " ").trim());
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
