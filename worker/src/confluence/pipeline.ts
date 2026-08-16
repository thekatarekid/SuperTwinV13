// ===========================================================================
// [CODE] Confluence pipeline run — build item 4.3.
//
// One ingest ORDER in, one fully-populated graph out, over whatever database
// `SUPERTWIN_DB_PATH` points at. Every stage is the REAL module:
//
//   ingest    → db/ingest (upsertSource/Stream/Actor, insertEvent + dedupe)
//   entities  → entities/binding + resolve (the [CODE] identity ladder)
//   sessions  → sessions/segment + seal (bootstrap walk, real content hashes)
//   episodes  → episodes/engine via scheduler/episode-pass's engineSessionOf
//   claims    → claims/write (real keys, real stated_at supersession)
//   loops     → claims/keys loopKey + loops/state deriveLoopState
//   edges     → entities/edges writeEdge
//   arcs      → arcs/provisional commitArc + arcs/promote-store promoteArcs
//
// Nothing here re-implements a rule, and nothing reads `ingested_at`. The
// [LLM] answers are the corpus's FROZEN extractions, keyed by event content —
// so the only thing that varies between two runs is the ORDER work arrives,
// which is exactly the variable §11.6 rule 6 demands be irrelevant.
//
// The processing order is derived FROM the ingest order: entities bind when
// their first event arrives, and sessions are worked in the order they became
// available under that ingest. A harness that quietly sorted everything by ts
// before processing would be testing its own sort, not the pipeline.
// ===========================================================================

import { commitArc, attachEpisode } from "../arcs/provisional.js";
import { promoteArcs } from "../arcs/promote-store.js";
import { arcKey, type AnchorRef } from "../arcs/key.js";
import { loopIdForKey, loopKey } from "../claims/keys.js";
import { activeClaims, writeClaim, type WriteOptions } from "../claims/write.js";
import { getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { bindSelfIdentity, ensureMeEntity } from "../entities/binding.js";
import { METADATA_DECIDER, writeEdge } from "../entities/edges.js";
import { loopPartyPair } from "../entities/party.js";
import { createEntity, type EntityType } from "../entities/registry.js";
import { resolveIdentity } from "../entities/resolve.js";
import { runEpisodePass } from "../episodes/engine.js";
import { deriveLoopState } from "../loops/state.js";
import { engineSessionOf } from "../scheduler/episode-pass.js";
import { KIND_DEFAULTS } from "../sessions/policies.js";
import { segment, type SegEvent, type SegSession } from "../sessions/segment.js";
import { sealStream, textIndex } from "../sessions/seal.js";
import {
  ACTORS,
  CONFLUENCE_NOW,
  FROZEN_CLAIMS,
  FROZEN_EDGES,
  FROZEN_LOOPS,
  SOURCE_ID,
  SOURCE_TYPE,
  STREAMS,
  frozenAg3Response,
  frozenSimilarity,
  type CorpusEvent,
} from "./corpus.js";

const RUN_ID = "run_confluence";
const NOW_ISO = new Date(CONFLUENCE_NOW).toISOString();

export interface PipelineReport {
  eventsInserted: number;
  eventsDeduped: number;
  sessionsSealed: number;
  episodePasses: number;
  claimWrites: number;
  loopWrites: number;
  edgeWrites: number;
  arcsCommitted: number;
  promoted: number;
}

/** actor extId → resolved entity id, for THIS run. Ids are minted, so the map
 *  is per-run; cross-run comparison happens on identity content (snapshot.ts). */
export type EntityMap = ReadonlyMap<string, string>;

/** The per-run id maps the stages hand each other. */
interface RunContext {
  entities: EntityMap;
  /** corpus stream extId → streams.id (deterministic, from upsertStream). */
  streamDbIds: ReadonlyMap<string, string>;
  /** corpus actor extId → actors.id (deterministic, from upsertActor). */
  actorDbIds: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Stage 1+2 — ingest events in the given order, binding identities lazily
// ---------------------------------------------------------------------------

function ingest(order: readonly CorpusEvent[], report: PipelineReport): RunContext {
  upsertSource({ id: SOURCE_ID, type: SOURCE_TYPE, name: "WhatsApp (confluence)" });
  const streamDbIds = new Map<string, string>();
  for (const s of STREAMS) {
    streamDbIds.set(s.extId, upsertStream({ sourceId: SOURCE_ID, sourceExtId: s.extId, name: s.name, kind: "dm" }));
  }

  const actorsByExt = new Map(ACTORS.map((a) => [a.extId, a]));
  const actorDbIds = new Map<string, string>();
  const entities = new Map<string, string>();
  ensureMeEntity();

  // Identities bind when the actor's FIRST event arrives in THIS order —
  // minting order (and therefore every minted id) differs across the three
  // runs, which is precisely what the content-keyed comparison must absorb.
  const bindActor = (extId: string, ts: string): void => {
    if (entities.has(extId)) return;
    const actor = actorsByExt.get(extId);
    if (actor === undefined) throw new Error(`confluence corpus: unknown actor ${extId}`);
    actorDbIds.set(extId, upsertActor({ sourceId: SOURCE_ID, sourceExtId: actor.jid, displayName: actor.name, isSelf: actor.isSelf === true }));
    if (actor.isSelf === true) {
      entities.set(extId, bindSelfIdentity({ sourceId: SOURCE_ID, kind: "jid", value: actor.jid }));
      return;
    }
    const resolved = resolveIdentity({
      sourceId: SOURCE_ID,
      kind: "jid",
      value: actor.jid,
      displayName: actor.name,
      seenAt: ts,
    });
    entities.set(extId, resolved.bind.entityId);
  };

  for (const ev of order) {
    bindActor(ev.actorExtId, ev.ts);
    const result = insertEvent({
      externalId: ev.externalId,
      sourceId: SOURCE_ID,
      sourceType: SOURCE_TYPE,
      streamId: streamDbIds.get(ev.streamExtId) ?? null,
      actorId: actorDbIds.get(ev.actorExtId) ?? null,
      ts: ev.ts,
      kind: "message",
      text: ev.text,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    });
    if (result.inserted) report.eventsInserted += 1;
    else report.eventsDeduped += 1;
  }
  return { entities, streamDbIds, actorDbIds };
}

// ---------------------------------------------------------------------------
// Stage 3 — sessions: the real bootstrap walk, per stream
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  external_id: string;
  ts: string;
  actor_id: string | null;
  text: string | null;
}

function streamEvents(streamDbId: string): EventRow[] {
  // ts (never ingested_at) is the read order — §3.3 rule 8.
  return getDb()
    .prepare(`SELECT id, external_id, ts, actor_id, text FROM events WHERE stream_id = ? ORDER BY ts, id`)
    .all(streamDbId) as EventRow[];
}

function segmentAndSeal(ctx: RunContext): Map<string, SegSession> {
  const db = getDb();
  const policy = KIND_DEFAULTS.conversation;
  const sealed = new Map<string, SegSession>();
  const eventDbIdByExt = new Map<string, string>();

  const insert = db.prepare(
    `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, tz, event_ids,
                           participant_entity_ids, boundary_reason_start, boundary_reason_end,
                           boundary_params_json, seal_mode, content_hash, superseded_hash,
                           hash_version, status, sealed_at, late_arrival)
     VALUES (@id, @streamId, @sourceId, @startedAt, @endedAt, @tz, @eventIds, @participants,
             @boundaryStart, @boundaryEnd, @boundaryParams, @sealMode, @contentHash,
             @supersededHash, @hashVersion, 'sealed', @sealedAt, 0)`,
  );

  for (const s of STREAMS) {
    const streamDbId = ctx.streamDbIds.get(s.extId);
    if (streamDbId === undefined) throw new Error(`confluence: stream ${s.extId} was not ingested`);
    const rows = streamEvents(streamDbId);
    for (const r of rows) eventDbIdByExt.set(r.external_id, r.id);
    const segEvents: SegEvent[] = rows.map((r) => ({
      external_id: r.external_id,
      ts: r.ts,
      actor: r.actor_id ?? "unknown",
      kind: "message",
      text: r.text ?? "",
    }));
    const walked = segment({
      stream: { key: streamDbId, tz: "Asia/Kolkata", source_id: SOURCE_ID },
      policy,
      events: segEvents,
      run_mode: "bootstrap",
    });
    const done = sealStream(walked.sessions, { policy, run_mode: "bootstrap", now: CONFLUENCE_NOW }, textIndex(segEvents));

    const actorEntity = new Map<string, string>();
    for (const a of ACTORS) {
      const actorDbId = ctx.actorDbIds.get(a.extId);
      const entityId = ctx.entities.get(a.extId);
      if (actorDbId !== undefined && entityId !== undefined) actorEntity.set(actorDbId, entityId);
    }

    for (const session of done.sessions) {
      if (session.status !== "sealed") continue;
      const memberDbIds = session.event_ids.map((ext) => eventDbIdByExt.get(ext)).filter((v): v is string => v !== undefined);
      const participants = [...new Set(session.actors.map((a) => actorEntity.get(a) ?? a))].sort();
      insert.run({
        id: session.id,
        streamId: streamDbId,
        sourceId: SOURCE_ID,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        tz: session.tz,
        eventIds: JSON.stringify(memberDbIds),
        participants: JSON.stringify(participants),
        boundaryStart: session.boundary_reason_start,
        boundaryEnd: session.boundary_reason_end,
        boundaryParams: JSON.stringify(session.boundary_params),
        sealMode: session.seal_mode,
        contentHash: session.content_hash,
        supersededHash: session.superseded_hash,
        hashVersion: session.hash_version,
        sealedAt: session.sealed_at ?? NOW_ISO,
      });
      sealed.set(session.id, session);
    }
  }
  return sealed;
}

// ---------------------------------------------------------------------------
// Stage 4-7 — the understanding passes, in ingest-derived order
// ---------------------------------------------------------------------------

/**
 * Sessions are worked in the order they were COMPLETED by the ingest: the
 * position of a session is the largest ingest-order index among its members.
 * Under `reverse` this processes newest history first; under `delayed-stream`
 * the delayed chat's sessions all come last. That is the real-world shape.
 */
function processingOrder(sealed: ReadonlyMap<string, SegSession>, order: readonly CorpusEvent[]): SegSession[] {
  const position = new Map(order.map((e, i) => [e.externalId, i]));
  const rank = (s: SegSession): number => Math.max(...s.event_ids.map((ext) => position.get(ext) ?? -1));
  return [...sealed.values()].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
}

function applyFrozenExtractions(session: SegSession, entities: EntityMap, report: PipelineReport): void {
  const db = getDb();
  const members = new Set(session.event_ids);
  const me = entities.get("self");
  if (me === undefined) throw new Error("confluence: self entity missing");
  const eventDbId = (ext: string): string => `${SOURCE_ID}:${ext}`;

  for (const c of FROZEN_CLAIMS) {
    if (!members.has(c.event)) continue;
    const ts = (db.prepare(`SELECT ts FROM events WHERE id = ?`).get(eventDbId(c.event)) as { ts: string }).ts;
    const subjectId = entities.get(c.subject) ?? null;
    // The [ML] near-hit rung, frozen per content: every already-active claim
    // of the same kind and subject is scored from the pair table. A pair the
    // table never measured offers no candidate — same as a cold embedder.
    const candidates = activeClaims()
      .filter((row) => row.kind === c.kind && row.subjectId === subjectId && row.text !== null)
      .map((row) => ({ claimId: row.id, similarity: frozenSimilarity(row.text as string, c.text) }))
      .filter((cand): cand is { claimId: string; similarity: number } => cand.similarity !== null);
    const adjudicator: WriteOptions["adjudicator"] = ({ input }) => {
      const response = frozenAg3Response(input.stored.text, input.incoming.text);
      return response === null ? null : { response };
    };
    writeClaim(
      {
        kind: c.kind,
        tag: c.tag,
        subjectId,
        predicate: c.predicate,
        text: c.text,
        confidence: c.confidence,
        statedAt: ts,
        evidence: [{ eventId: eventDbId(c.event), quote: c.text }],
      },
      { now: NOW_ISO, runId: RUN_ID, candidates, adjudicator },
    );
    report.claimWrites += 1;
  }

  for (const l of FROZEN_LOOPS) {
    if (!members.has(l.event)) continue;
    const ownerId = entities.get(l.owner) ?? null;
    const counterpartyId = entities.get(l.counterparty) ?? null;
    const key = loopKey({ ownerId, counterpartyId, intent: l.intent });
    const id = loopIdForKey(key);
    const stated = (db.prepare(`SELECT ts FROM events WHERE id = ?`).get(eventDbId(l.event)) as { ts: string }).ts;
    // §11.4.5 — resolution against evidence ALREADY in the DB. Under an order
    // where the resolving event has not been ingested yet, the loop stays open
    // NOW and resolves when that event lands; by end of run all orders agree.
    const evidenceId = l.resolutionEvent === undefined ? null : eventDbId(l.resolutionEvent);
    const evidencePresent =
      evidenceId !== null && db.prepare(`SELECT 1 AS ok FROM events WHERE id = ?`).get(evidenceId) !== undefined;
    const facts = deriveLoopState(
      {
        origin: l.origin,
        intent: l.intent,
        statedAt: stated,
        dueUtc: l.dueUtc ?? null,
        recurrence: l.recurrence ?? null,
        resolutionEvidenceEventId: evidencePresent ? evidenceId : null,
      },
      CONFLUENCE_NOW,
    );
    const pair = loopPartyPair({ ownerId, counterpartyId }, { selfEntityId: me, participantEntityIds: [ownerId, counterpartyId] });
    db.prepare(
      `INSERT OR REPLACE INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id,
                                     party_pair, direction, due_utc, recurrence, next_occurrence_utc,
                                     state, state_reason, resolution_evidence_event_id, stated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      key,
      l.intent,
      l.origin,
      ownerId,
      counterpartyId,
      pair,
      l.direction,
      l.dueUtc ?? null,
      l.recurrence ?? null,
      facts.nextOccurrenceUtc,
      facts.state,
      facts.stateReason,
      evidencePresent ? evidenceId : null,
      stated,
      NOW_ISO,
    );
    report.loopWrites += 1;
  }

  for (const e of FROZEN_EDGES) {
    if (!members.has(e.event)) continue;
    const existing = db
      .prepare(`SELECT id FROM entities WHERE canonical = ? AND type = ? AND merged_into IS NULL`)
      .get(e.dst.canonical, e.dst.type) as { id: string } | undefined;
    const dst = existing?.id ?? createEntity({ type: e.dst.type as EntityType, canonical: e.dst.canonical, provisional: false }).id;
    writeEdge({
      kind: e.kind,
      subtype: e.subtype,
      srcEntityId: me,
      dstEntityId: dst,
      decidedBy: METADATA_DECIDER,
      quote: e.quote,
      eventId: eventDbId(e.event),
      validFrom: null,
    });
    report.edgeWrites += 1;
  }
}

/**
 * Loops whose resolution evidence arrived AFTER the loop was written: the
 * §11.4.5 sweep code runs at reconcile. Re-derives from stored inputs only.
 */
function resolveLateEvidence(): void {
  const db = getDb();
  for (const l of FROZEN_LOOPS) {
    if (l.resolutionEvent === undefined) continue;
    const evidenceId = `${SOURCE_ID}:${l.resolutionEvent}`;
    if (db.prepare(`SELECT 1 AS ok FROM events WHERE id = ?`).get(evidenceId) === undefined) continue;
    const row = db
      .prepare(`SELECT id, origin, intent, due_utc, recurrence, stated_at FROM loops WHERE intent = ?`)
      .get(l.intent) as { id: string; origin: string; intent: string; due_utc: string | null; recurrence: string | null; stated_at: string } | undefined;
    if (row === undefined) continue;
    const facts = deriveLoopState(
      {
        origin: row.origin,
        intent: row.intent,
        statedAt: row.stated_at,
        dueUtc: row.due_utc,
        recurrence: row.recurrence,
        resolutionEvidenceEventId: evidenceId,
      },
      CONFLUENCE_NOW,
    );
    db.prepare(
      `UPDATE loops SET state = ?, state_reason = ?, next_occurrence_utc = ?, resolution_evidence_event_id = ?, updated_at = ? WHERE id = ?`,
    ).run(facts.state, facts.stateReason, facts.nextOccurrenceUtc, evidenceId, NOW_ISO, row.id);
  }
}

// ---------------------------------------------------------------------------
// Stage 8 — arcs and promotion
// ---------------------------------------------------------------------------

function commitArcs(ctx: RunContext, report: PipelineReport): void {
  const db = getDb();
  const entities = ctx.entities;
  const me = entities.get("self");
  for (const s of STREAMS) {
    const streamDbId = ctx.streamDbIds.get(s.extId);
    if (streamDbId === undefined) throw new Error(`confluence: stream ${s.extId} was not ingested`);
    const episodes = db
      .prepare(`SELECT id, started_at, ended_at FROM episodes WHERE stream_id = ? ORDER BY started_at, id`)
      .all(streamDbId) as { id: string; started_at: string | null; ended_at: string | null }[];
    if (episodes.length === 0) continue;
    const counterpartExt = s.extId.replace("dm_", "");
    const anchors: AnchorRef[] = [
      { entityId: me ?? "", type: "person" },
      { entityId: entities.get(counterpartExt) ?? "", type: "person" },
    ];
    const key = arcKey(anchors, s.name);
    const arc = commitArc({
      arcKey: key,
      label: s.name,
      labelSource: "derived",
      anchorEntityIds: anchors.map((a) => a.entityId),
      sourceIds: [SOURCE_ID],
      startedAt: episodes[0]?.started_at ?? null,
      lastEvidenceAt: episodes.at(-1)?.ended_at ?? episodes.at(-1)?.started_at ?? null,
      now: CONFLUENCE_NOW,
    });
    for (const ep of episodes) attachEpisode({ arcId: arc.id, episodeId: ep.id, addedBy: "reconcile" });
    db.prepare(`UPDATE loops SET arc_id = ? WHERE counterparty_id = ?`).run(arc.id, entities.get(counterpartExt) ?? "");
    report.arcsCommitted += 1;
  }
  const sweep = promoteArcs({ now: CONFLUENCE_NOW });
  report.promoted = sweep.promoted;
}

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

export function runConfluencePipeline(order: readonly CorpusEvent[]): PipelineReport {
  const report: PipelineReport = {
    eventsInserted: 0,
    eventsDeduped: 0,
    sessionsSealed: 0,
    episodePasses: 0,
    claimWrites: 0,
    loopWrites: 0,
    edgeWrites: 0,
    arcsCommitted: 0,
    promoted: 0,
  };
  runMigrations();
  const ctx = ingest(order, report);
  const sealed = segmentAndSeal(ctx);
  report.sessionsSealed = sealed.size;

  for (const session of processingOrder(sealed, order)) {
    const engineSession = engineSessionOf(session.id);
    if (engineSession === null) throw new Error(`confluence: session ${session.id} did not read back`);
    runEpisodePass(engineSession, { now: CONFLUENCE_NOW, runId: RUN_ID });
    report.episodePasses += 1;
    applyFrozenExtractions(session, ctx.entities, report);
  }

  resolveLateEvidence();
  commitArcs(ctx, report);
  return report;
}
