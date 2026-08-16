// ===========================================================================
// [CODE] Reading a P-CL1 / P-CL1Δ answer — arch §12.4, §12.5, §11.3. Item 3.1.
//
// This module turns the model's wire lines into a PLAN. It does not write a
// row, does not derive a state, does not decide a triage class and does not
// touch a clock. Everything it produces is what the model said, resolved
// against the prompt-local alias table and nothing else.
//
// FOUR INVARIANTS, ALL TESTED
//
//   ZERO MODEL OUTPUT DISCARDED.  Every parsed record lands in exactly one
//        bucket — claims, loops, summaries, updates, questions, unsupported,
//        or `otherRecords` — and `extractionAccounts()` asserts the sum. A
//        claim the model emitted with no evidence is REPORTED, byte-for-byte,
//        never deleted and never quietly written (evals M-088..091).
//
//   THE CLAIM KIND IS THE TAG.  `CLAIM_KIND_BY_TAG` is the whole mapping.
//        There is no `kind` field on the wire, so there is nothing to misspell
//        and nothing to validate (§5.3).
//
//   UNKNOWN BEATS WRONG.  A subject alias outside the roster resolves to
//        `null` by RANGE CHECK (§5.2.2), never to the nearest name. `+<hint>`
//        carries the model's own description into `subject_hint`, which is a
//        string and is never an id.
//
//   NOTHING IS REWRITTEN.  A claim that still carries "she" is FLAGGED, not
//        corrected. Code orders model output; it never edits it (build rule 9).
//        Precedence, when this plan is applied, is `stated_at` — the event ts
//        — and never `ingested_at`.
//
// State, triage and party_pair are absent from every type in this file on
// purpose: they are code facts, and they belong to item 3.2.
// ===========================================================================

import type { AliasTable } from "../wire/aliases.js";
import type { WireRecord } from "../wire/codec.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import type { WireSkip, WireViolation } from "../wire/tolerance.js";

// ---- the eight kinds -------------------------------------------------------

export const CLAIM_KIND_BY_TAG = {
  F: "fact",
  P: "preference",
  B: "belief",
  O: "opinion",
  I: "interest",
  R: "recommendation",
  H: "habit",
  W: "workflow",
} as const;

export type ClaimKind = (typeof CLAIM_KIND_BY_TAG)[keyof typeof CLAIM_KIND_BY_TAG];
export type ClaimTag = keyof typeof CLAIM_KIND_BY_TAG;

export const CLAIM_TAGS = Object.keys(CLAIM_KIND_BY_TAG) as ClaimTag[];

export function isClaimTag(tag: unknown): tag is ClaimTag {
  return typeof tag === "string" && Object.prototype.hasOwnProperty.call(CLAIM_KIND_BY_TAG, tag);
}

/** The stored long form for a tag, or null. The tag IS the kind (§5.3). */
export function claimKindForTag(tag: unknown): ClaimKind | null {
  return isClaimTag(tag) ? CLAIM_KIND_BY_TAG[tag] : null;
}

// ---- targets ---------------------------------------------------------------

/**
 * What a subject / owner / counterparty field resolved to.
 *
 * `absent` and `hint` are both ANSWERS: the model told us it does not know who,
 * with or without a description. `unresolved` is an alias outside the roster —
 * reported, never guessed (§5.8.6).
 */
export type ClaimTarget =
  | { kind: "self"; token: string }
  | { kind: "entity"; token: string; entityId: string }
  /** `+Rohan Mehta` or `+Pranjali's landlord` — a hint, and never an id. */
  | { kind: "hint"; token: string; hint: string }
  | { kind: "absent"; token: string }
  | { kind: "unresolved"; token: string };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function resolveTarget(raw: unknown, table: AliasTable): ClaimTarget {
  const token = str(raw).trim();
  const resolution = table.resolve(token);
  const ref = resolution.resolved;
  if (ref) {
    if (ref.kind === "self") return { kind: "self", token };
    if (ref.kind === "minted") {
      const hint = (ref.name ?? "").trim();
      return hint === "" ? { kind: "absent", token } : { kind: "hint", token, hint };
    }
    if (ref.kind === "entity" && ref.id) return { kind: "entity", token, entityId: ref.id };
    return { kind: "unresolved", token };
  }
  if (resolution.unresolved === null) return { kind: "absent", token };
  return { kind: "unresolved", token: resolution.unresolved };
}

/** The entity id a target names, or null. `self` is the me entity's own token. */
export function targetEntityId(target: ClaimTarget): string | null {
  if (target.kind === "entity") return target.entityId;
  if (target.kind === "self") return "self";
  return null;
}

/** `subject_hint` — a string, never an id, and null unless the model gave one. */
export function targetHint(target: ClaimTarget): string | null {
  return target.kind === "hint" ? target.hint : null;
}

// ---- evidence --------------------------------------------------------------

export interface Evidence {
  /** Real event ids, in the order the model listed them. */
  eventIds: string[];
  /** Event tokens the table could not place. Reported alongside, never guessed. */
  unresolvedEvents: string[];
}

function evidenceFor(raw: unknown, table: AliasTable): Evidence {
  const numbers = Array.isArray(raw) ? (raw as unknown[]) : [];
  const eventIds: string[] = [];
  const unresolvedEvents: string[] = [];
  for (const n of numbers) {
    const token = typeof n === "number" && Number.isInteger(n) ? n.toString(36) : String(n);
    const id = table.eventId(token);
    if (id) eventIds.push(id);
    else unresolvedEvents.push(token);
  }
  return { eventIds, unresolvedEvents };
}

// ---- resolved third person -------------------------------------------------

/**
 * §12.4: "Write every claim in RESOLVED THIRD PERSON. Never leave 'me', 'she',
 * 'there' unresolved."
 *
 * This is a FLAG, not a filter. A claim carrying a stray pronoun is still the
 * model's answer and is still returned in full; the flag is what lets the
 * write path (item 3.3) ask again rather than store "she is doing better" with
 * nobody attached. Nothing here edits a character of the text.
 */
export const STRAY_PRONOUNS: readonly string[] = [
  "i", "i'm", "i'd", "i'll", "i've", "me", "my", "mine", "myself",
  "we", "we're", "we've", "us", "our", "ours",
  "you", "you're", "you've", "your", "yours",
  "he", "he's", "him", "his", "she", "she's", "her", "hers",
  "they", "they're", "them", "their", "theirs",
  "here", "there",
];

const STRAY_SET = new Set(STRAY_PRONOUNS);

/** Every stray pronoun in the text, lowercased, first-seen order. */
export function strayPronouns(text: unknown): string[] {
  const words = str(text).toLowerCase().split(/[^a-z'’]+/);
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/’/g, "'").replace(/^'+|'+$/g, "");
    if (word !== "" && STRAY_SET.has(word) && !out.includes(word)) out.push(word);
  }
  return out;
}

// ---- the parsed items ------------------------------------------------------

export interface ExtractedClaim extends Evidence {
  tag: ClaimTag;
  /** The stored long form. Derived from the tag, never from a field. */
  kind: ClaimKind;
  subject: ClaimTarget;
  /** `claim_versions.subject_id`, or null. NULL + a hint beats a wrong id. */
  subjectId: string | null;
  subjectHint: string | null;
  /** Stored long form: first_person | about_other | reported_speech | quoted_third_party. */
  attribution: string | null;
  /** An empty field on the wire already decoded to 0.9 (§5.1). */
  confidence: number | null;
  /** Only when the episode STATED a time bound. Never a default, never today. */
  validFrom: string | null;
  /** The model's words, verbatim. Language is never compressed (§5). */
  text: string;
  /** Pronouns the model left unresolved. A flag for 3.3, never a rewrite. */
  stray: string[];
  /** The model's own line, byte-for-byte. */
  raw: string;
  line: number;
}

export interface ExtractedLoop extends Evidence {
  owner: ClaimTarget;
  ownerId: string | null;
  ownerHint: string | null;
  counterparty: ClaimTarget;
  counterpartyId: string | null;
  counterpartyHint: string | null;
  /** explicit | implicit — "different products" (§10.5). */
  origin: string | null;
  /** i_owe_them | they_owe_me | shared | self. */
  direction: string | null;
  stake: string | null;
  horizon: string | null;
  /** ISO date or null. `null` is "not stated" — an invented due is forbidden. */
  due: string | null;
  /** "monthly" / "annual" / … verbatim, or null. */
  recurrence: string | null;
  confidence: number | null;
  intent: string;
  stray: string[];
  raw: string;
  line: number;
}

export interface ExtractedSummary {
  episodeAlias: string;
  /** Resolved from the e-alias, or null when the model named one we did not send. */
  episodeId: string | null;
  summary: string;
  raw: string;
  line: number;
}

/** A `Z` line — delta mode only (§12.5). */
export interface ExtractedUpdate extends Evidence {
  /** `H1` / `T1`, as the model wrote it. */
  refAlias: string;
  /** The real claim/loop id when the caller supplied a map, else null. */
  refId: string | null;
  /** contradicted | dated | completed | cancelled | refined. */
  change: string | null;
  note: string;
  raw: string;
  line: number;
}

export interface ExtractedQuestion {
  about: string;
  question: string;
  raw: string;
  line: number;
}

/** An item the model emitted that cites no event this prompt sent. */
export interface UnsupportedItem {
  tag: string;
  reason: "no_evidence";
  /** The tokens it did cite, if any — all of them unplaceable. */
  unresolvedEvents: string[];
  raw: string;
  line: number;
}

export interface Cl1Answer {
  claims: ExtractedClaim[];
  loops: ExtractedLoop[];
  summaries: ExtractedSummary[];
  updates: ExtractedUpdate[];
  questions: ExtractedQuestion[];
  /**
   * §12.4: "Every claim and loop MUST cite ≥1 event." These cited none that
   * this prompt sent, so they cannot be written — evals M-088..091. They are
   * kept here verbatim so the repair round can re-ask them and so an audit can
   * see exactly what the model said.
   */
  unsupported: UnsupportedItem[];
  /** Tags this call may not emit. Counted and kept, never deleted. */
  otherRecords: WireRecord[];
  violations: WireViolation[];
  skipped: WireSkip[];
  parse: WireParseResult;
}

export interface ParseCl1Options {
  /**
   * `H1` → real id, from the delta prompt's `itemIds`. Absent in pass 1, where
   * there is nothing to update yet.
   */
  itemIds?: Readonly<Record<string, string>>;
  /**
   * Reject `Z` lines in a non-delta answer. Pass 1 has no prior items, so a Z
   * there is a tag this call may not emit — counted, not applied.
   */
  allowUpdates?: boolean;
}

// ---- the parse -------------------------------------------------------------

function claimFrom(record: WireRecord, table: AliasTable): ExtractedClaim {
  const v = record.values;
  const tag = record.tag as ClaimTag;
  const subject = resolveTarget(v.subject, table);
  const text = str(v.text);
  return {
    ...evidenceFor(v.events, table),
    tag,
    kind: CLAIM_KIND_BY_TAG[tag],
    subject,
    subjectId: targetEntityId(subject),
    subjectHint: targetHint(subject),
    attribution: str(v.attribution) === "" ? null : str(v.attribution),
    confidence: num(v.confidence),
    validFrom: str(v.valid_from) === "" ? null : str(v.valid_from),
    text,
    stray: strayPronouns(text),
    raw: record.raw,
    line: record.line,
  };
}

function loopFrom(record: WireRecord, table: AliasTable): ExtractedLoop {
  const v = record.values;
  const owner = resolveTarget(v.owner, table);
  const counterparty = resolveTarget(v.counterparty, table);
  const intent = str(v.intent);
  const recurrence = str(v.recurrence).trim();
  return {
    ...evidenceFor(v.events, table),
    owner,
    ownerId: targetEntityId(owner),
    ownerHint: targetHint(owner),
    counterparty,
    counterpartyId: targetEntityId(counterparty),
    counterpartyHint: targetHint(counterparty),
    origin: str(v.origin) === "" ? null : str(v.origin),
    direction: str(v.direction) === "" ? null : str(v.direction),
    stake: str(v.stake) === "" ? null : str(v.stake),
    horizon: str(v.horizon) === "" ? null : str(v.horizon),
    due: str(v.due) === "" ? null : str(v.due),
    recurrence: recurrence === "" ? null : recurrence,
    confidence: num(v.confidence),
    intent,
    stray: strayPronouns(intent),
    raw: record.raw,
    line: record.line,
  };
}

function unsupported(record: WireRecord, unresolvedEvents: string[]): UnsupportedItem {
  return {
    tag: record.tag,
    reason: "no_evidence",
    unresolvedEvents,
    raw: record.raw,
    line: record.line,
  };
}

/**
 * Parse a P-CL1 (or P-CL1Δ) answer. Never throws, for any input at all (§5.8.5).
 *
 * `table` is the prompt-local table the call was built with. It is the only
 * thing the answer is read against: an alias outside its range is "the model
 * did not say", which reads honestly and can never become a mis-attribution.
 */
export function parseCl1Response(
  response: unknown,
  table: AliasTable,
  options: ParseCl1Options = {},
): Cl1Answer {
  const parse = parseWire(response);
  const claims: ExtractedClaim[] = [];
  const loops: ExtractedLoop[] = [];
  const summaries: ExtractedSummary[] = [];
  const updates: ExtractedUpdate[] = [];
  const questions: ExtractedQuestion[] = [];
  const unsupportedItems: UnsupportedItem[] = [];
  const otherRecords: WireRecord[] = [];

  for (const record of parse.records) {
    if (isClaimTag(record.tag)) {
      const claim = claimFrom(record, table);
      if (claim.eventIds.length === 0) unsupportedItems.push(unsupported(record, claim.unresolvedEvents));
      else claims.push(claim);
      continue;
    }

    switch (record.tag) {
      case "T": {
        const loop = loopFrom(record, table);
        if (loop.eventIds.length === 0) unsupportedItems.push(unsupported(record, loop.unresolvedEvents));
        else loops.push(loop);
        break;
      }
      case "Y": {
        const alias = str(record.values.episode).trim();
        const ref = table.resolve(alias).resolved;
        summaries.push({
          episodeAlias: alias,
          episodeId: ref && ref.kind === "episode" ? ref.id : null,
          summary: str(record.values.summary),
          raw: record.raw,
          line: record.line,
        });
        break;
      }
      case "Z": {
        if (options.allowUpdates !== true) {
          otherRecords.push(record);
          break;
        }
        const alias = str(record.values.ref).trim();
        const key = alias.toUpperCase();
        updates.push({
          ...evidenceFor(record.values.events, table),
          refAlias: alias,
          refId: options.itemIds?.[key] ?? null,
          change: str(record.values.change) === "" ? null : str(record.values.change),
          note: str(record.values.note),
          raw: record.raw,
          line: record.line,
        });
        break;
      }
      case "Q":
        questions.push({
          about: str(record.values.about).trim(),
          question: str(record.values.question),
          raw: record.raw,
          line: record.line,
        });
        break;
      default:
        // A tag from another pass. Counted and kept verbatim (build rule 9).
        otherRecords.push(record);
        break;
    }
  }

  return {
    claims,
    loops,
    summaries,
    updates,
    questions,
    unsupported: unsupportedItems,
    otherRecords,
    violations: parse.violations,
    skipped: parse.skipped,
    parse,
  };
}

/** Delta answers, with `Z` enabled and the prompt's `itemIds` map wired in. */
export function parseCl1DeltaResponse(
  response: unknown,
  table: AliasTable,
  itemIds: Readonly<Record<string, string>> = {},
): Cl1Answer {
  return parseCl1Response(response, table, { itemIds, allowUpdates: true });
}

// ---- accounting ------------------------------------------------------------

export interface ExtractionCounts {
  records: number;
  claims: number;
  loops: number;
  summaries: number;
  updates: number;
  questions: number;
  unsupported: number;
  other: number;
}

export function extractionCounts(answer: Cl1Answer): ExtractionCounts {
  return {
    records: answer.parse.records.length,
    claims: answer.claims.length,
    loops: answer.loops.length,
    summaries: answer.summaries.length,
    updates: answer.updates.length,
    questions: answer.questions.length,
    unsupported: answer.unsupported.length,
    other: answer.otherRecords.length,
  };
}

/**
 * MODEL OUTPUT DISCARDED BY CODE == ZERO. Every parsed record is in exactly one
 * bucket. If this is ever false, something was dropped, and dropping is the one
 * thing this pipeline may not do.
 */
export function extractionAccounts(answer: Cl1Answer): boolean {
  const c = extractionCounts(answer);
  return (
    c.claims + c.loops + c.summaries + c.updates + c.questions + c.unsupported + c.other === c.records
  );
}

// ---- merging a batch -------------------------------------------------------

/** Concatenate answers from several calls, in call order. Nothing is deduped. */
export function mergeCl1Answers(answers: readonly Cl1Answer[]): Omit<Cl1Answer, "parse"> {
  const out: Omit<Cl1Answer, "parse"> = {
    claims: [],
    loops: [],
    summaries: [],
    updates: [],
    questions: [],
    unsupported: [],
    otherRecords: [],
    violations: [],
    skipped: [],
  };
  for (const a of answers) {
    out.claims.push(...a.claims);
    out.loops.push(...a.loops);
    out.summaries.push(...a.summaries);
    out.updates.push(...a.updates);
    out.questions.push(...a.questions);
    out.unsupported.push(...a.unsupported);
    out.otherRecords.push(...a.otherRecords);
    out.violations.push(...a.violations);
    out.skipped.push(...a.skipped);
  }
  return out;
}

// ---- parallel by episode, apply serialized ---------------------------------

/**
 * §12.4 / build item 3.1: "Parallel by episode, apply serialized."
 *
 * Calls run concurrently up to `concurrency`; results come back IN INPUT ORDER,
 * so the caller applies them one at a time in a deterministic sequence. That
 * ordering is what makes the write path confluent (item 3.3): the same
 * episodes produce the same rows no matter which call finished first.
 *
 * A worker that throws yields a rejected slot rather than taking the batch
 * down — one bad episode never stops the other three.
 */
export interface ParallelSlot<R> {
  index: number;
  ok: boolean;
  value?: R;
  error?: Error;
}

export async function extractInParallel<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 4,
): Promise<ParallelSlot<R>[]> {
  const width = Math.max(1, Math.floor(concurrency));
  const slots: ParallelSlot<R>[] = items.map((_, index) => ({ index, ok: false }));
  let next = 0;

  async function pump(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        slots[index] = { index, ok: true, value: await worker(items[index], index) };
      } catch (err) {
        slots[index] = { index, ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => pump()));
  return slots;
}

/** The successful values, in input order — what the serialized apply consumes. */
export function serializedResults<R>(slots: readonly ParallelSlot<R>[]): R[] {
  const out: R[] = [];
  for (const slot of slots) if (slot.ok && slot.value !== undefined) out.push(slot.value);
  return out;
}
