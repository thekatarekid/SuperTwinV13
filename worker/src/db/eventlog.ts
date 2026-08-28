// ===========================================================================
// V13 event log — the single-writer append path (build P0.4, spec §6.1).
//
// Every V13 event enters the log through appendEvents(): one transaction, one
// process, one module. Idempotency is by content_hash — a re-delivered wave
// (BND-04's wave 2, a daemon reconnect, a replay) inserts nothing the log
// already holds. The hash is computed over the envelope's identity fields
// (source · stream_key · actor · ts · kind · canonical payload), so adapters
// that carry a source-native id in the payload get exact-once semantics for
// free.
//
// The log is the V11 `events` table extended by 0100_v13_core: `text` stays
// the FTS-indexed projection of payload.text (the 0022 triggers keep
// events_fts in sync — appends here are FTS-searchable with no extra work).
//
// The legacy WhatsApp ingest path (db/ingest.ts insertEvent) stamps the same
// envelope columns via legacyEnvelopeFields() below, so both writers converge
// on one schema; P0.6 upgrades the adapter to full role envelopes.
// ===========================================================================

import { createHash, randomBytes } from "node:crypto";

import { bridgeIngestedEvents } from "../bridges/ingest.js";
import { noteSelfAuthoredEvents } from "../categories/promotion.js";
import { isCapturePaused } from "../library/pause.js";
import { getDb } from "./connection.js";

// ---- Envelope types (spec §6.1) -------------------------------------------

export type EventOrigin = "live" | "backfill";
export type AgeBand = "A" | "B" | "C" | "D";

/** roles {sender, audience[], receiver[], mentions[]} — receiver ⊆ audience. */
export interface EventRoles {
  sender: string;
  audience: string[];
  receiver: string[];
  mentions: string[];
}

export interface EventEnvelope {
  /** ULID-ish id; minted here when absent. */
  id?: string;
  /** When it was SAID — the only basis for precedence. ISO-8601. */
  ts: string;
  /** When WE saw it. Defaults to now. */
  capturedAt?: string;
  /** Source id, e.g. "wa", "browser", "screen". */
  source: string;
  /** e.g. "wa.message", "browser.visit". */
  kind: string;
  origin: EventOrigin;
  /** Backfill band (spec §5.3). Derived from ts when absent. */
  ageBand?: AgeBand;
  /** Source-native stream key, e.g. "9198xx-1602@g.us". */
  streamKey: string;
  /** e.g. "contact:rohan" | "self". */
  actor: string;
  roles: EventRoles;
  /** Typed per kind. `payload.text` is projected into events.text for FTS. */
  payload: Record<string, unknown>;
  contentHash?: string;
  blobRefs?: string[];
}

export interface AppendResult {
  inserted: number;
  skipped: number;
  /**
   * ids in input order; for a skipped duplicate, the EXISTING row's id; for
   * an envelope dropped by a capture pause (P2.4), "" — nothing was written.
   */
  ids: string[];
}

// ---- Id + hash + band helpers ---------------------------------------------

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** ULID-shaped id: 48-bit ms timestamp + 80 random bits — sortable by mint time. */
export function mintEventId(nowMs: number = Date.now()): string {
  let t = nowMs;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ULID_ALPHABET[t % 32];
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let out = time.join("");
  for (let i = 0; i < 16; i++) out += ULID_ALPHABET[rand[i] % 32];
  return out;
}

/** Stable stringify (sorted keys, recursively) so hashing is order-independent. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

/** content_hash over the envelope's identity fields. */
export function contentHash(env: {
  source: string;
  streamKey: string;
  actor: string;
  ts: string;
  kind: string;
  payload: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        env.source,
        env.streamKey,
        env.actor,
        env.ts,
        env.kind,
        env.payload,
      ]),
    )
    .digest("hex");
}

const DAY_MS = 86_400_000;

/** Age band from event ts (spec §5.3): A 0–30d · B 1–6mo · C 6mo–2y · D 2y+. */
export function ageBandFor(ts: string, nowMs: number = Date.now()): AgeBand {
  const t = Date.parse(ts);
  const age = Number.isFinite(t) ? nowMs - t : 0;
  if (age <= 30 * DAY_MS) return "A";
  if (age <= 182 * DAY_MS) return "B";
  if (age <= 730 * DAY_MS) return "C";
  return "D";
}

// ---- Single-writer append --------------------------------------------------

interface Stmts {
  upsertSource: ReturnType<ReturnType<typeof getDb>["prepare"]>;
  upsertStream: ReturnType<ReturnType<typeof getDb>["prepare"]>;
  byHash: ReturnType<ReturnType<typeof getDb>["prepare"]>;
  insert: ReturnType<ReturnType<typeof getDb>["prepare"]>;
  read: ReturnType<ReturnType<typeof getDb>["prepare"]>;
}

let stmtsDb: unknown = null;
let stmts: Stmts | null = null;

function statements(): Stmts {
  const db = getDb();
  if (stmts && stmtsDb === db) return stmts;
  stmtsDb = db;
  stmts = {
    upsertSource: db.prepare(`
      INSERT INTO sources (id, type, name) VALUES (@id, @id, @id)
      ON CONFLICT(id) DO NOTHING
    `),
    // Reuses the deterministic "<source>:st:<key>" id scheme from db/ingest.ts
    // so a stream the WhatsApp adapter already upserted (with label/kind) is
    // the SAME row this path resolves — never a duplicate lane.
    upsertStream: db.prepare(`
      INSERT INTO streams (id, source_id, external_key)
      VALUES (@id, @sourceId, @externalKey)
      ON CONFLICT(source_id, external_key) DO NOTHING
    `),
    byHash: db.prepare(`SELECT id FROM events WHERE content_hash = ?`),
    insert: db.prepare(`
      INSERT INTO events
        (id, source_id, source_type, stream_id, stream_key, ts, captured_at,
         kind, origin, age_band, actor, roles_json, payload_json, text,
         content_hash, blob_refs_json, is_historical)
      VALUES
        (@id, @sourceId, @sourceType, @streamId, @streamKey, @ts, @capturedAt,
         @kind, @origin, @ageBand, @actor, @rolesJson, @payloadJson, @text,
         @contentHash, @blobRefsJson, @isHistorical)
    `),
    read: db.prepare(`
      SELECT id, source_type, stream_key, ts, captured_at, kind, origin,
             age_band, actor, roles_json, payload_json, content_hash,
             blob_refs_json
        FROM events WHERE id = ?
    `),
  };
  return stmts;
}

/** Deterministic stream id — mirrors db/ingest.ts streamId(). */
function v13StreamId(source: string, streamKey: string): string {
  return `${source}:st:${streamKey}`;
}

/**
 * Append envelopes to the log in ONE transaction (the single-writer path).
 * Idempotent by content_hash: an envelope whose hash already exists is
 * skipped, and its slot in `ids` carries the EXISTING row's id.
 */
export function appendEvents(
  envelopes: EventEnvelope[],
  nowMs: number = Date.now(),
): AppendResult {
  const db = getDb();
  const s = statements();
  const result: AppendResult = { inserted: 0, skipped: 0, ids: [] };
  const insertedIds: string[] = [];

  const run = db.transaction(() => {
    for (const env of envelopes) {
      const hash = env.contentHash ?? contentHash(env);
      const existing = s.byHash.get(hash) as { id: string } | undefined;
      if (existing) {
        result.skipped++;
        result.ids.push(existing.id);
        continue;
      }
      // Per-stream capture pause (P2.4, spec §14.3.2): a paused stream's
      // events are dropped at this funnel — never stored-but-hidden. The
      // slot's id is "" (nothing was written and nothing pre-existed).
      if (isCapturePaused(env.source, env.streamKey)) {
        result.skipped++;
        result.ids.push("");
        continue;
      }
      s.upsertSource.run({ id: env.source });
      const streamId = v13StreamId(env.source, env.streamKey);
      s.upsertStream.run({
        id: streamId,
        sourceId: env.source,
        externalKey: env.streamKey,
      });
      const id = env.id ?? mintEventId(nowMs);
      const text = typeof env.payload.text === "string" ? env.payload.text : null;
      s.insert.run({
        id,
        sourceId: env.source,
        sourceType: env.source,
        streamId,
        streamKey: env.streamKey,
        ts: env.ts,
        capturedAt: env.capturedAt ?? new Date(nowMs).toISOString(),
        kind: env.kind,
        origin: env.origin,
        ageBand: env.ageBand ?? ageBandFor(env.ts, nowMs),
        actor: env.actor,
        rolesJson: JSON.stringify(env.roles),
        payloadJson: JSON.stringify(env.payload),
        text,
        contentHash: hash,
        blobRefsJson: JSON.stringify(env.blobRefs ?? []),
        isHistorical: env.origin === "backfill" ? 1 : 0,
      });
      result.inserted++;
      result.ids.push(id);
      insertedIds.push(id);
    }
  });
  run();
  // Bridge extraction at ingest (P1.1, spec §19 "built, never wired — wire
  // it"): url/phone/email/order-id literals → event_bridge_keys + bridges.
  // Best-effort by design: an event without bridge keys is an event, not an
  // error, so extraction failure never unwinds an append that committed.
  if (insertedIds.length > 0) {
    try {
      bridgeIngestedEvents(insertedIds);
    } catch (err) {
      console.error("[eventlog] bridge extraction failed (continuing):", err);
    }
    // Engagement + Cat-2 -> Cat-1 promotion (P1.6, spec §5.1, eval CAT-03):
    // a self-authored envelope is user engagement — never throws, never
    // unwinds the append that committed.
    noteSelfAuthoredEvents(
      envelopes
        .filter((env, i) => env.actor === "self" && insertedIds.includes(result.ids[i]))
        .map((env) => ({
          source: env.source,
          streamKey: env.streamKey,
          actor: env.actor,
          ts: env.ts,
        })),
      nowMs,
    );
  }
  return result;
}

/** Append one envelope. */
export function appendEvent(
  env: EventEnvelope,
  nowMs: number = Date.now(),
): { id: string; inserted: boolean } {
  const r = appendEvents([env], nowMs);
  return { id: r.ids[0], inserted: r.inserted === 1 };
}

/** Read an envelope back from the log (round-trip of appendEvents). */
export function readEnvelope(id: string): EventEnvelope | null {
  const row = statements().read.get(id) as
    | {
        id: string;
        source_type: string;
        stream_key: string;
        ts: string;
        captured_at: string;
        kind: string;
        origin: EventOrigin;
        age_band: AgeBand;
        actor: string;
        roles_json: string;
        payload_json: string;
        content_hash: string;
        blob_refs_json: string;
      }
    | undefined;
  if (!row || row.stream_key == null) return null;
  return {
    id: row.id,
    ts: row.ts,
    capturedAt: row.captured_at,
    source: row.source_type,
    kind: row.kind,
    origin: row.origin,
    ageBand: row.age_band,
    streamKey: row.stream_key,
    actor: row.actor,
    roles: JSON.parse(row.roles_json ?? "{}") as EventRoles,
    payload: JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>,
    contentHash: row.content_hash,
    blobRefs: JSON.parse(row.blob_refs_json ?? "[]") as string[],
  };
}

// ---- Legacy-writer bridge --------------------------------------------------

/**
 * Envelope fields for the V11-shaped WhatsApp insert path (db/ingest.ts).
 * That path dedupes on (source_id, external_id) already; this stamps the same
 * V13 columns the single-writer writes so BOTH writers produce dispatchable
 * envelope rows. The external id is folded into the hash payload so two
 * identical texts in the same second stay distinct events.
 */
export function legacyEnvelopeFields(row: {
  sourceId: string;
  externalId: string;
  streamKey: string | null;
  actorId: string | null;
  ts: string | null;
  kind: string | null;
  text: string | null;
  isHistorical: boolean | undefined;
}): {
  capturedAt: string;
  origin: EventOrigin;
  ageBand: AgeBand;
  actor: string;
  rolesJson: string;
  payloadJson: string;
  contentHash: string;
  blobRefsJson: string;
} {
  const nowMs = Date.now();
  const actor = row.actorId ?? "self";
  const payload = {
    external_id: row.externalId,
    text: row.text ?? undefined,
  };
  const roles: EventRoles = {
    sender: actor,
    audience: [],
    receiver: [],
    mentions: [],
  };
  return {
    capturedAt: new Date(nowMs).toISOString(),
    origin: row.isHistorical ? "backfill" : "live",
    ageBand: row.ts ? ageBandFor(row.ts, nowMs) : "A",
    actor,
    rolesJson: JSON.stringify(roles),
    payloadJson: JSON.stringify(payload),
    contentHash: contentHash({
      source: row.sourceId,
      streamKey: row.streamKey ?? "",
      actor,
      ts: row.ts ?? "",
      kind: row.kind ?? "",
      payload,
    }),
    blobRefsJson: "[]",
  };
}
