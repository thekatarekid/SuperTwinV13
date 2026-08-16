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
import { arcsExecutor } from "./arcs.js";
import { bridgesExecutor } from "./bridges.js";
import { calibExecutor } from "./calib.js";
import { edgesExecutor } from "./edges.js";
import { entitiesExecutor } from "./entities.js";
import { episodesExecutor } from "./episodes.js";
import { enrichmentExecutor } from "./enrichment.js";
import { ingestExecutor } from "./ingest.js";
import { mentionsExecutor } from "./mentions.js";
import { partyExecutor } from "./party.js";
import { promotionExecutor } from "./promotion.js";
import { schedulerExecutor } from "./scheduler.js";
import { sessionsExecutor } from "./sessions.js";
import { tiersExecutor } from "./tiers.js";
import { wireExecutor } from "./wire.js";
import { writeExecutor } from "./write.js";

export {
  accountingExecutor,
  arcsExecutor,
  bridgesExecutor,
  calibExecutor,
  edgesExecutor,
  entitiesExecutor,
  episodesExecutor,
  ingestExecutor,
  mentionsExecutor,
  partyExecutor,
  promotionExecutor,
  schedulerExecutor,
  sessionsExecutor,
  tiersExecutor,
  wireExecutor,
  writeExecutor,
};

/** Layer → executor, for the layers that have product code behind them today. */
export const PRODUCT_EXECUTORS = {
  ingest: ingestExecutor,
  enrichment: enrichmentExecutor,
  tiers: tiersExecutor,
  party: partyExecutor,
  promotion: promotionExecutor,
  sessions: sessionsExecutor,
  scheduler: schedulerExecutor,
  entities: entitiesExecutor,
  mentions: mentionsExecutor,
  edges: edgesExecutor,
  episodes: episodesExecutor,
  bridges: bridgesExecutor,
  arcs: arcsExecutor,
  wire: wireExecutor,
  accounting: accountingExecutor,
  calib: calibExecutor,
  write: writeExecutor,
} as const;

for (const [layer, executor] of Object.entries(PRODUCT_EXECUTORS)) {
  registerExecutor(layer, executor);
}
