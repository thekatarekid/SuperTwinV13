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
//   * `scheduler.dispatch` (BND) — registered ONLY when the scheduler rewrite
//     (P0.5, concurrent) has landed its eval hook; until then BND is PENDING.
//   * The V13 model passes (orient, extract, decide, …) register here as the
//     P1.x tasks land them, exactly the way BND does.
// ===========================================================================

import { assertEvalDbIsolated } from "../home.js";
import { registerExecutor } from "../runner.js";
import { bndExecutor, bndHookAvailable } from "./bnd.js";
import { criticExecutor, orientExecutor } from "./orient.js";
import {
  backfillExecutor,
  consolidateExecutor,
  digestExecutor,
  extractExecutor,
} from "./passes.js";
import { assistExecutor } from "./assist.js";
import { stubExecutor } from "./stub.js";
import {
  browserEvalExecutor,
  decideDispatchExecutor,
  exeExecutor,
  scheduleExecutor,
  timeExecutor,
} from "./p3.js";

export { bndExecutor, bndHookAvailable } from "./bnd.js";
export { criticExecutor, orientExecutor } from "./orient.js";
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
  registerExecutor("selftest.stub", stubExecutor);
  if (await bndHookAvailable()) {
    registerExecutor("scheduler.dispatch", bndExecutor);
  }
  // P1.3: the Orient map pass + the Critic gate (TOP/ASN/CRE/CRI/ROL/AGE…).
  registerExecutor("orient", orientExecutor);
  registerExecutor("critic", criticExecutor);
  // P1.4/P1.5/P1.6 (Phase 1 integration): the downstream passes.
  registerExecutor("extract", extractExecutor);
  // P3 integration: FUP cases run the real next-step pass (followup.v1);
  // everything else on "decide" is the DECIDE prompt as before.
  registerExecutor("decide", decideDispatchExecutor);
  registerExecutor("consolidate", consolidateExecutor);
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
}
