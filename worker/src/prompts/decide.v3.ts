// ===========================================================================
// decide.v3 — the DECIDE pass prompt (Phase 1 gate remediation, cycle 3).
//
// The spec §8.4 core is UNCHANGED (verbatim via v1). v3 sharpens the appended
// rules that the r3 run still breached: eager-close survived v2's prose rule
// (CLS-02 — the zero-tolerance false_auto_close gate), partial progress was
// re-cut as a fresh task (CLS-04), and suggestions rode followups untyped
// (TSK-03). Each now has an operational example, not just a rule.
// ===========================================================================

import { DECIDE_V1_CORE } from "./decide.v1.js";

export { DECIDE_V1_CORE as DECIDE_V3_CORE };

export const DECIDE_V3_ID = "decide.v3";

export const DECIDE_V3_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
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
- OWNERSHIP: a task belongs to the person it is addressed to. An
  instruction aimed at someone else NEVER lands on the user's list —
  at most a monitoring item naming that person. "your"/"you" refer to
  the message's receiver, not the user.
- COMMITMENT: an open question ("should we…?") or idea is NOT a task
  until someone commits. Marketing/promotional content never yields a
  task or preference.
- ENTAILMENT: do emit the implicit tasks a committed plan logistically
  requires (an early-morning flight entails the airport transport; a
  booking entails its payment) — clearly typed "implicit".
- SUGGESTIONS go in tasks[] with type "suggested" (never as untyped
  followups), at most 2 per day per space.
- CLOSURE EVIDENCE: verdict "close" requires two-sided or hard
  evidence (both parties confirm, or an artifact: ticket, receipt,
  confirmation). "I'll do it tonight" / "done na?" with no reply /
  a similar-but-different purchase => {"verdict":"suggest_close",
  "confidence":<=0.6} and the task STAYS OPEN. When in doubt, do not
  emit a closure at all.
- PARTIAL PROGRESS: work half-done (2 of 4 booked) keeps the ORIGINAL
  task open with its plan updated — never a closure, never a fresh
  replacement task for the remainder.
- RECURRENCE: a repeating annual/quarterly/monthly pattern becomes a
  recurring template (a schedules entry whose reason names the
  cadence) with the NEXT window as fire_at — never a task dated in the
  past.`;

export const DECIDE_V3_SYSTEM = `${DECIDE_V1_CORE}\n\n${DECIDE_V3_OUTPUT}`;
