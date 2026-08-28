// ===========================================================================
// [CODE] Identity rows and their normalisation — build item 1.5, arch §10.3.
//
// An identity is "how this entity appears in one source": a WhatsApp jid, a
// Gmail From address, a calendar attendee, a device id, an alias people use in
// text. The table's UNIQUE key is `(source_id, kind, value_norm)`, so the whole
// of rung ① of the resolution ladder is one indexed lookup.
//
// THE CROSS-SOURCE RULE, which is the entire point of this file:
//
//   Only NORMALISED PHONE and NORMALISED EMAIL bind across sources at [CODE].
//
//   `@rahul` on Slack and `@rahul` on X are two people who picked the same
//   string. A handle, an account id, a device id and an alias are namespaced by
//   their source and MUST NOT join across one. That is not a tuning knob; a
//   handle join is a wrong merge with a confident face on it.
//
// A WhatsApp jid carries a phone number inside it, so binding a jid also files
// the derived `phone` identity — that, and only that, is what lets a Contacts
// import and a WhatsApp import land on the same person with zero model calls.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { mergedAliasIds, resolveEntityId } from "./registry.js";

export const IDENTITY_KINDS = [
  "jid",
  "phone",
  "email",
  "handle",
  "account_id",
  "device_id",
  "profile_url",
  "alias",
] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

/** The only two kinds that may join two sources without a model. */
export const CROSS_SOURCE_KINDS: readonly IdentityKind[] = ["phone", "email"];

export function isIdentityKind(value: unknown): value is IdentityKind {
  return typeof value === "string" && (IDENTITY_KINDS as readonly string[]).includes(value);
}

export function isCrossSourceKind(kind: IdentityKind): boolean {
  return CROSS_SOURCE_KINDS.includes(kind);
}

// ---- normalisation ---------------------------------------------------------

/**
 * E.164-ish: digits only, with a leading `+`. `00` international prefixes and
 * separators go; nothing is invented. A number with no country code stays as
 * its digits — normalising `9812345678` into `+919812345678` would be guessing
 * a country, and a guessed country is a wrong cross-source join.
 */
export function normalisePhone(raw: string): string {
  const text = String(raw ?? "").trim();
  const digits = text.replace(/[^\d]/g, "");
  if (digits === "") return "";
  const hadPlus = text.startsWith("+") || digits.startsWith("00");
  const body = digits.startsWith("00") ? digits.slice(2) : digits;
  return hadPlus ? `+${body}` : body;
}

/** Lower-cased and trimmed. No plus-tag stripping and no dot folding: those are provider policies, not facts. */
export function normaliseEmail(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** Lower-cased; the `:12` multi-device suffix dropped, since it is a handset, not a person. */
export function normaliseJid(raw: string): string {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "") return "";
  const at = text.indexOf("@");
  if (at === -1) return text;
  const user = text.slice(0, at).split(":")[0];
  return `${user}@${text.slice(at + 1)}`;
}

/** Lower-cased, leading `@` dropped. Still source-scoped — see the header. */
export function normaliseHandle(raw: string): string {
  return String(raw ?? "").trim().toLowerCase().replace(/^@+/, "");
}

/** An alias is a name people use. Case-folded and whitespace-collapsed; nothing else. */
export function normaliseAlias(raw: string): string {
  return String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normaliseIdentityValue(kind: IdentityKind, raw: string): string {
  switch (kind) {
    case "phone":
      return normalisePhone(raw);
    case "email":
      return normaliseEmail(raw);
    case "jid":
      return normaliseJid(raw);
    case "handle":
      return normaliseHandle(raw);
    case "alias":
      return normaliseAlias(raw);
    default:
      return String(raw ?? "").trim();
  }
}

const JID_PHONE_DOMAINS = new Set(["s.whatsapp.net", "c.us", "whatsapp.net"]);

/**
 * The phone number inside a WhatsApp jid, or `null`. A `@g.us` group jid and a
 * `@lid` privacy jid carry no phone, and inventing one from either is how a
 * group ends up merged into a person.
 */
export function phoneFromJid(rawJid: string): string | null {
  const jid = normaliseJid(rawJid);
  const at = jid.indexOf("@");
  if (at === -1) return null;
  const user = jid.slice(0, at);
  const domain = jid.slice(at + 1);
  if (!JID_PHONE_DOMAINS.has(domain)) return null;
  if (!/^\d{6,15}$/.test(user)) return null;
  return `+${user}`;
}

// ---- rows ------------------------------------------------------------------

export interface IdentityRow {
  id: string;
  entityId: string;
  sourceId: string | null;
  kind: IdentityKind;
  valueNorm: string;
  confidence: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

interface RawIdentityRow {
  id: string;
  entity_id: string;
  source_id: string | null;
  kind: string;
  value_norm: string;
  confidence: number | null;
  decided_by: string | null;
  decided_at: string | null;
}

function hydrate(row: RawIdentityRow | undefined): IdentityRow | null {
  if (!row) return null;
  if (!isIdentityKind(row.kind)) {
    throw new Error(`identity ${row.id}: kind ${JSON.stringify(row.kind)} is outside the closed set`);
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    sourceId: row.source_id,
    kind: row.kind,
    valueNorm: row.value_norm,
    confidence: row.confidence,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

const SELECT = `SELECT id, entity_id, source_id, kind, value_norm, confidence, decided_by, decided_at
                  FROM entity_identities`;

export function mintIdentityId(): string {
  return `eid_${randomBytes(12).toString("hex")}`;
}

export interface PutIdentityParams {
  entityId: string;
  sourceId: string | null;
  kind: IdentityKind;
  /** Raw; normalised here so no caller can file an un-normalised value. */
  value: string;
  confidence?: number;
  /** `code:exact`, `code:cross_source`, `code:metadata`, `llm:p-ep1`, `user` … */
  decidedBy: string;
  decidedAt?: string;
}

/**
 * File an identity, or return the existing row for the same
 * `(source_id, kind, value_norm)`. There is deliberately no update path for the
 * entity a row points at: re-pointing an identity is a MERGE, and merges are
 * tombstones (see `merge.ts`), never a silent UPDATE.
 */
export function putIdentity(params: PutIdentityParams): IdentityRow {
  if (!isIdentityKind(params.kind)) {
    throw new Error(`putIdentity: ${JSON.stringify(params.kind)} is not an identity kind`);
  }
  const valueNorm = normaliseIdentityValue(params.kind, params.value);
  if (valueNorm === "") throw new Error(`putIdentity: ${params.kind} value normalised to empty`);
  if (!params.decidedBy) throw new Error("putIdentity: decided_by is required — every bind records its decider");

  const existing = findIdentity(params.sourceId, params.kind, valueNorm);
  if (existing) return existing;

  const entityId = resolveEntityId(params.entityId);
  if (!entityId) throw new Error(`putIdentity: no entity ${params.entityId}`);

  const id = mintIdentityId();
  getDb()
    .prepare(
      `INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm, confidence, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      entityId,
      params.sourceId,
      params.kind,
      valueNorm,
      params.confidence ?? null,
      params.decidedBy,
      params.decidedAt ?? new Date().toISOString(),
    );
  return readIdentity(id)!;
}

export function readIdentity(id: string): IdentityRow | null {
  return hydrate(getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as RawIdentityRow | undefined);
}

/** Rung ①: exact `(source_id, kind, value_norm)`. `value` is normalised for you. */
export function findIdentity(
  sourceId: string | null,
  kind: IdentityKind,
  value: string,
): IdentityRow | null {
  const valueNorm = normaliseIdentityValue(kind, value);
  if (valueNorm === "") return null;
  const row = getDb()
    .prepare(
      `${SELECT} WHERE kind = ? AND value_norm = ? AND source_id IS ?`,
    )
    .get(kind, valueNorm, sourceId) as RawIdentityRow | undefined;
  return hydrate(row);
}

/**
 * Rung ②: the same normalised value in ANY source — allowed for `phone` and
 * `email` only. Every other kind returns `[]` here by construction, which is
 * how G-063/G-064 (`@rahul` on two networks) stay two people.
 */
export function findCrossSource(kind: IdentityKind, value: string): IdentityRow[] {
  if (!isCrossSourceKind(kind)) return [];
  const valueNorm = normaliseIdentityValue(kind, value);
  if (valueNorm === "") return [];
  return (
    getDb().prepare(`${SELECT} WHERE kind = ? AND value_norm = ? ORDER BY id`).all(kind, valueNorm) as RawIdentityRow[]
  ).map((r) => hydrate(r)!);
}

/** Includes the identities still filed against tombstones that redirect here. */
export function identitiesOf(entityId: string): IdentityRow[] {
  const ids = mergedAliasIds(entityId);
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  return (
    getDb()
      .prepare(`${SELECT} WHERE entity_id IN (${marks}) ORDER BY kind, value_norm`)
      .all(...ids) as RawIdentityRow[]
  ).map((r) => hydrate(r)!);
}

/** Re-points every identity of `fromId` at `toId`. Used by merge and split only. */
export function repointIdentities(fromId: string, toId: string): number {
  const res = getDb()
    .prepare(`UPDATE entity_identities SET entity_id = ? WHERE entity_id = ?`)
    .run(toId, fromId);
  return res.changes;
}

/** Re-points the identities of one source only — how a split restores the losing side. */
export function repointIdentitiesOfSource(fromId: string, toId: string, sourceId: string | null): number {
  const res = getDb()
    .prepare(`UPDATE entity_identities SET entity_id = ? WHERE entity_id = ? AND source_id IS ?`)
    .run(toId, fromId, sourceId);
  return res.changes;
}
