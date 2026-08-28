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

import { registerExecutor } from "../runner.js";
import { bndExecutor, bndHookAvailable } from "./bnd.js";
import { criticExecutor, orientExecutor } from "./orient.js";
import {
  backfillExecutor,
  consolidateExecutor,
  decideExecutor,
  digestExecutor,
  extractExecutor,
} from "./passes.js";
import { stubExecutor } from "./stub.js";

export { bndExecutor, bndHookAvailable } from "./bnd.js";
export { criticExecutor, orientExecutor } from "./orient.js";
export {
  backfillExecutor,
  consolidateExecutor,
  decideExecutor,
  digestExecutor,
  extractExecutor,
} from "./passes.js";
export { stubExecutor } from "./stub.js";

export async function registerProductExecutors(): Promise<void> {
  registerExecutor("selftest.stub", stubExecutor);
  if (await bndHookAvailable()) {
    registerExecutor("scheduler.dispatch", bndExecutor);
  }
  // P1.3: the Orient map pass + the Critic gate (TOP/ASN/CRE/CRI/ROL/AGE…).
  registerExecutor("orient", orientExecutor);
  registerExecutor("critic", criticExecutor);
  // P1.4/P1.5/P1.6 (Phase 1 integration): the downstream passes.
  registerExecutor("extract", extractExecutor);
  registerExecutor("decide", decideExecutor);
  registerExecutor("consolidate", consolidateExecutor);
  registerExecutor("digest", digestExecutor);
  registerExecutor("scheduler.backfill", backfillExecutor);
}
