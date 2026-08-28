// ===========================================================================
// [PROMPT] bar-intent.v1 — grounded-bar intent router (build P4.1, spec
// §14.8.1).
//
// One input, no modes: every bar submission is classified as search /
// question / action / correction by a lightweight traced call (Haiku —
// build convention). The user never chooses a mode; genuine ambiguity
// defaults to search (cheapest, instantly revisable) — and so does every
// parse failure, in code, in parseIntentOutput below.
//
// Output contract: ONE JSON object on one line, no prose, no fences:
//   {"intent":"search"|"question"|"action"|"correction"}
// ===========================================================================

/** The versioned prompt id — names the trace, the runs row and the file. */
export const BAR_INTENT_VERSION = "bar-intent.v1";

export const BAR_INTENT_INSTRUCTIONS = `You route ONE utterance typed into a personal assistant's input bar.

Classify it as exactly one of:
  search    — the user is looking for something they saw/said before
              ("goa villa", "that airbnb link", "rohan flight message")
  question  — the user asks something answerable from their own history
              ("how much did we say per night?", "when is ma's birthday?")
  action    — the user tells the assistant to DO something
              ("plan a hampi trek…", "remind me to renew insurance",
               "add task: buy sunscreen", "book the 2nd option")
  correction— the user corrects something the assistant believes
              ("that's karan's task, not mine", "we cancelled the trip")

Rules:
- Bare noun phrases with no verb and no question mark => search.
- Questions ("?", how/what/when/who/did/is) => question.
- Imperatives aimed at the assistant (plan/remind/add/create/book/send/pay)
  => action.
- When genuinely ambiguous, choose search.
- Output EXACTLY one JSON object on one line: {"intent":"<one of the four>"}`;

export const BAR_INTENTS = ["search", "question", "action", "correction"] as const;

export type BarIntent = (typeof BAR_INTENTS)[number];

const INTENT_SET: ReadonlySet<string> = new Set(BAR_INTENTS);

/**
 * Parse the model's raw text into an intent. Anything unusable defaults to
 * "search" — the spec's ambiguity rule, enforced in code so a bad round can
 * never wedge the bar.
 */
export function parseIntentOutput(raw: string): BarIntent {
  const match = raw.match(/\{[^\n]*\}/);
  if (!match) return "search";
  try {
    const obj = JSON.parse(match[0]) as { intent?: unknown };
    if (typeof obj.intent === "string" && INTENT_SET.has(obj.intent)) {
      return obj.intent as BarIntent;
    }
  } catch {
    // fall through to the default
  }
  return "search";
}

/** Pack the variable half: the utterance, nothing else. */
export function packIntentInput(text: string): string {
  return `UTTERANCE ${text}`;
}
