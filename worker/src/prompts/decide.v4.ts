// ===========================================================================
// decide.v4 — the DECIDE pass prompt (Phase 1 gate remediation, round 2).
//
// The spec §8.4 core is UNCHANGED (verbatim via v1). v4 sharpens what the r4
// run still breached: completion talk about a LISTED open task must become a
// closure entry, never a new task (CLS-02 — the zero-tolerance
// false_auto_close gate measures this); chapters group cross-stream by topic
// and complete on milestones (CHP-01/03); recurring patterns emit the
// template + instance pair (TSK-10/AGE-02); date arithmetic uses the packed
// calendar block (TSK-01/06); risk classes get the draft-vs-send and errand
// examples (TSK-07).
// ===========================================================================

import { DECIDE_V1_CORE } from "./decide.v1.js";

export { DECIDE_V1_CORE as DECIDE_V4_CORE };

export const DECIDE_V4_ID = "decide.v4";

export const DECIDE_V4_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
{"space":"sp_x",
 "chapters":[{"id":"existing ch_ id or null","label":"Flights","status":"active",
   "episodes":["ep_412"],"target":"2026-08-29"}],
 "tasks":[{"title":"…","type":"explicit","category":"transaction",
   "risk_class":"approve-final","owner":"self","chapter":"Flights",
   "due":"2026-08-29","evidence":[{"event_ids":["e1"],"quote":"…"}],
   "confidence":0.9}],
 "schedules":[{"task":"…","fire_at":"2026-12-16T07:00+05:30","mode":"auto",
   "reason":"…"}],
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
  that is THEIR task — the user's list gets NO task; at most one
  monitoring item naming that person. "your"/"you" bind to the named
  addressee, never to the user by default.
- COMMITMENT: an open question ("should we…?") or idea is NOT a task
  until someone commits — it stays in plan/followups as a discussion
  item. Marketing/promotional content never yields a task.
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
  "implicit".
- RISK BY ACTION: anything moving money (pay/renew/book) =
  approve-final. Drafting text = auto; SENDING it = approve-final.
  Read-only research = auto. A physical errand only the user can do =
  advise-only.
- SUGGESTIONS: type "suggested", at most ONE per trigger, gentle — a
  decision reminder with the known facts (price, stock), NO due date,
  no urgency, never repeated.
- RECURRENCE: a repeating pattern in the claims (monthly rent, annual
  renewal) emits BOTH (a) a recurring template as a schedules entry —
  reason names the cadence and anchor ("monthly, the 1st" / "annual,
  mid-Sept") — and (b) ONE task instance for the NEXT upcoming window,
  due on a FUTURE date from the calendar block. Never a task dated in
  the past, never a bare one-off.
- DATES: resolve every relative date ("friday", "day after") with the
  [CALENDAR] block against the message timestamp; emit absolute dates.`;

export const DECIDE_V4_SYSTEM = `${DECIDE_V1_CORE}\n\n${DECIDE_V4_OUTPUT}`;
