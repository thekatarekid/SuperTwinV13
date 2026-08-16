// ===========================================================================
// [CODE] Building ONE P-CL1 call — arch §12.4, §5.2, §5.9.3. The read half of
// the P-CL1 stage: rows in, prompt out. (`./cl1-runner.ts` owns the transport
// and the budget, `./cl1-apply.ts` owns what the answer becomes, and
// `./cl1-entity.ts` owns the one boundary all three write entity ids through.)
//
// THE ROSTER IS THE WHOLE JOB. Everything the model may cite back — a subject,
// a loop owner, a speaker — is an alias minted HERE, and the parser resolves
// that alias back to whatever id this file handed the packer. So the packer is
// handed VERIFIED ENTITY IDS OR NOTHING:
//
//   * a participant, episode member or event actor is enrolled only after its
//     row is read (`toEntityId`), so a stale or merged-away id cannot become a
//     citable `a<n>`;
//   * a speaker with no bound entity is packed under `unbound:` rather than as
//     its raw `actors.id`, because a bare actor id comes back through the
//     parser looking exactly like a roster entity and lands in a foreign key.
//
// The events themselves are NEVER dropped for want of an identity. The words
// are the evidence, and a transcript with one nameless speaker still reads;
// what changes is that a claim about that speaker cannot be filed under anyone,
// which `./cl1-apply.ts` refuses rather than guesses.
//
// A TRUNCATED ROSTER IS NOT AN OPTION (§5.9.3): over the packer's cap the call
// is refused whole, because a missing roster line is how a model gets blamed
// for attributing a claim to the wrong Amit.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { meEntityId } from "../entities/binding.js";
import { getEntity } from "../entities/registry.js";
import type { EpisodeRow } from "../episodes/store.js";
import { buildCl1Prompt } from "../prompts/p-cl1.js";
import type { PackEntity, PackEvent, PackInput, PackLoop, PackStream } from "../wire/pack.js";
import { toEntityId, unboundToken, type EntityId } from "./cl1-entity.js";

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

interface StreamRow {
  id: string;
  label: string | null;
  stream_kind: string | null;
  tz: string | null;
  participant_entity_ids: string | null;
}

export interface EventRow {
  id: string;
  stream_id: string | null;
  ts: string | null;
  actor_id: string | null;
  actor_entity_id: string | null;
  text: string | null;
  reply_to_external_id: string | null;
}

interface LoopRow {
  id: string;
  intent: string | null;
  owner_id: string | null;
  due_utc: string | null;
  state: string | null;
}

function parseIds(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function marks(n: number): string {
  return new Array(n).fill("?").join(",");
}

/** The me entity, as the wire's reserved `self` token (§5.2). */
function selfToken(entityId: string | null, me: string | null): string | null {
  if (entityId === null) return null;
  return me !== null && entityId === me ? "self" : entityId;
}

export interface Cl1Context {
  prompt: NonNullable<ReturnType<typeof buildCl1Prompt>>;
  episodes: EpisodeRow[];
  /** `events.id` → its row, for stated_at, speaker and the evidence quote. */
  events: Map<string, EventRow>;
  /** The me entity id, or null on an install with nothing bound yet. */
  me: EntityId | null;
  /** Every entity id this batch put in the room — `roleOf`'s participant set. */
  participants: EntityId[];
  /** Which episode an event belongs to, so evidence carries `episode_id`. */
  episodeOfEvent: Map<string, string>;
  /**
   * The speakers this batch could NOT bind: packed token → `actors.id`. Empty
   * once identity binding has run; non-empty is the honest statement that this
   * prompt described people it cannot name, and the reason claims about them
   * are refused rather than filed under the user.
   */
  unboundActors: ReadonlyMap<string, string>;
}

/**
 * Build ONE P-CL1 call over a batch of episodes.
 *
 * The USER half is the ordinary packer's output, so the input is byte-for-byte
 * §12.4's shape: `#R` roster, `#C` stream header, `#T` the open loops supplied
 * as context (and correctly not re-emitted), `#D` date blocks, event lines,
 * `#COV`. Null when the batch has no readable events or the roster is over the
 * packer's cap — a truncated roster is how a model gets blamed for attributing
 * a claim to the wrong Amit (§5.9.3).
 */
export function buildCl1Call(episodes: readonly EpisodeRow[]): Cl1Context | null {
  if (episodes.length === 0) return null;
  const db = getDb();
  const me = toEntityId(meEntityId());

  const streamIds = [...new Set(episodes.map((e) => e.streamId).filter((s): s is string => s !== null))];
  if (streamIds.length === 0) return null;
  const streamRows = db
    .prepare(
      `SELECT id, label, stream_kind, tz, participant_entity_ids
         FROM streams WHERE id IN (${marks(streamIds.length)})`,
    )
    .all(...streamIds) as StreamRow[];
  if (streamRows.length === 0) return null;

  const eventIds = [...new Set(episodes.flatMap((e) => e.eventIds))];
  if (eventIds.length === 0) return null;
  const eventRows = db
    .prepare(
      `SELECT id, stream_id, ts, actor_id, actor_entity_id, text, reply_to_external_id
         FROM events WHERE id IN (${marks(eventIds.length)}) ORDER BY ts, id`,
    )
    .all(...eventIds) as EventRow[];
  if (eventRows.length === 0) return null;
  const events = new Map(eventRows.map((r) => [r.id, r]));

  const episodeOfEvent = new Map<string, string>();
  for (const ep of episodes) for (const id of ep.eventIds) if (!episodeOfEvent.has(id)) episodeOfEvent.set(id, ep.id);

  // The roster: every entity this batch can legitimately cite, VERIFIED against
  // `entities` on the way in. An id that is not a row is not a roster member —
  // the packer would otherwise mint an `a<n>` for it and the parser would hand
  // that alias back as an entity id, straight into a foreign key. `self` is
  // reserved and never printed in `#R`, so it is filtered by the packer.
  const bound = new Map<string, EntityId | null>();
  const boundId = (id: string | null): EntityId | null => {
    if (id === null) return null;
    if (!bound.has(id)) bound.set(id, toEntityId(id));
    return bound.get(id) ?? null;
  };

  const roster = new Set<EntityId>();
  const enrol = (id: string | null): void => {
    const entityId = boundId(id);
    if (entityId !== null) roster.add(entityId);
  };
  for (const row of streamRows) for (const id of parseIds(row.participant_entity_ids)) enrol(id);
  for (const ep of episodes) for (const id of ep.entityIds) enrol(id);
  for (const row of eventRows) enrol(row.actor_entity_id);

  const entities: PackEntity[] = [];
  const participants: EntityId[] = [];
  for (const id of [...roster].sort()) {
    participants.push(id);
    if (me !== null && id === me) continue;
    const entity = getEntity(id);
    if (entity === null) continue;
    entities.push({ id, name: entity.canonical ?? id, type: entity.type ?? "person" });
  }

  const streams: PackStream[] = streamRows.map((row) => ({
    id: row.id,
    name: row.label ?? row.id,
    kind: row.stream_kind ?? "dm",
    participantIds: parseIds(row.participant_entity_ids)
      .map((id) => selfToken(boundId(id), me))
      .filter((id): id is string => id !== null),
  }));

  // `#T` — the open loops of the people in this room. Context only: §12.4 says
  // they are supplied and NOT re-emitted, and the parser never writes a Z line
  // in pass 1 either way.
  const parties = participants.filter((id) => id !== me);
  const loopRows: LoopRow[] =
    parties.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, intent, owner_id, due_utc, state FROM loops
              WHERE state IN ('open','latent')
                AND (owner_id IN (${marks(parties.length)}) OR counterparty_id IN (${marks(parties.length)})
                     ${me === null ? "" : "OR owner_id = ?"})
              ORDER BY COALESCE(due_utc, stated_at), id
              LIMIT 40`,
          )
          .all(...parties, ...parties, ...(me === null ? [] : [me])) as LoopRow[]);
  const loops: PackLoop[] = loopRows.map((row) => ({
    id: row.id,
    intent: row.intent ?? "",
    // Through the same verification as everything else: a loop whose owner has
    // since been MERGED renders as the survivor's roster alias rather than as
    // `-`, because the packer only ever looks up an alias it already minted.
    ...(row.owner_id === null ? {} : { ownerId: selfToken(boundId(row.owner_id), me) ?? row.owner_id }),
    ...(row.due_utc === null ? {} : { due: row.due_utc }),
    state: row.state ?? "open",
    streamId: streams[0]?.id,
  }));

  // A speaker with no bound entity is packed UNDER ITS OWN NAMESPACE, never as
  // a bare actor id. The transcript still distinguishes who said what — which
  // is the only thing the model needs — while nothing the model can cite back
  // resolves to something an entity column would accept.
  const unboundActors = new Map<string, string>();
  const packEvents: PackEvent[] = [];
  for (const row of eventRows) {
    const actorEntityId = boundId(row.actor_entity_id);
    let speaker = selfToken(actorEntityId, me);
    if (speaker === null && row.actor_id !== null) {
      speaker = unboundToken(row.actor_id);
      unboundActors.set(speaker, row.actor_id);
    }
    if (row.stream_id === null || speaker === null) continue;
    packEvents.push({
      id: row.id,
      streamId: row.stream_id,
      at: row.ts ?? "",
      speakerId: speaker,
      ...(row.text === null ? {} : { text: row.text }),
    });
  }
  if (packEvents.length === 0) return null;

  const input: PackInput = {
    tz: streamRows.find((r) => r.tz !== null)?.tz ?? "UTC",
    entities,
    streams,
    episodes: episodes.map((ep) => ({
      id: ep.id,
      label: ep.topicLabel ?? "",
      state: ep.arcState ?? "open",
      ...(ep.endedAt === null ? {} : { lastActivity: ep.endedAt }),
      entityIds: ep.entityIds
        .map((id) => selfToken(boundId(id), me))
        .filter((id): id is string => id !== null),
      ...(ep.streamId === null ? {} : { streamId: ep.streamId }),
    })),
    loops,
    events: packEvents,
  };

  const prompt = buildCl1Prompt(input);
  if (prompt === null || prompt.stats.events === 0) return null;
  return { prompt, episodes: [...episodes], events, me, participants, episodeOfEvent, unboundActors };
}
