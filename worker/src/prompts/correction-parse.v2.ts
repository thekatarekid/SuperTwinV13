// ===========================================================================
// [PROMPT] correction-parse.v2 — "Tell the twin" utterance → structured
// correction (build P4 gates, spec §14.4.3 + §7.3.2, FIX-03/CIR-04).
//
// v2 = v1 + the two person-target types the People view applies by direct
// manipulation (set_circle) and by utterance (set_relationship). v1 could not
// express "she's my cousin, not a coworker" on a person card — it fell to
// not_true, which applies to claims only, so the correction was recorded but
// never applied. v2 closes that gap: relationship statements on a PERSON
// target supersede the old relationship claim (validity end, never deletion)
// and move the circle when the relation implies one.
//
// Output contract unchanged: ONE JSON object on one line, no prose/fences.
// ===========================================================================

import { CIRCLES } from "../entities/registry.js";
import { CORRECTION_TYPES } from "./correction-parse.v1.js";

export { packCorrectionInput } from "./correction-parse.v1.js";

/** The versioned prompt id — names the trace, the runs row and the file. */
export const CORRECTION_PARSE_V2_VERSION = "correction-parse.v2";

/** SYSTEM half. Stable text — changing it means cutting a v3 module. */
export const CORRECTION_PARSE_V2_INSTRUCTIONS = `You map ONE user correction utterance to ONE structured correction.

The user is talking about a single object (the "target") shown to you with its
kind and current state. They are correcting something the twin got wrong, or
reporting a change in the world. You never chat back — you emit exactly one
JSON object on a single line and nothing else.

Schema:
  {"type": TYPE, ...fields}

TYPE and its fields:
  wrong_person     — the object belongs to someone else. fields: {"owner": "<name as said>"}
  move             — file it under a different space. fields: {"to_space_hint": "<space name as said>"}
  cancel           — the plan/task was cancelled (NOT completed). no fields.
  already_done     — it is complete. no fields.
  not_task         — this should never have been a task. no fields.
  not_true         — a claim is factually wrong. no fields.
  outdated         — a claim was true once but not anymore. no fields.
  stop_tracking    — stop capturing/deriving from this stream or object. no fields.
  merge_into       — merge this proposal/space into another. fields: {"into_hint": "<name as said>"}
  edit             — a field-level fix. fields: {"field": "<title|due|date|...>", "value": "<new value>"}
  set_relationship — PERSON target only: the user states who this person IS to
                     them ("she's my cousin, not a coworker", "he's my manager").
                     fields: {"relation": "<relationship as said>", "circle": "<circle>"}
                     Include "circle" when the relation implies one of the nine
                     circles below (cousin/sister/mother => family, best friend
                     => close_friends, manager/colleague => coworkers); omit it
                     when no circle is implied.
  set_circle       — PERSON target only: move the person between circles with
                     no new relationship stated ("treat her as a close friend").
                     fields: {"circle": "<circle>"}
  none             — the utterance is not a correction (question, chit-chat). no fields.

The nine circles: ${CIRCLES.join(" | ")}.

Rules:
- Exactly one JSON object, one line, double-quoted keys, no trailing text.
- "cancelled"/"called off"/"not happening" => cancel, never already_done.
- An utterance that cancels AND hints at a future re-plan ("we cancelled goa,
  planning jan instead") is STILL cancel — the re-plan is a NEW object the
  user will create, never an edit/rename of the cancelled one.
- "done"/"finished"/"booked it already" => already_done.
- Relationship statements on a PERSON target ("she's my cousin") =>
  set_relationship, NEVER not_true — not_true/outdated are for claim targets.
- Fact statements on a CLAIM target ("he moved to Pune") => not_true or
  outdated with the new value carried via edit only when the user states one;
  otherwise not_true.
- When genuinely ambiguous, prefer the least destructive type.`;

/** All correction types v2 can emit: v1's plus the two person types. */
export const CORRECTION_TYPES_V2 = [
  ...CORRECTION_TYPES,
  "set_relationship",
  "set_circle",
] as const;

export type CorrectionTypeV2 = (typeof CORRECTION_TYPES_V2)[number];

/** One parsed structured correction (the code-applicable shape). */
export interface ParsedCorrectionV2 {
  type: CorrectionTypeV2;
  owner?: string;
  to_space_hint?: string;
  into_hint?: string;
  field?: string;
  value?: string;
  /** set_relationship: the relationship as the user said it. */
  relation?: string;
  /** set_relationship / set_circle: one of the nine spec §7.3.2 circles. */
  circle?: string;
}

const TYPE_SET_V2: ReadonlySet<string> = new Set(CORRECTION_TYPES_V2);

/**
 * Parse the model's raw text into a ParsedCorrectionV2, or null when nothing
 * usable came back — the caller then records the correction as pending rather
 * than inventing a mutation (FIX-01's "parse-to-nothing" is a recorded
 * failure, never a silent one).
 */
export function parseCorrectionOutputV2(raw: string): ParsedCorrectionV2 | null {
  const match = raw.match(/\{[^\n]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const type = rec.type;
  if (typeof type !== "string" || !TYPE_SET_V2.has(type)) return null;
  const out: ParsedCorrectionV2 = { type: type as CorrectionTypeV2 };
  for (const key of [
    "owner",
    "to_space_hint",
    "into_hint",
    "field",
    "value",
    "relation",
    "circle",
  ] as const) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}
