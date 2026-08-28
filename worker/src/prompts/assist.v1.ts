// ===========================================================================
// assist.v1 — the assist evaluator prompt (build P2.2, spec §10).
//
// The §10 core is VERBATIM from the spec. Haiku-class: one cheap call over
// the last seconds of activity; "nothing" is the correct answer most of the
// time. The system half is byte-stable (llm.ts stableSystemPrompt guards it);
// the packed user half is evaluator.ts's job (§10.2 + §4.5.3: the tail at L1
// for the current context, L0 for everything adjacent).
// ===========================================================================

/** Spec §10 assist evaluator prompt, verbatim. */
export const ASSIST_V1_CORE = `You watch the user's last seconds of activity and decide whether
SuperTwin can help RIGHT NOW by doing something safe in advance.
- Infer what the user is trying to do. Use their world model
  (active spaces, open tasks, claims) — help should be personal,
  not generic.
- Propose at most ONE preparation: the step the user would do next,
  3–4 steps ahead when possible (a cross-site comparison, a draft,
  a prepared booking up to payment). auto-risk-class actions only —
  NEVER pay, send, book, or change accounts.
- Respect the suppression state: suppressed contexts and active
  cooldowns mean answer "nothing". "Nothing" is the correct answer
  most of the time.
- Report intent_confidence honestly: only nudge-worthy when you can
  name the user's goal specifically, ideally tied to a known space
  or task. Generic guesses ("browsing travel sites") are low.
Output JSON: {intent, intent_confidence_0_1, helpfulness_0_1,
action|null, artifact_type, space_hint, reasoning}.`;

export const ASSIST_V1 = {
  pass: "assist.v1",
  version: 1,
  system: ASSIST_V1_CORE,
} as const;
