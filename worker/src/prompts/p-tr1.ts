// ===========================================================================
// [LLM-S] P-TR1 — triage — arch §12.8. Build item 3.8.
//
// One `J.triage` line per newly extracted loop:
//
//     J | <t-alias> | <au|ap|cx> | <u|h|m|l> | <reason>
//
// which becomes `loops.triage`. Three classes, and only one of them lets the
// system act on its own:
//
//     au  research / summarise / look up / draft-but-do-not-send
//     ap  anything outward-facing, irreversible, or ambiguous
//     cx  not actionable by the system at all
//
// THREE THINGS THIS FILE HOLDS
//
//   THE AGE OF THE EVIDENCE IS NOT THE QUESTION. §12.8's own note: "t5 and t6
//        were both said in the past and both arrived via backfill. t5 is dead;
//        t6 is live. The difference is the next occurrence, not the age." That
//        is the same discriminator `loops/state.ts` already implements, so the
//        past-due rule here is CHECKED against `deriveLoopState` rather than
//        re-derived.
//
//   THREE INVARIANTS ARE STRUCTURAL, NOT STYLISTIC. Non-self is always `cx`
//        (evals Q-007…Q-012 — another person's loop is never in YOUR tasks),
//        implicit is never `au`, and lapsed-with-no-recurrence is `cx`. They
//        are applied in `../loops/triage.ts`, and every application keeps the
//        model's own line byte-for-byte: nothing is dropped, edited or hidden
//        (build rule 9).
//
//   A FIRST PAINT NEVER WAITS FOR THIS CALL. The [CODE] value a loop renders
//        with before the model answers — non-self → `cx`, implicit → `ap`,
//        else `ap`, never `au` (§9.5.1) — is `tr1DefaultTriage()` in
//        `../loops/triage.ts`, alongside the rules and the field flip. This
//        file builds the call and reads the answer; that one decides what a
//        `loops.triage` column ends up holding.
//
// Nothing in this file writes a row.
// ===========================================================================

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import { neutraliseLabel, collapseNewlines } from "../wire/pack.js";
import type { WireRecord } from "../wire/codec.js";
import { ENUMS, type WireSkip, type WireViolation } from "../wire/tolerance.js";
import { deriveLoopState, type NowLike } from "../loops/state.js";
import { TRIAGE_CLASSES, type Triage } from "../claims/codefacts.js";
import { legendFor } from "./legend.js";

/** §12.8 "Settings", transcribed. */
export const P_TR1 = {
  id: "P-TR1",
  /** A valid `runs.role` — the triage spend on a batch of loops. */
  role: "triage",
  /** "haiku-4-5". */
  model: "haiku-4-5",
  /** "1 turn". */
  turns: 1,
  /** "none" — it judges the loops it is handed and looks nothing up. */
  tools: "none",
  thinking: "off",
  /** "90 s". */
  timeoutSeconds: 90,
  /** "20–50 loops" — the upper bound is the cap. */
  maxLoopsPerCall: 50,
  /** "2,000 max out". */
  maxOutputTokens: 2_000,
  /** Triage refines a painted loop; it never blocks the first paint (§9.5.1). */
  onCriticalPath: false,
} as const;

/** The one tag this call may emit. Anything else is counted, never applied. */
export const P_TR1_TAGS = ["J.triage"] as const;

/** §12.8 SYSTEM, verbatim. */
export const P_TR1_SYSTEM = `You classify newly extracted loops.

  au auto      — safe without asking. ONLY research, summarise, look up, or
                 prepare a draft that is not sent.
  ap approval  — anything outward-facing (a message, email, purchase, booking,
                 payment), anything irreversible, anything ambiguous, and
                 EVERY loop with origin im.
  cx context   — not actionable by the system. A loop owned by someone other
                 than the user is ALWAYS cx.

RULES
- origin im is ALWAYS ap or cx. Never au.
- owner not self is ALWAYS cx.
- Past due AND no recurrence → cx. It is history.
- BUT a recurring obligation whose NEXT occurrence is in the future is live,
  however old the evidence. An insurance policy, lease, warranty or
  subscription first mentioned two years ago is a real current item.
  Judge by the next occurrence, never by the age of the message.
- Torn between au and ap → choose ap.

OUTPUT
  J | <t-alias> | <au|ap|cx> | <u|h|m|l> | <reason>`;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function tr1Legend(): string {
  return legendFor({
    callType: P_TR1.id,
    tags: [...P_TR1_TAGS],
    aliases: ["loop", "entity"],
  });
}

/** legend + §12.8 SYSTEM. Byte-identical on every call, so it caches (§5.9.4). */
export function buildTr1System(): string {
  return [tr1Legend(), P_TR1_SYSTEM].join("\n\n");
}

// ---------------------------------------------------------------------------
// The three classes
// ---------------------------------------------------------------------------

export type { Triage };
export { TRIAGE_CLASSES };

/** `auto` → `au`, off the STW-2 enum table, never a second copy. */
export function triageCode(stored: string): string | null {
  return ENUMS.triage.encode(stored);
}

const TRIAGE_SET: ReadonlySet<string> = new Set(TRIAGE_CLASSES);

// ---- the call --------------------------------------------------------------

/** One loop, in the shape §12.8's USER block prints it. */
export interface Tr1Loop {
  /** The real `loops.id`. Never sent — the t-alias stands in for it (§5.2). */
  loopId: string;
  /** `loops.intent`, the loop's own words. Never rewritten. */
  intent: string;
  /** explicit | implicit (or the `ex`/`im` code). */
  origin?: string | null;
  /** `loops.owner_id` / `loops.counterparty_id`, or `self`. */
  ownerId?: string | null;
  counterpartyId?: string | null;
  /** `loops.due_utc`. Printed as-is; the model is told TODAY separately. */
  dueUtc?: string | null;
  /** `loops.recurrence` — the person's own cadence words — and its end date. */
  recurrence?: string | null;
  recurrenceEndsAt?: string | null;
  /** `loops.stake` — `high` | `medium` | `low`, or its code. */
  stake?: string | null;
  /** `events.ts` of the stating and last reinforcing events. NEVER
   * `ingested_at` (build rule 8). */
  statedAt?: string | null;
  lastReinforcedAt?: string | null;
}

export interface Tr1Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** loop id → the t-alias it was minted as, for the caller's own bookkeeping. */
  aliases: Record<string, string>;
  loops: readonly Tr1Loop[];
}

/** §12.8 caps the call at 50 loops; this is where that cap is applied. */
export function chunkLoops(
  loops: readonly Tr1Loop[],
  size: number = P_TR1.maxLoopsPerCall,
): Tr1Loop[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: Tr1Loop[][] = [];
  for (let i = 0; i < loops.length; i += limit) out.push(loops.slice(i, i + limit));
  return out;
}

function clean(value: string | null | undefined): string {
  const text = typeof value === "string" ? collapseNewlines(value).trim() : "";
  return text === "" ? "" : neutraliseLabel(text);
}

/** An enum field prints its wire code, or `-` when it is not stated. */
function enumText(name: "origin" | "stake", value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "-";
  return ENUMS[name].decode(raw)?.code ?? "-";
}

/** `rec annual next 2027-03-15` — the doc's own t6 line. */
function recurrenceText(loop: Tr1Loop, now: NowLike): string {
  const rec = clean(loop.recurrence);
  if (rec === "") return "rec -";
  const facts = deriveLoopState(
    { dueUtc: loop.dueUtc, recurrence: loop.recurrence, recurrenceEndsAt: loop.recurrenceEndsAt },
    now,
  );
  const next = facts.nextOccurrenceUtc;
  return next === null ? `rec ${rec}` : `rec ${rec} next ${next.slice(0, 10)}`;
}

function party(id: string | null | undefined, table: AliasTable): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (raw === "") return "-";
  return raw === "self" ? "self" : table.mint("entity", raw);
}

export interface Tr1UserOptions {
  /** The `TODAY` header. Defaults to `now` in UTC. */
  today?: string;
  /** The clock the recurrence projection is read against. */
  now?: NowLike;
}

/**
 * The USER block, in §12.8's shape:
 *
 *     SELF self   TODAY 2026-08-15
 *     t1 Send Pranjali the Goa villa link | ex | self | a1 | due 2026-08-16 | rec - | l
 *     t6 Renew health insurance policy | ex | self | - | due 2025-03-15 | rec annual next 2027-03-15 | h
 *
 * The `next` tail is [CODE], projected by `loops/state.ts` from the loop's own
 * recurrence — the model is asked to JUDGE by the next occurrence, so the next
 * occurrence is a fact it is given rather than arithmetic it is asked to do.
 */
export function buildTr1User(
  loops: readonly Tr1Loop[],
  table: AliasTable,
  options: Tr1UserOptions = {},
): string {
  const now = options.now ?? Date.now();
  const today =
    options.today ??
    new Date(typeof now === "number" ? now : new Date(now).getTime()).toISOString().slice(0, 10);
  const lines: string[] = [`SELF self   TODAY ${today}`];
  for (const loop of loops) {
    const alias = table.mint("loop", loop.loopId, loop.intent);
    const due = clean(loop.dueUtc);
    lines.push(
      [
        `${alias} ${clean(loop.intent) || "-"}`,
        enumText("origin", loop.origin),
        party(loop.ownerId, table),
        party(loop.counterpartyId, table),
        `due ${due === "" ? "-" : due}`,
        recurrenceText(loop, now),
        enumText("stake", loop.stake),
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

/** Build the call. Loops in, one alias table out, nothing persisted. */
export function buildTr1Prompt(
  loops: readonly Tr1Loop[],
  table?: AliasTable,
  options: Tr1UserOptions = {},
): Tr1Prompt {
  const aliasTable = table ?? createAliasTable();
  const user = buildTr1User(loops, aliasTable, options);
  const aliases: Record<string, string> = {};
  for (const loop of loops) {
    const token = aliasTable.tokenFor("loop", loop.loopId);
    if (token) aliases[loop.loopId] = token;
  }
  return { system: buildTr1System(), user, table: aliasTable, aliases, loops };
}

/** The provider knobs §12.8 fixes. Built here so no call site can raise them. */
export interface Tr1SendShape {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: "off";
  /** No tools: a plain completion, not an agent turn. */
  plainCompletion: true;
}


export function tr1SendOptions(): Tr1SendShape {
  return {
    model: P_TR1.model,
    maxTurns: P_TR1.turns,
    timeoutMs: P_TR1.timeoutSeconds * 1_000,
    maxOutputTokens: P_TR1.maxOutputTokens,
    thinkingBudget: "off",
    plainCompletion: true,
  };
}

// ---- the answer ------------------------------------------------------------

export interface Tr1Verdict {
  /** The alias the model wrote, verbatim. */
  alias: string;
  /** The loop it resolves to, or null when the alias was not on the roster. */
  loopId: string | null;
  /** The stored long form — `auto` | `approval` | `context`. */
  triage: Triage;
  /** `au` | `ap` | `cx`, the wire code for the same class. */
  code: string;
  /** `high` | `medium` | `low`, or null. */
  urgency: string | null;
  /** The model's reason and its whole line, both byte-for-byte (build rule 9). */
  reason: string;
  raw: string;
  line: number;
}

export interface Tr1Answer {
  /** One per loop the model answered for, in the order it answered. */
  verdicts: Tr1Verdict[];
  /** Verdicts naming a loop this call did not send. Reported, never guessed. */
  unresolved: Tr1Verdict[];
  /** Loop ids asked about that got no line back. Re-ask, never invent. */
  missing: string[];
  /** Loops answered for more than once — every answer kept, in order. */
  duplicates: Tr1Verdict[];
  /** Lines this call may not emit, and lines the tolerance layer classed as
   * prose. Counted and kept, never dropped. */
  otherRecords: WireRecord[];
  violations: WireViolation[];
  skipped: WireSkip[];
  parse: WireParseResult;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a P-TR1 answer. Never throws (§5.8): a line the codec rejects comes
 * back as a violation with the model's words intact, ready for a repair round.
 *
 * A `J.triage` line whose alias is not on this call's roster is UNRESOLVED —
 * reported, never reattributed to the nearest loop (§5.8.6). A second line for
 * a loop already answered is a DUPLICATE: the first wins and the rest are kept
 * in order, because code orders model output and never censors it.
 */
export function parseTr1Response(
  response: unknown,
  table: AliasTable,
  loops: readonly Tr1Loop[] = [],
): Tr1Answer {
  const parse = parseWire(response);
  const verdicts: Tr1Verdict[] = [];
  const unresolved: Tr1Verdict[] = [];
  const duplicates: Tr1Verdict[] = [];
  const otherRecords: WireRecord[] = [];
  const seen = new Set<string>();

  for (const record of parse.records) {
    if (record.variant !== "J.triage") {
      otherRecords.push(record);
      continue;
    }
    const stored = str(record.values.class);
    if (!TRIAGE_SET.has(stored)) {
      otherRecords.push(record);
      continue;
    }
    const alias = str(record.values.loop);
    const resolution = table.resolve(alias);
    const loopId =
      resolution.resolved && resolution.resolved.kind === "loop" ? resolution.resolved.id : null;
    const urgency = str(record.values.urgency);
    const verdict: Tr1Verdict = {
      alias,
      loopId,
      triage: stored as Triage,
      code: triageCode(stored) ?? "",
      urgency: urgency === "" ? null : urgency,
      reason: str(record.values.reason),
      raw: record.raw,
      line: record.line,
    };
    if (loopId === null) {
      unresolved.push(verdict);
      continue;
    }
    if (seen.has(loopId)) duplicates.push(verdict);
    else {
      seen.add(loopId);
      verdicts.push(verdict);
    }
  }

  const missing = loops.map((l) => l.loopId).filter((id) => !seen.has(id));

  return {
    verdicts,
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
 * Every line of the answer, counted. `records + violations + skipped` is what
 * the parser saw; the buckets are where each one went. Equality is how "zero
 * model output discarded by code" is MEASURED rather than asserted (R-040).
 */
export function tr1Accounts(answer: Tr1Answer): { seen: number; kept: number; balanced: boolean } {
  const seen =
    answer.parse.records.length + answer.parse.violations.length + answer.parse.skipped.length;
  const kept =
    answer.verdicts.length +
    answer.unresolved.length +
    answer.duplicates.length +
    answer.otherRecords.length +
    answer.violations.length +
    answer.skipped.length;
  return { seen, kept, balanced: seen === kept };
}
