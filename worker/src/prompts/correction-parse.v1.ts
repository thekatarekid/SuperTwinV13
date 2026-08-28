// ===========================================================================
// [PROMPT] correction-parse.v1 — "Tell the twin" utterance → structured
// correction (build P1.7, spec §14.4.3).
//
// The user speaks in a context-locked bar ("this is karan's task, not mine",
// "we cancelled this", "she's my cousin") and the model maps the utterance to
// ONE structured correction the code can apply immediately. Default model:
// Haiku (build convention). The call goes through the prompt runner, so it is
// traced (TRC-01) and accounted like every other LLM step.
//
// Output contract: a single JSON object on one line (no prose, no fences):
//   { "type": "<correction type>", ...fields }
// Types (spec §14.4.3): wrong_person | move | cancel | already_done |
// not_task | not_true | outdated | stop_tracking | merge_into | edit | none.
// ===========================================================================

/** The versioned prompt id — names the trace, the runs row and the file. */
export const CORRECTION_PARSE_VERSION = "correction-parse.v1";

/** SYSTEM half. Stable text — changing it means cutting a v2 module. */
export const CORRECTION_PARSE_INSTRUCTIONS = `You map ONE user correction utterance to ONE structured correction.

The user is talking about a single object (the "target") shown to you with its
kind and current state. They are correcting something the twin got wrong, or
reporting a change in the world. You never chat back — you emit exactly one
JSON object on a single line and nothing else.

Schema:
  {"type": TYPE, ...fields}

TYPE and its fields:
  wrong_person   — the object belongs to someone else. fields: {"owner": "<name as said>"}
  move           — file it under a different space. fields: {"to_space_hint": "<space name as said>"}
  cancel         — the plan/task was cancelled (NOT completed). no fields.
  already_done   — it is complete. no fields.
  not_task       — this should never have been a task. no fields.
  not_true       — a claim is factually wrong. no fields.
  outdated       — a claim was true once but not anymore. no fields.
  stop_tracking  — stop capturing/deriving from this stream or object. no fields.
  merge_into     — merge this proposal/space into another. fields: {"into_hint": "<name as said>"}
  edit           — a field-level fix. fields: {"field": "<title|due|date|...>", "value": "<new value>"}
  none           — the utterance is not a correction (question, chit-chat). no fields.

Rules:
- Exactly one JSON object, one line, double-quoted keys, no trailing text.
- "cancelled"/"called off"/"not happening" => cancel, never already_done.
- "done"/"finished"/"booked it already" => already_done.
- Relationship/fact statements about a person or claim ("she's my cousin",
  "he moved to Pune") on a claim target => not_true or outdated with the new
  value carried via edit only when the user states one; otherwise not_true.
- When genuinely ambiguous, prefer the least destructive type.`;

/** All correction types v1 can emit. */
export const CORRECTION_TYPES = [
  "wrong_person",
  "move",
  "cancel",
  "already_done",
  "not_task",
  "not_true",
  "outdated",
  "stop_tracking",
  "merge_into",
  "edit",
  "none",
] as const;

export type CorrectionType = (typeof CORRECTION_TYPES)[number];

/** One parsed structured correction (the code-applicable shape). */
export interface ParsedCorrection {
  type: CorrectionType;
  owner?: string;
  to_space_hint?: string;
  into_hint?: string;
  field?: string;
  value?: string;
}

const TYPE_SET: ReadonlySet<string> = new Set(CORRECTION_TYPES);

/**
 * Parse the model's raw text into a ParsedCorrection, or null when nothing
 * usable came back (the caller then records the correction as pending rather
 * than inventing a mutation — FIX-01's "parse-to-nothing" is a recorded
 * failure, never a silent one).
 */
export function parseCorrectionOutput(raw: string): ParsedCorrection | null {
  // Take the first {...} block on any line; the contract is one line but a
  // fenced or prefixed answer should not cost the user their correction.
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
  if (typeof type !== "string" || !TYPE_SET.has(type)) return null;
  const out: ParsedCorrection = { type: type as CorrectionType };
  for (const key of ["owner", "to_space_hint", "into_hint", "field", "value"] as const) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}

/** Pack the variable half: the target object + the utterance. */
export function packCorrectionInput(target: { kind: string; id: string; state: unknown }, utterance: string): string {
  return [
    `TARGET kind=${target.kind} id=${target.id}`,
    `STATE ${JSON.stringify(target.state)}`,
    `UTTERANCE ${utterance}`,
  ].join("\n");
}
