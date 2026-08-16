// ===========================================================================
// [CODE] Category S executor — the real STW-2 codec (worker/src/wire).
//
// Category S is `[CODE]`: there is no model in the loop, so `frozen_response`
// is simply the bytes a model would have emitted and the executor is the
// production parser. Nothing here re-implements the codec; every number below
// comes back out of `parseWire`.
//
// The parser must never throw — that is a §14.2 gate — so everything it
// dislikes comes back as a violation COUNT, not an exception. Two totality
// probes (`parseWire(null)`, `parseWire(undefined)`) run on every case, because
// a non-string input cannot be expressed in a JSON fixture's `frozen_response`
// and the doc's degenerate-input rows (S-014, S-015) ask for exactly that.
//
// A frozen response may carry TWO rounds separated by a line reading `#REPAIR`.
// That is how the bounded-repair rows (S-047, S-048) pose their case: round one
// is the model's first answer, round two is what it said when the rejected
// lines were re-asked. Responses with no separator have no second round and
// report no repair state.
// ===========================================================================

import {
  accountingHolds,
  createAliasTable,
  lineViolations,
  mergeRepair,
  parseWire,
  serialize,
  type AliasTable,
  type WireParseResult,
  type WireRecord,
} from "../../wire/index.js";
import type { Executor, Produced } from "../runner.js";
import type { FixtureGiven } from "../fixtures.js";

/** Record label → the output bucket the fixture's `expect` names. */
const WIRE_BUCKETS: Record<string, string> = {
  mention: "mentions",
  new_entity: "entities",
  link: "links",
  loop: "loops",
};

/** The line that separates a first answer from its repair round. */
export const REPAIR_SEPARATOR = "#REPAIR";

export function splitRepairRounds(response: string): { first: string; second: string | null } {
  const lines = response.split("\n");
  const at = lines.findIndex((l) => l.trim() === REPAIR_SEPARATOR);
  if (at === -1) return { first: response, second: null };
  return { first: lines.slice(0, at).join("\n"), second: lines.slice(at + 1).join("\n") };
}

/** Records → the buckets a fixture's `expect` compares against. */
export function bucketRecords(records: readonly WireRecord[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const record of records) {
    const [head, kind] = record.label.split(".");
    const bucket = head === "claim" ? "claims" : (WIRE_BUCKETS[record.label] ?? record.label);
    const list = (output[bucket] as unknown[] | undefined) ?? [];
    list.push(kind ? { kind, ...record.values } : { ...record.values });
    output[bucket] = list;
  }
  return output;
}

/**
 * Build the prompt-local alias table the fixture's roster describes.
 *
 * The roster is `"a1=Pranjali Sachdeva"` — alias token to label — and the table
 * mints in namespace order, so minting the roster's entries in order reproduces
 * exactly the table the packer would have handed to the model. That is what
 * makes the range check in S-042 meaningful: `a9` against a roster of seven is
 * out of range, and the table must say so rather than reach for the nearest
 * string.
 */
export function aliasTableFor(given: FixtureGiven): AliasTable {
  const table = createAliasTable();
  const byPrefix = new Map<string, { id: string; label: string }[]>();
  for (const entry of given.roster) {
    const eq = entry.indexOf("=");
    if (eq < 1) continue;
    const token = entry.slice(0, eq).trim();
    const label = entry.slice(eq + 1).trim();
    if (token === "self") continue;
    const prefix = token[0];
    const list = byPrefix.get(prefix) ?? [];
    list.push({ id: `${token}-id`, label });
    byPrefix.set(prefix, list);
  }
  const NS: Record<string, Parameters<AliasTable["mint"]>[0]> = {
    a: "entity",
    c: "stream",
    n: "arc",
    k: "proposed",
    e: "episode",
    t: "loop",
  };
  for (const [prefix, list] of byPrefix) {
    const ns = NS[prefix];
    if (!ns) continue;
    for (const { id, label } of list) table.mint(ns, id, label);
  }
  for (const event of given.events) table.mintEvent(`ev-${event.n}`);
  return table;
}

/** Every alias-shaped value the records cite, resolved against the roster. */
function resolveAliases(
  records: readonly WireRecord[],
  table: AliasTable,
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const record of records) {
    for (const value of Object.values(record.values)) {
      if (typeof value !== "string") continue;
      // Only alias-SHAPED tokens are asked about; prose is not an alias.
      if (!/^(?:self|\+.+|[acnket][0-9]+)$/i.test(value)) continue;
      const r = table.resolve(value);
      if (r.resolved) resolved.push(value);
      else if (r.unresolved !== null) unresolved.push(value);
    }
  }
  return { resolved, unresolved };
}

/**
 * The char saving the wire format buys over the JSON the same records would
 * need. REPORTED, never asserted (§14.2 `wire_char_saving`) — a token
 * assertion is a flake, so this feeds a `reported` gate and nothing else.
 */
function charSavingPct(records: readonly WireRecord[], wire: string): number {
  if (records.length === 0) return 0;
  const json = JSON.stringify(records.map((r) => ({ label: r.label, ...r.values })));
  if (json.length === 0) return 0;
  return (1 - wire.length / json.length) * 100;
}

/** Does `parseWire` survive an input a JSON fixture cannot even express? */
function totalityProbe(input: unknown): boolean {
  try {
    const result = parseWire(input);
    return result.records.length === 0 && accountingHolds(result);
  } catch {
    return false;
  }
}

function countsOf(parsed: WireParseResult): Record<string, unknown> {
  return {
    accepted: parsed.counts.accepted,
    line_violations: parsed.counts.violations,
    response_violations: parsed.counts.responseViolations,
    skipped: parsed.counts.skipped,
    non_blank_lines: parsed.counts.nonBlankLines,
    accounting_holds: accountingHolds(parsed),
    emphasis_stripped: parsed.counts.emphasisStripped,
    bullets_stripped: parsed.counts.bulletsStripped,
    violations: parsed.violations.map((v) => v.rule),
    skips: parsed.skipped.map((s) => s.class),
  };
}

export const wireExecutor: Executor = ({ fixture, response }) => {
  const rounds = splitRepairRounds(response);
  const parsed = parseWire(rounds.first);

  const round1 = serialize(parsed.records);
  const round2 = serialize(parseWire(round1).records);

  const aliases = resolveAliases(parsed.records, aliasTableFor(fixture.given));

  const state: Record<string, unknown> = {
    ...countsOf(parsed),
    round_trip: round1,
    round_trip_stable: round1 === round2,
    resolved_aliases: aliases.resolved,
    unresolved_aliases: aliases.unresolved,
    null_input_safe: totalityProbe(null),
    undefined_input_safe: totalityProbe(undefined),
    // The lines a repair round would re-ask — and ONLY those (§5.8.2).
    repair_asked_lines: lineViolations(parsed).map((v) => v.line),
  };

  if (rounds.second !== null) {
    const second = parseWire(rounds.second);
    const merged = mergeRepair(parsed, second);
    state.repair_rounds = merged.rounds;
    state.repair_records = merged.records.length;
    state.repair_violations = merged.violations.length;
    // Unique line numbers, so "retained" is a fact about WHICH lines are still
    // rejected rather than about how many times they are listed.
    state.repair_retained_lines = [...new Set(merged.violations.map((v) => v.line))].sort((a, b) => a - b);
  }

  const produced: Produced = {
    output: bucketRecords(parsed.records),
    state,
    metrics: {
      records: parsed.records.length,
      violations: parsed.violations.length,
      skipped: parsed.skipped.length,
      non_blank_lines: parsed.counts.nonBlankLines,
      accepted: parsed.counts.accepted,
      char_saving_pct: charSavingPct(parsed.records, round1),
    },
  };
  return produced;
};
