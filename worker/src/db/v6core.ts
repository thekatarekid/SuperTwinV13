// ===========================================================================
// [CODE] Typed row helpers over 0200_v6_core — V6 P1 S1.1 (Build §4.1).
//
// One API for every Stage-1 lane, so parallel agents do not each hand-roll
// SQL over the same six tables. Every helper is prepared, parameterised and
// idempotent where the row has a natural key.
//
//   Consents (T4-1/2)      grantConsent · getConsent · listConsents ·
//                          setConsentState · setConsentWindows · revokeConsent ·
//                          captureAllowed · understandFloor
//                          One LIVE row per source (revoked rows stay as
//                          history). Windows: INDEX = index_all | index_from,
//                          UNDERSTAND = understand_from; Understand can never
//                          reach further back than Index (CNS-03) — the check
//                          lives here and throws ConsentWindowError.
//
//   Archive (T5-1)         writeArchive · readArchive · readArchiveByEvent ·
//                          archiveCount
//                          Narrow layer-1 row: text zlib'd once, raw payload
//                          zlib'd beside it. Idempotent by content_hash.
//
//   Episode members (T2-5) addEpisodeEvents · episodeMemberIds
//                          Explicit membership rows on `episode_events`
//                          (event_id set, range of one) — range readers keep
//                          working, exact readers filter on event_id.
//
//   Bundle attempts (T0-9) bundleKey · noteBundleAttempt · isDeadLettered ·
//                          clearBundleAttempts · listDeadLetters
//                          MAX_BUNDLE_ATTEMPTS (3) → dead_letter_at set, never
//                          auto-retried (invariant §24.4).
//
//   Blobs (T6-8)           putBlob · getBlob · getBlobText · hasBlob
//                          Content-addressed by sha256 of the raw bytes; a
//                          repeat put bumps `refs`, stores nothing twice.
//
//   Coverage (§23.4)       upsertCoverage · coverageFor · coverageFloor
//                          source × date range × status. `coverageFloor` is the
//                          earliest captured day — the "I only have WhatsApp
//                          back to Jan 2024" caveat.
//
// Everything here uses the shared handle from ./connection.ts (SUPERTWIN_DB_PATH
// / SUPERTWIN_HOME resolution), so tests sandbox it the way every db module is
// sandboxed. No model calls, no I/O beyond SQLite.
// ===========================================================================

import { createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type Database from "better-sqlite3";

import { BUILT_THROUGH_PHASE } from "../version.js";
import { getDb } from "./connection.js";

// ---- Shared ----------------------------------------------------------------

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Deflate a UTF-8 string / buffer. */
function zip(data: string | Buffer): Buffer {
  return deflateSync(typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

function unzip(buf: Buffer | Uint8Array): Buffer {
  return inflateSync(Buffer.from(buf));
}

// Prepared statements are cached per handle (the handle changes between tests).
let stmtsDb: Database.Database | null = null;
let cache = new Map<string, Database.Statement>();

function prep(sql: string): Database.Statement {
  const db = getDb();
  if (stmtsDb !== db) {
    stmtsDb = db;
    cache = new Map();
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

// ===========================================================================
// Consents
// ===========================================================================

export type ConsentState = "connected" | "paused" | "disconnected" | "revoked";

export const CONSENT_STATES: readonly ConsentState[] = [
  "connected",
  "paused",
  "disconnected",
  "revoked",
];

export interface ConsentRow {
  id: string;
  /** 'wa' | 'browser' | 'screen' | 'self' */
  source: string;
  state: ConsentState;
  grantedAt: string;
  grantedBuild: string | null;
  scope: unknown | null;
  /** INDEX window is everything. */
  indexAll: boolean;
  /** INDEX floor (ISO) when indexAll is false. */
  indexFrom: string | null;
  /** UNDERSTAND floor (ISO); null = nothing goes to the model. */
  understandFrom: string | null;
  /** decisions.id holding the confirm card verbatim (T4-10). */
  decisionId: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

interface RawConsent {
  id: string;
  source: string;
  state: string;
  granted_at: string;
  granted_build: string | null;
  scope_json: string | null;
  index_all: number;
  index_from: string | null;
  understand_from: string | null;
  decision_id: string | null;
  revoked_at: string | null;
  updated_at: string;
}

export interface ConsentWindows {
  indexAll?: boolean;
  indexFrom?: string | null;
  understandFrom?: string | null;
}

export interface GrantConsentInput extends ConsentWindows {
  source: string;
  state?: ConsentState;
  scope?: unknown;
  decisionId?: string | null;
  grantedBuild?: string | null;
  grantedAt?: string;
}

/** Thrown when Understand would reach further back than Index (CNS-03). */
export class ConsentWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentWindowError";
  }
}

function toConsent(r: RawConsent): ConsentRow {
  let scope: unknown = null;
  if (r.scope_json !== null) {
    try {
      scope = JSON.parse(r.scope_json);
    } catch {
      scope = null;
    }
  }
  return {
    id: r.id,
    source: r.source,
    state: r.state as ConsentState,
    grantedAt: r.granted_at,
    grantedBuild: r.granted_build,
    scope,
    indexAll: r.index_all === 1,
    indexFrom: r.index_from,
    understandFrom: r.understand_from,
    decisionId: r.decision_id,
    revokedAt: r.revoked_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Understand never exceeds Index: with `indexAll` anything goes; otherwise
 * `understandFrom` must be ≥ `indexFrom` (ISO strings compare lexically once
 * both are ISO-8601 UTC — callers pass what `Date#toISOString` produces).
 */
export function assertWindowsValid(w: { indexAll: boolean; indexFrom: string | null; understandFrom: string | null }): void {
  if (w.indexAll) return;
  if (w.indexFrom === null) {
    throw new ConsentWindowError("index_from is required when index_all is false");
  }
  if (w.understandFrom !== null && Date.parse(w.understandFrom) < Date.parse(w.indexFrom)) {
    throw new ConsentWindowError(
      `understand_from ${w.understandFrom} reaches further back than index_from ${w.indexFrom}`,
    );
  }
}

/**
 * Record a grant. Any live row for the source is revoked first so the partial
 * unique index holds; the new row is the source's consent from now on.
 * Defaults: state 'connected', Index everything, Understand null (nothing to
 * the model until the confirm card sets a floor).
 */
export function grantConsent(input: GrantConsentInput): ConsentRow {
  const db = getDb();
  const indexAll = input.indexAll ?? (input.indexFrom == null);
  const windows = {
    indexAll,
    indexFrom: indexAll ? null : (input.indexFrom ?? null),
    understandFrom: input.understandFrom ?? null,
  };
  assertWindowsValid(windows);
  const id = mintId("cns");
  const at = input.grantedAt ?? nowIso();
  const tx = db.transaction(() => {
    prep(
      `UPDATE consents SET revoked_at = ?, state = 'revoked', updated_at = ?
        WHERE source = ? AND revoked_at IS NULL`,
    ).run(at, at, input.source);
    prep(
      `INSERT INTO consents
         (id, source, state, granted_at, granted_build, scope_json, index_all, index_from,
          understand_from, decision_id, updated_at)
       VALUES (@id, @source, @state, @grantedAt, @grantedBuild, @scopeJson, @indexAll, @indexFrom,
               @understandFrom, @decisionId, @updatedAt)`,
    ).run({
      id,
      source: input.source,
      state: input.state ?? "connected",
      grantedAt: at,
      grantedBuild: input.grantedBuild === undefined ? BUILT_THROUGH_PHASE : input.grantedBuild,
      scopeJson: input.scope === undefined ? null : JSON.stringify(input.scope),
      indexAll: windows.indexAll ? 1 : 0,
      indexFrom: windows.indexFrom,
      understandFrom: windows.understandFrom,
      decisionId: input.decisionId ?? null,
      updatedAt: at,
    });
  });
  tx();
  return getConsentById(id)!;
}

export function getConsentById(id: string): ConsentRow | null {
  const r = prep(`SELECT * FROM consents WHERE id = ?`).get(id) as RawConsent | undefined;
  return r ? toConsent(r) : null;
}

/** The source's LIVE (unrevoked) consent row, or null. */
export function getConsent(source: string): ConsentRow | null {
  const r = prep(`SELECT * FROM consents WHERE source = ? AND revoked_at IS NULL`).get(source) as
    | RawConsent
    | undefined;
  return r ? toConsent(r) : null;
}

/** Every live consent row, oldest grant first. */
export function listConsents(opts: { includeRevoked?: boolean } = {}): ConsentRow[] {
  const rows = (
    opts.includeRevoked
      ? prep(`SELECT * FROM consents ORDER BY granted_at, id`).all()
      : prep(`SELECT * FROM consents WHERE revoked_at IS NULL ORDER BY granted_at, id`).all()
  ) as RawConsent[];
  return rows.map(toConsent);
}

/** Flip the live row's state (pause / disconnect / reconnect). No row → null. */
export function setConsentState(source: string, state: ConsentState): ConsentRow | null {
  if (!CONSENT_STATES.includes(state)) throw new Error(`unknown consent state: ${state}`);
  const live = getConsent(source);
  if (!live) return null;
  if (state === "revoked") {
    revokeConsent(source);
    return getConsentById(live.id);
  }
  prep(`UPDATE consents SET state = ?, updated_at = ? WHERE id = ?`).run(state, nowIso(), live.id);
  return getConsentById(live.id);
}

/**
 * Change the two windows on the live row. Validated as a whole (the merged
 * result must satisfy Understand ≤ Index), so widening Understand past Index
 * is rejected with ConsentWindowError and nothing is written (CNS-03).
 */
export function setConsentWindows(source: string, w: ConsentWindows): ConsentRow | null {
  const live = getConsent(source);
  if (!live) return null;
  const indexAll = w.indexAll ?? live.indexAll;
  const merged = {
    indexAll,
    indexFrom: indexAll ? null : (w.indexFrom !== undefined ? w.indexFrom : live.indexFrom),
    understandFrom: w.understandFrom !== undefined ? w.understandFrom : live.understandFrom,
  };
  assertWindowsValid(merged);
  prep(
    `UPDATE consents SET index_all = ?, index_from = ?, understand_from = ?, updated_at = ? WHERE id = ?`,
  ).run(merged.indexAll ? 1 : 0, merged.indexFrom, merged.understandFrom, nowIso(), live.id);
  return getConsentById(live.id);
}

/** Revoke the live row. Returns false when there was none. */
export function revokeConsent(source: string, at: string = nowIso()): boolean {
  const r = prep(
    `UPDATE consents SET revoked_at = ?, state = 'revoked', updated_at = ?
      WHERE source = ? AND revoked_at IS NULL`,
  ).run(at, at, source);
  return r.changes > 0;
}

/**
 * The consent gate predicate (T4-1): a live row in state 'connected'. Paused,
 * disconnected, revoked or absent → false. S1.2 calls this at the two
 * single-writer funnels.
 */
export function captureAllowed(source: string): boolean {
  const r = prep(
    `SELECT 1 AS ok FROM consents WHERE source = ? AND revoked_at IS NULL AND state = 'connected'`,
  ).get(source);
  return r !== undefined;
}

/**
 * UNDERSTAND floor for the source: events with ts ≥ this go to the model;
 * older ones are archive-only. null = nothing is understood (no consent, or
 * no Understand window set yet).
 */
export function understandFloor(source: string): string | null {
  return getConsent(source)?.understandFrom ?? null;
}

// ===========================================================================
// Archive
// ===========================================================================

export interface ArchiveWrite {
  /** events.id the row mirrors (cascades with it). Optional for log-less rows. */
  eventId?: string | null;
  source: string;
  streamKey?: string | null;
  ts: string;
  kind?: string | null;
  actor?: string | null;
  consentId?: string | null;
  tier?: number | null;
  /** Natural key; a repeat write is a no-op. */
  contentHash: string;
  text?: string | null;
  /** The payload as received — stored verbatim (deflated). */
  payload: unknown;
}

export interface ArchiveRow {
  id: string;
  eventId: string | null;
  source: string;
  streamKey: string | null;
  ts: string;
  kind: string | null;
  actor: string | null;
  consentId: string | null;
  tier: number | null;
  contentHash: string;
  text: string | null;
  textLen: number;
  payload: unknown;
  createdAt: string;
}

interface RawArchive {
  id: string;
  event_id: string | null;
  source: string;
  stream_key: string | null;
  ts: string;
  kind: string | null;
  actor: string | null;
  consent_id: string | null;
  tier: number | null;
  content_hash: string;
  text_z: Buffer | null;
  text_len: number;
  payload_z: Buffer;
  created_at: string;
}

function toArchive(r: RawArchive): ArchiveRow {
  return {
    id: r.id,
    eventId: r.event_id,
    source: r.source,
    streamKey: r.stream_key,
    ts: r.ts,
    kind: r.kind,
    actor: r.actor,
    consentId: r.consent_id,
    tier: r.tier,
    contentHash: r.content_hash,
    text: r.text_z ? unzip(r.text_z).toString("utf8") : null,
    textLen: r.text_len,
    payload: JSON.parse(unzip(r.payload_z).toString("utf8")) as unknown,
    createdAt: r.created_at,
  };
}

/** Append one archive row. Idempotent by content_hash (existing id returned). */
export function writeArchive(w: ArchiveWrite): { id: string; inserted: boolean } {
  const existing = prep(`SELECT id FROM archive WHERE content_hash = ?`).get(w.contentHash) as
    | { id: string }
    | undefined;
  if (existing) return { id: existing.id, inserted: false };
  const id = mintId("arc");
  const text = w.text ?? null;
  prep(
    `INSERT INTO archive
       (id, event_id, source, stream_key, ts, kind, actor, consent_id, tier, content_hash,
        text_z, text_len, payload_z)
     VALUES (@id, @eventId, @source, @streamKey, @ts, @kind, @actor, @consentId, @tier, @contentHash,
             @textZ, @textLen, @payloadZ)`,
  ).run({
    id,
    eventId: w.eventId ?? null,
    source: w.source,
    streamKey: w.streamKey ?? null,
    ts: w.ts,
    kind: w.kind ?? null,
    actor: w.actor ?? null,
    consentId: w.consentId ?? null,
    tier: w.tier ?? null,
    contentHash: w.contentHash,
    textZ: text === null ? null : zip(text),
    textLen: text === null ? 0 : text.length,
    payloadZ: zip(JSON.stringify(w.payload ?? null)),
  });
  return { id, inserted: true };
}

export function readArchive(id: string): ArchiveRow | null {
  const r = prep(`SELECT * FROM archive WHERE id = ?`).get(id) as RawArchive | undefined;
  return r ? toArchive(r) : null;
}

export function readArchiveByEvent(eventId: string): ArchiveRow | null {
  const r = prep(`SELECT * FROM archive WHERE event_id = ?`).get(eventId) as RawArchive | undefined;
  return r ? toArchive(r) : null;
}

export function archiveCount(source?: string): number {
  const r = (
    source === undefined
      ? prep(`SELECT COUNT(*) AS n FROM archive`).get()
      : prep(`SELECT COUNT(*) AS n FROM archive WHERE source = ?`).get(source)
  ) as { n: number };
  return r.n;
}

// ===========================================================================
// Episode membership (explicit rows on episode_events)
// ===========================================================================

/**
 * Add explicit members to an episode. Each row is a range of one with
 * `event_id` set, so the 0101 range readers see it too. Unknown event ids are
 * skipped (a member must exist in the log). Returns how many rows were added.
 */
export function addEpisodeEvents(episodeId: string, eventIds: string[], addedBy = "orient"): number {
  if (eventIds.length === 0) return 0;
  const db = getDb();
  const rowidOf = prep(`SELECT rowid AS r FROM events WHERE id = ?`);
  const ins = prep(
    `INSERT OR IGNORE INTO episode_events
       (id, episode_id, event_id, start_event_id, end_event_id, start_rowid, end_rowid, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  const tx = db.transaction(() => {
    for (const eid of eventIds) {
      const row = rowidOf.get(eid) as { r: number } | undefined;
      if (!row) continue;
      const r = ins.run(mintId("ee"), episodeId, eid, eid, eid, row.r, row.r, addedBy);
      added += r.changes;
    }
  });
  tx();
  return added;
}

/** Explicit member ids of an episode, in log (rowid) order. */
export function episodeMemberIds(episodeId: string): string[] {
  const rows = prep(
    `SELECT event_id AS id FROM episode_events
      WHERE episode_id = ? AND event_id IS NOT NULL
      ORDER BY start_rowid, created_at`,
  ).all(episodeId) as { id: string }[];
  return rows.map((r) => r.id);
}

// ===========================================================================
// Bundle attempts
// ===========================================================================

/** A bundle is attempted at most this many times (Product_V6_Phase1 §24.4). */
export const MAX_BUNDLE_ATTEMPTS = 3;

export interface BundleRef {
  streamId: string;
  minRowid: number;
  maxRowid: number;
}

export interface BundleAttemptRow {
  bundleKey: string;
  streamId: string | null;
  minRowid: number | null;
  maxRowid: number | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  deadLetterAt: string | null;
  createdAt: string;
}

interface RawBundleAttempt {
  bundle_key: string;
  stream_id: string | null;
  min_rowid: number | null;
  max_rowid: number | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  dead_letter_at: string | null;
  created_at: string;
}

function toAttempt(r: RawBundleAttempt): BundleAttemptRow {
  return {
    bundleKey: r.bundle_key,
    streamId: r.stream_id,
    minRowid: r.min_rowid,
    maxRowid: r.max_rowid,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    deadLetterAt: r.dead_letter_at,
    createdAt: r.created_at,
  };
}

/** The in-flight key the dispatcher already uses: `<stream>:<min>-<max>`. */
export function bundleKey(ref: BundleRef): string {
  return `${ref.streamId}:${ref.minRowid}-${ref.maxRowid}`;
}

/**
 * Record one attempt on a bundle. The 3rd failed attempt sets dead_letter_at;
 * an already dead-lettered bundle is left alone (attempts stop counting).
 * Returns the row after the write.
 */
export function noteBundleAttempt(
  ref: BundleRef,
  opts: { error?: string | null; at?: string; maxAttempts?: number } = {},
): BundleAttemptRow {
  const key = bundleKey(ref);
  const at = opts.at ?? nowIso();
  const max = opts.maxAttempts ?? MAX_BUNDLE_ATTEMPTS;
  const db = getDb();
  const tx = db.transaction(() => {
    prep(
      `INSERT INTO bundle_attempts (bundle_key, stream_id, min_rowid, max_rowid, attempts, last_attempt_at, last_error)
       VALUES (?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(bundle_key) DO NOTHING`,
    ).run(key, ref.streamId, ref.minRowid, ref.maxRowid);
    prep(
      `UPDATE bundle_attempts
          SET attempts = attempts + 1,
              last_attempt_at = ?,
              last_error = ?,
              dead_letter_at = CASE
                WHEN dead_letter_at IS NOT NULL THEN dead_letter_at
                WHEN attempts + 1 >= ? THEN ?
                ELSE NULL END
        WHERE bundle_key = ? AND dead_letter_at IS NULL`,
    ).run(at, opts.error ?? null, max, at, key);
  });
  tx();
  return getBundleAttempt(ref)!;
}

export function getBundleAttempt(ref: BundleRef): BundleAttemptRow | null {
  const r = prep(`SELECT * FROM bundle_attempts WHERE bundle_key = ?`).get(bundleKey(ref)) as
    | RawBundleAttempt
    | undefined;
  return r ? toAttempt(r) : null;
}

export function isDeadLettered(ref: BundleRef): boolean {
  const r = prep(`SELECT 1 AS ok FROM bundle_attempts WHERE bundle_key = ? AND dead_letter_at IS NOT NULL`).get(
    bundleKey(ref),
  );
  return r !== undefined;
}

/** The bundle committed: forget its attempts. */
export function clearBundleAttempts(ref: BundleRef): boolean {
  return prep(`DELETE FROM bundle_attempts WHERE bundle_key = ?`).run(bundleKey(ref)).changes > 0;
}

/** Dead-lettered bundles, oldest first — what the ops view shows. */
export function listDeadLetters(): BundleAttemptRow[] {
  const rows = prep(
    `SELECT * FROM bundle_attempts WHERE dead_letter_at IS NOT NULL ORDER BY dead_letter_at, bundle_key`,
  ).all() as RawBundleAttempt[];
  return rows.map(toAttempt);
}

// ===========================================================================
// Blobs
// ===========================================================================

export interface BlobPut {
  sha256: string;
  /** Raw byte length. */
  size: number;
  /** false when the content was already stored (refs bumped instead). */
  inserted: boolean;
}

/** sha256 hex of the raw bytes — the blob's address. */
export function blobAddress(data: string | Buffer): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

/** Store content by address. A repeat put stores nothing and bumps `refs`. */
export function putBlob(data: string | Buffer, kind = "text"): BlobPut {
  const raw = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const sha256 = blobAddress(raw);
  const at = nowIso();
  const r = prep(
    `INSERT INTO blobs (sha256, kind, size, bytes_z, refs, created_at, last_ref_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET refs = refs + 1, last_ref_at = excluded.last_ref_at`,
  ).run(sha256, kind, raw.length, zip(raw), at, at);
  // better-sqlite3 reports changes=1 for both branches; distinguish by refs.
  void r;
  const row = prep(`SELECT refs FROM blobs WHERE sha256 = ?`).get(sha256) as { refs: number };
  return { sha256, size: raw.length, inserted: row.refs === 1 };
}

export function getBlob(sha256: string): Buffer | null {
  const r = prep(`SELECT bytes_z FROM blobs WHERE sha256 = ?`).get(sha256) as { bytes_z: Buffer } | undefined;
  return r ? unzip(r.bytes_z) : null;
}

export function getBlobText(sha256: string): string | null {
  const b = getBlob(sha256);
  return b === null ? null : b.toString("utf8");
}

export function hasBlob(sha256: string): boolean {
  return prep(`SELECT 1 AS ok FROM blobs WHERE sha256 = ?`).get(sha256) !== undefined;
}

export function blobStats(): { count: number; rawBytes: number; refs: number } {
  const r = prep(
    `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS rawBytes, COALESCE(SUM(refs), 0) AS refs FROM blobs`,
  ).get() as { count: number; rawBytes: number; refs: number };
  return r;
}

// ===========================================================================
// Coverage — source × date range × status
// ===========================================================================

export type CoverageStatus = "captured" | "indexed" | "understood" | "missing" | "excluded";

export const COVERAGE_STATUSES: readonly CoverageStatus[] = [
  "captured",
  "indexed",
  "understood",
  "missing",
  "excluded",
];

export interface CoverageRange {
  source: string;
  /** YYYY-MM-DD, inclusive. */
  rangeStart: string;
  /** YYYY-MM-DD, inclusive. */
  rangeEnd: string;
  status: CoverageStatus;
  events: number;
  note: string | null;
  updatedAt: string;
}

export interface CoverageUpsert {
  source: string;
  rangeStart: string;
  rangeEnd: string;
  status: CoverageStatus;
  events?: number;
  note?: string | null;
}

interface RawCoverage {
  source: string;
  range_start: string;
  range_end: string;
  status: string;
  events: number;
  note: string | null;
  updated_at: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toCoverage(r: RawCoverage): CoverageRange {
  return {
    source: r.source,
    rangeStart: r.range_start,
    rangeEnd: r.range_end,
    status: r.status as CoverageStatus,
    events: r.events,
    note: r.note,
    updatedAt: r.updated_at,
  };
}

/** Insert or replace one (source, range) row. Ranges are calendar days. */
export function upsertCoverage(c: CoverageUpsert): CoverageRange {
  if (!DAY_RE.test(c.rangeStart) || !DAY_RE.test(c.rangeEnd)) {
    throw new Error(`coverage range must be YYYY-MM-DD: ${c.rangeStart}..${c.rangeEnd}`);
  }
  if (c.rangeEnd < c.rangeStart) {
    throw new Error(`coverage range_end ${c.rangeEnd} precedes range_start ${c.rangeStart}`);
  }
  if (!COVERAGE_STATUSES.includes(c.status)) throw new Error(`unknown coverage status: ${c.status}`);
  prep(
    `INSERT INTO coverage (source, range_start, range_end, status, events, note, updated_at)
     VALUES (@source, @rangeStart, @rangeEnd, @status, @events, @note, @updatedAt)
     ON CONFLICT(source, range_start, range_end) DO UPDATE SET
       status = excluded.status,
       events = excluded.events,
       note = excluded.note,
       updated_at = excluded.updated_at`,
  ).run({
    source: c.source,
    rangeStart: c.rangeStart,
    rangeEnd: c.rangeEnd,
    status: c.status,
    events: Math.max(0, Math.floor(c.events ?? 0)),
    note: c.note ?? null,
    updatedAt: nowIso(),
  });
  return coverageFor(c.source).find((r) => r.rangeStart === c.rangeStart && r.rangeEnd === c.rangeEnd)!;
}

/** Every range row for a source, earliest first. */
export function coverageFor(source: string): CoverageRange[] {
  const rows = prep(`SELECT * FROM coverage WHERE source = ? ORDER BY range_start, range_end`).all(
    source,
  ) as RawCoverage[];
  return rows.map(toCoverage);
}

/**
 * The earliest day the source has anything for (captured/indexed/understood).
 * null = nothing yet. This is the truthful half of "I only have WhatsApp back
 * to Jan 2024".
 */
export function coverageFloor(source: string): string | null {
  const r = prep(
    `SELECT MIN(range_start) AS floor FROM coverage
      WHERE source = ? AND status IN ('captured', 'indexed', 'understood')`,
  ).get(source) as { floor: string | null };
  return r.floor;
}
