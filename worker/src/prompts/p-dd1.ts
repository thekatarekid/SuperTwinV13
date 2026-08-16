// ===========================================================================
// [LLM-S] P-DD1 — done-detection — arch §12.9. Build item 3.8.
//
// One `S` line per open loop the call was asked about:
//
//     S | <t-alias> | <dn|ps|dr|op> | <ev | -> | <conf> | <quote>
//
// FOUR THINGS THIS FILE HOLDS
//
//   `ps` IS AN ANSWER, NOT A STATE. `done_state` is the vocabulary of THIS
//        CALL: `dn ps dr op`. `loops.state` is a different, smaller set that
//        has no `possibly_done` in it and never will (§11.4.3, `loops/state.ts`
//        `ABOLISHED_STATES`). A `ps` line therefore does not park a loop — it
//        leaves it open and raises a one-tap question (evals Q-028, Q-029).
//        The mapping lives in `../loops/done.ts`; this file only reads the
//        answer, and nothing here ever produces a loop state.
//
//   MOST LOOPS NEVER REACH THIS CALL. Item 3.8: "Done-detection runs a [CODE]
//        pre-check first — newest-first means resolving evidence is often
//        already stored, so most historical loops resolve with no model call."
//        `dd1Candidates()` in `../loops/done.ts` is that gate; a caller that
//        skips it is paying for answers the state function already had.
//
//   EVIDENCE IS TIMED, NOT MERELY CITED. §12.9: "Episodes may be older OR
//        newer than the loop. Count only evidence occurring AFTER the loop was
//        stated." The model is told this and the code checks it, because the
//        transcript deliberately contains both.
//
//   THE QUOTE IS THE PROOF AND IT IS VERBATIM. A `dn` with no quote and no
//        event is a guess, and §12.9's own words are "Never mark done on a
//        guess." The quote is carried byte-for-byte into the row that closes
//        the loop, so a person can always see WHY it closed.
//
// Nothing in this file writes a row.
// ===========================================================================

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import { neutraliseLabel, collapseNewlines } from "../wire/pack.js";
import type { WireRecord } from "../wire/codec.js";
import { ENUMS, type WireSkip, type WireViolation } from "../wire/tolerance.js";
import { legendFor } from "./legend.js";

/** §12.9 "Settings", transcribed. */
export const P_DD1 = {
  id: "P-DD1",
  /** A valid `runs.role` — the done-detection spend on a batch of loops. */
  role: "done_detection",
  /** "haiku-4-5". */
  model: "haiku-4-5",
  /** "1 turn". */
  turns: 1,
  /** "none" — it reads the episodes it is given and nothing else. */
  tools: "none",
  thinking: "off",
  /** "90 s". */
  timeoutSeconds: 90,
  /** "≤30 loops". */
  maxLoopsPerCall: 30,
  /** "1,500 max out". */
  maxOutputTokens: 1_500,
  /** A loop closing is a refinement, never a first-paint blocker (§9.5.1). */
  onCriticalPath: false,
} as const;

/** The one tag this call may emit. Anything else is counted, never applied. */
export const P_DD1_TAGS = ["S"] as const;

/** §12.9 SYSTEM, verbatim. */
export const P_DD1_SYSTEM = `You check whether any open loop was completed, given new episodes.

  dn done · ps possibly · dr dropped · op still open

RULES
- Mark dn ONLY on concrete evidence: a confirmation, receipt, completion
  statement, delivery, or an explicit "done".
- Intent to do it later is NOT done.
- Suggestive but not conclusive → ps with the event id. A human confirms.
  Never mark done on a guess.
- The loop's subject is now moot (cancelled, irrelevant) → dr with evidence.
- Episodes may be older OR newer than the loop. Count only evidence occurring
  AFTER the loop was stated.

OUTPUT
  S | <t-alias> | <dn|ps|dr|op> | <ev | -> | <conf> | <quote>`;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function dd1Legend(): string {
  return legendFor({
    callType: P_DD1.id,
    tags: [...P_DD1_TAGS],
    aliases: ["loop", "entity", "episode"],
  });
}

/** legend + §12.9 SYSTEM. Byte-identical on every call, so it caches (§5.9.4). */
export function buildDd1System(): string {
  return [dd1Legend(), P_DD1_SYSTEM].join("\n\n");
}

// ---------------------------------------------------------------------------
// The four answers — this call's vocabulary, NOT the loop state set
// ---------------------------------------------------------------------------

/**
 * The stored long forms of the `done_state` wire enum. `possibly` is a thing
 * the MODEL may say. It is not, and never becomes, a value of `loops.state`.
 */
export type Dd1State = "done" | "possibly" | "dropped" | "still_open";

export const DD1_STATES: readonly Dd1State[] = ["done", "possibly", "dropped", "still_open"];

const DD1_STATE_SET: ReadonlySet<string> = new Set(DD1_STATES);

/** `done` → `dn`. Read off the STW-2 enum table, never a second copy. */
export function dd1StateCode(stored: string): string | null {
  return ENUMS.done_state.encode(stored);
}

// ---- the call --------------------------------------------------------------

/** One open loop, as §12.9's USER block prints it. */
export interface Dd1Loop {
  /** The real `loops.id`. Never sent — the t-alias stands in for it (§5.2). */
  loopId: string;
  /** `loops.intent`, the loop's own words. Never rewritten. */
  intent: string;
  /** `loops.owner_id`, or `self`. */
  ownerId?: string | null;
  /** `loops.counterparty_id`, or `self`, or absent. */
  counterpartyId?: string | null;
  /** "12 Aug" — already rendered by the caller in the user's tz. */
  due?: string | null;
  /**
   * `events.ts` of the stating event — the line the whole "after" rule hangs
   * on. NEVER `ingested_at` (build rule 8).
   */
  statedAt?: string | null;
}

export interface Dd1Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** loop id → the t-alias it was minted as, for the caller's own bookkeeping. */
  aliases: Record<string, string>;
  loops: readonly Dd1Loop[];
}

/** §12.9 caps the call at 30 loops; this is where that cap is applied. */
export function chunkDd1Loops(
  loops: readonly Dd1Loop[],
  size: number = P_DD1.maxLoopsPerCall,
): Dd1Loop[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: Dd1Loop[][] = [];
  for (let i = 0; i < loops.length; i += limit) out.push(loops.slice(i, i + limit));
  return out;
}

function clean(value: string | null | undefined): string {
  const text = typeof value === "string" ? collapseNewlines(value).trim() : "";
  return text === "" ? "" : neutraliseLabel(text);
}

function party(id: string | null | undefined, table: AliasTable): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (raw === "") return "-";
  return raw === "self" ? "self" : table.mint("entity", raw);
}

/** `2026-08-12T19:40` — minute precision, as the doc prints it. */
function saidText(statedAt: string | null | undefined): string {
  const raw = typeof statedAt === "string" ? statedAt.trim() : "";
  if (raw === "") return "-";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return clean(raw);
  return new Date(ms).toISOString().slice(0, 16);
}

/**
 * The USER block, in §12.9's shape: the loops first, then the packed episodes
 * exactly as `wire/pack.ts` emits them.
 *
 *     t1 Send Pranjali the Goa villa link | self | a1 | due 12 Aug | said 2026-08-12T19:40
 *     #C c1 Pranjali | dm | self,a1
 *     #D 2026-08-12 Wed | Asia/Kolkata
 *     1 21:04 self here — https://booking.com/villa-amara
 *
 * `transcript` MUST have been packed against the same alias table, or the
 * event ids the model cites will not resolve to anything.
 */
export function buildDd1User(
  loops: readonly Dd1Loop[],
  transcript: string,
  table: AliasTable,
): string {
  const lines: string[] = [];
  for (const loop of loops) {
    const alias = table.mint("loop", loop.loopId, loop.intent);
    const due = clean(loop.due);
    lines.push(
      [
        `${alias} ${clean(loop.intent) || "-"}`,
        party(loop.ownerId, table),
        party(loop.counterpartyId, table),
        `due ${due === "" ? "-" : due}`,
        `said ${saidText(loop.statedAt)}`,
      ].join(" | "),
    );
  }
  const body = typeof transcript === "string" ? transcript.trim() : "";
  if (body !== "") lines.push(body);
  return lines.join("\n");
}

/** Build the call. Loops + a packed transcript in, nothing persisted. */
export function buildDd1Prompt(
  loops: readonly Dd1Loop[],
  transcript: string,
  table?: AliasTable,
): Dd1Prompt {
  const aliasTable = table ?? createAliasTable();
  const user = buildDd1User(loops, transcript, aliasTable);
  const aliases: Record<string, string> = {};
  for (const loop of loops) {
    const token = aliasTable.tokenFor("loop", loop.loopId);
    if (token) aliases[loop.loopId] = token;
  }
  return { system: buildDd1System(), user, table: aliasTable, aliases, loops };
}

/** The provider knobs §12.9 fixes. Built here so no call site can raise them. */
export interface Dd1SendShape {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: "off";
  /** No tools: a plain completion, not an agent turn. */
  plainCompletion: true;
}

export function dd1SendOptions(): Dd1SendShape {
  return {
    model: P_DD1.model,
    maxTurns: P_DD1.turns,
    timeoutMs: P_DD1.timeoutSeconds * 1_000,
    maxOutputTokens: P_DD1.maxOutputTokens,
    thinkingBudget: "off",
    plainCompletion: true,
  };
}

// ---- the answer ------------------------------------------------------------

export interface Dd1Finding {
  /** The alias the model wrote, verbatim. */
  alias: string;
  /** The loop it resolves to, or null when the alias was not on the roster. */
  loopId: string | null;
  /** The stored long form — `done` | `possibly` | `dropped` | `still_open`. */
  state: Dd1State;
  /** `dn` | `ps` | `dr` | `op`, the wire code for the same answer. */
  code: string;
  /** The event alias the model cited, verbatim, or "" when it cited none. */
  eventAlias: string;
  /** The `events.id` that alias resolves to, or null. */
  eventId: string | null;
  confidence: number | null;
  /** The proof, byte-for-byte. Never trimmed to a house style. */
  quote: string;
  /** The model's own line, byte-for-byte (build rule 9). */
  raw: string;
  line: number;
}

export interface Dd1Answer {
  /** One per loop the model answered for, in the order it answered. */
  findings: Dd1Finding[];
  /** Findings naming a loop this call did not send. Reported, never guessed. */
  unresolved: Dd1Finding[];
  /** Loop ids that were asked about and got no line back. Re-ask, never invent. */
  missing: string[];
  /** Loops answered for more than once — every answer kept, in order. */
  duplicates: Dd1Finding[];
  /** Lines this call may not emit — counted and kept, never dropped. */
  otherRecords: WireRecord[];
  violations: WireViolation[];
  /** Lines the tolerance layer classed as prose. Counted, never silent. */
  skipped: WireSkip[];
  parse: WireParseResult;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a P-DD1 answer. Never throws (§5.8): a line the codec rejects comes
 * back as a violation with the model's words intact, ready for a repair round.
 *
 * An `S` line whose loop alias is not on this call's roster is UNRESOLVED —
 * reported, never reattributed to the nearest loop (§5.8.6). A cited event
 * alias that resolves to nothing leaves `eventId` null WITHOUT discarding the
 * finding: the caller decides, and `../loops/done.ts` refuses to close a loop
 * on an unresolvable citation rather than closing it on a guess.
 */
export function parseDd1Response(
  response: unknown,
  table: AliasTable,
  loops: readonly Dd1Loop[] = [],
): Dd1Answer {
  const parse = parseWire(response);
  const findings: Dd1Finding[] = [];
  const unresolved: Dd1Finding[] = [];
  const duplicates: Dd1Finding[] = [];
  const otherRecords: WireRecord[] = [];
  const seen = new Set<string>();

  for (const record of parse.records) {
    if (record.variant !== "S") {
      otherRecords.push(record);
      continue;
    }
    const stored = str(record.values.state);
    if (!DD1_STATE_SET.has(stored)) {
      otherRecords.push(record);
      continue;
    }
    const alias = str(record.values.loop);
    const resolution = table.resolve(alias);
    const loopId =
      resolution.resolved && resolution.resolved.kind === "loop" ? resolution.resolved.id : null;
    const eventAlias = str(record.values.event);
    const eventResolution = eventAlias === "" ? null : table.resolve(eventAlias);
    const eventId =
      eventResolution?.resolved && eventResolution.resolved.kind === "event"
        ? eventResolution.resolved.id
        : null;
    const finding: Dd1Finding = {
      alias,
      loopId,
      state: stored as Dd1State,
      code: dd1StateCode(stored) ?? "",
      eventAlias,
      eventId,
      confidence: typeof record.values.confidence === "number" ? record.values.confidence : null,
      quote: str(record.values.quote),
      raw: record.raw,
      line: record.line,
    };
    if (loopId === null) {
      unresolved.push(finding);
      continue;
    }
    if (seen.has(loopId)) duplicates.push(finding);
    else {
      seen.add(loopId);
      findings.push(finding);
    }
  }

  const missing = loops.map((l) => l.loopId).filter((id) => !seen.has(id));

  return {
    findings,
    unresolved,
    missing,
    duplicates,
    otherRecords,
    violations: parse.violations,
    skipped: parse.skipped,
    parse,
  };
}

/**
 * Every line of the answer, counted. Equality between what the parser saw and
 * where each line went is how "zero model output discarded by code" is
 * MEASURED rather than asserted (evals R-040).
 */
export function dd1Accounts(answer: Dd1Answer): { seen: number; kept: number; balanced: boolean } {
  const seen =
    answer.parse.records.length + answer.parse.violations.length + answer.parse.skipped.length;
  const kept =
    answer.findings.length +
    answer.unresolved.length +
    answer.duplicates.length +
    answer.otherRecords.length +
    answer.violations.length +
    answer.skipped.length;
  return { seen, kept, balanced: seen === kept };
}
