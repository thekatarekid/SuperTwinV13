// ===========================================================================
// followup.v1 — the NEXT-STEP pass prompt (build P3.1, spec §11.3).
//
// Triggered when a task just closed: (a) executor completion, (b) closure
// detection seeing the USER completed something. Input: the space plan +
// chapter state + what closed. Output: the 1–2 most helpful next tasks, each
// with visible provenance ("because: flights booked ✓"). The auto/confirm
// policy for any inline schedule is enforced IN CODE (schedule-policy.ts) —
// this prompt only proposes.
// ===========================================================================

import { RISK_CLASSES, TASK_CATEGORIES } from "./decide.v1.js";
import type { DecideFollowupV8 } from "./decide.v8.js";
import { validateDecideV8Output } from "./decide.v8.js";

export const FOLLOWUP_V1_ID = "followup.v1";

export const FOLLOWUP_V1_SYSTEM = `A task in ONE space just closed. You see the space's plan, its
chapters, its open tasks, and the closed task with how it closed.
Propose the 1-2 MOST HELPFUL next tasks from the plan - and often the
right answer is NONE:
- A trivial closure (a reply sent, a small errand done) gets NO
  follow-up. Not every closure deserves a next step.
- Never re-propose work that is already open, already done, or that
  the user just did themselves (they booked it - do not propose
  booking it).
- Each follow-up carries "because": the closed task's contribution,
  stated plainly ("flights booked ✓"). Provenance is visible, always.
- Category from: ${TASK_CATEGORIES.join("|")}. Risk class from:
  ${RISK_CLASSES.join("|")} - conservative: anything moving money or
  messaging people is never auto. Recurring commitments are ALWAYS
  confirm-mode suggestions.
- When a follow-up has a computable time window, attach a "schedule"
  object ({fire_at, recurrence, mode, polling?, reason}) with the
  derivation shown in its reason. mode=auto only for auto-class,
  high-confidence, time-bound checks; else confirm.
JSON only.

OUTPUT SHAPE (one JSON object, nothing else):
{"followups":[{"title":"Web check-in CCU-GOI","because":"flights booked ✓",
  "category":"scheduling","risk_class":"auto","due":"2026-12-16",
  "confidence":0.85,
  "schedule":{"task":"Web check-in CCU-GOI",
    "fire_at":"2026-12-16T07:00+05:30","mode":"auto",
    "reason":"check-in opens T-48h before the 18 Dec 07:00 departure"}}]}
Use {"followups":[]} when nothing genuinely helps.`;

export interface FollowupOutput {
  followups: DecideFollowupV8[];
}

/**
 * Validate the next-step output: reuse the v8 follow-up parsing by wrapping
 * the object into a full Decide shape. Throws when the top level is wrong.
 */
export function validateFollowupOutput(parsed: unknown): FollowupOutput {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a single JSON object with a "followups" array');
  }
  const root = parsed as Record<string, unknown>;
  const wrapped = validateDecideV8Output({
    chapters: [],
    tasks: [],
    schedules: [],
    closures: [],
    followups: Array.isArray(root.followups) ? root.followups : [],
    plan: null,
  });
  return { followups: wrapped.followups };
}
