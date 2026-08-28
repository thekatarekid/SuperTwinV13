// ===========================================================================
// extract.v5 — the EXTRACT pass prompt (Phase 1 gate remediation, round 2b).
//
// The spec §8.3 core is UNCHANGED (verbatim via v1). v5 = v4 plus the two
// rules the r5 run still breached: promotional copy yields ZERO claims
// whatever its wording (CLM-05/CAT-06 ad-preference), and subjective
// assessments are opinions, never facts (CLM-10 kind-blur).
// ===========================================================================

import { EXTRACT_V1_CORE } from "./extract.v1.js";

export { EXTRACT_V1_CORE as EXTRACT_V5_CORE };

export const EXTRACT_V5_ID = "extract.v5";

export const EXTRACT_V5_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
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
- KINSHIP: a stated relationship ("your cousin Aarav", "Rohan's boss
  Meera") emits BOTH the provisional person AND an explicit claim of
  kind "relationship" ("Aarav is Aditya's cousin") citing the quote —
  a hint alone drops the relationship.
- SUPERSEDE: a "contradicts" claim MUST set old_valid_until (the date
  the old claim stopped holding — usually this statement's date). The
  old claim is ended, never deleted.
- REINFORCE ACROSS SOURCES: when the context shows an EXISTING claim
  (any id like clm_*) stating the same fact, the observation is
  {"relation":"reinforces","related_claim":"<that id>"} with raised
  confidence — NEVER a "new" claim, whatever the source. A "new"
  duplicate of a claim in view is a source-silo failure.
- PROMO IS NOT THE USER: promotional/marketing copy from a business
  ("You LOVE mangoes! 20% off") yields ZERO claims about the user —
  the ad's second-person flattery is the advertiser talking, not the
  user. Transactional records (statements, order confirmations) yield
  facts; a habit claim needs REPEATED transactions as evidence, never
  one order, never ad copy.
- KIND HONESTY: a subjective assessment ("the architecture is a
  mess") is kind "opinion" (or "belief"), never "fact". Facts are for
  externally checkable statements (deadlines, addresses, events).
- SARCASM/BANTER: an obviously joking or sarcastic line produces ZERO
  claims — not a hedged belief at 0.6, not a fact, nothing in claims[].
  It may only feed tone[] (register/humor).
- WORKFLOW: the same sequence of actions observed on repeated days IS a
  workflow claim ("Morning routine: email -> burn sheet -> Slack")
  citing the repetition as evidence.`;

export const EXTRACT_V5_SYSTEM = `${EXTRACT_V1_CORE}\n\n${EXTRACT_V5_OUTPUT}`;
