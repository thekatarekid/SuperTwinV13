// ===========================================================================
// [CODE] The stream-roster stage — `bindGroupParticipants`' production caller.
// Arch §10.3 ("METADATA EDGES ARE FREE"), §11.1's stream roster, item 1.5.
//
// ⚠ THE DEFECT THIS FILE EXISTS FOR — the same species as `entity-pass.ts`'s.
// `entities/binding.ts` has exported `bindGroupParticipants` since item 1.5 and
// NOTHING IN PRODUCTION HAS EVER CALLED IT: its only references were three test
// files and the eval script executor. So on a live install with 93 streams (5
// of them groups) and 100 bound entities, `entity_edges` was 0 and
// `streams.participant_entity_ids` was NULL on every row. A group participant
// list is a relationship fact the source already told us, written at confidence
// 1.0 with zero model calls — and it was being thrown away.
//
// TWO WRITES, ONE PASS, BOTH FREE:
//
//   * `streams.participant_entity_ids` — the roster every downstream packer
//     reads. `cl1-pack.ts` builds P-CL1's `#C` participant line off it,
//     `p-ep2-judge.ts` reads it for the judge, `people-routes.ts` counts shared
//     lanes with it. All three got an empty list, which is how a five-person
//     group reached a prompt as a room with nobody in it.
//   * `affiliated_with:member` edges, group lane → its members, via
//     `bindGroupParticipants`. `arcs/promote-store.ts`'s `readSelfEdges` reads
//     exactly these off `me`, so promotion had no reference edges to promote on.
//
// THE ROSTER IS OBSERVED, NOT DECLARED. No adapter in this build hands the core
// a group's member list — `StreamRef` carries `participant_count`, a number,
// and nothing else. So the roster is the set of actors who have actually SPOKEN
// in the lane and have already been bound to an entity. That is exact (the
// source told us who sent each message) and it is a SUBSET of true membership:
// a silent member is missing until they speak. UNKNOWN BEATS WRONG — an
// under-full roster costs a mention that stays a hint, an invented one costs a
// claim attributed to somebody who was never there.
//
// ORDER: AFTER actor binding, BEFORE session sealing. After, because the roster
// is read off `events.actor_entity_id` and an unbound actor contributes
// nothing. Before, because a sealed session's membership is IMMUTABLE (§10.4)
// and every consumer above reads the roster off the stream while packing work
// the sealed sessions produced. `entityPass` is stage B2 and sealing is stage
// C, so calling this at the tail of `entityPass` satisfies both without a
// fourth stage.
//
// WAITING IS A PROPERTY OF THE ROWS. `pendingStreamRosters` asks for streams
// holding a bound actor their stored roster does not contain — the same idiom
// as `pendingEntityWork`'s `actor_entity_id IS NULL`. It needs no queue, no
// watermark and no memory of having run: it repairs an install whose events
// were bound before this file existed, it converges to zero, and a kill -9
// mid-sweep costs one stream.
//
// ZERO MODEL CALLS, STRUCTURALLY. Synchronous, no transport imported, and the
// only ladder it can reach is `bindIdentity`'s rungs ① and ② — which is why
// `kindOf` is INJECTED rather than imported: `entity-pass.ts` owns
// `identityKindOf`, and taking it as a parameter keeps the dependency pointing
// one way instead of closing a cycle between the two halves of one stage.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { bindGroupParticipants } from "../entities/binding.js";
import type { IdentityKind } from "../entities/identities.js";
import { resolveEntityId } from "../entities/registry.js";

/** How many streams one sweep repairs. Bounded like every other stage's chunk. */
export const STREAM_ROSTER_LIMIT = 256;

/**
 * The lane kinds whose roster is a MEMBERSHIP. A dm has two people in it and
 * neither is a member of anything; a feed, a log and a calendar have no group
 * to be a member of. Only `group` earns `affiliated_with:member` — every kind
 * still gets its `participant_entity_ids`, because every kind gets packed.
 */
const GROUP_KINDS = new Set(["group"]);

function log(line: string): void {
  console.error(`[roster] ${line}`);
}

/** `entity-pass.ts`'s `identityKindOf`, injected. See the header's last note. */
export type IdentityKindReader = (sourceId: string | null, value: string) => IdentityKind;

export interface StreamParticipantsOptions {
  kindOf: IdentityKindReader;
  /** How many streams this sweep may repair. Defaults to {@link STREAM_ROSTER_LIMIT}. */
  limit?: number;
}

export interface StreamParticipantsReport {
  /** Streams whose stored roster was behind the events and got rewritten. */
  streams: number;
  /** Of those, the group lanes that also got metadata edges. */
  groups: number;
  /** Entity ids written across every roster this pass. */
  participants: number;
  /**
   * `affiliated_with:member` edges ASSERTED — not created. `writeEdge` upserts
   * on `(kind, subtype, src, dst)`, so a second pass asserts the same edges and
   * writes no new rows; the count that answers "how many edges exist" is a
   * `COUNT(*)` over `entity_edges`, and this number is not it.
   */
  edgesAsserted: number;
  /**
   * Always 0, and typed as `0` so a future edit that reaches for a model has to
   * change the TYPE to do it. A participant list is a fact the source stated.
   */
  llmCalls: 0;
  errors: string[];
}

export function emptyStreamParticipantsReport(): StreamParticipantsReport {
  return { streams: 0, groups: 0, participants: 0, edgesAsserted: 0, llmCalls: 0, errors: [] };
}

interface StreamRow {
  id: string;
  source_id: string | null;
  external_key: string;
  label: string | null;
  stream_kind: string | null;
}

/**
 * Streams holding a bound actor their stored roster does not contain.
 *
 * `json_each` over `COALESCE(..., '[]')` makes the NULL case fall out of the
 * same predicate rather than needing an `OR participant_entity_ids IS NULL`
 * beside it: a NULL roster contains nothing, so every bound actor is missing
 * from it, so the stream is pending. One rule, not two.
 */
export function pendingStreamRosters(opts: { limit?: number } = {}): string[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? STREAM_ROSTER_LIMIT));
  return (
    getDb()
      .prepare(
        `SELECT s.id AS id
           FROM streams s
          WHERE EXISTS (
                  SELECT 1 FROM events e
                   WHERE e.stream_id = s.id AND e.actor_entity_id IS NOT NULL
                     AND NOT EXISTS (
                           SELECT 1 FROM json_each(COALESCE(s.participant_entity_ids, '[]')) je
                            WHERE je.value = e.actor_entity_id))
          ORDER BY s.id
          LIMIT ?`,
      )
      .all(limit) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * A label worth carrying onto a group entity. Same rule as the ingest path's
 * and `entity-pass.ts`'s: `canonical` is what a human reads, and a jid is not
 * one — a group whose label is still `120363…@g.us` gets no name rather than a
 * name nobody would recognise.
 */
function usableLabel(raw: string | null): string | null {
  const label = String(raw ?? "").trim();
  if (label === "" || label.includes("@")) return null;
  return label;
}

interface ActorRow {
  source_ext_id: string;
  display_name: string | null;
}

/**
 * Rebuild one stream's roster from its bound events, and — for a group lane —
 * assert the membership edges its participant list is.
 *
 * The roster is resolved through `resolveEntityId` before it is written: a
 * merged-away entity is not a second participant, and leaving a tombstone in
 * the JSON would put one person in the room twice under two ids.
 */
function bindOneStream(stream: StreamRow, kindOf: IdentityKindReader, report: StreamParticipantsReport): void {
  const db = getDb();
  const bound = (
    db
      .prepare(
        `SELECT DISTINCT actor_entity_id AS entity_id
           FROM events WHERE stream_id = ? AND actor_entity_id IS NOT NULL`,
      )
      .all(stream.id) as { entity_id: string }[]
  ).map((r) => r.entity_id);

  const roster = [...new Set(bound.map((id) => resolveEntityId(id)).filter((v): v is string => v !== null))].sort();
  if (roster.length === 0) return;

  // The FIRST instant the lane was observed. `writeEdge` files it as
  // `valid_from`, so a membership reads as "since the day they first spoke
  // here" rather than "since the last thing they said" — and `touchEntity`
  // takes the MIN for `first_seen_at` either way.
  const seenAt =
    (
      db
        .prepare(`SELECT MIN(ts) AS ts FROM events WHERE stream_id = ? AND actor_entity_id IS NOT NULL`)
        .get(stream.id) as { ts: string | null } | undefined
    )?.ts ?? null;

  if (GROUP_KINDS.has(String(stream.stream_kind ?? ""))) {
    // The members are re-read as IDENTITIES rather than handed over as the
    // entity ids above, because `bindGroupParticipants` is the [CODE] path that
    // owns this write and re-binding an already-bound actor is rung ① — an
    // indexed hit on `entity_identities`, free, and it mints nothing. Passing
    // ids around it would be a second way to write a membership, and a second
    // way is how the two of them drift.
    const actors = db
      .prepare(
        `SELECT DISTINCT a.source_ext_id AS source_ext_id, a.display_name AS display_name
           FROM events e JOIN actors a ON a.id = e.actor_id
          WHERE e.stream_id = ? AND e.actor_entity_id IS NOT NULL
            AND NULLIF(TRIM(a.source_ext_id), '') IS NOT NULL
          ORDER BY a.source_ext_id`,
      )
      .all(stream.id) as ActorRow[];

    if (actors.length > 0) {
      const result = bindGroupParticipants({
        sourceId: stream.source_id ?? "",
        group: {
          kind: kindOf(stream.source_id, stream.external_key),
          value: stream.external_key,
          displayName: usableLabel(stream.label),
        },
        participants: actors.map((a) => ({
          kind: kindOf(stream.source_id, a.source_ext_id),
          value: a.source_ext_id,
          displayName: usableLabel(a.display_name),
        })),
        seenAt,
      });
      report.groups += 1;
      report.edgesAsserted += result.edges.length;
    }
  }

  db.prepare(`UPDATE streams SET participant_entity_ids = ? WHERE id = ?`).run(JSON.stringify(roster), stream.id);
  report.streams += 1;
  report.participants += roster.length;
}

/**
 * Sweep every stream whose roster is behind its events.
 *
 * SYNCHRONOUS ON PURPOSE, like `drainEntityQueue`: there is no transport to
 * await, so the cost guarantee is the function's signature rather than a
 * comment. Idempotent — a second call finds nothing pending, and even a forced
 * re-run writes the same sorted JSON and upserts onto the same edge rows.
 *
 * A stream that throws is recorded and SKIPPED, never retried in place: the
 * pending query will offer it again on the next pass, and one unreadable lane
 * must not cost the other 92 their rosters.
 */
export function bindStreamParticipants(opts: StreamParticipantsOptions): StreamParticipantsReport {
  const report = emptyStreamParticipantsReport();
  const limit = Math.max(1, Math.floor(opts.limit ?? STREAM_ROSTER_LIMIT));
  const ids = pendingStreamRosters({ limit });
  if (ids.length === 0) return report;

  const read = getDb().prepare(
    `SELECT id, source_id, external_key, label, stream_kind FROM streams WHERE id = ?`,
  );
  for (const id of ids) {
    try {
      const stream = read.get(id) as StreamRow | undefined;
      if (stream === undefined) continue;
      bindOneStream(stream, opts.kindOf, report);
    } catch (err) {
      report.errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(
    `streams=${report.streams} groups=${report.groups} participants=${report.participants} ` +
      `edges=${report.edgesAsserted} llm=${report.llmCalls} errors=${report.errors.length}`,
  );
  return report;
}
