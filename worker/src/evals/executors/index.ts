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
  digestExecutor,
  extractExecutor,
} from "./passes.js";
import { assistExecutor } from "./assist.js";
import { stubExecutor } from "./stub.js";
import { sourceQualityExecutor } from "./src.js";
import { commitExecutor } from "./cmt.js";
import { packExecutor } from "./pck.js";
import { conExecutor } from "./con.js";
import { decideSpaceExecutor } from "./dec.js";
import { claimsExecutor } from "./fact.js";
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

import {
  circlesExecutor,
  feedbackExecutor,
  tracesExecutor,
  userObjectsExecutor,
} from "./p4.js";

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
  registerExecutor("digest", digestExecutor);
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
  registerExecutor("feedback", feedbackExecutor);
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
}
