// ===========================================================================
// [CODE] Reading claim rows back — arch §11.6, §9.2. Build item 3.3.
//
// The row layer `write.ts` and the eval executor share, split out because
// write.ts is the write PATH and this is the read side of the same table.
//
// The one thing worth stating twice: `claims_active` is a VIEW (migration
// 0020), so `activeClaims()` is a SELECT over it and never a flag on a row.
// The ORDER BY here mirrors the view's — `stated_at DESC, id DESC` — and no
// query in this file mentions `ingested_at`, because precedence never may.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { ClaimVersionLike } from "./supersede.js";
import { orderVersions } from "./supersede.js";
import type { ClaimWriteInput } from "./types.js";

// ---- rows ------------------------------------------------------------------

export interface ClaimVersionRow extends ClaimVersionLike {
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
  validFrom: string | null;
  validTo: string | null;
  closedBy: string | null;
  closedReason: string | null;
  decidedBy: string | null;
}

interface RawRow {
  id: string;
  claim_key: string;
  kind: string | null;
  subject_id: string | null;
  subject_hint: string | null;
  predicate: string | null;
  object: string | null;
  text: string | null;
  speaker_id: string | null;
  addressee_id: string | null;
  attribution: string | null;
  party_pair: string | null;
  confidence: number | null;
  stated_at: string;
  valid_from: string | null;
  valid_to: string | null;
  closed_by: string | null;
  closed_reason: string | null;
  decided_by: string | null;
}

const SELECT_COLUMNS = `id, claim_key, kind, subject_id, subject_hint, predicate, object, text,
       speaker_id, addressee_id, attribution, party_pair, confidence, stated_at,
       valid_from, valid_to, closed_by, closed_reason, decided_by`;

function toRow(r: RawRow): ClaimVersionRow {
  return {
    id: r.id,
    claimKey: r.claim_key,
    kind: r.kind,
    subjectId: r.subject_id,
    subjectHint: r.subject_hint,
    predicate: r.predicate,
    object: r.object,
    text: r.text,
    speakerId: r.speaker_id,
    addresseeId: r.addressee_id,
    attribution: r.attribution,
    partyPair: r.party_pair,
    confidence: r.confidence,
    statedAt: r.stated_at,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    closedBy: r.closed_by,
    closedReason: r.closed_reason,
    decidedBy: r.decided_by,
  };
}

/** Every version of one key, latest-said first. Nothing is filtered out. */
export function versionsOfKey(key: string): ClaimVersionRow[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM claim_versions WHERE claim_key = ?`)
    .all(key) as RawRow[];
  return orderVersions(rows.map(toRow));
}

export function readClaimVersion(id: string): ClaimVersionRow | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM claim_versions WHERE id = ?`)
    .get(id) as RawRow | undefined;
  return row ? toRow(row) : null;
}

/** The `claims_active` VIEW from migration 0020 — never a table, never a flag. */
export function activeClaims(): ClaimVersionRow[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM claims_active ORDER BY stated_at DESC, id DESC`)
    .all() as RawRow[];
  return rows.map(toRow);
}

/** Evidence event ids attached to a claim, sorted. */
export function evidenceOf(claimId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT event_id FROM evidence WHERE subject_kind = 'claim' AND subject_id = ? ORDER BY event_id`)
      .all(claimId) as { event_id: string }[]
  ).map((r) => r.event_id);
}

// ---- near hits -------------------------------------------------------------

/**
 * Stored claims about the same subject and kind whose key differs — the only
 * rows a near hit can be. Active versions only: a claim already superseded is
 * not what the incoming one is near.
 */
export function nearHitCandidates(input: ClaimWriteInput, key: string): ClaimVersionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM claims_active
        WHERE kind = ? AND claim_key <> ? AND subject_id IS ?
        ORDER BY stated_at DESC, id DESC`,
    )
    .all(input.kind, key, input.subjectId ?? null) as RawRow[];
  return rows.map(toRow);
}
