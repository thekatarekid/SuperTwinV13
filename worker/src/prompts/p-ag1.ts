// ===========================================================================
// [AGENT] P-AG1 — the identity resolver — arch §12.2. Build item 1.10.
//
// Rung ④ of the resolution ladder, and the ONLY agent in the enrichment path.
// It is reached when the [CODE] rungs found no exact identity and the
// calibrated [ML] rung landed in the band — or could not run at all — and it
// answers with exactly one line:
//
//     V | <left> | <right> | <same|diff|un> | <conf> | <reason> [| <ev,ev>]
//
// Four settings are load-bearing and are enforced here rather than trusted:
//
//   ≤3 TURNS · 60 s      it investigates, it does not research. `P_AG1.turns`
//                        and `timeoutSeconds` are what the caller passes the
//                        provider, and `ag1SendOptions` builds that object so
//                        no call site can quietly raise either.
//   3 TOOLS, READ-ONLY   `search_entities`, `read_entity`, `read_events`.
//                        `assertReadOnly` refuses any allow-list that carries
//                        anything else, and every implementation below runs
//                        SELECTs only.
//   WRITE SCOPE NONE     the agent proposes; `entities/resolve.ts` disposes.
//                        Nothing in this file writes a row.
//   `un` → THE QUEUE     never auto-retried. Enforced on the ladder side by
//                        `agentAlreadyAsked`, which routes an already-answered
//                        pair straight to rung ⑤.
//
// EVIDENCE BEATS NAME SIMILARITY is the prompt's first rule, and the USER
// block is built to make that possible: identities, groups, first/last event
// and the shared signals go in, so "the same first name" is visibly the
// weakest thing on the page.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { edgesOf } from "../entities/edges.js";
import { identitiesOf } from "../entities/identities.js";
import { getEntity, resolveEntityId } from "../entities/registry.js";
import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import { collapseNewlines, neutraliseLabel } from "../wire/pack.js";
import { parseWire, type WireParseResult } from "../wire/index.js";
import type { WireViolation } from "../wire/tolerance.js";
import { legendFor } from "./legend.js";

/** §12.2 "Settings", transcribed. */
export const P_AG1 = {
  id: "P-AG1",
  role: "identity_resolver",
  model: "sonnet-5",
  /** "max 3 turns". */
  turns: 3,
  /** "60 s wall". */
  timeoutSeconds: 60,
  /** "8k total". */
  maxTotalTokens: 8_000,
  thinking: "off",
  /** "write scope none" — the agent may read the graph and nothing else. */
  writeScope: "none",
  /** §9.5.1 — an agent turn is never what the user is waiting on. */
  onCriticalPath: false,
} as const;

/** §12.2 SYSTEM, verbatim. */
export const P_AG1_SYSTEM = `You resolve whether two entity records refer to the same real-world entity.
You have read-only tools. Investigate, then answer with ONE line.

RULES
- Evidence beats name similarity. A shared phone or email is near-proof.
  The same first name alone is weak.
- For people consider co-occurring contacts, shared groups, places, time patterns.
- Insufficient or conflicting evidence → "un". A human will decide. Never force.

OUTPUT
  V | <left> | <right> | <same|diff|un> | <conf> | <reason> [| <ev,ev>]`;

// ---- the three tools -------------------------------------------------------

/** §12.2: `search_entities(query, type?)` → ≤10 matches. */
export const AG1_SEARCH_LIMIT = 10;
/** §12.2: `read_events(ids ≤10)`. */
export const AG1_EVENT_LIMIT = 10;
/** "top mentions with quotes" — enough to judge, not enough to drown in. */
export const AG1_MENTION_LIMIT = 5;

export interface Ag1ToolSpec {
  name: string;
  signature: string;
  returns: string;
}

/** The whole tool surface. Three entries, all read-only, all capped. */
export const AG1_TOOLS: readonly Ag1ToolSpec[] = [
  {
    name: "search_entities",
    signature: "search_entities(query, type?)",
    returns: `≤${AG1_SEARCH_LIMIT} matches`,
  },
  { name: "read_entity", signature: "read_entity(id)", returns: "identities, edges, top mentions with quotes" },
  { name: "read_events", signature: `read_events(ids ≤${AG1_EVENT_LIMIT})`, returns: "raw text" },
];

export const AG1_TOOL_NAMES: readonly string[] = AG1_TOOLS.map((t) => t.name);

/** The local MCP server §12.2 names, scoped to this call only. */
export const AG1_MCP_SERVER = "supertwin-tools";

export function ag1AllowedTools(): string[] {
  return AG1_TOOL_NAMES.map((name) => `mcp__${AG1_MCP_SERVER}__${name}`);
}

export class WriteScopeViolation extends Error {
  constructor(offending: readonly string[]) {
    super(
      `P-AG1 runs with write scope none and three read-only tools; ` +
        `refusing ${JSON.stringify(offending)} (§12.2)`,
    );
    this.name = "WriteScopeViolation";
  }
}

/**
 * The gate every caller passes its allow-list through. A tool P-AG1 does not
 * own is not "extra capability", it is a write scope the architecture says
 * this call does not have.
 */
export function assertReadOnly(allowedTools: readonly string[]): void {
  const permitted = new Set([...AG1_TOOL_NAMES, ...ag1AllowedTools()]);
  const offending = allowedTools.filter((t) => !permitted.has(t));
  if (offending.length > 0) throw new WriteScopeViolation(offending);
}

// ---- the read-only implementations -----------------------------------------

export interface Ag1EntityMatch {
  id: string;
  name: string | null;
  type: string;
  subtype: string | null;
}

export interface Ag1IdentitySummary {
  kind: string;
  value: string;
  sourceId: string | null;
}

export interface Ag1EdgeSummary {
  kind: string;
  subtype: string | null;
  otherId: string;
  otherName: string | null;
  direction: "out" | "in";
}

export interface Ag1MentionSummary {
  eventId: string;
  surface: string | null;
  quote: string;
}

export interface Ag1EntityCard {
  id: string;
  name: string | null;
  type: string;
  subtype: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  identities: Ag1IdentitySummary[];
  edges: Ag1EdgeSummary[];
  mentions: Ag1MentionSummary[];
}

export interface Ag1EventText {
  id: string;
  ts: string;
  text: string;
}

/** `search_entities(query, type?)`. Exact-ish prefix/substring, capped, SELECT only. */
export function searchEntities(query: string, type?: string): Ag1EntityMatch[] {
  const needle = `%${String(query ?? "").trim().toLowerCase()}%`;
  const rows = getDb()
    .prepare(
      `SELECT id, canonical, type, subtype FROM entities
        WHERE merged_into IS NULL
          AND LOWER(COALESCE(canonical, '')) LIKE ?
          ${type ? "AND type = ?" : ""}
        ORDER BY COALESCE(last_seen_at, created_at) DESC, id
        LIMIT ?`,
    )
    .all(...(type ? [needle, type, AG1_SEARCH_LIMIT] : [needle, AG1_SEARCH_LIMIT])) as {
    id: string;
    canonical: string | null;
    type: string;
    subtype: string | null;
  }[];
  return rows.map((r) => ({ id: r.id, name: r.canonical, type: r.type, subtype: r.subtype }));
}

/** `read_entity(id)` → identities, edges, top mentions with quotes. */
export function readEntityCard(id: string): Ag1EntityCard | null {
  const resolved = resolveEntityId(id);
  const row = resolved ? getEntity(resolved) : null;
  if (!row || !resolved) return null;

  const mentions = (
    getDb()
      .prepare(
        `SELECT m.event_id AS event_id, m.surface_text AS surface, COALESCE(e.text, '') AS quote
           FROM mentions m JOIN events e ON e.id = m.event_id
          WHERE m.entity_id = ?
          ORDER BY e.ts DESC, m.id
          LIMIT ?`,
      )
      .all(resolved, AG1_MENTION_LIMIT) as { event_id: string; surface: string | null; quote: string }[]
  ).map((m) => ({ eventId: m.event_id, surface: m.surface, quote: collapseNewlines(m.quote) }));

  const edges: Ag1EdgeSummary[] = edgesOf(resolved, { status: "active" }).map((e) => {
    const out = e.srcEntityId === resolved;
    const otherId = out ? e.dstEntityId : e.srcEntityId;
    return {
      kind: e.kind,
      subtype: e.subtype,
      otherId,
      otherName: getEntity(otherId)?.canonical ?? null,
      direction: out ? "out" : "in",
    };
  });

  return {
    id: resolved,
    name: row.canonical,
    type: row.type,
    subtype: row.subtype,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    identities: identitiesOf(resolved).map((i) => ({
      kind: i.kind,
      value: i.valueNorm,
      sourceId: i.sourceId,
    })),
    edges,
    mentions,
  };
}

/** `read_events(ids ≤10)` → raw text. More than ten ids and the tail is refused. */
export function readEventTexts(ids: readonly string[]): Ag1EventText[] {
  const wanted = [...new Set(ids.map((i) => String(i)))].slice(0, AG1_EVENT_LIMIT);
  if (wanted.length === 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, ts, COALESCE(text, '') AS text FROM events
        WHERE id IN (${wanted.map(() => "?").join(",")}) ORDER BY ts, id`,
    )
    .all(...wanted) as { id: string; ts: string; text: string }[];
  return rows.map((r) => ({ id: r.id, ts: r.ts, text: r.text }));
}

export interface Ag1Tools {
  search_entities(query: string, type?: string): Ag1EntityMatch[];
  read_entity(id: string): Ag1EntityCard | null;
  read_events(ids: readonly string[]): Ag1EventText[];
}

/** The three, bound together. Every one is a SELECT; none of them writes. */
export function createAg1Tools(): Ag1Tools {
  return {
    search_entities: searchEntities,
    read_entity: readEntityCard,
    read_events: readEventTexts,
  };
}

// ---- the prompt ------------------------------------------------------------

export interface Ag1Side {
  /** The real entity id. The alias stands in for it on the wire. */
  entityId: string;
  name: string;
  /** Wire code or stored long form — `per`, `person`, … */
  type?: string;
  /** `jid 919812…21`, `phone +919425…07` — already elided by the caller. */
  identities?: readonly string[];
  /** `seen from 2026-07-28` / `last event 2026-07-24`. */
  seen?: string;
  /** Group entity ids this side belongs to. */
  groupIds?: readonly string[];
}

export interface Ag1Pair {
  left: Ag1Side;
  right: Ag1Side;
  /**
   * The calibrated normalised score, or null when the [ML] rung was disabled.
   * A null prints as "unavailable" WITH the reason — never as a number,
   * because a made-up score is exactly the evidence this prompt must not have.
   */
  score: number | null;
  /** Why there is no score. Required when `score` is null. */
  scoreUnavailableReason?: string;
  /** "both in a4; both addressed as \"Papa\"" — the shared signals. */
  shared?: readonly string[];
}

export interface Ag1Prompt {
  system: string;
  user: string;
  table: AliasTable;
  /** entity id → the alias it was minted as. */
  aliases: Record<string, string>;
  allowedTools: string[];
}

export function ag1Legend(): string {
  return legendFor({ callType: P_AG1.id, tags: ["V.entity"], aliases: ["entity"] });
}

function sideLine(label: "A" | "B", side: Ag1Side, table: AliasTable): string {
  const alias = table.mint("entity", side.entityId, side.name);
  const parts: string[] = [`${alias} "${neutraliseLabel(side.name)}"`];
  if (side.type) parts.push(side.type);
  const ids = (side.identities ?? []).map((i) => neutraliseLabel(i)).filter((i) => i !== "");
  if (ids.length > 0) parts.push(ids.join(", "));
  if (side.seen) parts.push(neutraliseLabel(side.seen));
  const groups = (side.groupIds ?? []).map((id) => table.mint("entity", id));
  if (groups.length > 0) parts.push(`in ${groups.join(", ")}`);
  return `${label}: ${parts.join(" · ")}`;
}

/**
 * The USER block, in §12.2's shape. Both sides, the calibrated score, and the
 * shared signals — and nothing the model could mistake for a decision already
 * taken.
 */
export function buildAg1User(pair: Ag1Pair, table: AliasTable): string {
  const lines = [sideLine("A", pair.left, table), sideLine("B", pair.right, table)];
  if (typeof pair.score === "number" && Number.isFinite(pair.score)) {
    lines.push(`ML score (calibrated): ${pair.score.toFixed(2)}`);
  } else {
    const why = pair.scoreUnavailableReason ?? "the similarity rung is disabled";
    lines.push(`ML score: unavailable — ${why}`);
  }
  const shared = (pair.shared ?? []).map((s) => neutraliseLabel(s)).filter((s) => s !== "");
  if (shared.length > 0) lines.push(`shared: ${shared.join("; ")}`);
  return lines.join("\n");
}

export function buildAg1Prompt(pair: Ag1Pair, table?: AliasTable): Ag1Prompt {
  const aliasTable = table ?? createAliasTable();
  const user = buildAg1User(pair, aliasTable);
  const aliases: Record<string, string> = {};
  for (const side of [pair.left, pair.right]) {
    const token = aliasTable.tokenFor("entity", side.entityId);
    if (token) aliases[side.entityId] = token;
  }
  const allowedTools = ag1AllowedTools();
  assertReadOnly(allowedTools);
  return { system: `${ag1Legend()}\n\n${P_AG1_SYSTEM}`, user, table: aliasTable, aliases, allowedTools };
}

/** The provider knobs §12.2 fixes. Built here so no call site can raise them. */
export interface Ag1SendShape {
  model: string;
  maxTurns: number;
  timeoutMs: number;
  allowedTools: string[];
  thinkingBudget: "off";
  /** Fresh session, tools on: this is an agent turn, not a plain completion. */
  plainCompletion: false;
}

export function ag1SendOptions(): Ag1SendShape {
  const allowedTools = ag1AllowedTools();
  assertReadOnly(allowedTools);
  return {
    model: P_AG1.model,
    maxTurns: P_AG1.turns,
    timeoutMs: P_AG1.timeoutSeconds * 1_000,
    allowedTools,
    thinkingBudget: "off",
    plainCompletion: false,
  };
}

// ---- the answer ------------------------------------------------------------

export type Ag1VerdictKind = "same" | "different" | "unsure";

export interface Ag1Verdict {
  /** The aliases, verbatim. */
  leftAlias: string;
  rightAlias: string;
  /** Resolved entity ids, or null when an alias was out of roster. */
  leftId: string | null;
  rightId: string | null;
  verdict: Ag1VerdictKind;
  confidence: number | null;
  reason: string;
  /** The optional `ev,ev` tail. */
  evidence: string[];
  raw: string;
}

export interface Ag1Answer {
  /** §12.2: ONE line. The first well-formed verdict is the answer. */
  verdict: Ag1Verdict | null;
  /** Extra verdicts, kept rather than deleted — code orders, never censors. */
  extra: Ag1Verdict[];
  /** Verdicts whose aliases did not resolve. Reported, never guessed. */
  unresolved: Ag1Verdict[];
  violations: WireViolation[];
  parse: WireParseResult;
}

function evidenceList(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Parse a P-AG1 answer. Never throws: a malformed line is a violation quoting
 * the model verbatim, and an alias outside the two-entity roster resolves to
 * `null` rather than to whichever entity looked closest (§5.8.6).
 */
export function parseAg1Response(response: unknown, table: AliasTable): Ag1Answer {
  const parse = parseWire(response);
  const good: Ag1Verdict[] = [];
  const unresolved: Ag1Verdict[] = [];

  for (const record of parse.records) {
    if (record.variant !== "V.entity") continue;
    const v = record.values;
    const stored = typeof v.verdict === "string" ? v.verdict : "";
    if (stored !== "same" && stored !== "different" && stored !== "unsure") continue;
    const leftAlias = typeof v.left === "string" ? v.left : "";
    const rightAlias = typeof v.right === "string" ? v.right : "";
    const leftRef = table.resolve(leftAlias).resolved;
    const rightRef = table.resolve(rightAlias).resolved;
    const verdict: Ag1Verdict = {
      leftAlias,
      rightAlias,
      leftId: leftRef && leftRef.kind === "entity" ? leftRef.id : null,
      rightId: rightRef && rightRef.kind === "entity" ? rightRef.id : null,
      verdict: stored,
      confidence: typeof v.confidence === "number" ? v.confidence : null,
      reason: typeof v.reason === "string" ? v.reason : "",
      evidence: evidenceList(v.evidence),
      raw: record.raw,
    };
    if (verdict.leftId === null || verdict.rightId === null) unresolved.push(verdict);
    else good.push(verdict);
  }

  return {
    verdict: good[0] ?? null,
    extra: good.slice(1),
    unresolved,
    violations: parse.violations,
    parse,
  };
}
