// ===========================================================================
// brief.v2 — P-13, the prose half of the brief (Prompts_V6_Phase1 P-13; V6 P1
// S4.6; evals BRF-01, BRF-02).
//
// THE SPLIT. Code composes the ledger (brief/ledger.ts) from the world model;
// this call only writes it up. The model is never asked what is true, what is
// due, or what changed — only how to say it. That is why the brief costs at
// most one call, why it costs ZERO when nothing changed (brief/run.ts checks
// the delta before it packs anything), and why every line can be traced back
// to a row: the ledger travels with the brief and the card shows it.
//
//   IN   the three parts, already decided, each item already one line, each
//        carrying its source chip.
//   OUT  {"text":"<markdown>"} — nothing else. No items, no ids to resolve,
//        no structure to parse: the ledger IS the structure.
//
// The one contract code can police mechanically is that the prose invents no
// FIGURE: an amount, a time or a count in the prose that appears nowhere in
// the ledger is named (`brief-inflation:<token>`) so the surface can show the
// brief with its ledger beside it rather than quietly shipping a number the
// world model never held.
//
// Versioned module per build convention 1.3: a changed word means brief.v3.
// ===========================================================================

export const BRIEF_V2_ID = "brief.v2";

/** P-13 system prompt, verbatim. */
export const BRIEF_V2_SYSTEM = `Write the user's brief from the ledger below. Three short parts: needs you,
today, what moved since the last brief. One line each item. Warm, brief, direct,
the user's language mix. No item not in the ledger. No greeting longer than
two words. OUTPUT {"text":"<markdown>"}`;

// ---- Result -----------------------------------------------------------------

export interface BriefV2Result {
  text: string;
}

/**
 * Validate P-13's output. Throws (so runJsonPass takes its one repair round)
 * on anything but an object carrying non-empty `text`.
 */
export function parseBriefV2(parsed: unknown): BriefV2Result {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected one JSON object {"text":"<markdown>"}');
  }
  const raw = (parsed as Record<string, unknown>).text;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new Error('"text" must be a non-empty markdown string');
  return { text };
}

// ---- The mechanical check ---------------------------------------------------

/**
 * Figures the prose states that the ledger does not. Digits only: names and
 * phrasing are the model's job, numbers are the world model's.
 *
 * Normalised so formatting is never mistaken for invention — separators are
 * dropped (`8,400` == `8400`) and a bare `0` prefix ignored (`07:15` ==
 * `7:15`), and a number that is a prefix of a ledger number (`5` in `5.4k`)
 * counts as present.
 */
export function figuresNotInLedger(text: string, ledgerText: string): string[] {
  const known = new Set(numbersIn(ledgerText));
  const out: string[] = [];
  for (const n of numbersIn(text)) {
    if (known.has(n)) continue;
    if ([...known].some((k) => k.startsWith(n) || n.startsWith(k))) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,.\s]*\d|\d/g)) {
    const n = m[0].replace(/[,\s]/g, "").replace(/\.$/, "").replace(/^0+(?=\d)/, "");
    if (n) out.push(n);
  }
  return out;
}
