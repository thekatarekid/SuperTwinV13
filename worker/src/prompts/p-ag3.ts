// ===========================================================================
// [LLM-M] P-AG3 — claim contradiction — arch §12.7. Build item 3.3.
//
// The near-hit branch of the write path (§11.6). An exact `claim_key` hit is
// a reinforcement and never reaches a model; a claim that is CLOSE to one
// already stored — same subject, same kind, different key — is the one case
// code cannot settle, so one pair goes out and one line comes back:
//
//     V | <a> | <b> | <dup|rfn|ctr|dst|un> | <later: a|b|-> | <valid_to> |
//         <conf> | <reason>
//
// THREE THINGS THIS FILE HOLDS
//
//   ONE PAIR PER CALL.  §12.7 settings: "1 pair · 400 max out". Two pairs in
//        one call let one pair's evidence colour the other's verdict, and the
//        write path disposes of exactly one relationship at a time.
//
//   `stated_at` IS PRINTED FOR BOTH SIDES, ALWAYS.  The SYSTEM block's
//        CRITICAL rule — "judge ONLY by stated_at … Either claim may be the
//        older one" — is unanswerable unless both dates are on the page. The
//        USER builder therefore prints `said <date>` for A and B even when one
//        of them is unknown, where it prints `said -` rather than today.
//        `A stored` / `B incoming` describe STORAGE, not time: the labels are
//        deliberately not "old" and "new".
//
//   THE MODEL'S `later` IS ADVICE, NOT PRECEDENCE.  It is parsed, kept and
//        handed on verbatim; `claims/supersede.ts` decides who supersedes whom
//        from `stated_at` alone and records any disagreement rather than
//        silently taking either side. Nothing here writes a row.
//
// Sonnet-5, 1 turn, no tools, thinking off, 60 s — transcribed from §12.7 and
// built into `ag3SendOptions` so no call site can quietly raise any of them.
// ===========================================================================

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import { neutraliseLabel } from "../wire/pack.js";
import type { WireRecord } from "../wire/codec.js";
import type { WireSkip, WireViolation } from "../wire/tolerance.js";
import { legendFor } from "./legend.js";

/** §12.7 "Settings", transcribed. */
export const P_AG3 = {
  id: "P-AG3",
  /** A valid `runs.role` — this call's spend is claim spend. */
  role: "claim",
  model: "sonnet-5",
  /** "1 turn". */
  turns: 1,
  /** "none" — it reads the pair it is given and nothing else. */
  tools: "none",
  thinking: "off",
  /** "60 s". */
  timeoutSeconds: 60,
  /** "1 pair". */
  maxPairsPerCall: 1,
  /** "400 max out". */
  maxOutputTokens: 400,
  /** §9.5.1 — an adjudication is never what the user is waiting on. */
  onCriticalPath: false,
} as const;

/** The one tag this call may emit. Anything else is counted, never applied. */
export const P_AG3_TAGS = ["V.claim"] as const;

/** §12.7 SYSTEM, verbatim. */
export const P_AG3_SYSTEM = `You decide the relationship between two claims about the same subject.

  dup duplicate · rfn refinement · ctr contradiction · dst distinct · un unsure

RULES
- Time matters. "Lived in Ratlam" and "lives in Bangalore" contradict only if
  both are asserted as current. If one is clearly past they are distinct with
  different validity windows.
- A preference changing over time IS a contradiction. Record it so the earlier
  one closes with a date, never deleted.
- CRITICAL: judge ONLY by stated_at — when each was SAID. Data does not arrive
  in order: history is read newest-first, sources connect at different times,
  delayed syncs land late. Either claim may be the older one. Never assume the
  incoming one is newer and never reason about which was recorded first.
- Say which claim describes the LATER state, and give a validity end for the
  earlier one where one is implied.

OUTPUT
  V | <a> | <b> | <dup|rfn|ctr|dst|un> | <later: a|b|-> | <valid_to earlier>
    | <conf> | <reason>`;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function ag3Legend(): string {
  return legendFor({ callType: P_AG3.id, tags: [...P_AG3_TAGS], aliases: ["entity"] });
}

/** legend + §12.7 SYSTEM. Byte-identical on every call, so it caches (§5.9.4). */
export function buildAg3System(): string {
  return [ag3Legend(), P_AG3_SYSTEM].join("\n\n");
}

// ---- the call --------------------------------------------------------------

/** One side of the pair. `A` is what is stored, `B` is what came in. */
export interface Ag3Claim {
  /** The real `claim_versions.id`. Never sent — the wire says `A` or `B`. */
  id: string;
  /** The wire tag for the kind (`F`, `P`, …). The kind IS the tag (§5.3). */
  tag: string;
  /** The claim, in the model's own words. Never re-written here. */
  text: string;
  /** `claim_versions.stated_at` — when it was SAID. Printed for both sides. */
  statedAt: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  /** A verbatim evidence quote, if the caller has one to show. */
  quote?: string | null;
}

export interface Ag3Subject {
  /** The real `entities.id`, or null when the subject is only a hint. */
  entityId: string | null;
  name: string | null;
  /** `per`, `org`, … printed as given. */
  type?: string | null;
}

export interface Ag3Input {
  subject: Ag3Subject;
  /** The claim already in `claim_versions`. */
  stored: Ag3Claim;
  /** The claim the write path is holding. Storage order, NOT time order. */
  incoming: Ag3Claim;
  /**
   * The CALIBRATED similarity that nominated this pair. Never a raw cosine and
   * never a guess: a pair whose score was not measured prints `-`.
   */
  similarity?: number | null;
}

export interface Ag3Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** The a-alias the subject was minted as, or `-` for a hint-only subject. */
  subjectAlias: string;
  /** `A` → stored id, `B` → incoming id. How a verdict becomes a row. */
  claimIds: { A: string; B: string };
}

function dateText(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? "-" : neutraliseLabel(text);
}

function scoreText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-";
}

function claimLine(role: "A stored  " | "B incoming", claim: Ag3Claim): string {
  const parts = [
    `${role} ${neutraliseLabel(claim.tag || "-")} "${neutraliseLabel(claim.text)}"`,
    `said ${dateText(claim.statedAt)}`,
    `valid ${dateText(claim.validFrom)} / ${dateText(claim.validTo)}`,
  ];
  const quote = typeof claim.quote === "string" ? neutraliseLabel(claim.quote) : "";
  if (quote !== "") parts.push(`"${quote}"`);
  return parts.join(" · ");
}

/**
 * The USER block, in §12.7's shape:
 *
 *     SUBJ a2 Rahul Arora per
 *     A stored   F "Lives in Indiranagar." said … · valid - / - · "…"
 *     B incoming F "Lives in Koramangala." said … · valid - / - · "…"
 *     sim 0.71
 */
export function buildAg3User(input: Ag3Input, table: AliasTable): string {
  const subject = input.subject;
  const alias = subject.entityId ? table.mint("entity", subject.entityId, subject.name ?? undefined) : "-";
  const head = [
    "SUBJ",
    alias,
    neutraliseLabel(subject.name ?? "-"),
    neutraliseLabel(subject.type ?? "-"),
  ].join(" ");
  return [
    head,
    claimLine("A stored  ", input.stored),
    claimLine("B incoming", input.incoming),
    `sim ${scoreText(input.similarity)}`,
  ].join("\n");
}

/** Build the call. One pair in, one alias table out, nothing persisted. */
export function buildAg3Prompt(input: Ag3Input, table?: AliasTable): Ag3Prompt {
  const aliasTable = table ?? createAliasTable();
  const user = buildAg3User(input, aliasTable);
  return {
    system: buildAg3System(),
    user,
    table: aliasTable,
    subjectAlias: input.subject.entityId
      ? (aliasTable.tokenFor("entity", input.subject.entityId) ?? "-")
      : "-",
    claimIds: { A: input.stored.id, B: input.incoming.id },
  };
}

/** The provider knobs §12.7 fixes. Built here so no call site can raise them. */
export interface Ag3SendShape {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: "off";
  /** No tools: a plain completion, not an agent turn. */
  plainCompletion: true;
}

export function ag3SendOptions(): Ag3SendShape {
  return {
    model: P_AG3.model,
    maxTurns: P_AG3.turns,
    timeoutMs: P_AG3.timeoutSeconds * 1_000,
    maxOutputTokens: P_AG3.maxOutputTokens,
    thinkingBudget: "off",
    plainCompletion: true,
  };
}

// ---- the answer ------------------------------------------------------------

/** The stored long forms of §12.7's five codes. */
export type Ag3Relation = "duplicate" | "refinement" | "contradiction" | "distinct" | "unsure";

const RELATIONS = new Set<Ag3Relation>([
  "duplicate",
  "refinement",
  "contradiction",
  "distinct",
  "unsure",
]);

export interface Ag3Verdict {
  /** The refs the model wrote — normally `A` and `B`. */
  aRef: string;
  bRef: string;
  /** Resolved ids, or null when the model named a side this call did not send. */
  aId: string | null;
  bId: string | null;
  relation: Ag3Relation;
  /**
   * Which side the model says describes the LATER state — `A`, `B` or null.
   * ADVICE. `stated_at` decides precedence; this is kept so a disagreement can
   * be recorded instead of discarded.
   */
  later: "A" | "B" | null;
  /** The validity end the model implied for the earlier claim, or null. */
  validTo: string | null;
  confidence: number | null;
  reason: string;
  /** The model's own line, byte-for-byte (build rule 9). */
  raw: string;
  line: number;
}

export interface Ag3Answer {
  /** §12.7: ONE line. The first well-formed verdict about this pair. */
  verdict: Ag3Verdict | null;
  /** Further verdicts, kept rather than deleted — code orders, never censors. */
  extra: Ag3Verdict[];
  /** Verdicts naming a claim this call was not about. Never reassigned. */
  orphans: Ag3Verdict[];
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

function sideOf(raw: string, claimIds: { A: string; B: string }): { ref: string; id: string | null } {
  const ref = raw.trim();
  const upper = ref.toUpperCase();
  if (upper === "A") return { ref, id: claimIds.A };
  if (upper === "B") return { ref, id: claimIds.B };
  if (ref === claimIds.A) return { ref, id: claimIds.A };
  if (ref === claimIds.B) return { ref, id: claimIds.B };
  return { ref, id: null };
}

function laterOf(raw: string): "A" | "B" | null {
  const t = raw.trim().toUpperCase();
  return t === "A" || t === "B" ? t : null;
}

/**
 * Parse a P-AG3 answer. Never throws.
 *
 * A verdict whose refs are not this call's pair is an ORPHAN: it is reported,
 * never applied to the pair that WAS asked about (§5.8.6). Every other line
 * the parser judged lands in `otherRecords` or `violations`, so the sum of the
 * buckets is the model's whole answer.
 */
export function parseAg3Response(
  response: unknown,
  claimIds: { A: string; B: string },
): Ag3Answer {
  const parse = parseWire(response);
  const good: Ag3Verdict[] = [];
  const orphans: Ag3Verdict[] = [];
  const otherRecords: WireRecord[] = [];

  for (const record of parse.records) {
    if (record.variant !== "V.claim") {
      otherRecords.push(record);
      continue;
    }
    const values = record.values;
    const stored = str(values.verdict) as Ag3Relation;
    if (!RELATIONS.has(stored)) {
      otherRecords.push(record);
      continue;
    }
    const a = sideOf(str(values.claim_a), claimIds);
    const b = sideOf(str(values.claim_b), claimIds);
    const verdict: Ag3Verdict = {
      aRef: a.ref,
      bRef: b.ref,
      aId: a.id,
      bId: b.id,
      relation: stored,
      later: laterOf(str(values.later)),
      validTo: str(values.valid_to) === "" ? null : str(values.valid_to),
      confidence: typeof values.confidence === "number" ? values.confidence : null,
      reason: str(values.reason),
      raw: record.raw,
      line: record.line,
    };
    if (verdict.aId === null || verdict.bId === null) orphans.push(verdict);
    else good.push(verdict);
  }

  return {
    verdict: good[0] ?? null,
    extra: good.slice(1),
    orphans,
    otherRecords,
    violations: parse.violations,
    skipped: parse.skipped,
    parse,
  };
}

/**
 * Every line of the answer, counted. `records + violations` is what the parser
 * saw; the four buckets are where each one went. The write path asserts these
 * are equal, which is how "zero model output discarded by code" is MEASURED
 * rather than asserted (evals R-040).
 */
export function ag3Accounts(answer: Ag3Answer): { seen: number; kept: number; balanced: boolean } {
  const seen =
    answer.parse.records.length + answer.parse.violations.length + answer.parse.skipped.length;
  const kept =
    (answer.verdict ? 1 : 0) +
    answer.extra.length +
    answer.orphans.length +
    answer.otherRecords.length +
    answer.violations.length +
    answer.skipped.length;
  return { seen, kept, balanced: seen === kept };
}
