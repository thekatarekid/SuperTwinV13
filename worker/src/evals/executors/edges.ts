// ===========================================================================
// [CODE] Category I — EDGES (build item 1.5).
//
// Seven kinds, closed subtypes, metadata edges that cost nothing, and
// contradictions that close an edge rather than delete it. The `edges` bucket
// this reports is built straight out of `entity_edges` and `edge_evidence`, so
// an expectation naming a quote is asserting that the quote really is stored
// against the event it came from.
// ===========================================================================

import { runEntityCase } from "./entity-script.js";
import type { Executor } from "../runner.js";

export const edgesExecutor: Executor = ({ fixture, response }) => runEntityCase(fixture, response);
