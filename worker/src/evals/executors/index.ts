// ===========================================================================
// [CODE] Executor registration — the seam between the golden set and the
// product (evals doc §1, build item 0.6).
//
// Importing this module registers every executor that drives REAL product code.
// The runner deliberately does not import it: the registry has to work for a
// layer nobody has built yet, and a runner that reached for the layers would
// make "pending" impossible to distinguish from "broken".
//
// P0.3 pruned the V11 executors (sessions, episodes, arcs, claims, tiers, …)
// with the product code they drove. Only the STW-2 wire codec survives — the
// self-test set (evals/selftest) exercises it — and the V13 executors (P1.x)
// register here the same way. A layer absent from this list has no executor,
// so its category is PENDING and its gates read `no data`.
// ===========================================================================

import { registerExecutor } from "../runner.js";
import { wireExecutor } from "./wire.js";

export { wireExecutor };

/** Layer → executor, for the layers that have product code behind them today. */
export const PRODUCT_EXECUTORS = {
  wire: wireExecutor,
} as const;

for (const [layer, executor] of Object.entries(PRODUCT_EXECUTORS)) {
  registerExecutor(layer, executor);
}
