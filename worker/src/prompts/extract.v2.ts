// ===========================================================================
// extract.v2 — the EXTRACT pass prompt (Phase 1 gate remediation, cycle 2).
//
// The spec §8.3 core is UNCHANGED (verbatim, re-exported from v1). v2 extends
// only the appended output contract, targeting the CLM failure modes the
// golden run named: unresolved subjects (CLM-01), missing supersede validity
// ends (CLM-03/09), sarcasm stored as belief (CLM-07), and cross-source
// duplicates instead of reinforcement (CLM-13).
// ===========================================================================

import { EXTRACT_V1_CORE } from "./extract.v1.js";

export { EXTRACT_V1_CORE as EXTRACT_V2_CORE };

export const EXTRACT_V2_ID = "extract.v2";

/** v2 output contract, appended after the verbatim core. */
export const EXTRACT_V2_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
{"claims":[{"kind":"preference","subject":"ent_x9 or unknown",
  "subject_hint":"only when subject is unknown","text":"…",
  "relation":"new","related_claim":null,"old_valid_until":null,
  "evidence":[{"event_ids":["e1"],"quote":"verbatim quote"}],
  "confidence":0.8,"valid_from":"2026-08-01"}],
 "provisional_people":[{"name":"Sameer","hint":"Rohan's cousin, mentioned once"}],
 "tone":[{"person":"ent_x9 or null","stream":"stream id or null",
  "register":"casual","language_mix":"Hinglish","emoji_habits":"heavy 😂",
  "address_terms":[{"term":"bro","class":"generic"}]}]}
relation is "new", "reinforces" or "contradicts"; related_claim carries the
claim id it reinforces/contradicts, else null. Omit sections you have nothing
for by emitting empty arrays.
Hard rules:
- SUBJECT RESOLUTION: when the speaker or context names a known person
  (roster/CRM id in view, or the message sender themself), RESOLVE the
  subject to that id and write the claim text in third person with the
  person's name ("Rohan prefers aisle seats"). "unknown" is only for a
  person no id in view can match.
- SUPERSEDE: a "contradicts" claim MUST set old_valid_until (the date
  the old claim stopped holding — usually this statement's date). The
  old claim is ended, never deleted.
- REINFORCE ACROSS SOURCES: the same fact arriving from another source
  (browser, screen, another chat) reinforces the EXISTING claim id and
  raises confidence — it is never a parallel new claim.
- Sarcasm/banter is a tone note only — never a belief/fact claim, at
  any confidence.
- A repeated observed sequence of actions is a workflow claim citing
  the repetition.`;

export const EXTRACT_V2_SYSTEM = `${EXTRACT_V1_CORE}\n\n${EXTRACT_V2_OUTPUT}`;
