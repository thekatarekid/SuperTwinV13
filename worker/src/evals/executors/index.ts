// ===========================================================================
// [CODE] Executor registration — the seam between the golden set and the
// product (build P0.9).
//
// `registerProductExecutors()` wires every pass that has product code behind
// it today. The runner deliberately does not call it: the registry has to work
// for layers nobody has built yet, and a runner that reached for the layers
// would make PENDING indistinguishable from broken. The CLI calls it.
//
// Current wiring:
//   * `selftest.stub` — the deterministic self-test pass (always available).
//   * `bundle` (BND) and `gate` (GATE) — the V6 scheduler's code cases (S3.3).
//   * The V13 model passes (orient, extract, decide, …) register here as the
//     P1.x tasks land them, exactly the way BND does.
// ===========================================================================

import { setConsentGateMode } from "../../db/consent-gate.js";
import { assertEvalDbIsolated } from "../home.js";
import { registerExecutor } from "../runner.js";
import { bundleExecutor } from "./bnd.js";
import { gateExecutor } from "./gate.js";
import { orientExecutor } from "./orient.js";
import { criExecutor } from "./cri.js";
import {
  backfillExecutor,
  extractExecutor,
} from "./passes.js";
import { digExecutor } from "./dig.js";
import { tierExecutor } from "./tier.js";
import { assistExecutor } from "./assist.js";
import { stubExecutor } from "./stub.js";
import { sourceQualityExecutor } from "./src.js";
import { commitExecutor } from "./cmt.js";
import { packExecutor } from "./pck.js";
import { conExecutor } from "./con.js";
import { decideSpaceExecutor } from "./dec.js";
import { claimsExecutor } from "./fact.js";
import { liveExecutor } from "./liv.js";
import { calendarExecutor } from "./cal.js";
import { tskExecutor } from "./tsk.js";
import { spacesExecutor } from "./spc.js";
import { barExecutor, fixExecutor } from "./bar.js";
import {
  browserEvalExecutor,
  decideDispatchExecutor,
  exeExecutor,
  scheduleExecutor,
  timeExecutor,
} from "./p3.js";

export { bundleExecutor } from "./bnd.js";
export { gateExecutor } from "./gate.js";
export { criticExecutor, orientExecutor } from "./orient.js";
export { criExecutor } from "./cri.js";
export { conExecutor } from "./con.js";
export { calendarExecutor, timCode } from "./cal.js";
export { tskExecutor } from "./tsk.js";
export { spacesExecutor } from "./spc.js";
export { barExecutor, fixExecutor } from "./bar.js";
export {
  backfillExecutor,
  consolidateExecutor,
  decideExecutor,
  digestExecutor,
  extractExecutor,
} from "./passes.js";
export { assistExecutor } from "./assist.js";
export { stubExecutor } from "./stub.js";
export {
  browserEvalExecutor,
  decideDispatchExecutor,
  exeExecutor,
  scheduleExecutor,
  timeExecutor,
} from "./p3.js";
export {
  circlesExecutor,
  feedbackExecutor,
  tracesExecutor,
  userObjectsExecutor,
} from "./p4.js";

import { circlesExecutor, tracesExecutor, userObjectsExecutor } from "./p4.js";

export async function registerProductExecutors(): Promise<void> {
  // CONTAINMENT CHOKEPOINT. Almost every executor below seeds rows through
  // getDb(), and getDb() falls through to ~/SuperTwinV13/supertwinv13.db when
  // nothing sandboxes it — which is exactly how fixture events ("Rohan: villa
  // advance by 5pm", villas.example) reached a real user's Timeline. Wiring
  // these executors while pointed at the production DB is refused here, so the
  // leak cannot come back by someone forgetting the CLI's setup step.
  assertEvalDbIsolated("registerProductExecutors()");
  // The executors seed fixture events with no consent rows; they measure
  // passes, not the funnel. The consent gate (V6 S1.2) is asserted by the
  // CNS vitest suites, so the harness opens it here.
  setConsentGateMode("open");
  registerExecutor("selftest.stub", stubExecutor);
  // V6 P1 S3.3: BND (bundling) and GATE (the state gate) run against the real
  // scheduler/v6 code — cold window, day-bundler, dispatcher invariants, pool
  // lanes. Zero model calls.
  registerExecutor("bundle", bundleExecutor);
  registerExecutor("gate", gateExecutor);
  // P1.3: the Orient map pass + the Critic gate (TOP/ASN/CRE/CRI/ROL/AGE…).
  registerExecutor("orient", orientExecutor);
  // V6 P1 S3.5: CRI — structured §5.9 fixtures run the mechanical layer +
  // critic.v5 (CRI-04 is code: zero model calls); prose V1 fixtures fall
  // through to the legacy critic executor.
  registerExecutor("critic", criExecutor);
  // P1.4/P1.5/P1.6 (Phase 1 integration): the downstream passes.
  registerExecutor("extract", extractExecutor);
  // P3 integration: FUP cases run the real next-step pass (followup.v1);
  // everything else on "decide" is the DECIDE prompt as before.
  registerExecutor("decide", decideDispatchExecutor);
  // V6 P1 S3.9: CON / IDEM — structured code fixtures run the real T2/T3
  // consolidation with a stub judge (zero model calls); prose V1 fixtures fall
  // through to the legacy live consolidate executor.
  registerExecutor("consolidate", conExecutor);
  // V6 P1 S3.8: DIG — DIG-* fixtures run the real digest planner + digest.v2
  // pass (DIG-01 is code: canned provider-layer stub, zero live calls); every
  // other fixture on "digest" (CAT-*) keeps the legacy executor.
  registerExecutor("digest", digExecutor);
  // V6 P1 S3.8: TIER — tier assignment against tiers/tiering.ts + promote.ts
  // (TIER-01/02/04 code, zero model calls; TIER-03 one cached tier.v1 call).
  registerExecutor("tier", tierExecutor);
  registerExecutor("scheduler.backfill", backfillExecutor);
  // P2 integration: the assist lane (AST) — gate/suppression/risk-line cases
  // drive the product code directly; evaluator cases run the live prompt.
  registerExecutor("assist", assistExecutor);
  // P3 integration + gates: schedules/time through Decide + the code policy
  // gate, the real executor session, and the code-asserted browser harness.
  registerExecutor("schedule", scheduleExecutor);
  registerExecutor("time", timeExecutor);
  registerExecutor("executor", exeExecutor);
  registerExecutor("browser", browserEvalExecutor);
  // P4 gates: the grounded bar (USR), the People-view circle edit (CIR-04),
  // the person-card relationship correction (FIX-03) and the end-to-end
  // why?→trace chain (TRC-02).
  registerExecutor("user-objects", userObjectsExecutor);
  registerExecutor("circles", circlesExecutor);
  // V6 P1 S5.5: the feedback pass now dispatches by id — FIX-01..06 keep
  // running live through p4.ts's executor, FIX-07..09 are code (the "Not mine"
  // chip and its undo, the behavioral rule, the golden-case drafts).
  registerExecutor("feedback", fixExecutor);
  registerExecutor("traces", tracesExecutor);
  // V6 P1 S1.4: SRC source-quality code cases (URL text form, raw payload,
  // render-time collapse). Zero model calls.
  registerExecutor("source-quality", sourceQualityExecutor);
  // V6 P1 S3.1: CMT commit cases (explicit membership, one stream per
  // episode, per-item salvage, evidence, coverage) against the real
  // brain/commit.ts with canned Orient output. Zero model calls.
  registerExecutor("commit", commitExecutor);
  // V6 P1 S3.2: PCK pack cases (blocks, cap 5 / 104-space size, episode-bounded
  // history, quoted always, budgeted truncation, thin context, T0 only) against
  // the real packer/pack.ts. Zero model calls.
  registerExecutor("pack", packExecutor);
  // V6 P1 S3.7: DEC decide cases (stage routing, closures, check_at, ownership,
  // milestones only if staged, TIM-04 window) — canned decide.v9 output through
  // the real pass with a pinned clock. Zero model calls.
  registerExecutor("decide-space", decideSpaceExecutor);
  // V6 P1 S3.6: FACT / TYP claim cases (supersede vs coexist, self-reported
  // beats observed, ads/jokes/third-party rails, typed columns exact) against
  // the real brain/extract-pass.ts with recorded extract.v6 outputs. Zero
  // model calls.
  registerExecutor("claims", claimsExecutor);
  // V6 P1 S4.1: LIV live-call cases (the villa sentence, history never nudges,
  // grounding is this flush, section-independent parsing, the intent floor) —
  // recorded live.v1 output through the real tick (pack → live.v1 → critic →
  // commit → applyLiveDecide) with a pinned clock. Zero model calls.
  registerExecutor("live", liveExecutor);
  // V6 P1 S5.3: CAL calendar cases (tentative until confirmed, lead time by
  // circle, the March deadline, recurrence as a rule, layers separable)
  // against the real calendar/{clocks,store,layers}.ts. Zero model calls.
  registerExecutor("calendar", calendarExecutor);
  // V6 P1 S5.2: TSK / SCH / FUP task cases (prioritized sections with an
  // explained score, suggested marked and uncapped, the wait-until step, a
  // wake-up that reads before it calls, a slept-through fire executing with
  // its delay shown, follow-ups joining the plan) — against tasks/priority.ts,
  // tasks/closure-rules.ts, tasks/wakeups.ts and the real decide / next-step
  // passes on canned output. Zero model calls.
  registerExecutor("tasks", tskExecutor);
  // V6 P1 S5.1: SPC space cases (inferred birth in propose-only with the sweep
  // preview, asked-for never proposed, dedupe on user-created, woken with its
  // old evidence, the justifying utterance, graduation and its reset, the
  // weekly unsorted review on change only, enrichment on change only) — against
  // brain/commit.ts, spaces/* and consolidation/graduation.ts. Zero model calls.
  registerExecutor("space", spacesExecutor);
  // V6 P1 S5.5: BAR grounded-bar cases (type-ahead local and under budget, the
  // route classes, a lookup that cites hard, an aggregate that never comes
  // from the top-k, an absence over a WHOLE scan with its coverage caveat, a
  // partial that says partial, a labelled general answer, create-now with the
  // utterance on the hot stream, a follow-up that stays on the object, and
  // ask-once ambiguity) against the real bar, retrieval, sufficiency and route
  // code with every model seam injected. Zero model calls.
  registerExecutor("bar", barExecutor);
}
