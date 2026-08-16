// ===========================================================================
// [CODE] Category H — MENTIONS (build item 1.5, feeding build item 1.10).
//
// A mention is a text span pointing at an entity. The [CODE] half of that —
// exact roster hits, the alias table, the hint that stands in for a referent
// nobody can name, and the question two live candidates raise — is what this
// executor drives. The model half arrives as a frozen P-EP1 answer below the
// `#WIRE` line and is applied through the real parser, so the seam the live
// runner swaps is the same one exercised here.
//
// UNKNOWN BEATS WRONG is the assertion behind most of these rows: a mention
// with no entity and a hint is a PASS, and a mention with a guessed entity is
// a failure even when the guess happens to be right.
// ===========================================================================

import { runEntityCase } from "./entity-script.js";
import type { Executor } from "../runner.js";

export const mentionsExecutor: Executor = ({ fixture, response }) => runEntityCase(fixture, response);
