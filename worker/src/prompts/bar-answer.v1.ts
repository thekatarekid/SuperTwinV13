// ===========================================================================
// [PROMPT] bar-answer.v1 — grounded chat for the bar's answer state (build
// P4.1, spec §14.8 state ③, USR-04).
//
// Citations are load-bearing: every claim must carry an evidence chip. The
// contract reuses the CITATIONS-line convention from server/chat-grounding
// (parseCitationsFromText parses it), and the HARD gate lives in code —
// grounded/handlers.ts refuses to serve an answer whose claims carry no
// resolvable citations. This prompt just makes the honest path the easy one.
// ===========================================================================

/** The versioned prompt id — names the trace, the runs row and the file. */
export const BAR_ANSWER_VERSION = "bar-answer.v1";

export const BAR_ANSWER_INSTRUCTIONS = `You answer ONE question from the user's own captured history.

A <supertwin-context> block precedes the question: it is one turn's retrieval
over the user's data (chat messages, browser visits, screen sessions), each
line tagged [evt <id>]. THE BLOCK IS ALL YOU HAVE. Answer only from it.

Rules:
- Every claim in your answer must cite the event(s) it draws on, inline as
  [1], [2], … .
- If the block does not contain the answer, reply exactly:
  nothing in your data about this
  and cite nothing. NEVER paraphrase from memory or invent a recollection.
- Keep answers short — two or three sentences, quoting the actual words
  ("max 6k a night yaar") where they carry the answer.
- End with EXACTLY one final line:
  CITATIONS: [{"n":1,"kind":"event","id":"<real evt id copied verbatim>","label":"<sender · gist>"}]
  It must be a valid JSON array on the very last line, no fences. If you
  answered "nothing in your data about this", end with: CITATIONS: []`;

/** Pack the variable half: context block + optional thread history + question. */
export function packAnswerInput(
  contextBlock: string,
  question: string,
  history: readonly { role: "user" | "twin"; text: string }[] = [],
): string {
  const parts: string[] = [];
  if (contextBlock) parts.push(contextBlock);
  if (history.length > 0) {
    parts.push(
      ["THREAD SO FAR:", ...history.map((m) => `${m.role}: ${m.text}`)].join("\n"),
    );
  }
  parts.push(`QUESTION ${question}`);
  return parts.join("\n\n");
}
