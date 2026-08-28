// ===========================================================================
// [PROMPT] bar-action.v1 — bar utterance → structured action (build P4.1,
// spec §14.8.3, USR-01/02/05).
//
// Actions follow task rules: the bar is a faster front door, never a side
// door around approvals. This prompt only PARSES the ask into a structured
// form; grounded/handlers.ts applies it through the normal object paths —
// user-created spaces go ACTIVE with sweep + plan, tasks file into existing
// spaces (match, not new — USR-02), ambiguity asks once (USR-03), and any
// risky verb keeps its risk class so execution stays behind the approval
// gate (risky_without_token = 0).
//
// Output contract: ONE JSON object on one line:
//   {"verb":"create_space"|"create_task"|"remind"|"execute"|"other",
//    "title":"…", "space_hint":"…"?, "due":"YYYY-MM-DD"?, "risky":bool,
//    "goal":"…"?, "chapters":["…"]?, "first_tasks":["…"]?}
// ===========================================================================

/** The versioned prompt id — names the trace, the runs row and the file. */
export const BAR_ACTION_VERSION = "bar-action.v1";

export const BAR_ACTION_INSTRUCTIONS = `You turn ONE action utterance into a structured plan the code can apply.

You are given the utterance, today's date, the user's existing spaces
(id + label), and a short sweep of related items retrieved from their history.

Verbs:
  create_space — a new goal/project to plan ("plan a hampi trek…"). Also
                 draft the plan: "goal" (one line), "chapters" (2-4 short
                 labels like Travel/Stay/Gear), "first_tasks" (1-3 titles).
  create_task  — a discrete to-do ("add task: buy sunscreen").
  remind       — a reminder ("remind me to renew insurance next week") —
                 emit "due" as an absolute YYYY-MM-DD date resolved from
                 today's date.
  execute      — do a concrete thing now against existing context ("book the
                 2nd option", "send rohan the link"). Always risky:true when
                 it spends money or messages someone.
  other        — none of the above.

Rules:
- If an EXISTING space clearly matches the ask, set "space_hint" to that
  space's id (match, never propose a duplicate space).
- If two existing spaces could both match, list both ids in
  "space_candidates" instead of guessing — the code will ask the user once.
- "risky": true for anything that sends a message, pays, books or commits
  on the user's behalf; false for purely internal changes.
- Output EXACTLY one JSON object on one line, double-quoted keys, no prose.`;

export const BAR_ACTION_VERBS = [
  "create_space",
  "create_task",
  "remind",
  "execute",
  "other",
] as const;

export type BarActionVerb = (typeof BAR_ACTION_VERBS)[number];

const VERB_SET: ReadonlySet<string> = new Set(BAR_ACTION_VERBS);

/** One parsed structured action (the code-applicable shape). */
export interface ParsedBarAction {
  verb: BarActionVerb;
  title: string;
  space_hint?: string;
  space_candidates?: string[];
  due?: string;
  risky: boolean;
  goal?: string;
  chapters?: string[];
  first_tasks?: string[];
}

/**
 * Parse the model's raw text into a ParsedBarAction, or null when nothing
 * usable came back — the caller then answers honestly ("couldn't work out
 * what to do") instead of inventing a mutation.
 */
export function parseActionOutput(raw: string): ParsedBarAction | null {
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
  const verb = rec.verb;
  const title = rec.title;
  if (typeof verb !== "string" || !VERB_SET.has(verb)) return null;
  if (typeof title !== "string" || title.trim() === "") return null;
  const out: ParsedBarAction = {
    verb: verb as BarActionVerb,
    title: title.trim(),
    risky: rec.risky === true,
  };
  for (const key of ["space_hint", "due", "goal"] as const) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  for (const key of ["space_candidates", "chapters", "first_tasks"] as const) {
    const v = rec[key];
    if (Array.isArray(v)) {
      const strings = v.filter((x): x is string => typeof x === "string" && x.length > 0);
      if (strings.length > 0) out[key] = strings;
    }
  }
  return out;
}

/** Pack the variable half: utterance + date + spaces + sweep context. */
export function packActionInput(input: {
  text: string;
  today: string;
  spaces: readonly { id: string; label: string }[];
  sweep: readonly string[];
}): string {
  return [
    `TODAY ${input.today}`,
    `SPACES ${JSON.stringify(input.spaces)}`,
    input.sweep.length > 0 ? `RELATED\n${input.sweep.join("\n")}` : "RELATED (none)",
    `UTTERANCE ${input.text}`,
  ].join("\n");
}
