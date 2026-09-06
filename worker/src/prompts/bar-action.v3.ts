// ===========================================================================
// [PROMPT] bar-action.v3 — bar utterance → structured action (V6 P1 S6 gate,
// spec §14.8.3, USR-01/02/03/05).
//
// v3 fixes the gap the S6 graduation sweep found, the same way v2 fixed v1's:
// a rule the model was told but never SHOWN.
//
// v2 says, correctly: "If two or more existing spaces could each plausibly
// claim it, DO NOT pick: list their ids in `space_candidates` instead — the
// code will ask the user once. Guessing wrong is worse than asking." The code
// behind that rule has been there since S5.5 (handlers.ts holds the object and
// returns `needs_input` + one-tap options the moment `space_candidates` has
// two resolvable ids).
//
// But v2's ONLY worked example is the unambiguous case, and it ends in a
// `space_hint`. So on "add task: buy sunscreen for goa", with BOTH "Goa trip
// in December" and "Goa wedding (Anika)" active, the model did what the one
// example showed and picked one — a coin flip. USR-03 failed on all three S6
// runs and took the HARD `guess_rate = 0` gate with it.
//
// v3 = v2's text with a second worked example: the ambiguous case, ending in
// `space_candidates` and no `space_hint`. Nothing else changes — same verbs,
// same fields, same parser, same one-line JSON contract. The parse and pack
// halves are still v1's, re-exported unchanged.
//
// v3 also hardens the output line the way S5 hardened P-12: the pass runs with
// `maxTurns: 1` (brain/llm.ts), so a Haiku preamble before the JSON spends the
// only turn and the call comes back as an error — which the bar surfaces as
// `status: "failed"`, USR-02's intermittent red. v3 says the first character
// must be "{" and says why.
//
// v2 stays in the tree and stays selectable: it is what the frozen USR numbers
// were measured on.
// ===========================================================================

export {
  BAR_ACTION_VERBS,
  packActionInput,
  parseActionOutput,
  type BarActionVerb,
  type ParsedBarAction,
} from "./bar-action.v1.js";

/** The versioned prompt id — names the trace, the runs row and the file. */
export const BAR_ACTION_V3_VERSION = "bar-action.v3";

export const BAR_ACTION_V3_INSTRUCTIONS = `You turn ONE action utterance into a structured plan the code can apply.

You are given the utterance, today's date, the user's existing spaces
(id + label), and a short sweep of related items retrieved from their history.

Output EXACTLY one JSON object on one line, double-quoted keys, no prose, no
code fences. Your FIRST character must be "{" and your last must be "}" — you
get ONE turn, so a sentence of preamble before the object spends it and the
answer is lost. The object ALWAYS has:
  "verb"  — one of create_space | create_task | remind | execute | other
  "title" — REQUIRED for every verb except "other": a short imperative label
            of the thing ("Hampi trek with the goa gang", "Renew car
            insurance", "Buy sunscreen for Goa", "Book option 2 for 18-21 Dec")
  "risky" — true for anything that sends a message, pays, books or commits
            on the user's behalf; false for purely internal changes.

Verbs and their extra fields:
  create_space — a new goal/project to plan ("plan a hampi trek…"). Also
                 draft the plan: "goal" (one line), "chapters" (2-4 short
                 labels like ["Travel","Stay","Gear"]), "first_tasks"
                 (1-3 task titles).
  create_task  — a discrete to-do ("add task: buy sunscreen").
  remind       — a reminder ("remind me to renew insurance next week") —
                 emit "due" as an absolute YYYY-MM-DD date resolved from
                 today's date.
  execute      — do a concrete thing now against existing context ("book the
                 2nd option", "send rohan the link"). Always risky:true when
                 it spends money or messages someone. Resolve the title from
                 the sweep when the utterance points at it ("the 2nd option").
  other        — none of the above.

Space filing — this is the field people get wrong, so read both examples:
- If ONE existing space clearly matches the ask, set "space_hint" to that
  space's id (match, never propose a duplicate space).
- If TWO OR MORE existing spaces could each plausibly claim it, DO NOT PICK
  ONE. Omit "space_hint" entirely and list their ids in "space_candidates".
  The code holds the object and asks the user once, with one tap per
  candidate. Guessing wrong is worse than asking. A shared word in two space
  labels ("goa", "wedding", "office") is exactly this case.

Example A — ONE space matches (utterance "remind me to renew car insurance
next week", today 2026-08-29, space sp_money "Money & renewals" exists):
{"verb":"remind","title":"Renew car insurance","due":"2026-09-05","risky":false,"space_hint":"sp_money"}

Example B — TWO spaces could claim it (utterance "add task: buy sunscreen for
goa", spaces sp_goa_dec "Goa trip in December" and sp_goa_wedding "Goa wedding
(Anika)" both exist). Note: NO "space_hint", both ids listed:
{"verb":"create_task","title":"Buy sunscreen for Goa","risky":false,"space_candidates":["sp_goa_dec","sp_goa_wedding"]}`;
