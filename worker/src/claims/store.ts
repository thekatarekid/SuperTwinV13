// ===========================================================================
// [CODE] Claims store — build P1.1, spec §8.3. Designed fresh for V13 on the
// KEPT V11 table design: `claim_versions` is append-only (0020) and which
// version is ACTIVE is derived (the `claims_active` view) — an old claim
// arriving late lands as a predecessor and cannot dislodge current truth.
//
// V13 adds (0101_world_model):
//   - a `claims` HEADER row per claim_key, maintained here in the same tx as
//     every version write (kind/subject/status/active version/counters), so
//     list surfaces never scan the version set;
//   - `evidence_json` + `episode_id` on versions (no evidence, no write);
//   - `space_claims` refs (claims live globally; spaces hold refs — §9);
//   - `tone_profiles` (§7.3.3): drafting voice per person/group. Generic
//     address terms feed HERE and are never identity or relationship.
//
// Rules enforced in code, not prompt:
//   - party_pair is DERIVED (entities/party.ts), never accepted from a model.
//   - contradictions never overwrite: a new version coexists until a judge
//     (or the user) closes the old one; closes set closed_by, never delete.
//   - every write records a decisions row (build convention 1.4).
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { claimPartyPair, type PartySession } from "../entities/party.js";

export const CLAIM_KINDS = [
  "fact",
  "preference",
  "belief",
  "opinion",
  "interest",
  "habit",
  "recommendation",
  "workflow",
  "relationship",
  // V6 P1 S3.6 (extract.v6, Prompts P-04 rule 4 + Product_V6_Phase1 §11):
  "like",
  "dislike",
  "pattern",
  "feeling",
  "prospective",
  "behavioral",
  "narrative",
  "emotional",
  "identity",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === "string" && (CLAIM_KINDS as readonly string[]).includes(value);
}

export interface ClaimEvidence {
  event_ids: string[];
  /** VERBATIM. No evidence, no write. */
  quote: string;
}

export function mintClaimVersionId(): string {
  return `clv_${randomBytes(9).toString("hex")}`;
}

export interface WriteClaimParams {
  claimKey: string;
  kind: ClaimKind;
  /** Resolved roster id — or null with a hint. UNKNOWN BEATS WRONG (§8.3). */
  subjectId?: string | null;
  subjectHint?: string | null;
  predicate?: string | null;
  object?: string | null;
  text: string;
  speakerId?: string | null;
  addresseeId?: string | null;
  attribution?: string | null;
  confidence: number;
  /** When it was SAID — the ONLY basis for precedence. */
  statedAt: string;
  validFrom?: string | null;
  validTo?: string | null;
  evidence: ClaimEvidence[];
  /** Source v13 episode. */
  episodeId?: string | null;
  /** Session view for party_pair derivation ([CODE], never the model's). */
  session?: PartySession;
  decidedBy: string; // 'llm:extract' | 'user' | ...
  runId?: string | null;
  /** Against existing claims: new | reinforces | contradicts (spec §8.3). */
  relation?: "new" | "reinforces" | "contradicts";
  relatedVersionId?: string | null;
}

export interface ClaimVersionRow {
  id: string;
  claimKey: string;
  kind: string | null;
  subjectId: string | null;
  subjectHint: string | null;
  predicate: string | null;
  object: string | null;
  text: string | null;
  speakerId: string | null;
  addresseeId: string | null;
  attribution: string | null;
  partyPair: string | null;
  confidence: number | null;
  statedAt: string;
  validFrom: string | null;
  validTo: string | null;
  closedBy: string | null;
  closedReason: string | null;
  decidedBy: string | null;
  evidence: ClaimEvidence[];
  episodeId: string | null;
}

function hydrateVersion(r: Record<string, unknown>): ClaimVersionRow {
  let evidence: ClaimEvidence[] = [];
  if (typeof r.evidence_json === "string" && r.evidence_json !== "") {
    try {
      const parsed: unknown = JSON.parse(r.evidence_json);
      if (Array.isArray(parsed)) evidence = parsed as ClaimEvidence[];
    } catch {
      /* stored by us; a broken row reads as no evidence rather than a throw */
    }
  }
  return {
    id: String(r.id),
    claimKey: String(r.claim_key),
    kind: (r.kind as string | null) ?? null,
    subjectId: (r.subject_id as string | null) ?? null,
    subjectHint: (r.subject_hint as string | null) ?? null,
    predicate: (r.predicate as string | null) ?? null,
    object: (r.object as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    speakerId: (r.speaker_id as string | null) ?? null,
    addresseeId: (r.addressee_id as string | null) ?? null,
    attribution: (r.attribution as string | null) ?? null,
    partyPair: (r.party_pair as string | null) ?? null,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    statedAt: String(r.stated_at),
    validFrom: (r.valid_from as string | null) ?? null,
    validTo: (r.valid_to as string | null) ?? null,
    closedBy: (r.closed_by as string | null) ?? null,
    closedReason: (r.closed_reason as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    evidence,
    episodeId: (r.episode_id as string | null) ?? null,
  };
}

/** Recompute + store the header for one claim_key (same tx as the write). */
function refreshHeader(claimKey: string): void {
  const db = getDb();
  const active = db
    .prepare(`SELECT id, kind, subject_id, subject_hint, stated_at FROM claims_active WHERE claim_key = ?`)
    .get(claimKey) as
    | { id: string; kind: string | null; subject_id: string | null; subject_hint: string | null; stated_at: string }
    | undefined;
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(stated_at) AS first, MAX(stated_at) AS last
         FROM claim_versions WHERE claim_key = ?`,
    )
    .get(claimKey) as { n: number; first: string | null; last: string | null };
  // Fall back to the newest version for kind/subject when nothing is active.
  const newest = db
    .prepare(
      `SELECT kind, subject_id, subject_hint FROM claim_versions
        WHERE claim_key = ? ORDER BY stated_at DESC, id DESC LIMIT 1`,
    )
    .get(claimKey) as { kind: string | null; subject_id: string | null; subject_hint: string | null } | undefined;
  db.prepare(
    `INSERT INTO claims (claim_key, kind, subject_id, subject_hint, status, active_version_id,
                         version_count, first_stated_at, last_stated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (claim_key) DO UPDATE SET
       kind              = excluded.kind,
       subject_id        = excluded.subject_id,
       subject_hint      = excluded.subject_hint,
       status            = excluded.status,
       active_version_id = excluded.active_version_id,
       version_count     = excluded.version_count,
       first_stated_at   = excluded.first_stated_at,
       last_stated_at    = excluded.last_stated_at,
       updated_at        = excluded.updated_at`,
  ).run(
    claimKey,
    active?.kind ?? newest?.kind ?? null,
    active?.subject_id ?? newest?.subject_id ?? null,
    active?.subject_hint ?? newest?.subject_hint ?? null,
    active ? "active" : "closed",
    active?.id ?? null,
    stats.n,
    stats.first,
    stats.last,
  );
}

/**
 * Append one claim version (+ header + decisions row) in one transaction.
 * Contradictions NEVER overwrite: the new version lands and the old stays
 * active until `closeClaimVersion` (a judge or the user) ends its validity.
 */
export function writeClaimVersion(params: WriteClaimParams): ClaimVersionRow {
  if (!isClaimKind(params.kind)) {
    throw new Error(`writeClaimVersion: ${JSON.stringify(params.kind)} is not a claim kind`);
  }
  if (!params.evidence || params.evidence.length === 0 || params.evidence.some((e) => !e.quote?.trim())) {
    throw new Error("writeClaimVersion: no evidence, no write (spec §8 conventions)");
  }
  if (!params.statedAt) throw new Error("writeClaimVersion: statedAt is required — precedence runs on it");

  const db = getDb();
  const id = mintClaimVersionId();
  // party_pair = role(speaker) ‖ role(subject), DERIVED BY CODE — never the
  // model's field. Null when either end is unresolved.
  const partyPair = claimPartyPair(
    { speakerId: params.speakerId ?? null, subjectId: params.subjectId ?? null },
    params.session ?? {},
  );

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO claim_versions
         (id, claim_key, kind, subject_id, subject_hint, predicate, object, text,
          speaker_id, addressee_id, attribution, party_pair, confidence,
          stated_at, valid_from, valid_to, ingested_at, decided_by,
          evidence_json, episode_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.claimKey,
      params.kind,
      params.subjectId ?? null,
      params.subjectHint ?? null,
      params.predicate ?? null,
      params.object ?? null,
      params.text,
      params.speakerId ?? null,
      params.addresseeId ?? null,
      params.attribution ?? null,
      partyPair,
      params.confidence,
      params.statedAt,
      params.validFrom ?? null,
      params.validTo ?? null,
      new Date().toISOString(),
      params.decidedBy,
      JSON.stringify(params.evidence),
      params.episodeId ?? null,
    );
    refreshHeader(params.claimKey);
    writeDecision({
      runId: params.runId ?? null,
      pass: params.decidedBy,
      targetKind: "claim",
      targetId: params.claimKey,
      action:
        params.relation === "reinforces"
          ? "reinforce"
          : params.relation === "contradicts"
            ? "contradict"
            : "create_version",
      new: { version_id: id, text: params.text, related: params.relatedVersionId ?? null },
      confidence: params.confidence,
      reason: params.relation ?? "new",
    });
  });
  write();
  return readVersion(id)!;
}

/**
 * End one version's validity (supersede-vs-coexist judge outcome, or a user
 * correction). Old claims get validity ends, NEVER deletion (spec §8.3).
 */
export function closeClaimVersion(
  versionId: string,
  opts: { closedBy: string; reason?: string | null; validTo?: string | null; runId?: string | null },
): ClaimVersionRow {
  const db = getDb();
  const before = readVersion(versionId);
  if (!before) throw new Error(`closeClaimVersion: no version ${versionId}`);
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE claim_versions
          SET closed_by = ?, closed_reason = ?, valid_to = COALESCE(?, valid_to),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(opts.closedBy, opts.reason ?? null, opts.validTo ?? null, versionId);
    refreshHeader(before.claimKey);
    writeDecision({
      runId: opts.runId ?? null,
      pass: opts.closedBy,
      targetKind: "claim",
      targetId: before.claimKey,
      action: "close_version",
      old: { version_id: versionId, closed_by: null },
      new: { version_id: versionId, closed_by: opts.closedBy, reason: opts.reason ?? null },
      reason: opts.reason ?? null,
    });
  });
  run();
  return readVersion(versionId)!;
}

export function readVersion(id: string): ClaimVersionRow | null {
  const row = getDb().prepare(`SELECT * FROM claim_versions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrateVersion(row) : null;
}

/** The active version for one claim_key — the claims_active view, hydrated. */
export function activeClaim(claimKey: string): ClaimVersionRow | null {
  const row = getDb().prepare(`SELECT * FROM claims_active WHERE claim_key = ?`).get(claimKey) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrateVersion(row) : null;
}

/** Active claims about one (resolved) subject. */
export function claimsAbout(subjectId: string, kind?: ClaimKind): ClaimVersionRow[] {
  const rows = (
    kind
      ? getDb()
          .prepare(`SELECT * FROM claims_active WHERE subject_id = ? AND kind = ? ORDER BY stated_at DESC`)
          .all(subjectId, kind)
      : getDb().prepare(`SELECT * FROM claims_active WHERE subject_id = ? ORDER BY stated_at DESC`).all(subjectId)
  ) as Record<string, unknown>[];
  return rows.map(hydrateVersion);
}

/** All versions of one claim_key, newest stated first (the audit trail). */
export function claimHistory(claimKey: string): ClaimVersionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM claim_versions WHERE claim_key = ? ORDER BY stated_at DESC, id DESC`)
    .all(claimKey) as Record<string, unknown>[];
  return rows.map(hydrateVersion);
}

// ---- space refs (claims live globally; spaces hold refs — spec §9) ---------

export function linkClaimToSpace(spaceId: string, claimKey: string, addedBy = "code"): boolean {
  const info = getDb()
    .prepare(`INSERT OR IGNORE INTO space_claims (space_id, claim_key, added_by) VALUES (?, ?, ?)`)
    .run(spaceId, claimKey, addedBy);
  return info.changes > 0;
}

export function claimsInSpace(spaceId: string): ClaimVersionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT ca.* FROM claims_active ca
        JOIN space_claims sc ON sc.claim_key = ca.claim_key
       WHERE sc.space_id = ? ORDER BY ca.stated_at DESC`,
    )
    .all(spaceId) as Record<string, unknown>[];
  return rows.map(hydrateVersion);
}

// ---- tone profiles (spec §7.3.3) -------------------------------------------

export interface AddressTerm {
  term: string;
  /** 'discriminating' = addressee evidence; 'generic' = tone ONLY, never identity. */
  class: "discriminating" | "generic";
  count: number;
}

export interface ToneProfile {
  id: string;
  personEntityId: string | null;
  streamId: string | null;
  register: string | null;
  languageMix: string | null;
  emojiHabits: string | null;
  addressTerms: AddressTerm[];
  notes: string | null;
  updatedAt: string;
}

export interface UpsertToneParams {
  personEntityId?: string | null;
  streamId?: string | null;
  register?: string | null;
  languageMix?: string | null;
  emojiHabits?: string | null;
  /** Merged into the stored list by term (counts added, class kept sticky-discriminating). */
  addressTerms?: AddressTerm[];
  notes?: string | null;
  decidedBy?: string;
  runId?: string | null;
}

function hydrateTone(r: Record<string, unknown>): ToneProfile {
  let terms: AddressTerm[] = [];
  if (typeof r.address_terms_json === "string" && r.address_terms_json !== "") {
    try {
      const parsed: unknown = JSON.parse(r.address_terms_json);
      if (Array.isArray(parsed)) terms = parsed as AddressTerm[];
    } catch {
      /* tolerated: a broken row reads as no terms */
    }
  }
  return {
    id: String(r.id),
    personEntityId: (r.person_entity_id as string | null) ?? null,
    streamId: (r.stream_id as string | null) ?? null,
    register: (r.register as string | null) ?? null,
    languageMix: (r.language_mix as string | null) ?? null,
    emojiHabits: (r.emoji_habits as string | null) ?? null,
    addressTerms: terms,
    notes: (r.notes as string | null) ?? null,
    updatedAt: String(r.updated_at),
  };
}

export function getToneProfile(personEntityId: string | null, streamId: string | null): ToneProfile | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM tone_profiles
        WHERE COALESCE(person_entity_id, '') = COALESCE(?, '')
          AND COALESCE(stream_id, '') = COALESCE(?, '')`,
    )
    .get(personEntityId, streamId) as Record<string, unknown> | undefined;
  return row ? hydrateTone(row) : null;
}

/**
 * Create or merge a tone profile for a person and/or a stream (group). At
 * least one scope key is required. Address-term counts accumulate; a term
 * once judged `discriminating` stays discriminating.
 */
export function upsertToneProfile(params: UpsertToneParams): ToneProfile {
  const person = params.personEntityId ?? null;
  const stream = params.streamId ?? null;
  if (person === null && stream === null) {
    throw new Error("upsertToneProfile: at least one of personEntityId / streamId is required");
  }
  const db = getDb();
  const existing = getToneProfile(person, stream);

  const merged = new Map<string, AddressTerm>();
  for (const t of existing?.addressTerms ?? []) merged.set(t.term, { ...t });
  for (const t of params.addressTerms ?? []) {
    const prev = merged.get(t.term);
    if (prev) {
      prev.count += t.count;
      if (t.class === "discriminating") prev.class = "discriminating";
    } else {
      merged.set(t.term, { ...t });
    }
  }
  const termsJson = JSON.stringify([...merged.values()].sort((a, b) => a.term.localeCompare(b.term)));

  const write = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE tone_profiles
            SET register = COALESCE(?, register),
                language_mix = COALESCE(?, language_mix),
                emoji_habits = COALESCE(?, emoji_habits),
                address_terms_json = ?,
                notes = COALESCE(?, notes),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
      ).run(params.register ?? null, params.languageMix ?? null, params.emojiHabits ?? null, termsJson, params.notes ?? null, existing.id);
    } else {
      db.prepare(
        `INSERT INTO tone_profiles
           (id, person_entity_id, stream_id, register, language_mix, emoji_habits, address_terms_json, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `tone_${randomBytes(9).toString("hex")}`,
        person,
        stream,
        params.register ?? null,
        params.languageMix ?? null,
        params.emojiHabits ?? null,
        termsJson,
        params.notes ?? null,
      );
    }
    const after = getToneProfile(person, stream)!;
    writeDecision({
      runId: params.runId ?? null,
      pass: params.decidedBy ?? "llm:extract",
      targetKind: "tone_profile",
      targetId: after.id,
      action: existing ? "update" : "create",
      old: existing ?? null,
      new: after,
    });
  });
  write();
  return getToneProfile(person, stream)!;
}
