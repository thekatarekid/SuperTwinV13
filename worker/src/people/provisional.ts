// ===========================================================================
// [CODE] Provisional people — V6 P1 S5.4 (Product_V6 §11.5 "Entities and
// provisional people", Product_V6_Phase1 §11.3, ROL-09, CRM-03).
//
// 1. Any resolved-enough mention creates a PROVISIONAL person: a name plus
//    context anchors (who mentioned them, in which stream, the phrase), no
//    identifiers needed. "Vivaan", "Priya's landlord", a cousin.
// 2. Provisional people MERGE FORWARD when an identifier or a confirmation
//    arrives: a new WhatsApp actor whose push name matches a name-only person
//    is the same person — retrieve the candidates, then judge: one candidate
//    merges (tombstone, undoable), several queue a question, none does
//    nothing. The identified entity survives; the mention-born one redirects.
// 3. Relationship hints ("likely Isha's son") ride along as anchors with a
//    confidence UNDER 1.0 and never become a claim here — the extract pass
//    writes claims, with evidence, when the text supports one.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { findIdentity, identitiesOf, normaliseAlias, putIdentity, type IdentityKind } from "../entities/identities.js";
import { mergeEntities, queueResolution, type MergeResult } from "../entities/merge.js";
import { createEntity, getEntity, listEntities, resolveEntityId, touchEntity, type EntityRow } from "../entities/registry.js";
import type { RosterPerson } from "./roles.js";

const DECIDER = "code:provisional";

/** Tokens that look like names but are not people. Lower-case. */
const NOT_NAMES = new Set([
  "i",
  "the",
  "a",
  "an",
  "ok",
  "okay",
  "yes",
  "no",
  "haan",
  "nahi",
  "sab",
  "aaj",
  "kal",
  "sept",
  "sep",
  "oct",
  "nov",
  "dec",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "sat",
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "goa",
  "airbnb",
  "uber",
  "zepto",
  "school",
  "annual",
  "day",
]);

/** Possessive or subject markers that make a capitalised token a person mention. */
const PERSON_MARKERS = /\b(ke|ka|ki|ko|ne|se|'s|s')\b/i;

export interface NameMention {
  name: string;
  /** The phrase around the name, verbatim. */
  phrase: string;
  /** Anchor hints: possessive context, school/kid words. */
  hints: string[];
}

/**
 * Capitalised tokens in a message that are NOT on the roster and read as a
 * person (followed by a possessive/subject marker, or a two-token proper
 * name). Pure. The caller decides whether to mint a provisional person.
 */
export function unknownNameMentions(text: string, roster: readonly RosterPerson[]): NameMention[] {
  const known = new Set<string>();
  for (const p of roster) for (const n of [p.name, ...(p.aliases ?? [])]) known.add(n.toLowerCase());
  const tokens = text.split(/\s+/);
  const out: NameMention[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i]!.replace(/^[@"'(]+|[",.!?:;)]+$/g, "");
    if (!/^[A-Z][a-z]{2,}$/.test(raw)) continue;
    const lower = raw.toLowerCase();
    if (i === 0 && !PERSON_MARKERS.test(tokens.slice(1, 3).join(" "))) {
      // Sentence-initial capitals need a marker to count.
      if (!PERSON_MARKERS.test(tokens[i + 1] ?? "")) continue;
    }
    if (known.has(lower) || NOT_NAMES.has(lower)) continue;
    const next = tokens[i + 1] ?? "";
    const marker = PERSON_MARKERS.test(next);
    const twoToken = /^[A-Z][a-z]{2,}$/.test(next.replace(/[",.!?]+$/g, "")) && !NOT_NAMES.has(next.toLowerCase());
    if (!marker && !twoToken && i !== 0) continue;
    const hints: string[] = [];
    if (marker) hints.push(`possessive/subject marker "${next}"`);
    if (/\b(school|class|kid|bacha|bachha|beta|beti|son|daughter|annual day|exam)\b/i.test(text)) hints.push("child/school context");
    out.push({ name: twoToken ? `${raw} ${next.replace(/[",.!?]+$/g, "")}` : raw, phrase: text, hints });
  }
  return out;
}

export interface MintProvisionalParams {
  name: string;
  /** Who said it (entity id or roster ref) and where. */
  mentionedBy: string | null;
  streamKey: string | null;
  /** Verbatim phrase(s). */
  phrases: string[];
  eventIds?: string[];
  /** A code hint, e.g. {relation:"child_of", of:"isha", confidence:0.6}. Never a claim. */
  relationshipHint?: { relation: string; of: string; confidence: number } | null;
  runId?: string | null;
  seenAt?: string | null;
}

export interface ProvisionalResult {
  entity: EntityRow;
  created: boolean;
  anchors: Record<string, unknown>;
}

/**
 * Find or mint the provisional person for a name. Same-name provisional people
 * are one person until an identifier says otherwise (they carry none). A
 * confirmed entity with that canonical wins outright — the mention is theirs.
 */
export function mintProvisionalPerson(p: MintProvisionalParams): ProvisionalResult {
  const db = getDb();
  const name = p.name.trim();
  const seenAt = p.seenAt ?? new Date().toISOString();
  const anchors = {
    mentioned_by: p.mentionedBy,
    stream: p.streamKey,
    phrases: p.phrases,
    event_ids: p.eventIds ?? [],
    relationship_hint: p.relationshipHint ?? null,
  };
  const existing = db
    .prepare(`SELECT id FROM entities WHERE type = 'person' AND merged_into IS NULL AND LOWER(canonical) = LOWER(?) ORDER BY provisional ASC, created_at ASC LIMIT 1`)
    .get(name) as { id: string } | undefined;
  if (existing) {
    touchEntity(existing.id, seenAt);
    writeDecision({
      runId: p.runId ?? null,
      pass: DECIDER,
      targetKind: "entity",
      targetId: existing.id,
      action: "anchor",
      old: null,
      new: anchors,
      reason: "another mention of a known name — anchors appended, no second person",
      confidence: 0.8,
    });
    return { entity: getEntity(existing.id)!, created: false, anchors };
  }
  const row = createEntity({ type: "person", canonical: name, provisional: true, seenAt });
  putIdentity({ entityId: row.id, sourceId: null, kind: "alias", value: name, confidence: 0.6, decidedBy: DECIDER });
  writeDecision({
    runId: p.runId ?? null,
    pass: DECIDER,
    targetKind: "entity",
    targetId: row.id,
    action: "create",
    old: null,
    new: { canonical: name, provisional: true, ...anchors },
    reason: p.relationshipHint
      ? `mentioned by name, no identifier; likely ${p.relationshipHint.relation.replace("_", " ")} ${p.relationshipHint.of} (${p.relationshipHint.confidence})`
      : "mentioned by name, no identifier",
    confidence: p.relationshipHint?.confidence ?? 0.7,
  });
  return { entity: row, created: true, anchors };
}

/** Anchors recorded for a person across its decision rows (the card's "how I know them"). */
export function anchorsOf(entityId: string): Record<string, unknown>[] {
  const id = resolveEntityId(entityId);
  if (!id) return [];
  const rows = getDb()
    .prepare(`SELECT new_json FROM decisions WHERE target_kind = 'entity' AND target_id = ? AND action IN ('create','anchor') AND pass = ? ORDER BY created_at`)
    .all(id, DECIDER) as { new_json: string | null }[];
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!r.new_json) continue;
    try {
      out.push(JSON.parse(r.new_json) as Record<string, unknown>);
    } catch {
      /* tolerated */
    }
  }
  return out;
}

/** Name-only provisional people whose canonical (or alias) matches. Retrieval, rung 3. */
export function candidatesForName(name: string, opts: { provisionalOnly?: boolean } = {}): EntityRow[] {
  const n = normaliseAlias(name);
  if (n === "") return [];
  const first = n.split(" ")[0]!;
  return listEntities({ type: "person", provisional: opts.provisionalOnly ? true : undefined }).filter((e) => {
    const canon = e.canonical ? normaliseAlias(e.canonical) : "";
    if (canon === n) return true;
    if (canon.split(" ")[0] === first && (canon.split(" ").length === 1 || n.split(" ").length === 1)) return true;
    return identitiesOf(e.id).some((i) => i.kind === "alias" && i.valueNorm === n);
  });
}

export interface MergeForwardParams {
  /** The entity that now carries an identifier (phone/jid/email). */
  identifiedEntityId: string;
  /** The display name that came with the identifier. */
  name: string | null | undefined;
  kind: IdentityKind;
  value: string;
  runId?: string | null;
}

export interface MergeForwardResult {
  outcome: "merged" | "queued" | "none";
  merge?: MergeResult;
  questionId?: string;
  candidates: string[];
}

/**
 * CRM-03: an identifier arrives for a name the record only knew provisionally.
 * Retrieve (name-only provisional people with that name), then judge in code:
 *   one candidate  → merge forward (provisional → identified), decisions row
 *   two or more    → a "same person?" question, nothing merged
 *   none           → nothing
 * The identified entity is the survivor so the phone/jid stays where ingest
 * filed it; the provisional's anchors, mentions and claims follow the redirect.
 */
export function mergeForwardOnIdentifier(p: MergeForwardParams): MergeForwardResult {
  const name = (p.name ?? "").trim();
  const survivor = resolveEntityId(p.identifiedEntityId);
  if (name === "" || !survivor) return { outcome: "none", candidates: [] };
  const cands = candidatesForName(name, { provisionalOnly: true }).filter((e) => {
    if (e.id === survivor) return false;
    // A candidate that already carries a cross-source identifier is not name-only.
    return !identitiesOf(e.id).some((i) => i.kind === "phone" || i.kind === "jid" || i.kind === "email");
  });
  if (cands.length === 0) return { outcome: "none", candidates: [] };
  if (cands.length > 1) {
    const questionId = queueResolution({
      left: cands[0]!.id,
      right: survivor,
      question: `Is ${name} (${p.kind} ${p.value}) the same as one of the ${cands.length} people named ${name} mentioned earlier?`,
      options: [...cands.map((c) => c.id), "different"],
      reason: "code:merge_forward:ambiguous",
    });
    return { outcome: "queued", questionId, candidates: cands.map((c) => c.id) };
  }
  const loser = cands[0]!;
  const merge = mergeEntities({
    loser: loser.id,
    winner: survivor,
    actor: "code:merge_forward",
    runId: p.runId ?? null,
    reason: `identifier arrived: ${p.kind} ${p.value} for "${name}" — the mention-born person is this person`,
  });
  if (merge.merged) {
    writeDecision({
      runId: p.runId ?? null,
      pass: DECIDER,
      targetKind: "entity",
      targetId: loser.id,
      action: "merge_forward",
      old: { merged_into: null },
      new: { merged_into: survivor, identifier: { kind: p.kind, value: p.value } },
      reason: `provisional "${name}" merged forward on ${p.kind}`,
      confidence: 0.9,
    });
    // The survivor is no longer provisional: a second, independent touch.
    getDb().prepare(`UPDATE entities SET provisional = 0 WHERE id = ?`).run(survivor);
  }
  return { outcome: merge.merged ? "merged" : "none", merge, candidates: [loser.id] };
}

/** True when an identity value is already bound somewhere (a merge candidate, not an error). */
export function identityAlreadyBound(sourceId: string | null, kind: IdentityKind, value: string): boolean {
  return findIdentity(sourceId, kind, value) !== null;
}
