// ===========================================================================
// [CODE] Sessions surface routes — build item 1.11, arch §14.2 (the Sessions
// surface) and §10.4 (segmentation, replay, the seal).
//
// One read and four writes-or-dry-runs:
//
//   GET  /api/sessions                        the page: sessions + filter opts
//   GET  /api/streams/:id/segmentation        defaults · override · effective
//   PUT  /api/streams/:id/segmentation        store the per-stream override
//   POST /api/streams/:id/segmentation/replay DRY RUN — a diff, no writes
//   POST /api/streams/:id/segmentation/apply  the re-cut a human confirmed
//
// Two rules this module exists to keep:
//
//  1. A REPLAY NEVER APPLIES (§14.2). `/replay` walks the stream twice — once
//     with the standing policy, once with the candidate — and answers with the
//     difference. It touches no table. `/apply` is a separate call, and it is
//     the only one that re-cuts anything. Two methods, so no amount of UI
//     wiring can conflate "show me" with "do it".
//
//  2. NOTHING IS RECOMPUTED HERE. The boundary rules live in
//     `sessions/policies.ts`, the walk in `sessions/segment.ts`, the seal in
//     `sessions/seal.ts`. This file loads rows, calls them, and shapes the
//     answer — a surface that re-derives a boundary is a surface that can
//     disagree with the segmenter about where a session ended.
//
// ⚠ `GET /api/sessions` COLLIDES with the Phase-0 chat-session list, which
//   answers with a BARE ARRAY of CLI chat transcripts. The client detects that
//   shape and names it (`assertSessionsPage`, src/lib/surfaces-client.ts), so
//   this handler must be mounted AHEAD of the legacy one and the legacy list
//   moved to its own path.
//
// The wire shapes below mirror `src/lib/surfaces-client.ts` §Sessions. They are
// restated rather than imported because the worker does not build against the
// UI's tsconfig; the client's interfaces are the contract either way.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getManifest, isStreamKind, type StreamKind } from "../adapters/registry.js";
import { getDb } from "../db/connection.js";
import { getEntity } from "../entities/registry.js";
import { logMutation } from "../entities/merge.js";
import { enqueueWork } from "../scheduler/queue.js";
import { isDroppedAtAdapter } from "../sessions/ops.js";
import {
  isBoundaryReason,
  KIND_DEFAULTS,
  localDayKey,
  parseOverride,
  resolvePolicy,
  tsMs,
  type BoundaryReason,
  type PolicyOverride,
  type SessionPolicy,
} from "../sessions/policies.js";
import { sealStream, textIndex } from "../sessions/seal.js";
import { segment, type MeasuredParams, type SegEvent, type SegSession } from "../sessions/segment.js";

/** How many sessions one page carries. The surface is a browser, not an export. */
const PAGE_LIMIT = 500;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (src/lib/surfaces-client.ts lines 173–267)
// ---------------------------------------------------------------------------

/** The rule that fired plus the numbers it measured. Both halves, always. */
export interface BoundaryView {
  reason: BoundaryReason;
  measured: MeasuredParams;
}

export interface SessionView {
  id: string;
  streamId: string | null;
  streamLabel: string;
  sourceId: string | null;
  sourceLabel: string;
  kind: string;
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
  participants: string[];
  status: "open" | "sealed";
  sealMode: string | null;
  sealedAt: string | null;
  contentHash: string | null;
  supersededHash: string | null;
  boundaryStart: BoundaryView;
  boundaryEnd: BoundaryView | null;
  pendingEnrichmentCount: number;
  enrichmentNote: string | null;
  reprocessCount: number;
  reprocessedAt: string | null;
  reprocessReason: string | null;
  lateArrival: boolean;
  overlapOf: string | null;
  understood: boolean;
}

export interface SessionsPage {
  sessions: SessionView[];
  sealedCount: number;
  sources: { id: string; label: string }[];
  streams: { id: string; label: string; sourceId: string | null }[];
}

/** The knobs a per-stream override may state (§10.4). */
export interface SegmentationParams {
  gapMs: number;
  shiftMinGapMs: number;
  sizeCapEvents: number;
  sizeCapChars: number;
  dayBoundary: boolean;
  debounceMs: number;
  ceilingMs: number;
}

export interface StreamSegmentation {
  streamId: string;
  streamLabel: string;
  kind: string;
  defaults: SegmentationParams;
  overrides: Partial<SegmentationParams>;
  effective: SegmentationParams;
}

export interface ReplayDiffRow {
  change: "added" | "removed" | "unchanged";
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
  boundaryStart: BoundaryView;
  boundaryEnd: BoundaryView | null;
}

/** The result of a DRY RUN. Nothing in this shape has been written. */
export interface ReplayDiff {
  streamId: string;
  params: Partial<SegmentationParams>;
  sessionsBefore: number;
  sessionsAfter: number;
  rows: ReplayDiffRow[];
}

/** What every gesture hands back — the `mutations` row it wrote (§6). */
export interface MutationReceipt {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field?: string | null;
}

/** The one actor a surface gesture may ever write under. */
const USER_ACTOR = "user";

// ---------------------------------------------------------------------------
// Params ⇄ policy
// ---------------------------------------------------------------------------

/**
 * The wire's camelCase against the policy's snake_case, in one table so the two
 * directions can never drift apart. Only these seven fields are editable from
 * the surface; the rest of a `SessionPolicy` is the kind's business (§10.4).
 */
const NUMERIC_PARAMS = [
  ["gapMs", "gap_ms"],
  ["shiftMinGapMs", "shift_min_gap_ms"],
  ["sizeCapEvents", "size_cap_events"],
  ["sizeCapChars", "size_cap_chars"],
  ["debounceMs", "debounce_ms"],
  ["ceilingMs", "ceiling_ms"],
] as const satisfies readonly (readonly [keyof SegmentationParams, keyof SessionPolicy])[];

/**
 * A policy as the surface edits it.
 *
 * An uncapped field is `Infinity` in the policy and serialises as `null` — the
 * honest wire spelling of "no cap". The editor renders a null as an empty knob
 * and only sends a number back when a human types one, so a round-trip never
 * silently turns "uncapped" into zero.
 */
function toParams(policy: SessionPolicy): SegmentationParams {
  return {
    gapMs: policy.gap_ms,
    shiftMinGapMs: policy.shift_min_gap_ms,
    sizeCapEvents: policy.size_cap_events,
    sizeCapChars: policy.size_cap_chars,
    dayBoundary: policy.day_boundary,
    debounceMs: policy.debounce_ms,
    ceilingMs: policy.ceiling_ms,
  };
}

/**
 * A candidate the surface sent, as a policy override. Anything that is not a
 * finite non-negative number (or a boolean, for `dayBoundary`) is DROPPED
 * rather than coerced: a field nobody stated must fall through to the kind's
 * default, and a `null` on the wire means exactly that.
 */
function toOverride(raw: unknown): PolicyOverride {
  const out: PolicyOverride = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const [wire, policyKey] of NUMERIC_PARAMS) {
    const v = rec[wire];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      (out as Record<string, unknown>)[policyKey] = v;
    }
  }
  if (typeof rec.dayBoundary === "boolean") out.day_boundary = rec.dayBoundary;
  return out;
}

/** The override as the surface reads it back — the mirror of `toOverride`. */
function overrideToParams(override: PolicyOverride | null): Partial<SegmentationParams> {
  const out: Partial<SegmentationParams> = {};
  if (!override) return out;
  for (const [wire, policyKey] of NUMERIC_PARAMS) {
    const v = override[policyKey];
    if (typeof v === "number") (out as Record<string, unknown>)[wire] = v;
  }
  if (typeof override.day_boundary === "boolean") out.dayBoundary = override.day_boundary;
  return out;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

interface StreamRow {
  id: string;
  source_id: string | null;
  external_key: string | null;
  label: string | null;
  stream_kind: string | null;
  tz: string | null;
  segmentation_override_json: string | null;
  actor_model: string | null;
}

/**
 * One stream with the source facts the policy needs. There is no stream store
 * module yet (item 1.1 still owns the `channels` → `streams` rename), so the
 * read is spelled here rather than in a helper nobody else can use.
 */
function readStream(streamId: string): StreamRow | null {
  const row = getDb()
    .prepare(
      `SELECT st.id, st.source_id, st.external_key, st.label, st.stream_kind, st.tz,
              st.segmentation_override_json, so.actor_model AS actor_model
         FROM streams st
         LEFT JOIN sources so ON so.id = st.source_id
        WHERE st.id = ?`,
    )
    .get(streamId) as StreamRow | undefined;
  return row ?? null;
}

/**
 * Which of the five shapes this lane is (§2.1). The manifest owns the answer —
 * `stream_kind_of` is the extension point — and the stored lane word is only
 * consulted when the source is not registered (a fresh DB, an import from a
 * source this build no longer ships).
 */
function kindOf(stream: StreamRow): StreamKind {
  const manifest = stream.source_id ? getManifest(stream.source_id) : undefined;
  if (manifest) {
    return manifest.stream_kind_of({
      external_key: stream.external_key ?? stream.id,
      kind: stream.stream_kind ?? undefined,
      label: stream.label ?? undefined,
    });
  }
  return isStreamKind(stream.stream_kind) ? stream.stream_kind : "conversation";
}

/** The policy this lane is segmented by, override included unless one is given. */
function policyFor(stream: StreamRow, override?: PolicyOverride | null): SessionPolicy {
  const manifest = stream.source_id ? getManifest(stream.source_id) : undefined;
  return resolvePolicy({
    kind: kindOf(stream),
    segmentation: manifest?.segmentation ?? null,
    lane: stream.stream_kind,
    override: override === undefined ? parseOverride(stream.segmentation_override_json) : override,
    actor_model: stream.actor_model === "single_actor" ? "single_actor" : "multi_actor",
  });
}

function streamLabelOf(stream: StreamRow): string {
  return stream.label ?? stream.external_key ?? stream.id;
}

function tzOf(stream: StreamRow): string {
  return stream.tz ?? "UTC";
}

// ---------------------------------------------------------------------------
// GET /api/sessions
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  stream_id: string | null;
  source_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  tz: string | null;
  event_count: number | null;
  participant_entity_ids: string | null;
  boundary_reason_start: string | null;
  boundary_reason_end: string | null;
  boundary_params_json: string | null;
  seal_mode: string | null;
  content_hash: string | null;
  superseded_hash: string | null;
  status: string | null;
  sealed_at: string | null;
  late_arrival: number | null;
  overlap_of: string | null;
  pending_enrichment_count: number | null;
  reprocess_count: number | null;
  stream_label: string | null;
  stream_key: string | null;
  stream_kind: string | null;
  stream_tz: string | null;
  source_label: string | null;
  actor_model: string | null;
  understood: number | null;
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/** `boundary_params_json` is `{ start, end }`; a malformed blob reads as empty. */
function parseBoundaryParams(json: string | null): { start: MeasuredParams; end: MeasuredParams | null } {
  if (!json) return { start: {}, end: null };
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return { start: {}, end: null };
    const rec = parsed as { start?: unknown; end?: unknown };
    const measured = (v: unknown): MeasuredParams =>
      typeof v === "object" && v !== null && !Array.isArray(v) ? (v as MeasuredParams) : {};
    return {
      start: measured(rec.start),
      end: rec.end === null || rec.end === undefined ? null : measured(rec.end),
    };
  } catch {
    return { start: {}, end: null };
  }
}

function boundaryView(reason: string | null, measured: MeasuredParams, fallback: BoundaryReason): BoundaryView {
  return { reason: isBoundaryReason(reason) ? reason : fallback, measured };
}

/**
 * "1 voice note pending · text understood immediately" (§8.4, §9.6): media
 * never blocks text, so the note says BOTH halves or it says nothing. The
 * surface renders it verbatim and never composes one of its own.
 */
function enrichmentNoteFor(pending: number): string | null {
  if (pending <= 0) return null;
  return `${pending} enrichment${pending === 1 ? "" : "s"} pending · text understood immediately`;
}

/** Entity ids read as their canonical labels; an unknown id reads as itself. */
function participantLabels(entityIds: readonly string[]): string[] {
  return entityIds.map((id) => getEntity(id)?.canonical ?? id);
}

function toSessionView(row: SessionRow): SessionView {
  const boundary = parseBoundaryParams(row.boundary_params_json);
  const pending = row.pending_enrichment_count ?? 0;
  return {
    id: row.id,
    streamId: row.stream_id,
    streamLabel: row.stream_label ?? row.stream_key ?? row.stream_id ?? "unknown stream",
    sourceId: row.source_id,
    sourceLabel: row.source_label ?? row.source_id ?? "unknown source",
    kind: kindOf({
      id: row.stream_id ?? "",
      source_id: row.source_id,
      external_key: row.stream_key,
      label: row.stream_label,
      stream_kind: row.stream_kind,
      tz: row.stream_tz,
      segmentation_override_json: null,
      actor_model: row.actor_model,
    }),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    eventCount: row.event_count ?? 0,
    participants: participantLabels(parseJsonArray(row.participant_entity_ids)),
    status: row.status === "sealed" ? "sealed" : "open",
    sealMode: row.seal_mode,
    sealedAt: row.sealed_at,
    contentHash: row.content_hash,
    supersededHash: row.superseded_hash,
    boundaryStart: boundaryView(row.boundary_reason_start, boundary.start, "stream_start"),
    boundaryEnd:
      row.boundary_reason_end === null
        ? null
        : boundaryView(row.boundary_reason_end, boundary.end ?? {}, "gap"),
    pendingEnrichmentCount: pending,
    enrichmentNote: enrichmentNoteFor(pending),
    reprocessCount: row.reprocess_count ?? 0,
    // Migration 0020's `sessions` carries the reprocess COUNT and nothing else —
    // no stamp, no reason. Inventing either from `sealed_at` would put a time on
    // screen that no pass ever recorded, so both stay null until a column does.
    reprocessedAt: null,
    reprocessReason: null,
    lateArrival: (row.late_arrival ?? 0) !== 0,
    overlapOf: row.overlap_of,
    understood: (row.understood ?? 0) > 0,
  };
}

function sessionsPage(query: { sourceId: string | null; streamId: string | null; date: string | null }): SessionsPage {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.stream_id, s.source_id, s.started_at, s.ended_at, s.tz,
              json_array_length(COALESCE(s.event_ids, '[]'))     AS event_count,
              s.participant_entity_ids, s.boundary_reason_start, s.boundary_reason_end,
              s.boundary_params_json, s.seal_mode, s.content_hash, s.superseded_hash,
              s.status, s.sealed_at, s.late_arrival, s.overlap_of,
              s.pending_enrichment_count, s.reprocess_count,
              st.label        AS stream_label,
              st.external_key AS stream_key,
              st.stream_kind  AS stream_kind,
              st.tz           AS stream_tz,
              COALESCE(so.display_name, so.name, so.id) AS source_label,
              so.actor_model  AS actor_model,
              -- Understanding is a COHORT fact (§9.4): the pass runs over a
              -- cohort's sealed sessions and stamps understood_at when it is
              -- done, so "has this session been understood" is exactly "is it
              -- in a cohort that finished".
              (SELECT COUNT(*)
                 FROM cohorts c, json_each(COALESCE(c.session_ids, '[]')) cj
                WHERE cj.value = s.id AND c.understood_at IS NOT NULL) AS understood
         FROM sessions s
         LEFT JOIN streams st ON st.id = s.stream_id
         LEFT JOIN sources so ON so.id = COALESCE(s.source_id, st.source_id)
        WHERE (? IS NULL OR COALESCE(s.source_id, st.source_id) = ?)
          AND (? IS NULL OR s.stream_id = ?)
        ORDER BY s.started_at DESC, s.id
        LIMIT ?`,
    )
    .all(query.sourceId, query.sourceId, query.streamId, query.streamId, PAGE_LIMIT) as SessionRow[];

  // The date filter is a LOCAL day in the stream's zone (§10.4 note 6), so it
  // cannot be a string comparison against a UTC stamp: 23:50 and 00:01 in
  // Asia/Kolkata are two days apart while their UTC stamps share one.
  const matched = query.date
    ? rows.filter((r) => localDayKey(tsMs(r.started_at), r.tz ?? r.stream_tz ?? "UTC") === query.date)
    : rows;

  const sources = db
    .prepare(`SELECT id, COALESCE(display_name, name, id) AS label FROM sources ORDER BY label, id`)
    .all() as { id: string; label: string }[];
  const streams = db
    .prepare(
      `SELECT id, COALESCE(label, external_key, id) AS label, source_id AS sourceId
         FROM streams ORDER BY label, id`,
    )
    .all() as { id: string; label: string; sourceId: string | null }[];

  return {
    sessions: matched.map(toSessionView),
    sealedCount: matched.filter((r) => r.status === "sealed").length,
    sources,
    streams,
  };
}

// ---------------------------------------------------------------------------
// The walk, for replay and apply
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  external_id: string | null;
  ts: string | null;
  actor_id: string | null;
  actor_entity_id: string | null;
  actor_raw: string | null;
  kind: string | null;
  text: string | null;
  media_description: string | null;
  transcript: string | null;
  link_scraped_text: string | null;
  reply_to_external_id: string | null;
  ts_end: string | null;
  salience: number | null;
}

/**
 * One stream's events, in `ts` order — never rowid (§3.3 rule 8). The same read
 * `confluence/pipeline.ts` does before it segments, for the same reason: the
 * walk is only replayable if the input order is a property of the data.
 */
function streamEvents(streamId: string): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, external_id, ts, actor_id, actor_entity_id, actor_raw, kind, text,
              media_description, transcript, link_scraped_text, reply_to_external_id,
              ts_end, salience
         FROM events WHERE stream_id = ? ORDER BY ts, id`,
    )
    .all(streamId) as EventRow[];
}

/**
 * An event row as the segmenter sees it. Enrichment text is INSIDE the size cap
 * and the content hash (§10.4), so a transcript or a scraped page counts here
 * exactly as it will when the session is sealed.
 */
function toSegEvent(row: EventRow): SegEvent {
  return {
    external_id: row.external_id ?? row.id,
    ts: row.ts ?? "",
    actor: row.actor_entity_id ?? row.actor_id ?? row.actor_raw ?? "unknown",
    kind: row.kind ?? "message",
    text: row.text ?? "",
    enrichment_text: row.transcript ?? row.media_description ?? row.link_scraped_text ?? undefined,
    reply_to_external_id: row.reply_to_external_id,
    ts_end: row.ts_end,
    salience: row.salience ?? undefined,
  };
}

/** The events a walk over this stream would consider, receipts already dropped. */
function segEventsFor(streamId: string): { rows: EventRow[]; events: SegEvent[] } {
  // §10.4 note 5 — a read receipt or delivery ack is not an event. The adapter
  // already drops them; re-applying the same predicate keeps a replay honest
  // over rows ingested before that guard existed.
  const rows = streamEvents(streamId).filter((r) => !isDroppedAtAdapter(r.kind ?? "message"));
  return { rows, events: rows.map(toSegEvent) };
}

function walk(stream: StreamRow, policy: SessionPolicy, events: readonly SegEvent[]): SegSession[] {
  return segment({
    stream: { key: stream.id, tz: tzOf(stream), source_id: stream.source_id ?? undefined },
    policy,
    events,
    run_mode: "bootstrap",
  }).sessions;
}

function toDiffRow(session: SegSession, change: ReplayDiffRow["change"]): ReplayDiffRow {
  return {
    change,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    eventCount: session.event_count,
    boundaryStart: { reason: session.boundary_reason_start, measured: session.boundary_params.start },
    boundaryEnd:
      session.boundary_reason_end === null
        ? null
        : { reason: session.boundary_reason_end, measured: session.boundary_params.end ?? {} },
  };
}

/**
 * The difference between two walks, keyed by session id.
 *
 * A session id is derived from the stream key, the start instant and the first
 * event (`sessionIdOf`), so identical cuts land on identical ids and "did this
 * boundary move" needs no fuzzy matching. Both sides are WALKS, not the stored
 * rows: diffing a fresh walk against a cut taken months ago under a different
 * policy would report drift as if the candidate params had caused it.
 */
function diffWalks(before: readonly SegSession[], after: readonly SegSession[]): ReplayDiffRow[] {
  const beforeById = new Map(before.map((s) => [s.id, s]));
  const afterById = new Map(after.map((s) => [s.id, s]));
  const rows: ReplayDiffRow[] = [];
  for (const s of before) if (!afterById.has(s.id)) rows.push(toDiffRow(s, "removed"));
  for (const s of after) rows.push(toDiffRow(s, beforeById.has(s.id) ? "unchanged" : "added"));
  rows.sort((a, b) => tsMs(a.startedAt) - tsMs(b.startedAt));
  return rows;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function actorOf(body: Record<string, unknown> | undefined): string {
  return typeof body?.actor === "string" && body.actor !== "" ? body.actor : USER_ACTOR;
}

function saveOverride(stream: StreamRow, override: PolicyOverride): string {
  const json = Object.keys(override).length > 0 ? JSON.stringify(override) : null;
  getDb().prepare(`UPDATE streams SET segmentation_override_json = ? WHERE id = ?`).run(json, stream.id);
  return json ?? "";
}

/**
 * Re-cut one stream at the confirmed params.
 *
 * This is the destructive half of the surface and it is deliberately narrow:
 * the stream's own sessions are replaced, and nothing else is touched. Session
 * ids and content hashes MOVE — that is what re-cutting means — so every new
 * sealed session is re-enqueued for the episode pass, and the episode rows that
 * pointed at the old cut fall away with it (`episode_sessions` cascades).
 * `event_ids` is stored as DB ids, matching every other writer of this table.
 */
function recut(stream: StreamRow, policy: SessionPolicy): { before: string[]; after: SegSession[] } {
  const db = getDb();
  const { rows, events } = segEventsFor(stream.id);
  const dbIdByExternal = new Map(rows.map((r) => [r.external_id ?? r.id, r.id]));
  const sealed = sealStream(
    walk(stream, policy, events),
    { policy, run_mode: "bootstrap", now: Date.now() },
    textIndex(events.map((e) => ({ external_id: e.external_id, text: e.text, enrichment_text: e.enrichment_text }))),
  );

  const before = (
    db.prepare(`SELECT id FROM sessions WHERE stream_id = ? ORDER BY started_at, id`).all(stream.id) as {
      id: string;
    }[]
  ).map((r) => r.id);

  const insert = db.prepare(
    `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, tz, event_ids,
                           participant_entity_ids, boundary_reason_start, boundary_reason_end,
                           boundary_params_json, seal_mode, content_hash, superseded_hash,
                           hash_version, status, sealed_at, late_arrival, overlap_of)
     VALUES (@id, @streamId, @sourceId, @startedAt, @endedAt, @tz, @eventIds, @participants,
             @boundaryStart, @boundaryEnd, @boundaryParams, @sealMode, @contentHash,
             @supersededHash, @hashVersion, @status, @sealedAt, @lateArrival, @overlapOf)`,
  );

  db.transaction(() => {
    db.prepare(`DELETE FROM sessions WHERE stream_id = ?`).run(stream.id);
    for (const s of sealed.sessions) {
      insert.run({
        id: s.id,
        streamId: stream.id,
        sourceId: s.source_id,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        tz: s.tz,
        eventIds: JSON.stringify(
          s.event_ids.map((ext) => dbIdByExternal.get(ext)).filter((v): v is string => v !== undefined),
        ),
        participants: JSON.stringify(s.actors),
        boundaryStart: s.boundary_reason_start,
        boundaryEnd: s.boundary_reason_end,
        boundaryParams: JSON.stringify(s.boundary_params),
        sealMode: s.seal_mode,
        contentHash: s.content_hash,
        supersededHash: s.superseded_hash,
        hashVersion: s.hash_version,
        status: s.status,
        sealedAt: s.sealed_at,
        lateArrival: s.late_arrival ? 1 : 0,
        overlapOf: s.overlap_of,
      });
    }
  })();

  // A re-cut session has never been judged, so it goes back through the same
  // door every other sealed session uses. Priority 0: the scheduler reprices on
  // its next plan, and a hand-triggered re-cut may not jump a running cohort.
  for (const s of sealed.sessions) {
    if (s.status !== "sealed") continue;
    enqueueWork({ unitKind: "session", unitId: s.id, stage: "episode", priority: 0 });
  }
  return { before, after: sealed.sessions };
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

const SEGMENTATION = /^\/api\/streams\/([^/]+)\/segmentation$/;
const SEGMENTATION_REPLAY = /^\/api\/streams\/([^/]+)\/segmentation\/replay$/;
const SEGMENTATION_APPLY = /^\/api\/streams\/([^/]+)\/segmentation\/apply$/;

/**
 * Handle a Sessions-surface request. Returns true when this module owns the
 * path — `GET /api/sessions` and everything under `/api/streams/`.
 *
 * The Phase-0 chat-session routes that used to live under `/api/sessions` have
 * moved to `/api/chat/sessions*` in the hand-written router, so nothing here
 * has to leave a hole for them.
 */
export async function handleSessionsV2Route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const ownsStreams = path.startsWith("/api/streams/");
  if (!ownsStreams && !(method === "GET" && path === "/api/sessions")) return false;

  // ---- GET /api/sessions?source=&stream=&date= ----------------------------
  if (!ownsStreams) {
    sendJson(
      res,
      200,
      sessionsPage({
        sourceId: url.searchParams.get("source"),
        streamId: url.searchParams.get("stream"),
        date: url.searchParams.get("date"),
      }) satisfies SessionsPage,
    );
    return true;
  }

  // Every /api/streams/ route below is per-stream, so the row is read once and
  // an unknown id is one 404 rather than four spellings of the same check.
  const match =
    path.match(SEGMENTATION) ?? path.match(SEGMENTATION_REPLAY) ?? path.match(SEGMENTATION_APPLY);
  if (!match) {
    sendJson(res, 404, { error: "unknown streams route" });
    return true;
  }
  const streamId = decodeURIComponent(match[1]!);
  const stream = readStream(streamId);
  if (!stream) {
    sendJson(res, 404, { error: "no stream with that id" });
    return true;
  }
  const kind = kindOf(stream);

  // ---- GET /api/streams/:id/segmentation ----------------------------------
  if (method === "GET" && SEGMENTATION.test(path)) {
    const override = parseOverride(stream.segmentation_override_json);
    sendJson(res, 200, {
      streamId: stream.id,
      streamLabel: streamLabelOf(stream),
      kind,
      // The KIND's defaults — what applies with no override in place. The
      // manifest's own windows are part of `effective`, not of this.
      defaults: toParams(KIND_DEFAULTS[kind]),
      overrides: overrideToParams(override),
      effective: toParams(policyFor(stream)),
    } satisfies StreamSegmentation);
    return true;
  }

  // ---- PUT /api/streams/:id/segmentation { overrides, actor } -------------
  if (method === "PUT" && SEGMENTATION.test(path)) {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "body must be a JSON object" });
      return true;
    }
    const override = toOverride(body.overrides);
    const oldValue = stream.segmentation_override_json;
    const newValue = saveOverride(stream, override);
    const mutationId = logMutation({
      actor: actorOf(body),
      targetKind: "stream",
      targetId: stream.id,
      field: "segmentation_override_json",
      oldValue,
      newValue,
      reason: "segmentation override saved from the Sessions surface",
    });
    sendJson(res, 200, {
      mutationId,
      actor: actorOf(body),
      targetKind: "stream",
      targetId: stream.id,
      field: "segmentation_override_json",
    } satisfies MutationReceipt);
    return true;
  }

  // ---- POST /api/streams/:id/segmentation/replay { params } — DRY RUN -----
  if (method === "POST" && SEGMENTATION_REPLAY.test(path)) {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "body must be a JSON object" });
      return true;
    }
    const candidate = toOverride(body.params);
    const { events } = segEventsFor(stream.id);
    const before = walk(stream, policyFor(stream), events);
    const after = walk(stream, policyFor(stream, candidate), events);
    sendJson(res, 200, {
      streamId: stream.id,
      params: overrideToParams(candidate),
      sessionsBefore: before.length,
      sessionsAfter: after.length,
      rows: diffWalks(before, after),
    } satisfies ReplayDiff);
    return true;
  }

  // ---- POST /api/streams/:id/segmentation/apply { params, actor } ---------
  if (method === "POST" && SEGMENTATION_APPLY.test(path)) {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "body must be a JSON object" });
      return true;
    }
    const actor = actorOf(body);
    const candidate = toOverride(body.params);
    // The applied params become the stream's standing policy: a re-cut the next
    // import would immediately undo is not a re-cut, it is a flicker.
    const oldOverride = stream.segmentation_override_json;
    saveOverride(stream, candidate);
    const { before, after } = recut(stream, policyFor(stream, candidate));
    const mutationId = logMutation({
      actor,
      targetKind: "stream",
      targetId: stream.id,
      field: "segmentation",
      oldValue: { override: oldOverride, sessions: before },
      newValue: { override: overrideToParams(candidate), sessions: after.map((s) => s.id) },
      reason: `re-segmented ${before.length} session(s) into ${after.length}`,
    });
    sendJson(res, 200, {
      mutationId,
      actor,
      targetKind: "stream",
      targetId: stream.id,
      field: "segmentation",
    } satisfies MutationReceipt);
    return true;
  }

  sendJson(res, 404, { error: "unknown streams route" });
  return true;
}
