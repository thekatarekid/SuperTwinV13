// ===========================================================================
// [CODE] Per-step on/off — the one place the "a step turned off QUEUES, never
// drops" rule (Product_V6 §25 Intelligence; GoldenEvals V6 P1 SET-01) is
// decided (V6 P1 S5.6).
//
// Settings › Intelligence persists `process_enabled_<step>` = "0" | "1". The
// dispatcher asks `laneStepEnabled(lane)` before it hands a bundle to a sink:
// a lane whose entry step is off returns "held" — the events stay
// `dispatched_at IS NULL`, the live accumulator keeps them, the history and
// digest planners keep offering them — and the next tick after the step is
// switched back on dispatches exactly what was waiting. Nothing is stamped,
// nothing is dead-lettered, no model call is made while the step is off.
//
// The step KEYS are the live pass ids the traced runners spend under
// (`orient`, `extract`, `decide`, `digest`, …): a picker keyed on anything
// else would be a setting nothing reads (the 13.9 build keyed Orient as
// `orient.v6` while the runner asked app_state for `selected_model_orient`).
// ===========================================================================

import { getDb } from "../db/connection.js";

export const PROCESS_ENABLED_PREFIX = "process_enabled_";

export type Lane = "live" | "history" | "digest";

/** The step that opens each lane: understanding lanes start at Orient, the digest lane at Digest. */
export const LANE_STEP: Readonly<Record<Lane, string>> = {
  live: "orient",
  history: "orient",
  digest: "digest",
};

/** How long a live bundle held for a switched-off step waits before it is offered again. */
export const STEP_OFF_HOLD_MS = 30_000;

/** True unless Settings has persisted "0" for the step. No database reads as on. */
export function isStepEnabled(step: string): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM app_state WHERE key = ?`)
      .get(`${PROCESS_ENABLED_PREFIX}${step}`) as { value: string | null } | undefined;
    return row?.value !== "0";
  } catch {
    return true;
  }
}

export function laneStepEnabled(lane: Lane): boolean {
  return isStepEnabled(LANE_STEP[lane]);
}

// ---- Which golden categories a step's change re-runs -----------------------
//
// "A model change runs the golden set first" (Product_V6 §9.5, §25; SET-02).
// The whole set is hours of model spend; the categories a step actually
// answers for are what its change can regress. Unknown step → the full set.

export const STEP_EVAL_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  orient: ["TOP", "ASN", "CRE", "ROL", "AGE", "CMT", "CROSS"],
  critic: ["CRI"],
  extract: ["CLM", "FACT", "TYP", "ROL"],
  decide: ["TSK", "CLS", "CHP", "FUP", "SCH", "DEC", "TIM"],
  digest: ["DIG", "CAT"],
  consolidate: ["CON", "IDEM"],
  assist: ["AST"],
  executor: ["EXE", "BRW"],
  chat: ["USR", "FIX", "TRC"],
  tier: ["TIER"],
};

export function evalCategoriesForStep(step: string): readonly string[] | null {
  return STEP_EVAL_CATEGORIES[step] ?? null;
}
