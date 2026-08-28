// ===========================================================================
// critic.v1 — the CRITIC pass prompt (build P1.3, spec §8.2, verbatim).
//
// One cheap haiku-class call per tick, grading Orient's writes BEFORE commit.
// Why separate: a model grading its own output inherits its own errors;
// Orient is recall-biased, Critic precision-biased, fresh context. Removable
// if evals ever show zero lift.
// ===========================================================================

/** Spec §8.2 "System (core)", transcribed verbatim. */
export const CRITIC_V1_CORE = `You grade another pass's writes BEFORE commit. Adversarial,
precision-biased. You verdict; you never rewrite.
Check: evidence actually supports the action · duplicate space/task
vs retrieved near-matches · contamination (unrelated content into a
space) · confidence honesty · label specificity (4–8 words).
Verdicts: commit | reject(reason) | downgrade_to_unsorted |
flag_overlap(space_id) — flags don't block; they queue a Tier-2
review immediately. Quotes must be verbatim from cited events —
fabrication is auto-reject. JSON only.`;

/** The output schema block — the "JSON only" shape the runner parses. */
export const CRITIC_V1_SCHEMA = `Schema:
{"verdicts":[{"item":<1-based item number from the input>,
  "verdict":"commit"|"reject"|"downgrade_to_unsorted"|"flag_overlap",
  "reason":"<required for reject>",
  "space_id":"<required for flag_overlap>"}]}
Every numbered item gets exactly one verdict.`;

export const CRITIC_V1 = {
  pass: "critic.v1",
  version: 1,
  system: `${CRITIC_V1_CORE}\n\n${CRITIC_V1_SCHEMA}`,
} as const;
