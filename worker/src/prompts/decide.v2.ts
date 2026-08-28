// ===========================================================================
// decide.v2 — the DECIDE pass prompt (Phase 1 gate remediation, cycle 2).
//
// The spec §8.4 core is UNCHANGED (verbatim, re-exported from v1). v2 extends
// only the appended output contract with the hard rules the golden run's
// failure modes named: task-theft (TSK-04), eager-tasker (TSK-05), missing
// entailed tasks (TSK-02), ad-task (TSK-09), eager-close/false-victory
// (CLS-02/05 — false_auto_close is a zero-tolerance gate), and
// recurrence-blindness (AGE-02).
// ===========================================================================

import { DECIDE_V1_CORE } from "./decide.v1.js";

export { DECIDE_V1_CORE as DECIDE_V2_CORE };

export const DECIDE_V2_ID = "decide.v2";

/** v2 output contract (the spec §8.4 example, pinned as a schema). */
export const DECIDE_V2_OUTPUT = `OUTPUT SHAPE (one JSON object, nothing else):
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
- CLOSURE EVIDENCE: verdict "close" requires two-sided or hard
  evidence (both parties confirm, or an artifact: ticket, receipt,
  confirmation). One-sided intent, "will do tonight", or a
  similar-but-different purchase is "suggest_close" at most.
- RECURRENCE: a repeating annual/quarterly/monthly pattern becomes a
  recurring template (a schedules entry whose reason names the
  cadence) with the NEXT window as fire_at — never a task dated in the
  past.`;

export const DECIDE_V2_SYSTEM = `${DECIDE_V1_CORE}\n\n${DECIDE_V2_OUTPUT}`;
