// ===========================================================================
// decide.v6 — the DECIDE pass prompt (Phase 1 gate remediation, round 2c).
//
// The spec §8.4 core is UNCHANGED (verbatim via v1). v6 keeps v5's rules and
// closes the r6 residue: another person's action yields no task in ANY
// owner's name — only the one monitoring item (TSK-04); the recurring
// template example lives in the OUTPUT SHAPE itself so the schedules entry
// carries it (TSK-10); entailed transport is approve-final/auto, never
// advise-only (TSK-02).
// ===========================================================================

import { DECIDE_V1_CORE } from "./decide.v1.js";

export { DECIDE_V1_CORE as DECIDE_V6_CORE };

export const DECIDE_V6_ID = "decide.v6";

export const DECIDE_V6_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
{"space":"sp_x",
 "chapters":[{"id":"existing ch_ id or null","label":"Flights","status":"active",
   "episodes":["ep_412"],"target":"2026-08-29"}],
 "tasks":[{"title":"…","type":"explicit","category":"transaction",
   "risk_class":"approve-final","owner":"self","chapter":"Flights",
   "due":"2026-08-29","evidence":[{"event_ids":["e1"],"quote":"…"}],
   "confidence":0.9}],
 "schedules":[{"task":"…","fire_at":"2026-12-16T07:00+05:30","mode":"auto",
   "reason":"…"},
  {"task":"Pay rent","fire_at":"2026-09-01T09:00+05:30","mode":"confirm",
   "reason":"recurring template — monthly, anchor the 1st"}],
 "closures":[{"task":"tsk_x or exact task title","verdict":"close",
   "outcome":"done","reason":"…","confidence":0.9}],
 "followups":[{"title":"…","because":"…"}],
 "plan":{"next":["…"]}}
closures.verdict is "close" or "suggest_close"; closures.outcome is "done" or
"cancelled". Use empty arrays for sections with nothing to say; plan may be
null when nothing materially changed.
Hard rules:
- OWNERSHIP: a task belongs to the person it is addressed to. When the
  message names another person as the doer ("karan book YOUR ticket"),
  that is THEIR task — emit NO tasks[] entry for the action itself, in
  ANYONE's name (a task with owner "karan" is still task-theft). The
  ONLY permissible output is one monitoring item: owner "self",
  category "monitoring", risk_class "advise-only", title naming the
  person ("Karan's ticket pending"). "your"/"you" bind to the named
  addressee, never to the user by default.
- COMMITMENT: an open question ("should we…?") or idea yields NO
  tasks[] entry AT ALL until someone commits — not even a "decide on
  X" task. It goes in plan.next (or followups) as an open discussion
  item. Marketing/promotional content never yields a task.
- REINFORCE, DON'T CLONE: when the new events nag or ask about a task
  LISTED OPEN in the state ("flights book hue kya??"), emit NO new
  task — the urgency bump and fresh evidence land in plan.next naming
  that existing task (optionally a followup nudge). A duplicate task
  for a listed action is task-mitosis.
- CLOSURE FIRST: when the new events talk about DOING or having done a
  task that is LISTED OPEN in the state, the output is a closures
  entry for that task id — NEVER a new task for the same action.
  Verdict "close" needs two-sided or hard evidence (both parties
  confirm, or an artifact: ticket, receipt, confirmation). One-sided
  intent ("paying tonight pakka", "done na?" unanswered) =>
  {"verdict":"suggest_close","confidence":<=0.6} and the task stays
  open. When in doubt, no closure at all.
- PARTIAL PROGRESS: work half-done (2 of 4 booked) keeps the ORIGINAL
  task open — update plan.next with the progress state ("2/4 booked;
  Karan and Rohan pending") — never a closure, never a fresh
  replacement task for the remainder.
- CHAPTERS: group this space's episodes by SUB-GOAL TOPIC across
  streams and sources (chat + browser evidence of one sub-goal = one
  chapter). Never one chapter per episode, never one per stream, never
  one catch-all chapter when distinct sub-goals are visible. When new
  events show a chapter's goal achieved (booking confirmed), set that
  chapter's status "done" — the chapter IS the milestone; no separate
  milestone object exists.
- ENTAILMENT: do emit the implicit tasks a committed plan requires (an
  early-morning flight entails ~pre-dawn airport transport, category
  scheduling; a booking entails its payment) — clearly typed
  "implicit". Risk for entailed work follows the action: BOOKING the
  cab is approve-final, RESEARCHING options is auto — advise-only is
  only for what the user alone can physically do.
- RISK BY ACTION: anything moving money (pay/renew/book) =
  approve-final. Drafting text = auto; SENDING it = approve-final.
  Read-only research = auto. A physical errand only the user can do =
  advise-only.
- SUGGESTIONS: any task the user never asked for — a plan-gap filler,
  a stalled-milestone reminder, an idea from the system — is ALWAYS
  type "suggested" (never "explicit"/"implicit"), at most ONE per
  trigger, gentle: the known facts (price, stock, expiring holds), NO
  urgency, never repeated.
- RECURRENCE: a repeating pattern in the claims (monthly rent, annual
  renewal) emits BOTH (a) the recurring TEMPLATE as a schedules entry
  whose reason MUST begin "recurring template — <cadence>, anchor
  <day>" (e.g. "recurring template — monthly, anchor the 1st"), and
  (b) ONE task instance for the NEXT upcoming window, due on a FUTURE
  date from the calendar block. Never a task dated in the past, never
  a bare one-off.
- DATES: resolve every relative date with the [CALENDAR] block against
  the MESSAGE timestamp (never today's date). Worked examples: message
  Mon 2026-08-24, "by friday" -> that week's Friday 2026-08-28;
  message Tue 2026-08-25, "by day after" -> day after tomorrow =
  2026-08-27. Emit absolute dates only.`;

export const DECIDE_V6_SYSTEM = `${DECIDE_V1_CORE}\n\n${DECIDE_V6_OUTPUT}`;
