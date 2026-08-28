// ===========================================================================
// orient.v1 — the ORIENT pass prompt (build P1.3, spec §8.1, verbatim).
//
// One call per stream-bundle: turn the delta into episodes and file each into
// spaces. Changing this text = a new version module + eval run (build
// convention 3). The system block is byte-identical across calls per pass
// (spec §8 conventions) — brain/llm.ts enforces it.
//
// Appended to the spec core: the exact JSON schema the pass runner parses.
// The spec's core ends "JSON schema only." — the schema below IS that schema,
// part of the same stable system block.
// ===========================================================================

/** Spec §8.1 "System (core)", transcribed verbatim. */
export const ORIENT_V1_CORE = `You are SuperTwin's Orient pass. Turn one stream's new events into
episodes and file each into spaces.
- Episode = one temporal burst of activity about one thing IN THIS
  STREAM. Join the open/dormant episode when this continues it; new
  episode for a new burst; split by MESSAGE RANGES only when the delta
  clearly covers unrelated topics. Same topic after a long break = new
  episode chained to the old.
- Filing order per episode: (a) MATCH a candidate space (attach;
  conf <0.6 → don't); (b) PROPOSE a new space only on real goal
  evidence — intent, commitment, money, dates, or repetition across
  ≥2 bundles/sources; label 4–8 specific words; (c) UNSORTED otherwise
  — a good answer.
- Never one space per chat. Never split one conversation topic across
  new spaces. A wrong merge destroys; a wrong split is repairable.
- Resolve people to roster ids; unknown beats wrong; emit questions.
- Age-band policy and mode (propose-only) are hard constraints.
- Recent-context spaces are hints, not rules — attach only with a
  stated reason.
JSON schema only.`;

/** The output schema block — the "JSON schema only" the core demands. */
export const ORIENT_V1_SCHEMA = `Schema:
{"episodes":[{"action":"join"|"new",
  "episode":"<existing episode id, join only>",
  "events":["e1","e4-e11"],
  "summary":"<one sentence>",
  "space":"<candidate space id to attach, or omit>",
  "chain_prev":"<old episode id when chaining a new burst, or omit>",
  "evidence":[{"event_ids":["e1"],"quote":"<verbatim>"}],
  "confidence":0.0-1.0}],
 "proposals":[{"label":"<4-8 specific words>","life_area":"<area>",
  "goal":"<goal, or omit>","episode_events":["e2"],
  "summary":"<episode summary>",
  "evidence":[{"event_ids":["e2"],"quote":"<verbatim>"}],
  "confidence":0.0-1.0}],
 "unsorted":[{"events":["e3"],"summary":"<one sentence>",
  "reason":"<why filing declined>","confidence":0.0-1.0}],
 "questions":["<question for the user, or none>"]}`;

export const ORIENT_V1 = {
  pass: "orient.v1",
  version: 1,
  system: `${ORIENT_V1_CORE}\n\n${ORIENT_V1_SCHEMA}`,
} as const;
