// ===========================================================================
// orient.v3 — the ORIENT pass prompt (Phase 1 gate remediation, cycle 2).
//
// The spec §8.1 core is UNCHANGED (verbatim, re-exported from v1). v3 rewrites
// only the appended schema block's guidance: v2's "propose, don't defer" line
// measurably INCREASED over-creation (TOP/ASN over_creation 62.5% → 87.5%),
// so v3 replaces it with the match-first / whose-goal / split-by-topic rules
// the failing wrong[] modes named (candidate-blindness, identity-theft,
// hoarder, mono-blob). Convention 3: prompt change = new version + eval run.
// ===========================================================================

import { ORIENT_V1_CORE } from "./orient.v1.js";

export { ORIENT_V1_CORE as ORIENT_V3_CORE };

/** The output schema block — v2's typing fields, rebalanced guidance. */
export const ORIENT_V3_SCHEMA = `Schema:
{"episodes":[{"action":"join"|"new",
  "episode":"<existing episode id, join only>",
  "events":["e1","e4-e11"],
  "summary":"<one sentence>",
  "space":"<candidate space id to attach, or omit>",
  "chain_prev":"<old episode id when chaining a new burst, or omit>",
  "evidence":[{"event_ids":["e1"],"quote":"<verbatim>"}],
  "confidence":0.0-1.0}],
 "proposals":[{"label":"<4-8 specific words>","life_area":"<area>",
  "goal":"<goal, or omit>",
  "term":"short"|"long","persistence":"permanent"|"ephemeral",
  "cadence":"one-time"|"recurring",
  "episode_events":["e2"],
  "summary":"<episode summary>",
  "evidence":[{"event_ids":["e2"],"quote":"<verbatim>"}],
  "confidence":0.0-1.0}],
 "unsorted":[{"events":["e3"],"summary":"<one sentence>",
  "reason":"<why filing declined>","confidence":0.0-1.0}],
 "questions":["<question for the user, or none>"]}
Hard rules, in order:
- MATCH FIRST: when a listed candidate space fits (label, exemplars,
  dates, entities line up), ATTACH the episode to it — never propose a
  near-duplicate of a candidate that is already in view.
- WHOSE GOAL: a space is the USER'S undertaking. Someone else's plan
  is never the user's space — at most a note about that person.
- SINGLE MENTION: one mention with no commitment stays unsorted.
  Repetition already visible across listed occasions IS >=2-bundle
  evidence.
- SPLIT BY TOPIC: when the delta covers clearly unrelated topics, emit
  one episode PER topic with distinct message ranges — even inside one
  conversation, even when one range belongs to an existing space and
  another does not. Promotional/forwarded marketing is context, never
  its own episode topic.
- Type every proposal (term/persistence/cadence) from the evidence: a
  tonight-only plan is short+ephemeral+one-time; a renewal pattern is
  recurring.`;

export const ORIENT_V3 = {
  pass: "orient.v3",
  version: 3,
  system: `${ORIENT_V1_CORE}\n\n${ORIENT_V3_SCHEMA}`,
} as const;
