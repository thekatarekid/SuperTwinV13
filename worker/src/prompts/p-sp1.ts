// ===========================================================================
// [LLM-S] P-SP1 — archetype + label — arch §12.10. Build item 3.7.
//
// One thread of a person's life, one SHAPE and one NAME. The call reads a
// promoted arc's shape — its sources, its anchors, its open loops, a few
// verbatim quotes — and answers one `D` line per thread:
//
//     D | <n-alias> | <archetype> | <one|rec> | <ends_at | -> | <conf> | <label>
//
// which becomes `arcs.archetype` + `arcs.archetype_source = 'model'`, plus the
// cadence, the end date and the label the space renders under.
//
// FIVE THINGS THIS FILE HOLDS
//
//   EIGHT SHAPES, NOT EIGHT TOPICS.  `prj evt rhy adm hld mat pur wch` are
//        SHAPES — "Choose by the SHAPE of the thing, not its subject matter."
//        The one that is genuinely hard is pursuit vs watch, and §12.10 settles
//        it with a single question: does the person ACT (pursuit) or OBSERVE
//        (watch)? That rule is in the SYSTEM block verbatim and nowhere else,
//        because a paraphrase of it is a different classifier.
//
//   DEFERRED, NEVER ON FIRST PAINT.  §9.5.1 and `scheduler/paint.ts`:
//        "archetype is cosmetic; a space renders with a neutral default and
//        refines within the minute". `onCriticalPath: false` is the rule, not
//        an observation — a space with a null archetype is a space that paints.
//
//   TEN THREADS PER CALL.  §12.10 settings: "≤10 threads · 800 max out".
//        `chunkThreads()` is where that cap is applied, so a caller with forty
//        promoted arcs makes four calls instead of one unreadable one.
//
//   ARCHETYPE IS REVISABLE, AND THE TRANSITION IS RECORDED.  A thread "may
//        still be growing as older data lands"; the same arc will be asked
//        again. `sp1Transitions()` turns a re-answer into a from → to record
//        whose reason IS the model's own line, byte-for-byte. A user-set
//        archetype (`archetype_source = 'user'`) is never overwritten by a
//        model one — it is reported as held.
//
//   A SHORT LABEL IS FLAGGED, NEVER REWRITTEN.  §12.10 wants 4–8 words with
//        the anchor that makes the thread findable among forty; "Goa trip"
//        would be rejected. Build rule 9 says code orders model output and
//        never edits it, so `labelWords` / `labelTooShort` travel WITH the
//        verbatim label and the caller decides whether to re-ask. Nothing here
//        trims, pads or paraphrases a label.
//
// Nothing in this file writes a row. It builds the call, reads the answer, and
// hands the arc writer a field flip it can apply as-is.
// ===========================================================================

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import { neutraliseLabel, collapseNewlines } from "../wire/pack.js";
import type { WireRecord } from "../wire/codec.js";
import { ENUMS, type WireSkip, type WireViolation } from "../wire/tolerance.js";
import { legendFor } from "./legend.js";

/** §12.10 "Settings", transcribed. */
export const P_SP1 = {
  id: "P-SP1",
  /** A valid `runs.role` — a space is an arc wearing a shape, so: arc spend. */
  role: "arc",
  /** "haiku-4-5" — a shape and a name, not a judgement call. */
  model: "haiku-4-5",
  /** "1 turn". */
  turns: 1,
  /** "none" — it reads the threads it is given and nothing else. */
  tools: "none",
  thinking: "off",
  /** "60 s". */
  timeoutSeconds: 60,
  /** "≤10 threads". */
  maxThreadsPerCall: 10,
  /** "800 max out". */
  maxOutputTokens: 800,
  /** §9.5.1 / `scheduler/paint.ts` — archetype is cosmetic; it never blocks. */
  onCriticalPath: false,
} as const;

/** The one tag this call may emit. Anything else is counted, never applied. */
export const P_SP1_TAGS = ["D"] as const;

/** §12.10 SYSTEM, verbatim. */
export const P_SP1_SYSTEM = `You classify a thread of a person's life into exactly ONE shape and name it.

  prj project  an outcome with a span and many steps
  evt event    a single point in time
  rhy rhythm   a recurring COMMITMENT to others
  adm admin    a recurring external duty with a ledger (bills, renewals, tax)
  hld holding  a durable thing owned or inhabited (a flat, a car, a connection)
  mat matter   an unresolved situation with no fixed end (a health concern,
               a dispute, an ongoing worry)
  pur pursuit  a self-directed recurring activity with no obligation
               (cooking experiments, reading, learning)
  wch watch    standing attention on a topic, no obligation

RULES
- Choose by the SHAPE of the thing, not its subject matter.
- pursuit vs watch: does the person ACT (pursuit) or OBSERVE (watch)?
  Mostly their own events → pursuit. Mostly things arriving at them → watch.
- LABEL: MORE THAN THREE WORDS. 4 to 8 plain words, concrete, in the person's
  own vocabulary. A label must distinguish this thread from every other one
  the person has, so include the anchor that makes it specific — who, where,
  or when.
    BAD  "Goa trip"        "Housing"        "Insurance"      "Rahul"
    GOOD "Goa trip with Rohan in September"
         "Flat hunt in Indiranagar"
         "Health insurance renewal every March"
         "Rahul's wedding in December"
- ends_at only if there is a real end. cadence rec if its loops regenerate.
- A thread may still be growing as older data lands. Classify what is present;
  you will be asked again if it changes materially.

OUTPUT
  D | <n-alias> | <archetype> | <one|rec> | <ends_at | -> | <conf> | <label>`;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function sp1Legend(): string {
  return legendFor({
    callType: P_SP1.id,
    tags: [...P_SP1_TAGS],
    aliases: ["arc", "entity"],
  });
}

/** legend + §12.10 SYSTEM. Byte-identical on every call, so it caches (§5.9.4). */
export function buildSp1System(): string {
  return [sp1Legend(), P_SP1_SYSTEM].join("\n\n");
}

// ---------------------------------------------------------------------------
// The eight shapes
// ---------------------------------------------------------------------------

/** The stored long forms, as `arcs.archetype` holds them. */
export type Sp1Archetype =
  | "project"
  | "event"
  | "rhythm"
  | "admin"
  | "holding"
  | "matter"
  | "pursuit"
  | "watch";

/** The eight, in §12.10's order. The accuracy gate scores across all of them. */
export const SP1_ARCHETYPES: readonly Sp1Archetype[] = [
  "project",
  "event",
  "rhythm",
  "admin",
  "holding",
  "matter",
  "pursuit",
  "watch",
] as const;

const ARCHETYPE_SET: ReadonlySet<string> = new Set(SP1_ARCHETYPES);

/** `project` → `prj`. Read off the STW-2 enum table, never a second copy. */
export function archetypeCode(stored: string): string | null {
  return ENUMS.archetype.encode(stored);
}

/** `arcs.archetype_source` — who put the shape there. */
export type ArchetypeSource = "model" | "user";

// ---- the call --------------------------------------------------------------

/** One open loop on the thread, as the USER block prints it. */
export interface Sp1Loop {
  /** "confirm villa to Rohan" — the loop's own words. Never rewritten. */
  text: string;
  /** "20 Aug", already rendered by the caller in the user's tz. */
  due?: string | null;
  /** "monthly" / "weekly" — the recurrence in the person's words, if any. */
  every?: string | null;
}

/** One promoted arc, in the shape §12.10's USER block asks for. */
export interface Sp1Thread {
  /** The real `arcs.id`. Never sent — the n-alias stands in for it (§5.2). */
  arcId: string;
  /** The arc's working label. The model is being asked for a better one. */
  label: string | null;
  /** `wa,web,cal,gmail,shop` — source ids, printed in the caller's order. */
  sourceIds?: readonly string[];
  /** Anchor entity ids. They ride as a-aliases on the shared table. */
  anchorEntityIds?: readonly string[];
  /** `promotion` enum: `cmt` | `ref` | `rec` | `usr`, code or stored form. */
  promotion?: string | null;
  /** The open loops. `loops: -` when there are none. */
  loops?: readonly Sp1Loop[];
  /** "rent ₹52k", "lease to Nov 2027" — the reference facts, for a holding. */
  facts?: readonly string[];
  /** "9 episodes over 7 weeks, user participated in all" — the shape gloss. */
  note?: string | null;
  /** Verbatim quotes, on their own line. Language is never compressed (§5.5). */
  quotes?: readonly string[];
}

export interface Sp1Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** arc id → the n-alias it was minted as, for the caller's own bookkeeping. */
  aliases: Record<string, string>;
  threads: readonly Sp1Thread[];
}

/** §12.10 caps the call at 10 threads; this is where that cap is applied. */
export function chunkThreads(
  threads: readonly Sp1Thread[],
  size: number = P_SP1.maxThreadsPerCall,
): Sp1Thread[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: Sp1Thread[][] = [];
  for (let i = 0; i < threads.length; i += limit) out.push(threads.slice(i, i + limit));
  return out;
}

function clean(value: string | null | undefined): string {
  const text = typeof value === "string" ? collapseNewlines(value).trim() : "";
  return text === "" ? "" : neutraliseLabel(text);
}

function listText(values: readonly string[] | undefined): string {
  const items = (values ?? []).map((v) => clean(v)).filter((v) => v !== "");
  return items.length === 0 ? "-" : items.join(",");
}

/** `confirm villa to Rohan (due 20 Aug)` · `broadband renews (due 28 Aug, monthly)`. */
function loopText(loop: Sp1Loop): string {
  const qualifiers: string[] = [];
  const due = clean(loop.due);
  const every = clean(loop.every);
  if (due !== "") qualifiers.push(`due ${due}`);
  if (every !== "") qualifiers.push(every);
  const inner = qualifiers.length === 0 ? "-" : qualifiers.join(", ");
  return `${clean(loop.text) || "-"} (${inner})`;
}

/** `promo cmt` — the code, from the STW-2 table. An unknown value prints `-`. */
function promotionText(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "-";
  return ENUMS.promotion.decode(raw)?.code ?? "-";
}

/**
 * The USER block, in §12.10's shape:
 *
 *     n1 Goa trip | wa,web,cal,gmail,shop | anchors a2,a7,a5 | promo cmt
 *        loops: confirm villa to Rohan (due 20 Aug) · compare flights (-)
 *        "villa held till 20 Aug" / "12–15 Sep"
 *
 * A thread with no loops prints `loops: -` and carries its facts or its gloss
 * on the same line, exactly as the doc's n4 and n5 do.
 */
export function buildSp1User(threads: readonly Sp1Thread[], table: AliasTable): string {
  const lines: string[] = [];
  for (const thread of threads) {
    const alias = table.mint("arc", thread.arcId, thread.label ?? undefined);
    const anchors = (thread.anchorEntityIds ?? []).map((id) =>
      id === "self" ? "self" : table.mint("entity", id),
    );
    lines.push(
      [
        `${alias} ${clean(thread.label) || "-"}`,
        listText(thread.sourceIds),
        `anchors ${anchors.length === 0 ? "-" : anchors.join(",")}`,
        `promo ${promotionText(thread.promotion)}`,
      ].join(" | "),
    );

    const loops = (thread.loops ?? []).map(loopText);
    const second: string[] = [`loops: ${loops.length === 0 ? "-" : loops.join(" · ")}`];
    const facts = (thread.facts ?? []).map((f) => clean(f)).filter((f) => f !== "");
    if (facts.length > 0) second.push(`facts: ${facts.join(", ")}`);
    const note = clean(thread.note);
    if (note !== "") second.push(note);
    lines.push(`   ${second.join(" | ")}`);

    const quotes = (thread.quotes ?? []).map((q) => clean(q)).filter((q) => q !== "");
    if (quotes.length > 0) {
      lines.push(`   ${quotes.map((q) => `"${q.replace(/"/g, "'")}"`).join(" / ")}`);
    }
  }
  return lines.join("\n");
}

/** Build the call. Threads in, one alias table out, nothing persisted. */
export function buildSp1Prompt(threads: readonly Sp1Thread[], table?: AliasTable): Sp1Prompt {
  const aliasTable = table ?? createAliasTable();
  const user = buildSp1User(threads, aliasTable);
  const aliases: Record<string, string> = {};
  for (const thread of threads) {
    const token = aliasTable.tokenFor("arc", thread.arcId);
    if (token) aliases[thread.arcId] = token;
  }
  return { system: buildSp1System(), user, table: aliasTable, aliases, threads };
}

/** The provider knobs §12.10 fixes. Built here so no call site can raise them. */
export interface Sp1SendShape {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: "off";
  /** No tools: a plain completion, not an agent turn. */
  plainCompletion: true;
}

export function sp1SendOptions(): Sp1SendShape {
  return {
    model: P_SP1.model,
    maxTurns: P_SP1.turns,
    timeoutMs: P_SP1.timeoutSeconds * 1_000,
    maxOutputTokens: P_SP1.maxOutputTokens,
    thinkingBudget: "off",
    plainCompletion: true,
  };
}

// ---- the answer ------------------------------------------------------------

/** §12.10: "4 to 8 plain words". Below this the label is flagged, not fixed. */
export const SP1_LABEL_MIN_WORDS = 4;

/** Word count of a label, for the flag. Never used to change the label. */
export function labelWordCount(label: string): number {
  const words = label.trim().split(/\s+/).filter((w) => w !== "");
  return words.length;
}

export interface Sp1Derivation {
  /** The alias the model wrote, verbatim. */
  alias: string;
  /** The arc it resolves to, or null when the alias was not on the roster. */
  arcId: string | null;
  /** The stored long form — `project`, `pursuit`, … as `arcs.archetype` holds it. */
  archetype: Sp1Archetype;
  /** `prj`, `pur`, … the wire code for the same shape. */
  code: string;
  /** `one_off` | `recurrence` | null. */
  cadence: string | null;
  /** A real end date, or null. §12.10: "ends_at only if there is a real end." */
  endsAt: string | null;
  confidence: number | null;
  /** The model's label, byte-for-byte. Never trimmed to a house style. */
  label: string;
  /** How many words that label has. */
  labelWords: number;
  /** True when §12.10's 4-word floor is not met. A FLAG — nothing is dropped. */
  labelTooShort: boolean;
  /** The model's own line, byte-for-byte (build rule 9). */
  raw: string;
  line: number;
}

export interface Sp1Answer {
  /** One per thread the model answered for, in the order it answered. */
  derivations: Sp1Derivation[];
  /** Derivations naming an arc this call did not send. Reported, never guessed. */
  unresolved: Sp1Derivation[];
  /** Arc ids that were asked about and got no line back. Re-ask, never invent. */
  missing: string[];
  /** Arcs the model answered for more than once — every answer kept, in order. */
  duplicates: Sp1Derivation[];
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
 * Parse a P-SP1 answer. Never throws (§5.8): a line the codec rejects comes
 * back as a violation with the model's words intact, ready for a repair round.
 *
 * A `D` line whose alias is not on this call's roster is UNRESOLVED — reported,
 * never reattributed to the nearest thread (§5.8.6). A second line for an arc
 * already answered is a DUPLICATE: the first wins for the field flip and the
 * rest are kept in order, because code orders model output and never censors it.
 */
export function parseSp1Response(
  response: unknown,
  table: AliasTable,
  threads: readonly Sp1Thread[] = [],
): Sp1Answer {
  const parse = parseWire(response);
  const derivations: Sp1Derivation[] = [];
  const unresolved: Sp1Derivation[] = [];
  const duplicates: Sp1Derivation[] = [];
  const otherRecords: WireRecord[] = [];
  const seen = new Set<string>();

  for (const record of parse.records) {
    if (record.variant !== "D") {
      otherRecords.push(record);
      continue;
    }
    const stored = str(record.values.archetype);
    if (!ARCHETYPE_SET.has(stored)) {
      otherRecords.push(record);
      continue;
    }
    const alias = str(record.values.arc);
    const resolution = table.resolve(alias);
    const arcId =
      resolution.resolved && resolution.resolved.kind === "arc" ? resolution.resolved.id : null;
    const label = str(record.values.label);
    const words = labelWordCount(label);
    const derivation: Sp1Derivation = {
      alias,
      arcId,
      archetype: stored as Sp1Archetype,
      code: archetypeCode(stored) ?? "",
      cadence: str(record.values.cadence) === "" ? null : str(record.values.cadence),
      endsAt: str(record.values.ends_at) === "" ? null : str(record.values.ends_at),
      confidence: typeof record.values.confidence === "number" ? record.values.confidence : null,
      label,
      labelWords: words,
      labelTooShort: words < SP1_LABEL_MIN_WORDS,
      raw: record.raw,
      line: record.line,
    };
    if (arcId === null) {
      unresolved.push(derivation);
      continue;
    }
    if (seen.has(arcId)) duplicates.push(derivation);
    else {
      seen.add(arcId);
      derivations.push(derivation);
    }
  }

  const missing = threads.map((t) => t.arcId).filter((id) => !seen.has(id));

  return {
    derivations,
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
 * the parser saw; the buckets are where each one went. A caller asserts these
 * are equal, which is how "zero model output discarded by code" is MEASURED
 * rather than asserted (evals R-040).
 */
export function sp1Accounts(answer: Sp1Answer): { seen: number; kept: number; balanced: boolean } {
  const seen =
    answer.parse.records.length + answer.parse.violations.length + answer.parse.skipped.length;
  const kept =
    answer.derivations.length +
    answer.unresolved.length +
    answer.duplicates.length +
    answer.otherRecords.length +
    answer.violations.length +
    answer.skipped.length;
  return { seen, kept, balanced: seen === kept };
}

// ---- the field flip --------------------------------------------------------

/**
 * What the arc writer applies. §11 / migration 0020: the derived fields flip on
 * `arcs` itself — there is no `spaces` table (build rule 6).
 */
export interface Sp1Assignment {
  arcId: string;
  /** `arcs.archetype`. */
  archetype: Sp1Archetype;
  /** `arcs.archetype_source` — always `model` for a P-SP1 answer. */
  archetypeSource: ArchetypeSource;
  /** `arcs.cadence` — `one_off` | `recurrence` | null. */
  cadence: string | null;
  /** `arcs.ends_at` — a real end, or null. */
  endsAt: string | null;
  /** The label the space renders under. Verbatim. */
  label: string;
  confidence: number | null;
  /** True when §12.10's word floor is not met — the caller may re-ask. */
  labelTooShort: boolean;
}

/** What an arc already carries, so a user's shape is never overwritten. */
export interface Sp1Current {
  archetype: string | null;
  archetypeSource: string | null;
}

export interface Sp1Flip {
  /** Field flips to apply, in answer order. */
  assignments: Sp1Assignment[];
  /**
   * Arcs whose archetype was set by the USER. `archetype_source = 'user'` wins:
   * the model's line is kept here, unapplied, never silently dropped.
   */
  held: Sp1Derivation[];
}

/**
 * Turn an answer into field flips. `current` is optional; when it is given, an
 * arc whose `archetype_source` is `user` is HELD rather than overwritten.
 */
export function sp1Assignments(
  answer: Sp1Answer,
  current?: ReadonlyMap<string, Sp1Current>,
): Sp1Flip {
  const assignments: Sp1Assignment[] = [];
  const held: Sp1Derivation[] = [];
  for (const d of answer.derivations) {
    if (d.arcId === null) continue;
    if (current?.get(d.arcId)?.archetypeSource === "user") {
      held.push(d);
      continue;
    }
    assignments.push({
      arcId: d.arcId,
      archetype: d.archetype,
      archetypeSource: "model",
      cadence: d.cadence,
      endsAt: d.endsAt,
      label: d.label,
      confidence: d.confidence,
      labelTooShort: d.labelTooShort,
    });
  }
  return { assignments, held };
}

/**
 * A revision. Build item 3.7: "Archetype is revisable; record the transition
 * with a reason." The reason IS the model's own line, byte-for-byte — a
 * paraphrase would be code editing model output (build rule 9).
 */
export interface Sp1Transition {
  arcId: string;
  /** The shape the arc carried before, or null when it had none. */
  from: string | null;
  to: Sp1Archetype;
  source: ArchetypeSource;
  /** The model's `D` line, verbatim. */
  reason: string;
  confidence: number | null;
}

/**
 * Only the arcs whose shape actually CHANGED. A first classification (from
 * null) is a transition too — it is the one the space first renders under.
 * Arcs held by a user-set archetype produce no transition.
 */
export function sp1Transitions(
  answer: Sp1Answer,
  current?: ReadonlyMap<string, Sp1Current>,
): Sp1Transition[] {
  const out: Sp1Transition[] = [];
  for (const d of answer.derivations) {
    if (d.arcId === null) continue;
    const held = current?.get(d.arcId);
    if (held?.archetypeSource === "user") continue;
    const from = held?.archetype ?? null;
    if (from === d.archetype) continue;
    out.push({
      arcId: d.arcId,
      from,
      to: d.archetype,
      source: "model",
      reason: d.raw,
      confidence: d.confidence,
    });
  }
  return out;
}
