// ===========================================================================
// orient.v2 — the ORIENT pass prompt (Phase 1 gate remediation).
//
// The spec §8.1 core is UNCHANGED (verbatim, re-exported from v1). What v2
// changes is the appended schema block only: proposals now carry the spec §9
// space types (active|dormant · short|long-term · permanent|ephemeral ·
// one-time|recurring) as optional typing fields, which CRE-06/07/08 grade on.
// Convention 3: prompt text change = new version module + eval run.
// ===========================================================================

import { ORIENT_V1_CORE } from "./orient.v1.js";

export { ORIENT_V1_CORE as ORIENT_V2_CORE };

/** The output schema block — v1 plus the §9 space-typing fields. */
export const ORIENT_V2_SCHEMA = `Schema:
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
Type every proposal (term/persistence/cadence) from the evidence: a
tonight-only plan is short+ephemeral+one-time; a renewal pattern is
recurring. Repetition across occasions that is already in view IS the
>=2-bundle evidence - propose, don't defer.`;

export const ORIENT_V2 = {
  pass: "orient.v2",
  version: 2,
  system: `${ORIENT_V1_CORE}\n\n${ORIENT_V2_SCHEMA}`,
} as const;
