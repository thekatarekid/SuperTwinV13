// ===========================================================================
// [CODE] Entities surface routes — build item 1.11, arch §14.1.
//
// The read/write API behind `src/tabs/EntitiesTab.tsx`: one page read, six
// gestures, and the resolution queue with the agent's verbatim reasoning.
//
//   GET  /api/entities?type=&q=&unresolved=1   the page: counts, entities
//   POST /api/entities/:id/merge               { into }        loser → winner
//   POST /api/entities/:id/split               { identityIds }
//   POST /api/entities/:id/rename              { canonical }
//   POST /api/entities/:id/pin                 { pinned }
//   POST /api/entities/:id/relations           { kind, subtype, dstEntityId }
//   POST /api/entities/edges/:id/reject        {}
//   GET  /api/resolution-queue                 open pairs, oldest first
//   POST /api/resolution-queue/:id             { verdict }
//
// EVERY SHAPE HERE IS A VIEW SHAPE, NOT A TABLE ROW. The worker owns the joins
// — identity → entity, edge → evidence quote, entity → session/episode/arc
// counts — because a surface that stitches rows together in the browser is a
// surface that can disagree with the database about what happened.
//
// EVERY GESTURE RETURNS ITS MUTATION RECEIPT. `mutations(actor:user)` is the
// ledger "undo run X" replays over (§6) and the row that makes a correction
// survive re-derivation, so a gesture that wrote nothing and a gesture that
// wrote a row must be distinguishable from the UI. Nothing here writes without
// leaving one, and the receipt is what the tab prints.
//
// IDENTITY VALUES LEAVE ELIDED. "9177…03", never the whole number: §14.1
// renders an identity for recognition, not for copying, and a surface that has
// never held the full string cannot leak it.
//
// The business rules all live in `entities/` — the tombstone merge, the
// permanent `different` verdict, the closed type and edge vocabularies, the
// "no evidence, no write" rule on edges. This module routes, validates and
// projects; it decides nothing.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import { edgeEvidence, edgesOf, mintEdgeId, readEdge, rejectEdge } from "../entities/edges.js";
import { identitiesOf } from "../entities/identities.js";
import {
  logMutation,
  mergeEntities,
  readDecision,
  recordDecision,
  splitEntity,
} from "../entities/merge.js";
import {
  ENTITY_TYPES,
  countEntities,
  createEntity,
  getEntity,
  isEdgeKind,
  isEdgeSubtype,
  isEntityType,
  listEntities,
  mergedAliasIds,
  pinEntity,
  renameEntity,
  resolveEntityId,
  type EdgeKind,
  type EntityRow,
  type EntityType,
} from "../entities/registry.js";
import { AGENT_DECIDER } from "../entities/resolve.js";
import { answerQuestion, listOpenQuestions } from "./ops-routes.js";

/** The one actor a surface gesture may ever write under (§14.0). */
export const USER_ACTOR = "user";

/** The kind/target the resolution ladder parks its pairs under (`merge.ts`). */
const PAIR_QUESTION_KIND = "identity";
const PAIR_TARGET_KIND = "entity_pair";

/** How many entities one page carries. A filter narrows; it never paginates. */
export const ENTITY_PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// The view shapes — mirrors of `src/lib/surfaces-client.ts` §14.1
// ---------------------------------------------------------------------------

export interface IdentityView {
  id: string;
  kind: string;
  /** Already elided — the full value never crosses the wire. */
  value: string;
  sourceId: string | null;
  confidence: number | null;
  decidedBy: string | null;
}

export interface EdgeEvidenceView {
  eventId: string;
  quote: string;
}

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
  provisional: boolean;
  pinned: boolean;
  firstSeenAt: string | null;
  identities: IdentityView[];
  relations: RelationView[];
  counts: { sessions: number; episodes: number; arcs: number };
  needsResolution: boolean;
}

export interface EntitiesPage {
  counts: Partial<Record<EntityType, number>>;
  unresolvedCount: number;
  entities: EntityView[];
}

export interface ResolutionQueueItem {
  id: string;
  left: { id: string; label: string };
  right: { id: string; label: string };
  agentVerdict: "same" | "different" | "unsure" | null;
  confidence: number | null;
  reasoning: string;
  askedAt: string | null;
}

export type ResolutionVerdict = "same" | "different" | "later";

/** What `POST`ing a gesture hands back: the `mutations` row it wrote. */
export interface MutationReceipt {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field?: string | null;
}

// ---------------------------------------------------------------------------
// Local helpers — there is no shared http util module; ops-routes.ts is the
// pattern these two are copied from.
// ---------------------------------------------------------------------------

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

/** Write the ledger row and hand back the receipt the surface renders. */
function receipt(params: {
  targetKind: string;
  targetId: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}): MutationReceipt {
  const mutationId = logMutation({ actor: USER_ACTOR, ...params });
  return {
    mutationId,
    actor: USER_ACTOR,
    targetKind: params.targetKind,
    targetId: params.targetId,
    field: params.field ?? null,
  };
}

/**
 * "9177…03". Short values pass through whole — a four-letter alias elided to
 * nothing tells the human less than it hides.
 */
export function elideIdentityValue(value: string): string {
  const text = String(value ?? "");
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}…${text.slice(-2)}`;
}

/**
 * What to call an entity. `canonical` when somebody named it, otherwise the
 * first alias anybody used for it, and the id as the last resort — never a
 * blank, because an unnamed row still has to be clickable.
 */
function labelOf(row: EntityRow): string {
  const canonical = (row.canonical ?? "").trim();
  if (canonical !== "") return canonical;
  const alias = identitiesOf(row.id).find((i) => i.kind === "alias");
  return alias ? alias.valueNorm : row.id;
}

function entityLabel(id: string): string {
  const row = getEntity(id);
  return row ? labelOf(row) : id;
}

// ---------------------------------------------------------------------------
// Session / episode / arc counts
// ---------------------------------------------------------------------------

interface Participation {
  sessions: Map<string, number>;
  episodes: Map<string, number>;
  arcs: Map<string, number>;
}

/**
 * Sessions, episodes and arcs each record their entities as a JSON array on
 * their own row, and no store function counts them per entity — so the three
 * tallies are read here, once per request, rather than three queries per
 * entity rendered. `json_each` is how the scheduler already walks these arrays
 * (`scheduler/live.ts`). A column holding something that is not JSON would
 * throw mid-read; the page answers with zeroes instead, because "no counts
 * yet" is the honest reading of a corpus that has not been derived.
 */
function tally(sql: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const row of getDb().prepare(sql).all() as { entity_id: string | null; n: number }[]) {
      if (row.entity_id) out.set(row.entity_id, row.n);
    }
  } catch {
    return out;
  }
  return out;
}

function participation(): Participation {
  return {
    sessions: tally(
      `SELECT je.value AS entity_id, COUNT(*) AS n
         FROM sessions s, json_each(COALESCE(s.participant_entity_ids, '[]')) je
        GROUP BY je.value`,
    ),
    episodes: tally(
      `SELECT je.value AS entity_id, COUNT(*) AS n
         FROM episodes e, json_each(COALESCE(e.entity_ids, '[]')) je
        GROUP BY je.value`,
    ),
    arcs: tally(
      `SELECT je.value AS entity_id, COUNT(*) AS n
         FROM arcs a, json_each(COALESCE(a.anchor_entity_ids, '[]')) je
        GROUP BY je.value`,
    ),
  };
}

/** Counts are summed over the tombstones too — a merge is not a lost session. */
function countOver(tallied: Map<string, number>, aliasIds: readonly string[]): number {
  let total = 0;
  for (const id of aliasIds) total += tallied.get(id) ?? 0;
  return total;
}

// ---------------------------------------------------------------------------
// The resolution queue
// ---------------------------------------------------------------------------

function pairOf(targetId: string | null): [string, string] | null {
  const parts = (targetId ?? "").split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return [parts[0], parts[1]];
}

/**
 * Rung ⑤ as the surface renders it. The agent's reasoning ships verbatim —
 * `resolution_decisions.reason` is what P-AG1 actually said, and summarising it
 * here would be the surface deciding what the human needs to know.
 */
export function resolutionQueue(): ResolutionQueueItem[] {
  const items: ResolutionQueueItem[] = [];
  for (const question of listOpenQuestions()) {
    if (question.kind !== PAIR_QUESTION_KIND || question.targetKind !== PAIR_TARGET_KIND) continue;
    const pair = pairOf(question.targetId);
    if (!pair) continue;
    const [left, right] = pair;
    const decision = readDecision(left, right);
    // `queueResolution` files the decider that queued the pair: `agent:p-ag1…`
    // when the agent answered, `code:no_agent` / `code:first_paint` when it was
    // never asked. Only the first of those is an agent verdict.
    const fromAgent = (decision?.decidedBy ?? "").startsWith(AGENT_DECIDER);
    items.push({
      id: question.id,
      left: { id: left, label: entityLabel(left) },
      right: { id: right, label: entityLabel(right) },
      agentVerdict: fromAgent && decision ? decision.verdict : null,
      // `resolution_decisions` has no confidence column — the ladder's score is
      // not persisted with the verdict. Null rather than a number nobody measured.
      confidence: null,
      reasoning: decision?.reason ?? question.question,
      askedAt: question.askedAt,
    });
  }
  return items;
}

/** Every entity with a pair still sitting in the queue, both sides. */
function unresolvedEntityIds(queue: readonly ResolutionQueueItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of queue) {
    ids.add(item.left.id);
    ids.add(item.right.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function entityView(row: EntityRow, part: Participation, unresolved: Set<string>): EntityView {
  const aliasIds = mergedAliasIds(row.id);
  const identities: IdentityView[] = identitiesOf(row.id).map((identity) => ({
    id: identity.id,
    kind: identity.kind,
    value: elideIdentityValue(identity.valueNorm),
    sourceId: identity.sourceId,
    confidence: identity.confidence,
    decidedBy: identity.decidedBy,
  }));
  const relations: RelationView[] = edgesOf(row.id).map((edge) => {
    const outward = aliasIds.includes(edge.srcEntityId);
    const raw = outward ? edge.dstEntityId : edge.srcEntityId;
    const otherId = resolveEntityId(raw) ?? raw;
    return {
      edgeId: edge.id,
      kind: edge.kind,
      subtype: edge.subtype,
      direction: outward ? "out" : "in",
      otherId,
      otherLabel: entityLabel(otherId),
      confidence: edge.confidence,
      decidedBy: edge.decidedBy,
      status: edge.status,
      evidence: edgeEvidence(edge.id).map((e) => ({ eventId: e.eventId, quote: e.quote })),
    };
  });
  return {
    id: row.id,
    type: row.type,
    subtype: row.subtype,
    label: labelOf(row),
    provisional: row.provisional,
    pinned: row.userPinned,
    firstSeenAt: row.firstSeenAt,
    identities,
    relations,
    counts: {
      sessions: countOver(part.sessions, aliasIds),
      episodes: countOver(part.episodes, aliasIds),
      arcs: countOver(part.arcs, aliasIds),
    },
    needsResolution: aliasIds.some((id) => unresolved.has(id)),
  };
}

/** Search is over the name, the id and the identity values — not the graph. */
function matchesQuery(row: EntityRow, needle: string): boolean {
  if (needle === "") return true;
  if ((row.canonical ?? "").toLowerCase().includes(needle)) return true;
  if (row.id.toLowerCase().includes(needle)) return true;
  return identitiesOf(row.id).some((i) => i.valueNorm.toLowerCase().includes(needle));
}

export function entitiesPage(params: URLSearchParams): EntitiesPage {
  const queue = resolutionQueue();
  const unresolved = unresolvedEntityIds(queue);

  // The chips count the whole corpus, not the filtered page — a filter that
  // rewrote its own counts would tell the user their data disappeared.
  const counts: Partial<Record<EntityType, number>> = {};
  for (const type of ENTITY_TYPES) counts[type] = countEntities({ type });

  const typeParam = params.get("type");
  const type = isEntityType(typeParam) ? typeParam : undefined;
  const needle = (params.get("q") ?? "").trim().toLowerCase();
  const unresolvedOnly = params.get("unresolved") === "1";

  const part = participation();
  const entities: EntityView[] = [];
  for (const row of listEntities(type ? { type } : {})) {
    if (!matchesQuery(row, needle)) continue;
    const view = entityView(row, part, unresolved);
    if (unresolvedOnly && !view.needsResolution) continue;
    entities.push(view);
    if (entities.length >= ENTITY_PAGE_LIMIT) break;
  }

  return { counts, unresolvedCount: queue.length, entities };
}

// ---------------------------------------------------------------------------
// The one write a store function cannot make
// ---------------------------------------------------------------------------

/**
 * A relation the human added by hand. `writeEdge` cannot serve this gesture:
 * for any decider but `code:metadata` it demands a verbatim quote AND the event
 * the quote came from (edges.ts rule 2), and a surface gesture has neither —
 * the evidence IS the person, recorded as `decided_by = 'user'` here and as a
 * `mutations(actor:user)` row by the caller. So this is the one place in the
 * module that writes a row a store function would otherwise own; everything
 * about it — the closed kind/subtype sets, `status`, the unique
 * (kind, subtype, src, dst) key, confidence 1 — is what `writeEdge` would have
 * written for an exact, model-free bind.
 */
function writeUserEdge(
  kind: EdgeKind,
  subtype: string | null,
  srcEntityId: string,
  dstEntityId: string,
): string {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM entity_edges
        WHERE kind = ? AND COALESCE(subtype,'') = ? AND src_entity_id = ? AND dst_entity_id = ?`,
    )
    .get(kind, subtype ?? "", srcEntityId, dstEntityId) as { id: string } | undefined;
  if (existing) {
    // A human re-asserting an edge re-opens it — including one they rejected
    // earlier, which is the only way back from `rejected` on this surface.
    db.prepare(
      `UPDATE entity_edges SET status = 'active', valid_to = NULL, confidence = 1, decided_by = ? WHERE id = ?`,
    ).run(USER_ACTOR, existing.id);
    return existing.id;
  }
  const id = mintEdgeId();
  db.prepare(
    `INSERT INTO entity_edges (id, kind, subtype, src_entity_id, dst_entity_id, confidence,
                               decided_by, status, valid_from, valid_to)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'active', NULL, NULL)`,
  ).run(id, kind, subtype, srcEntityId, dstEntityId, USER_ACTOR);
  return id;
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** Handle an entities request. Returns true when this module owns the path. */
export async function handleEntitiesRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const owned =
    path === "/api/entities" ||
    path.startsWith("/api/entities/") ||
    path === "/api/resolution-queue" ||
    path.startsWith("/api/resolution-queue/");
  if (!owned) return false;

  // ---- GET /api/entities → the whole page in one read ----------------------
  if (method === "GET" && path === "/api/entities") {
    sendJson(res, 200, entitiesPage(url.searchParams));
    return true;
  }

  // ---- POST /api/entities/edges/:id/reject --------------------------------
  // Ahead of the per-entity gestures below only for readability: their patterns
  // are anchored two segments deep, so `edges/:id/reject` cannot match them.
  const reject = path.match(/^\/api\/entities\/edges\/([^/]+)\/reject$/);
  if (method === "POST" && reject) {
    const edgeId = decodeURIComponent(reject[1]!);
    const before = readEdge(edgeId);
    if (!before) {
      sendJson(res, 404, { error: "no such edge" });
      return true;
    }
    // Never a delete: a rejected edge keeps its evidence, because the quote is
    // still a true thing somebody said (edges.ts rule 3).
    rejectEdge(edgeId);
    sendJson(
      res,
      200,
      receipt({
        targetKind: "entity_edge",
        targetId: edgeId,
        field: "status",
        oldValue: before.status,
        newValue: "rejected",
        reason: "entities surface: reject edge",
      }),
    );
    return true;
  }

  // ---- POST /api/entities/:id/merge { into } ------------------------------
  const merge = path.match(/^\/api\/entities\/([^/]+)\/merge$/);
  if (method === "POST" && merge) {
    const loser = decodeURIComponent(merge[1]!);
    const body = await readJsonBody(req);
    const into = typeof body?.into === "string" ? body.into.trim() : "";
    if (into === "") {
      sendJson(res, 400, { error: "into (surviving entity id) required" });
      return true;
    }
    if (!getEntity(loser) || !getEntity(into)) {
      sendJson(res, 404, { error: "no such entity" });
      return true;
    }
    const result = mergeEntities({
      loser,
      winner: into,
      actor: USER_ACTOR,
      reason: "entities surface: merge",
    });
    if (!result.merged) {
      // A stored `different` is permanent — reversing it is a deliberate act
      // with its own row, never a side effect of a merge gesture.
      sendJson(res, 409, { error: `merge refused: ${result.refused ?? "unknown"}` });
      return true;
    }
    sendJson(
      res,
      200,
      receipt({
        targetKind: "entity_pair",
        targetId: `${result.winner}|${result.loser}`,
        field: "resolution",
        newValue: { verdict: "same", winner: result.winner, loser: result.loser },
        reason: "entities surface: merge",
      }),
    );
    return true;
  }

  // ---- POST /api/entities/:id/split { identityIds } ------------------------
  const split = path.match(/^\/api\/entities\/([^/]+)\/split$/);
  if (method === "POST" && split) {
    const entityId = decodeURIComponent(split[1]!);
    const body = await readJsonBody(req);
    const asked = Array.isArray(body?.identityIds) ? body.identityIds.map((v) => String(v)) : null;
    if (!asked || asked.length === 0) {
      sendJson(res, 400, { error: "identityIds (non-empty array) required" });
      return true;
    }
    const row = getEntity(entityId);
    if (!row) {
      sendJson(res, 404, { error: "no such entity" });
      return true;
    }
    const picked = new Set(asked);
    const rows = identitiesOf(row.id).filter((i) => picked.has(i.id));
    if (rows.length !== picked.size) {
      sendJson(res, 400, { error: "identityIds must name identities of this entity" });
      return true;
    }

    // Identities still filed against a tombstone are there because of a merge,
    // and undoing that merge is `splitEntity`'s job — it restores the losing
    // side WITH the `different` verdict, which a hand-rolled repoint would lose.
    const restored: string[] = [];
    for (const tombstone of new Set(rows.map((i) => i.entityId).filter((id) => id !== row.id))) {
      const outcome = splitEntity({
        entityId: tombstone,
        actor: USER_ACTOR,
        reason: "entities surface: split",
      });
      if (outcome.split) restored.push(outcome.restored);
    }

    // Whatever is left sits on the survivor itself: one entity that is two
    // people. There is no store function that moves a SINGLE identity row —
    // `repointIdentities` moves an entity's whole set — so the move is written
    // here, with the per-row mutation `compactMerges` files for the same move
    // and the permanent `different` that keeps the ladder from re-merging them.
    const strays = rows.filter((i) => i.entityId === row.id);
    let mintedId: string | null = null;
    if (strays.length > 0) {
      const minted = createEntity({ type: row.type, subtype: row.subtype, provisional: false });
      mintedId = minted.id;
      const move = getDb().prepare(`UPDATE entity_identities SET entity_id = ? WHERE id = ?`);
      for (const stray of strays) {
        move.run(minted.id, stray.id);
        logMutation({
          actor: USER_ACTOR,
          targetKind: "entity_identity",
          targetId: stray.id,
          field: "entity_id",
          oldValue: { entityId: row.id, sourceId: stray.sourceId },
          newValue: { entityId: minted.id },
          reason: "entities surface: split",
        });
      }
      recordDecision({
        left: row.id,
        right: minted.id,
        verdict: "different",
        decidedBy: USER_ACTOR,
        reason: "entities surface: split",
      });
    }

    sendJson(
      res,
      200,
      receipt({
        targetKind: "entity",
        targetId: row.id,
        field: "identities",
        oldValue: { identityIds: [...picked] },
        newValue: { restored, movedTo: mintedId },
        reason: "entities surface: split",
      }),
    );
    return true;
  }

  // ---- POST /api/entities/:id/rename { canonical } -------------------------
  const rename = path.match(/^\/api\/entities\/([^/]+)\/rename$/);
  if (method === "POST" && rename) {
    const entityId = decodeURIComponent(rename[1]!);
    const body = await readJsonBody(req);
    const canonical = typeof body?.canonical === "string" ? body.canonical.trim() : "";
    if (canonical === "") {
      sendJson(res, 400, { error: "canonical (non-empty string) required" });
      return true;
    }
    const row = getEntity(entityId);
    if (!row) {
      sendJson(res, 404, { error: "no such entity" });
      return true;
    }
    renameEntity(row.id, canonical);
    sendJson(
      res,
      200,
      receipt({
        targetKind: "entity",
        targetId: row.id,
        field: "canonical",
        oldValue: row.canonical,
        newValue: canonical,
        reason: "entities surface: rename",
      }),
    );
    return true;
  }

  // ---- POST /api/entities/:id/pin { pinned } -------------------------------
  const pin = path.match(/^\/api\/entities\/([^/]+)\/pin$/);
  if (method === "POST" && pin) {
    const entityId = decodeURIComponent(pin[1]!);
    const body = await readJsonBody(req);
    if (typeof body?.pinned !== "boolean") {
      sendJson(res, 400, { error: "pinned (boolean) required" });
      return true;
    }
    const row = getEntity(entityId);
    if (!row) {
      sendJson(res, 404, { error: "no such entity" });
      return true;
    }
    pinEntity(row.id, body.pinned);
    sendJson(
      res,
      200,
      receipt({
        targetKind: "entity",
        targetId: row.id,
        field: "user_pinned",
        oldValue: row.userPinned,
        newValue: body.pinned,
        reason: "entities surface: pin",
      }),
    );
    return true;
  }

  // ---- POST /api/entities/:id/relations { kind, subtype, dstEntityId } -----
  const relation = path.match(/^\/api\/entities\/([^/]+)\/relations$/);
  if (method === "POST" && relation) {
    const entityId = decodeURIComponent(relation[1]!);
    const body = await readJsonBody(req);
    const kind = body?.kind;
    if (!isEdgeKind(kind)) {
      sendJson(res, 400, { error: "kind must be one of the 7 edge kinds" });
      return true;
    }
    const subtype = typeof body?.subtype === "string" && body.subtype !== "" ? body.subtype : null;
    if (!isEdgeSubtype(kind, subtype)) {
      sendJson(res, 400, { error: `${JSON.stringify(subtype)} is not a subtype of ${kind}` });
      return true;
    }
    const dst = typeof body?.dstEntityId === "string" ? body.dstEntityId.trim() : "";
    const src = getEntity(entityId);
    const other = dst === "" ? null : getEntity(dst);
    if (!src || !other) {
      sendJson(res, 404, { error: "no such entity" });
      return true;
    }
    if (src.id === other.id) {
      sendJson(res, 400, { error: `${kind} from an entity to itself` });
      return true;
    }
    const edgeId = writeUserEdge(kind, subtype, src.id, other.id);
    sendJson(
      res,
      200,
      receipt({
        targetKind: "entity_edge",
        targetId: edgeId,
        field: "status",
        newValue: { kind, subtype, srcEntityId: src.id, dstEntityId: other.id, status: "active" },
        reason: "entities surface: add relation",
      }),
    );
    return true;
  }

  // ---- GET /api/resolution-queue → a bare array, oldest first --------------
  if (method === "GET" && path === "/api/resolution-queue") {
    sendJson(res, 200, resolutionQueue());
    return true;
  }

  // ---- POST /api/resolution-queue/:id { verdict } --------------------------
  const answer = path.match(/^\/api\/resolution-queue\/([^/]+)$/);
  if (method === "POST" && answer) {
    const questionId = decodeURIComponent(answer[1]!);
    const body = await readJsonBody(req);
    const verdict = body?.verdict;
    if (verdict !== "same" && verdict !== "different" && verdict !== "later") {
      sendJson(res, 400, { error: "verdict must be same|different|later" });
      return true;
    }
    const item = resolutionQueue().find((q) => q.id === questionId);
    if (!item) {
      sendJson(res, 404, { error: "no open resolution question with that id" });
      return true;
    }
    const left = item.left.id;
    const right = item.right.id;
    const pairId = `${left}|${right}`;

    // `later` is a scheduling choice, not an answer: the question stays open
    // and the graph is untouched. The deferral itself is still recorded, so a
    // gesture that changed nothing is visible as one.
    if (verdict === "later") {
      answerQuestion(questionId, "later");
      sendJson(
        res,
        200,
        receipt({
          targetKind: "question",
          targetId: questionId,
          field: "verdict",
          newValue: "later",
          reason: "resolution queue: deferred",
        }),
      );
      return true;
    }

    if (verdict === "same") {
      const result = mergeEntities({
        loser: right,
        winner: left,
        actor: USER_ACTOR,
        reason: "resolution queue: same",
      });
      if (!result.merged) {
        // The graph refused after the queue offered the pair. It stays a
        // question rather than becoming a silent no-op.
        sendJson(res, 409, { error: `merge refused: ${result.refused ?? "unknown"}` });
        return true;
      }
    } else {
      // A `different` from the user is permanent and outranks every later
      // automation score — enforced by `recordDecision`, not by this route.
      recordDecision({
        left,
        right,
        verdict: "different",
        decidedBy: USER_ACTOR,
        reason: "resolution queue: different",
      });
    }
    answerQuestion(questionId, verdict);
    sendJson(
      res,
      200,
      receipt({
        targetKind: PAIR_TARGET_KIND,
        targetId: pairId,
        field: "resolution",
        newValue: { verdict, questionId },
        reason: `resolution queue: ${verdict}`,
      }),
    );
    return true;
  }

  sendJson(res, 404, { error: "unknown entities route" });
  return true;
}
