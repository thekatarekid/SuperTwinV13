// ===========================================================================
// [LLM-M] P-EP1 — the entity pass — arch §12.1. Build item 1.10.
//
// One call per session. It answers three questions and nothing else:
//
//   M  MENTIONS      every textual reference, linked to a roster alias, or
//                    left at `-` with a hint. UNKNOWN BEATS WRONG.
//   N  NEW ENTITIES  things clearly referred to but absent from the roster.
//                    The model mints `k1`, `k2` … ITSELF; this file resolves
//                    those temp ids to real ids after dedupe (§5.2 `k` is the
//                    "proposed" namespace, and it never leaves the prompt).
//   L  EDGES         durable structural relations, each with a verbatim quote.
//   Q  QUESTIONS     what it could not settle, for the resolution queue.
//
// TEMP IDS ARE NOT IDS. `k1` is a token inside one answer. `mintProposals`
// turns the N lines into real entities — deduping within the answer and
// against the roster by EXACT normalised name plus type, never by similarity —
// and `resolveProposed` then rewrites the M and L targets. A `k` that was
// cited with no N line of its own is REPORTED as dangling, never invented:
// §12.1 says "every k you cite needs its own N line", so a k without one is a
// hole in the answer, not a licence to guess which entity was meant.
//
// Nothing here writes a mention, an edge or a decision. Parsing produces a
// plan; `entities/` performs it. That split is what lets the parser be total
// (§5.8: it never throws, on any input at all).
// ===========================================================================

import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { packPrompt, type PackInput, type PackOptions, type PackResult } from "../wire/pack.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import type { WireRecord } from "../wire/codec.js";
import type { WireViolation } from "../wire/tolerance.js";
import { normaliseIdentityValue } from "../entities/identities.js";
import {
  createEntity,
  isEdgeKind,
  isEntityType,
  resolveEntityId,
  type EdgeKind,
  type EntityType,
} from "../entities/registry.js";
import { legendFor } from "./legend.js";

/** §12.1 "Settings", transcribed. */
export const P_EP1 = {
  id: "P-EP1",
  role: "entity_pass",
  model: "sonnet-5",
  turns: 1,
  tools: "none",
  thinking: "off",
  timeoutSeconds: 120,
  /** "≤6 sessions or 8k in" — whichever cap is hit first closes the call. */
  maxSessionsPerCall: 6,
  maxInputTokens: 8_000,
  maxOutputTokens: 3_000,
} as const;

/** The four tags this call may emit. Anything else is a violation (§5.3). */
export const P_EP1_TAGS = ["M", "N", "L", "Q"] as const;

/** §12.1 SYSTEM, verbatim. */
export const P_EP1_SYSTEM = `You are the entity linker for a private personal-memory system.

TASKS
1. MENTIONS — every textual reference to a person, group, org, place, thing,
   media work, document, occasion or topic. Link each to a roster alias.
2. NEW ENTITIES — propose anything clearly referred to but absent from the
   roster. Mint k1, k2 … yourself; every k you cite needs its own N line.
3. EDGES — durable structural relations only. Every edge REQUIRES a quote.

RULES
- Unsure between two roster entries, or the referent is unclear? Emit the
  mention with "-" as the target and a hint. UNKNOWN BEATS WRONG.
- Resolve pronouns only within this stream block and only when unambiguous.
- Speaker identity is given per event. Never infer or contradict it.
- "[voice note, transcription pending]" and "[image, description pending]"
  are UNKNOWN content. Extract nothing from them. They are not empty
  messages and not acknowledgements.
- Do NOT emit edges for opinions, preferences, feelings or one-off actions.
  Those are claims, and another pass handles them.
- Propose a topic only if its surface form occurs 2+ times or matches the roster.

OUTPUT
  M | <ev> | <surface text> | <a-alias | k-alias | -> | <conf> [| <hint>]
  N | <k-alias> | <Name> | <type> [| <subtype>]
  L | <ev> | <src> | <edge> | <subtype> | <dst> | <conf> | <quote>
  Q | <about> | <question>
Values: type = per|grp|org|plc|thg|med|doc|occ|top
        edge = rel|aff|has|loc|prt|par|abt`;

/** The memoised legend for this call type (§5.9.4) — rendered, never copied. */
export function ep1Legend(): string {
  return legendFor({
    callType: P_EP1.id,
    tags: [...P_EP1_TAGS],
    aliases: ["entity", "proposed"],
  });
}

export interface Ep1Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** The packer's own report — roster size, streams, events, day blocks. */
  stats: Extract<PackResult, { ok: true }>["stats"];
}

/**
 * Build the call. The roster and the events go through the ordinary packer, so
 * P-EP1's USER block is byte-for-byte the shape §12.1 shows and the alias table
 * that comes back is the ONLY thing the answer may be read against.
 *
 * A roster over the packer's cap comes back as `null` rather than a truncated
 * prompt: dropping half a roster silently is how a model gets blamed for
 * linking to the wrong Amit.
 */
export function buildEp1Prompt(input: PackInput, options: PackOptions = {}): Ep1Prompt | null {
  const packed = packPrompt(input, options);
  if (!packed.ok) return null;
  return {
    system: `${ep1Legend()}\n\n${P_EP1_SYSTEM}`,
    user: packed.text,
    table: packed.table,
    stats: packed.stats,
  };
}

// ---- the answer ------------------------------------------------------------

/** A `k`-alias as the model wrote it. `k` is §5.2's "proposed" namespace. */
const PROPOSED_RE = /^k[0-9]+$/i;

export function isProposedAlias(token: unknown): boolean {
  return typeof token === "string" && PROPOSED_RE.test(token.trim());
}

export type Ep1Target =
  /** A roster alias that resolved to a real entity. */
  | { kind: "entity"; token: string; entityId: string }
  /** `k3` — a temp id, pending `mintProposals`. */
  | { kind: "proposed"; token: string; alias: string }
  /** `self`. The one entity that is never numbered. */
  | { kind: "self"; token: string }
  /** `-` — the model said "I do not know". That is an answer, not a failure. */
  | { kind: "absent"; token: string }
  /** A token that is not in the roster's range. Reported, never guessed. */
  | { kind: "unresolved"; token: string };

export interface Ep1Mention {
  /** Event ids, in the order the model listed them. */
  eventIds: string[];
  /** Event tokens the table could not place — reported alongside. */
  unresolvedEvents: string[];
  surface: string;
  target: Ep1Target;
  confidence: number | null;
  hint: string | null;
  raw: string;
}

export interface Ep1Proposal {
  /** `k1` — the model's own temp id. */
  alias: string;
  name: string;
  type: EntityType;
  subtype: string | null;
  raw: string;
}

export interface Ep1Link {
  eventIds: string[];
  unresolvedEvents: string[];
  src: Ep1Target;
  kind: EdgeKind;
  subtype: string | null;
  dst: Ep1Target;
  confidence: number | null;
  /** §12.1: "Every edge REQUIRES a quote." An edge without one is dropped. */
  quote: string;
  raw: string;
}

export interface Ep1Question {
  about: string;
  question: string;
  raw: string;
}

export interface Ep1Answer {
  mentions: Ep1Mention[];
  proposals: Ep1Proposal[];
  links: Ep1Link[];
  questions: Ep1Question[];
  /** Edges the model emitted with no quote — §12.1's one hard requirement. */
  quotelessLinks: Ep1Link[];
  /** N lines whose type was not in the closed set. Kept, never coerced. */
  untypedProposals: string[];
  /** `k` aliases cited by an M or L line that no N line declares. */
  danglingProposals: string[];
  /** Lines the parser judged but this call may not emit — counted, not dropped. */
  otherRecords: WireRecord[];
  violations: WireViolation[];
  parse: WireParseResult;
}

function targetFor(raw: unknown, table: AliasTable): Ep1Target {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (isProposedAlias(token)) {
    return { kind: "proposed", token, alias: token.toLowerCase() };
  }
  const resolution = table.resolve(token);
  if (resolution.resolved) {
    const ref = resolution.resolved;
    if (ref.kind === "self") return { kind: "self", token };
    if (ref.kind === "entity" && ref.id) return { kind: "entity", token, entityId: ref.id };
    return { kind: "unresolved", token };
  }
  if (resolution.unresolved === null) return { kind: "absent", token };
  return { kind: "unresolved", token: resolution.unresolved };
}

function eventsFor(
  raw: unknown,
  table: AliasTable,
): { eventIds: string[]; unresolvedEvents: string[] } {
  const numbers = Array.isArray(raw) ? (raw as number[]) : [];
  const eventIds: string[] = [];
  const unresolvedEvents: string[] = [];
  for (const n of numbers) {
    const token = Number.isInteger(n) ? n.toString(36) : String(n);
    const id = table.eventId(token);
    if (id) eventIds.push(id);
    else unresolvedEvents.push(token);
  }
  return { eventIds, unresolvedEvents };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function conf(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * Parse a P-EP1 answer. Never throws (§5.8): every line the codec rejects comes
 * back as a violation quoting the model verbatim, ready for the ONE repair
 * round, and every line this call may not emit is counted in `otherRecords`
 * rather than discarded — code orders model output, it never censors it.
 */
export function parseEp1Response(response: unknown, table: AliasTable): Ep1Answer {
  const parse = parseWire(response);
  const mentions: Ep1Mention[] = [];
  const proposals: Ep1Proposal[] = [];
  const links: Ep1Link[] = [];
  const questions: Ep1Question[] = [];
  const quotelessLinks: Ep1Link[] = [];
  const untypedProposals: string[] = [];
  const otherRecords: WireRecord[] = [];

  for (const record of parse.records) {
    const v = record.values;
    switch (record.tag) {
      case "M": {
        const ev = eventsFor(v.events, table);
        mentions.push({
          ...ev,
          surface: str(v.surface),
          target: targetFor(v.entity, table),
          confidence: conf(v.confidence),
          hint: typeof v.hint === "string" && v.hint !== "" ? v.hint : null,
          raw: record.raw,
        });
        break;
      }
      case "N": {
        const type = str(v.type);
        const alias = str(v.entity).trim().toLowerCase();
        if (!isEntityType(type) || !isProposedAlias(alias)) {
          untypedProposals.push(record.raw);
          break;
        }
        const subtype = str(v.subtype).trim();
        proposals.push({
          alias,
          name: str(v.name).trim(),
          type,
          subtype: subtype === "" || subtype === "-" ? null : subtype,
          raw: record.raw,
        });
        break;
      }
      case "L": {
        const ev = eventsFor(v.events, table);
        const kind = str(v.kind);
        if (!isEdgeKind(kind)) {
          otherRecords.push(record);
          break;
        }
        const subtype = str(v.subtype).trim();
        const link: Ep1Link = {
          ...ev,
          src: targetFor(v.src, table),
          kind,
          subtype: subtype === "" || subtype === "-" ? null : subtype,
          dst: targetFor(v.dst, table),
          confidence: conf(v.confidence),
          quote: str(v.quote).trim(),
          raw: record.raw,
        };
        if (link.quote === "") quotelessLinks.push(link);
        else links.push(link);
        break;
      }
      case "Q":
        questions.push({
          about: str(v.about).trim(),
          question: str(v.question).trim(),
          raw: record.raw,
        });
        break;
      default:
        // A claim tag in an entity answer belongs to another pass. It is
        // COUNTED and kept verbatim, never deleted (build rule 9).
        otherRecords.push(record);
        break;
    }
  }

  const declared = new Set(proposals.map((p) => p.alias));
  const cited = new Set<string>();
  for (const m of mentions) if (m.target.kind === "proposed") cited.add(m.target.alias);
  for (const l of [...links, ...quotelessLinks]) {
    if (l.src.kind === "proposed") cited.add(l.src.alias);
    if (l.dst.kind === "proposed") cited.add(l.dst.alias);
  }
  const danglingProposals = [...cited].filter((k) => !declared.has(k)).sort();

  return {
    mentions,
    proposals,
    links,
    questions,
    quotelessLinks,
    untypedProposals,
    danglingProposals,
    otherRecords,
    violations: parse.violations,
    parse,
  };
}

// ---- temp ids -> real ids --------------------------------------------------

export interface Ep1RosterEntry {
  entityId: string;
  name: string;
  type: EntityType;
}

export interface MintOptions {
  /** Entities that already exist. A proposal matching one REUSES it. */
  roster?: readonly Ep1RosterEntry[];
  /** Recorded on every entity this function creates. */
  decidedBy?: string;
  /** Test seam. Defaults to the real registry. */
  create?: typeof createEntity;
}

export interface MintedProposals {
  /** `k1` → real entity id. The map `resolveProposed` rewrites targets with. */
  ids: Map<string, string>;
  /** Aliases that caused a `createEntity`. */
  minted: string[];
  /** Aliases that folded onto an entity that already existed. */
  reused: string[];
  /** Aliases that folded onto an EARLIER alias in the same answer. */
  deduped: string[];
  /** Proposals with no usable name. A nameless entity is not an entity. */
  dropped: string[];
}

/** `[CODE]`: exact, case- and whitespace-insensitive. Nothing fuzzy here. */
function dedupeKey(type: EntityType, name: string): string {
  return `${type} ${normaliseIdentityValue("alias", name)}`;
}

/**
 * Turn N lines into real entities.
 *
 * Dedupe is EXACT and runs in two passes: against the roster first (so a
 * proposal for someone already known reuses them rather than forking a second
 * copy the ladder then has to merge back), then against earlier proposals in
 * the same answer (so `k2 Indiranagar` and `k5 indiranagar` are one place).
 * Anything less certain than an exact normalised name-and-type match is NOT
 * folded here — that is a similarity question, and similarity questions belong
 * on the ladder in `entities/resolve.ts`, where they are calibrated.
 */
export function mintProposals(
  proposals: readonly Ep1Proposal[],
  options: MintOptions = {},
): MintedProposals {
  const create = options.create ?? createEntity;
  const out: MintedProposals = { ids: new Map(), minted: [], reused: [], deduped: [], dropped: [] };
  const byKey = new Map<string, string>();

  for (const entry of options.roster ?? []) {
    const resolved = resolveEntityId(entry.entityId) ?? entry.entityId;
    const key = dedupeKey(entry.type, entry.name);
    if (!byKey.has(key)) byKey.set(key, resolved);
  }
  const fromRoster = new Set(byKey.values());

  for (const proposal of proposals) {
    if (proposal.name === "" || normaliseIdentityValue("alias", proposal.name) === "") {
      out.dropped.push(proposal.alias);
      continue;
    }
    if (out.ids.has(proposal.alias)) {
      // The model declared the same k twice. The first N line stands.
      out.deduped.push(proposal.alias);
      continue;
    }
    const key = dedupeKey(proposal.type, proposal.name);
    const held = byKey.get(key);
    if (held) {
      out.ids.set(proposal.alias, held);
      (fromRoster.has(held) ? out.reused : out.deduped).push(proposal.alias);
      continue;
    }
    const row = create({
      type: proposal.type,
      subtype: proposal.subtype,
      canonical: proposal.name,
      provisional: true,
    });
    byKey.set(key, row.id);
    out.ids.set(proposal.alias, row.id);
    out.minted.push(proposal.alias);
  }
  return out;
}

export interface ResolvedEp1 {
  mentions: Ep1Mention[];
  links: Ep1Link[];
  /** Targets still pointing at a `k` with no N line. The answer's holes. */
  dangling: string[];
}

function rewrite(target: Ep1Target, ids: ReadonlyMap<string, string>): Ep1Target {
  if (target.kind !== "proposed") return target;
  const id = ids.get(target.alias);
  return id ? { kind: "entity", token: target.token, entityId: id } : target;
}

/**
 * Rewrite every `k` target to the id it was minted as. A `k` the map does not
 * carry stays `proposed` and is listed in `dangling` — the caller files that
 * mention unlinked with a hint, and never against "the nearest" entity.
 */
export function resolveProposed(answer: Ep1Answer, ids: ReadonlyMap<string, string>): ResolvedEp1 {
  const mentions = answer.mentions.map((m) => ({ ...m, target: rewrite(m.target, ids) }));
  const links = answer.links.map((l) => ({
    ...l,
    src: rewrite(l.src, ids),
    dst: rewrite(l.dst, ids),
  }));
  const dangling = new Set<string>();
  for (const m of mentions) if (m.target.kind === "proposed") dangling.add(m.target.alias);
  for (const l of links) {
    if (l.src.kind === "proposed") dangling.add(l.src.alias);
    if (l.dst.kind === "proposed") dangling.add(l.dst.alias);
  }
  return { mentions, links, dangling: [...dangling].sort() };
}

/** The id a target names, or null — `self`, `-` and a dangling `k` are all null. */
export function targetEntityId(target: Ep1Target): string | null {
  return target.kind === "entity" ? target.entityId : null;
}

export function makeEp1Table(): AliasTable {
  return createAliasTable();
}
