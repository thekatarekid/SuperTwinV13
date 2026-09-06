// ===========================================================================
// [PROMPT] bar-general.v1 — answers not from the user's data (Prompts V6 P1
// P-14; Product_V6 Phase 1 §19 rule 5; Build S5.5).
//
// When route.v1 returns `general`, the bar answers from general knowledge in
// one short call, with NO retrieval and NO reference to the user's data. Code
// prefixes the label ("Not from your data") — the model starts with nothing.
//
// Output contract: ONE JSON object on one line, no prose, no fences.
// ===========================================================================

/** The versioned prompt id — names the trace, the runs row and the file. */
export const BAR_GENERAL_V1_VERSION = "bar-general.v1";

export const BAR_GENERAL_V1_INSTRUCTIONS = `Answer briefly and correctly from general knowledge. Do not reference the
user's data. Start the answer with nothing; code prefixes "Not from your data".
OUTPUT {"text":"…"}`;

/** The label code prefixes (Product_V6_Phase1 §19 rule 5). */
export const NOT_FROM_YOUR_DATA = "Not from your data";

export function parseGeneralOutput(raw: string): string | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { text?: unknown };
    if (typeof obj.text === "string" && obj.text.trim() !== "") return obj.text.trim();
  } catch {
    // fall through
  }
  return null;
}

export function packGeneralInput(question: string): string {
  return `QUESTION ${question}`;
}

/** The labelled answer the bar renders: "Not from your data — <text>". */
export function labelGeneralAnswer(text: string): string {
  return `${NOT_FROM_YOUR_DATA} — ${text}`;
}
