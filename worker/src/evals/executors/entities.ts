// ===========================================================================
// [CODE] Category G — IDENTITY (build item 1.5).
//
// Binding, cross-source joins, merges and negative pairs, all through the real
// `entities/` modules over a real temp DB. `frozen_response` is a [CODE] script
// (see `entity-world.ts`); the six P-AG1 rows additionally carry a frozen
// `V|…` verdict below a `#WIRE` line, which the real STW-2 parser reads and the
// real ladder applies.
//
// Nothing in this file decides anything. If a case passes, `binding.ts`,
// `identities.ts` and `merge.ts` are what passed it.
// ===========================================================================

import { runEntityCase } from "./entity-script.js";
import type { Executor } from "../runner.js";

export const entitiesExecutor: Executor = ({ fixture, response }) => runEntityCase(fixture, response);
