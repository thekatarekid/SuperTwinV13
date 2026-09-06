// ===========================================================================
// nudgeVerdict — the OUTPUT-side verdict (V6 Phase 1, S4.4; Build §7.1
// "Behavioural thresholds move to settings.ts and the output-side
// nudgeVerdict()"; Product_V6_Phase1 §18.4–18.5).
//
// WHAT REPLACED WHAT. The retiring `assist/` lane decided at the INPUT: a
// topic accumulated novelty until `gateVerdict()` said "worth a call", and
// cooldown / suppression / quiet hours could stop the work from ever being
// done. The V6 P1 lane inverts that. The work is done because the state gate
// (S3.3) says this flush matters; what is left to decide is what the finished
// thing earns on screen. That is this function, and it runs on the OUTPUT:
//
//   prepared action (brain/live.ts)  ─► nudgeVerdict ─► "card" | "shelf"
//   routed item     (surfaces/router) ─► nudgeVerdict ─► + "blocked"
//
// ONE SET OF THRESHOLDS. Both callers read `assistP1Settings()`
// (settings/p1-settings.ts, Settings › Assist) through `nudgeThresholds()`.
// Before S4.4 they did not: brain/live.ts read `assist.intent_confidence_min`
// with a 0.7 default and the router read the SAME app_state key with a 0.6
// default, so an action at 0.65 was shelved by one and carded by the other.
// The floor now has exactly one default (spec §10.1: 0.7) and one reader.
//
// WHAT IT IS NOT. It is not "whether to nudge at all" in the router's sense —
// the router still decides WHERE and never withholds (`router_withheld = 0`).
// "blocked" is the one kind-level refusal Product §18.5 grants the user ("do
// not do this again"), it is reversible from Settings, and the item is still
// filed in its space and on the timeline. There is no cap, no cooldown and no
// quiet-hours hold here, by design.
//
// No model call, no database write: a verdict is a pure function of the item
// and the settings row. The caller records it (a decisions row, or the
// prepared action's `surface`).
// ===========================================================================

import { assistP1Settings } from "../settings/p1-settings.js";

/** What a finished item earns. "card" is the only one the user is shown now. */
export type NudgeSurfaceVerdict = "card" | "shelf" | "blocked";

export interface NudgeThresholds {
  /** Below this intent confidence a card would name the wrong goal (LIV-06). */
  intentFloor: number;
  /** Kinds the user turned off, reversibly (NUD-08). */
  blockedKinds: readonly string[];
}

export interface NudgeCandidate {
  /** One of the six prepared kinds; anything else is housekeeping. */
  kind: string;
  intentConfidence: number;
}

export interface NudgeDecision {
  verdict: NudgeSurfaceVerdict;
  /** The line that goes in the decisions row — always says why. */
  reason: string;
  /** Convenience for the writer: the two surfaces a prepared row can carry. */
  surface: "card" | "shelf";
}

/** The behavioural thresholds, from Settings › Assist. Never throws. */
export function nudgeThresholds(): NudgeThresholds {
  try {
    const s = assistP1Settings();
    return { intentFloor: s.intent_floor, blockedKinds: s.blocked_kinds };
  } catch {
    // No database (a unit test, first boot): the spec defaults stand.
    return { intentFloor: DEFAULT_NUDGE_INTENT_FLOOR, blockedKinds: [] };
  }
}

/** Spec §10.1. Mirrored by settings/p1-settings.ts `DEFAULT_INTENT_FLOOR`. */
export const DEFAULT_NUDGE_INTENT_FLOOR = 0.7;

/**
 * The verdict for one finished item. Order matters: a blocked kind is blocked
 * however confident it is, and confidence only ever decides card-versus-shelf
 * — it never drops the work.
 */
export function nudgeVerdict(item: NudgeCandidate, t: NudgeThresholds = nudgeThresholds()): NudgeDecision {
  if (t.blockedKinds.includes(item.kind)) {
    return {
      verdict: "blocked",
      surface: "shelf",
      reason: `"${item.kind}" is in Settings › Assist › blocked kinds — filed, never nudged (reversible)`,
    };
  }
  if (!(item.intentConfidence >= t.intentFloor)) {
    return {
      verdict: "shelf",
      surface: "shelf",
      reason: `intent confidence ${item.intentConfidence} below the floor ${t.intentFloor} — shelved, no card`,
    };
  }
  return { verdict: "card", surface: "card", reason: `intent confidence ${item.intentConfidence} at or above the floor ${t.intentFloor}` };
}
