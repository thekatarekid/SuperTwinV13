// [CODE] The read/write API behind the two inspection surfaces — Entities
// (§14.1) and Sessions (§14.2), build item 1.11.
//
// Every shape here is a VIEW shape, not a table row. The worker owns the joins
// (identity → entity, edge → evidence quote, session → stream label) because a
// surface that stitches rows together in the browser is a surface that can
// disagree with the database about what happened.
//
// Two conventions the surfaces depend on:
//
//  1. EVERY GESTURE RETURNS ITS MUTATION RECEIPT. `mutations(actor:user)` is
//     the audit trail "undo run X" replays over (§6), so a gesture that wrote
//     nothing and a gesture that wrote a row must be distinguishable from the
//     UI. The receipt is rendered, not swallowed.
//  2. A REPLAY NEVER APPLIES. `replaySegmentation` is a dry run that returns a
//     diff; `applySegmentation` is a separate call the human has to make. The
//     two are different methods so no amount of UI wiring can conflate them.

import { workerUrl } from "./config";
import type { CoverageRow } from "../components/CoverageMeter";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The one actor a surface gesture may ever write under. */
export const USER_ACTOR = "user";

/** What `POST`ing a gesture hands back: the `mutations` row it wrote. */
export interface MutationReceipt {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field?: string | null;
}

/** §14.0 — the meter's data, identical on every surface. */
export interface CoverageSnapshot {
  mode: "bootstrap" | "steady" | "reprocess";
  rows: CoverageRow[];
  /** Verbatim from the scheduler (`lanes.pauseState`); the UI never composes it. */
  pausedLabel?: string | null;
  remainingMinutes?: number | null;
}

// ---------------------------------------------------------------------------
// Entities (§14.1)
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = [
  "person",
  "group",
  "org",
  "place",
  "thing",
  "media_work",
  "document",
  "occasion",
  "topic",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const EDGE_KINDS = [
  "related_to",
  "affiliated_with",
  "has",
  "located_at",
  "part_of",
  "participates_in",
  "about",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface IdentityView {
  id: string;
  /** jid | phone | email | handle | account_id | device_id | profile_url | alias */
  kind: string;
  /** Already elided by the worker — "9177…03", never the full number. */
  value: string;
  sourceId: string | null;
  confidence: number | null;
  /** `code:exact`, `user`, `ml`, `agent:p-ag1` — §1.10's "zero silent guesses". */
  decidedBy: string | null;
}

/** An edge's evidence: the event it came from and the VERBATIM quote (§6). */
export interface EdgeEvidenceView {
  eventId: string;
  quote: string;
}

/** One hop out of (or into) the entity being inspected. */
export interface RelationView {
  edgeId: string;
  kind: EdgeKind;
  subtype: string | null;
  direction: "out" | "in";
  otherId: string;
  otherLabel: string;
  confidence: number | null;
  decidedBy: string | null;
  status: "active" | "superseded" | "rejected";
  evidence: EdgeEvidenceView[];
}

export interface EntityView {
  id: string;
  type: EntityType;
  subtype: string | null;
  label: string;
  /** Not yet reconciled — rendered as provisional, never as settled fact (§14.0b). */
  provisional: boolean;
  pinned: boolean;
  firstSeenAt: string | null;
  identities: IdentityView[];
  relations: RelationView[];
  counts: { sessions: number; episodes: number; arcs: number };
  /** Has a pair sitting in the resolution queue. */
  needsResolution: boolean;
}

export interface EntitiesPage {
  /** Per-type totals for the filter chips — the whole corpus, not this page. */
  counts: Partial<Record<EntityType, number>>;
  unresolvedCount: number;
  entities: EntityView[];
}

export interface EntityQuery {
  type?: EntityType | null;
  q?: string;
  unresolvedOnly?: boolean;
}

/** A pair the ladder could not settle. The agent's reasoning ships with it. */
export interface ResolutionQueueItem {
  id: string;
  left: { id: string; label: string };
  right: { id: string; label: string };
  /** What the agent concluded, when it was asked at all. */
  agentVerdict: "same" | "different" | "unsure" | null;
  confidence: number | null;
  /** Verbatim reasoning. Never summarised, never truncated by the client. */
  reasoning: string;
  askedAt: string | null;
}

export type ResolutionVerdict = "same" | "different" | "later";

// ---------------------------------------------------------------------------
// Sessions (§14.2)
// ---------------------------------------------------------------------------

export const BOUNDARY_REASONS = [
  "gap",
  "participant_shift",
  "reply_break",
  "size_cap",
  "day_boundary",
  "context_shift",
  "record_bounded",
  "ceiling",
  "debounce",
  "stream_start",
  "author_shift",
  "late_arrival",
] as const;
export type BoundaryReason = (typeof BOUNDARY_REASONS)[number];

export type SealMode = "immediate" | "debounce" | "ceiling";

/**
 * A boundary as the segmenter recorded it: the rule that fired plus the numbers
 * it measured. Both halves are required — "gap" without "7h20m > 6h" is a label,
 * and §10.4 asks for an explanation.
 */
export interface BoundaryView {
  reason: BoundaryReason;
  measured: Readonly<Record<string, number | string | boolean>>;
}

export interface SessionView {
  id: string;
  streamId: string | null;
  streamLabel: string;
  sourceId: string | null;
  sourceLabel: string;
  /** conversation | bounded | activity | ambient | document */
  kind: string;
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
  participants: string[];
  status: "open" | "sealed";
  sealMode: SealMode | null;
  sealedAt: string | null;
  contentHash: string | null;
  supersededHash: string | null;
  boundaryStart: BoundaryView;
  /** Null while the session is still open — there is no end rule yet. */
  boundaryEnd: BoundaryView | null;
  pendingEnrichmentCount: number;
  /** "1 voice note pending · text understood immediately", from the worker. */
  enrichmentNote: string | null;
  reprocessCount: number;
  reprocessedAt: string | null;
  reprocessReason: string | null;
  lateArrival: boolean;
  overlapOf: string | null;
  /** The understanding pass has run over the sealed content. */
  understood: boolean;
}

export interface SessionsPage {
  sessions: SessionView[];
  sealedCount: number;
  /** Filter options, so the surface never invents a source or stream name. */
  sources: { id: string; label: string }[];
  streams: { id: string; label: string; sourceId: string | null }[];
}

export interface SessionQuery {
  sourceId?: string | null;
  streamId?: string | null;
  /** Local `YYYY-MM-DD`; absent means every day. */
  date?: string | null;
}

/** The segmentation knobs a per-stream override may state (§10.4). */
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
  /** The kind's defaults — what applies with no override in place. */
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

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface GestureActor {
  actor: string;
}

/**
 * The slice of a surface client the coverage meter needs — §14.0's "on every
 * surface" is only enforceable if every surface's client can be handed to
 * `<SurfaceCoverage>`, whatever else that client can do.
 */
export interface CoverageClient {
  getCoverage(signal?: AbortSignal): Promise<CoverageSnapshot>;
}

export interface SurfacesClient extends CoverageClient {
  listEntities(query: EntityQuery, signal?: AbortSignal): Promise<EntitiesPage>;
  mergeEntity(p: GestureActor & { id: string; into: string }): Promise<MutationReceipt>;
  splitEntity(p: GestureActor & { id: string; identityIds: string[] }): Promise<MutationReceipt>;
  renameEntity(p: GestureActor & { id: string; canonical: string }): Promise<MutationReceipt>;
  pinEntity(p: GestureActor & { id: string; pinned: boolean }): Promise<MutationReceipt>;
  addRelation(
    p: GestureActor & { id: string; kind: EdgeKind; subtype: string | null; dstEntityId: string },
  ): Promise<MutationReceipt>;
  rejectEdge(p: GestureActor & { edgeId: string }): Promise<MutationReceipt>;

  listResolutionQueue(signal?: AbortSignal): Promise<ResolutionQueueItem[]>;
  answerResolution(
    p: GestureActor & { id: string; verdict: ResolutionVerdict },
  ): Promise<MutationReceipt>;

  listSessions(query: SessionQuery, signal?: AbortSignal): Promise<SessionsPage>;
  getSegmentation(streamId: string, signal?: AbortSignal): Promise<StreamSegmentation>;
  saveSegmentation(
    p: GestureActor & { streamId: string; overrides: Partial<SegmentationParams> },
  ): Promise<MutationReceipt>;
  /** DRY RUN. Returns a diff and writes nothing. */
  replaySegmentation(
    p: { streamId: string; params: Partial<SegmentationParams> },
    signal?: AbortSignal,
  ): Promise<ReplayDiff>;
  /** The write the replay refused to do, made explicitly by a human. */
  applySegmentation(
    p: GestureActor & { streamId: string; params: Partial<SegmentationParams> },
  ): Promise<MutationReceipt>;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(workerUrl(path), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const res = await fetch(workerUrl(path), {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function qs(params: Record<string, string | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

const id = (v: string) => encodeURIComponent(v);

/**
 * `/api/sessions` is also the path Phase 0 served the CLI chat-session list on.
 * The two shapes are different — this one is an object, that one a bare array —
 * so a worker still on the old handler is caught here and named, rather than
 * rendering a screen of chat transcripts as if they were segmented sessions.
 */
function assertSessionsPage(body: unknown): SessionsPage {
  if (Array.isArray(body) || typeof body !== "object" || body === null || !("sessions" in body)) {
    throw new Error(
      "GET /api/sessions returned the Phase-0 chat-session list, not the V2 sessions page",
    );
  }
  return body as SessionsPage;
}

export const surfacesClient: SurfacesClient = {
  getCoverage: (signal) => getJson<CoverageSnapshot>("/api/coverage", signal),

  listEntities: (query, signal) =>
    getJson<EntitiesPage>(
      `/api/entities${qs({
        type: query.type ?? undefined,
        q: query.q,
        unresolved: query.unresolvedOnly ? "1" : undefined,
      })}`,
      signal,
    ),

  mergeEntity: ({ id: entityId, into, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/entities/${id(entityId)}/merge`, { into, actor }),

  splitEntity: ({ id: entityId, identityIds, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/entities/${id(entityId)}/split`, {
      identityIds,
      actor,
    }),

  renameEntity: ({ id: entityId, canonical, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/entities/${id(entityId)}/rename`, {
      canonical,
      actor,
    }),

  pinEntity: ({ id: entityId, pinned, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/entities/${id(entityId)}/pin`, { pinned, actor }),

  addRelation: ({ id: entityId, kind, subtype, dstEntityId, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/entities/${id(entityId)}/relations`, {
      kind,
      subtype,
      dstEntityId,
      actor,
    }),

  rejectEdge: ({ edgeId, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/entities/edges/${id(edgeId)}/reject`, { actor }),

  listResolutionQueue: (signal) => getJson<ResolutionQueueItem[]>("/api/resolution-queue", signal),

  answerResolution: ({ id: questionId, verdict, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/resolution-queue/${id(questionId)}`, {
      verdict,
      actor,
    }),

  listSessions: async (query, signal) =>
    assertSessionsPage(
      await getJson<unknown>(
        `/api/sessions${qs({
          source: query.sourceId ?? undefined,
          stream: query.streamId ?? undefined,
          date: query.date ?? undefined,
        })}`,
        signal,
      ),
    ),

  getSegmentation: (streamId, signal) =>
    getJson<StreamSegmentation>(`/api/streams/${id(streamId)}/segmentation`, signal),

  saveSegmentation: ({ streamId, overrides, actor }) =>
    sendJson<MutationReceipt>("PUT", `/api/streams/${id(streamId)}/segmentation`, {
      overrides,
      actor,
    }),

  replaySegmentation: ({ streamId, params }) =>
    sendJson<ReplayDiff>("POST", `/api/streams/${id(streamId)}/segmentation/replay`, { params }),

  applySegmentation: ({ streamId, params, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/streams/${id(streamId)}/segmentation/apply`, {
      params,
      actor,
    }),
};
