// ===========================================================================
// orient.v6 — the ORIENT pass prompt (Phase 1 gate remediation, round 2c).
//
// The spec §8.1 core is UNCHANGED (verbatim, re-exported from v1). v6 keeps
// v5's spine and closes the r6 residue: banter/memes never ride into a goal
// space's episode (ASN-05 contamination), a single mention is an unsorted[]
// entry and never a low-confidence proposal (ASN-08), and a dated occasion
// demanding the user's own action is real goal evidence (TOP-08).
// Convention 3: prompt change = new version + eval run.
// ===========================================================================

import { ORIENT_V1_CORE } from "./orient.v1.js";

export { ORIENT_V1_CORE as ORIENT_V6_CORE };

/** The output schema block — v3's typing fields, sharpened guidance. */
export const ORIENT_V6_SCHEMA = `Schema:
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
  dates, entities line up), ATTACH the episode to it with confidence
  >=0.85 and a verbatim quote — never file it unsorted, never propose
  a near-duplicate of a candidate already in view.
- WHOSE GOAL: a space is the USER'S undertaking. Someone else's plan
  is never the user's space — at most a note about that person.
- AMBIGUITY: when TWO listed candidates both plausibly fit and the
  delta names neither, do NOT attach at >=0.6 — file it unsorted (low
  confidence) AND emit a targeted question naming both candidates
  ("X for the trip or the wedding?"). A coin-flip attach is worse
  than an honest question.
- THRESHOLD: one mention with no commitment goes in unsorted[] — it is
  NEVER a proposals[] entry, not even at low confidence; the honest
  shape for "too early to tell" is unsorted plus (optionally) a
  question. But
  repetition ALREADY LISTED in the state (>=2 prior occasions of the
  same pursuit, or a purchase artifact like a cart/checkout page on
  top of prior research) IS real goal evidence — propose then, and
  cite ALL the listed occasions' event ids as evidence, never just
  the newest. A recurring pattern in the CLAIMS plus a fresh trigger
  event meets the same threshold — propose with cadence "recurring"
  (an episode alone is not an answer). A CONCRETE DATED occasion that
  requires the user's own action ("ma ka birthday 12 tarikh ko, gift
  socho") is goal evidence too — propose it rather than holding it.
- ONE EPISODE PER STREAM: an episode never spans streams. Two chats
  about the same topic in one tick = two episodes (each with its own
  events), both attached to the same space. Never merge streams into
  one episode; never fork a space per chat.
- SPLIT BY TOPIC: when the delta covers clearly unrelated topics, emit
  one episode PER topic with distinct message ranges — even inside one
  conversation, even when one range attaches and another proposes.
  Promotional/forwarded marketing is context, never its own topic.
- REACTIONS BELONG: emoji-only messages, reactions and stickers that
  answer an open episode's content JOIN that episode as agreement /
  sentiment signals (say so in the summary). They are never unsorted
  and never an episode of their own.
- TYPE EVERY PROPOSAL (term/persistence/cadence) from the evidence:
  a tonight-only plan is short+ephemeral+one-time; a repeating
  renewal/ritual pattern in the claims is cadence "recurring".
- PROPOSE-ONLY: every proposal is born status 'proposed' for user
  review — write the proposal; the commit layer queues it. Never
  claim, or wait for, activation.`;

export const ORIENT_V6 = {
  pass: "orient.v6",
  version: 6,
  system: `${ORIENT_V1_CORE}\n\n${ORIENT_V6_SCHEMA}`,
} as const;
