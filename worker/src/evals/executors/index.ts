// ===========================================================================
// [CODE] Executor registration — the seam between the golden set and the
// product (evals doc §1, build item 0.6).
//
// Importing this module registers every executor that drives REAL product code.
// The runner deliberately does not import it: the registry has to work for a
// layer nobody has built yet, and a runner that reached for the layers would
// make "pending" impossible to distinguish from "broken".
//
// A layer absent from this list has no executor, so its category is PENDING and
// its gates read `no data`. That is the honest report until the item that owns
// the layer lands and adds a line here.
// ===========================================================================

import { registerExecutor } from "../runner.js";
import { accountingExecutor } from "./accounting.js";
import { calibExecutor } from "./calib.js";
import { wireExecutor } from "./wire.js";

export { accountingExecutor, calibExecutor, wireExecutor };

/** Layer → executor, for the layers that have product code behind them today. */
export const PRODUCT_EXECUTORS = {
  wire: wireExecutor,
  accounting: accountingExecutor,
  calib: calibExecutor,
} as const;

for (const [layer, executor] of Object.entries(PRODUCT_EXECUTORS)) {
  registerExecutor(layer, executor);
}
