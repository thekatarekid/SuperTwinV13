// ===========================================================================
// [ROSTER] — resolved people, relationships, nicknames (V6 P1 S3.2; Product
// P1 §7.2 "roster: resolved people, relationships, nicknames").
//
// Who is in the pack: the participants of every stream in it plus the actors
// of every bundle and history event, resolved to entity rows through
// `events.actor_entity_id`, then `entity_identities.value_norm`. An actor no
// row resolves is listed as unresolved — the thin-context signal reads that
// count (PCK-06). Nicknames are `alias` identities; relationships are the
// active entity edges between roster members and the self entity.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { SELF_ENTITY_ID } from "../db/migrations/0201_v6_graph.js";

export interface RosterEntry {
  /** Entity id (the ref the model cites). */
  ref: string;
  name: string;
  circle: string | null;
  provisional: boolean;
  nicknames: string[];
  /** e.g. "family_of self", "works_with ent_x". */
  relationships: string[];
  /** Actor refs (`contact:rohan`, a jid) this entity answers for in the pack. */
  actors: string[];
}

export interface Roster {
  entries: RosterEntry[];
  /** Actor refs no entity resolves, `self` excluded. */
  unresolved: string[];
}

export const ROSTER_MAX = 24;
const NICKNAMES_MAX = 3;
const RELATIONSHIPS_MAX = 3;

function stripPrefix(actor: string): string {
  const i = actor.indexOf(":");
  return i > 0 ? actor.slice(i + 1) : actor;
}

/**
 * Build the roster for a set of streams and the events they carry.
 * `eventIds` are used for `actor_entity_id`, `actors` for identity lookups.
 */
export function buildRoster(input: {
  participantIds: readonly string[];
  eventIds: readonly string[];
  actors: readonly string[];
}): Roster {
  const db = getDb();
  const entityActors = new Map<string, Set<string>>();
  const add = (entityId: string, actor?: string): void => {
    const set = entityActors.get(entityId) ?? new Set<string>();
    if (actor) set.add(actor);
    entityActors.set(entityId, set);
  };
  for (const p of input.participantIds) add(p);

  const actors = [...new Set(input.actors.filter((a) => a && a !== "?" && a !== "self"))];
  const resolvedActors = new Set<string>();

  // 1. actor_entity_id on the events themselves.
  const eventIds = [...new Set(input.eventIds.filter((id) => id !== ""))];
  if (eventIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT actor, actor_entity_id FROM events
          WHERE id IN (${eventIds.map(() => "?").join(",")}) AND actor_entity_id IS NOT NULL`,
      )
      .all(...eventIds) as { actor: string | null; actor_entity_id: string }[];
    for (const r of rows) {
      add(r.actor_entity_id, r.actor ?? undefined);
      if (r.actor) resolvedActors.add(r.actor);
    }
  }

  // 2. identities: the actor ref as written, and without its `kind:` prefix.
  const pending = actors.filter((a) => !resolvedActors.has(a));
  if (pending.length > 0) {
    const values = [...new Set(pending.flatMap((a) => [a, stripPrefix(a), a.toLowerCase(), stripPrefix(a).toLowerCase()]))];
    const rows = db
      .prepare(
        `SELECT ei.entity_id, ei.value_norm FROM entity_identities ei
           JOIN entities en ON en.id = ei.entity_id AND en.merged_into IS NULL
          WHERE ei.value_norm IN (${values.map(() => "?").join(",")})`,
      )
      .all(...values) as { entity_id: string; value_norm: string }[];
    const byValue = new Map<string, string>();
    for (const r of rows) if (!byValue.has(r.value_norm)) byValue.set(r.value_norm, r.entity_id);
    for (const a of pending) {
      const hit =
        byValue.get(a) ?? byValue.get(stripPrefix(a)) ?? byValue.get(a.toLowerCase()) ?? byValue.get(stripPrefix(a).toLowerCase());
      if (hit) {
        add(hit, a);
        resolvedActors.add(a);
      }
    }
  }

  const unresolved = actors.filter((a) => !resolvedActors.has(a)).sort();
  entityActors.delete(SELF_ENTITY_ID);
  if (entityActors.size === 0) return { entries: [], unresolved };

  const ids = [...entityActors.keys()];
  const ph = ids.map(() => "?").join(",");
  const entities = db
    .prepare(
      `SELECT id, canonical, circle, provisional FROM entities
        WHERE id IN (${ph}) AND merged_into IS NULL ORDER BY id`,
    )
    .all(...ids) as { id: string; canonical: string | null; circle: string | null; provisional: number }[];
  const nick = db
    .prepare(
      `SELECT entity_id, value_norm FROM entity_identities
        WHERE kind = 'alias' AND entity_id IN (${ph}) ORDER BY entity_id, value_norm`,
    )
    .all(...ids) as { entity_id: string; value_norm: string }[];
  const nicknames = new Map<string, string[]>();
  for (const n of nick) {
    const list = nicknames.get(n.entity_id) ?? [];
    if (list.length < NICKNAMES_MAX) list.push(n.value_norm);
    nicknames.set(n.entity_id, list);
  }
  const edges = db
    .prepare(
      `SELECT kind, subtype, src_entity_id, dst_entity_id FROM entity_edges
        WHERE status = 'active' AND (src_entity_id IN (${ph}) OR dst_entity_id IN (${ph}))
        ORDER BY kind, src_entity_id, dst_entity_id`,
    )
    .all(...ids, ...ids) as { kind: string; subtype: string | null; src_entity_id: string; dst_entity_id: string }[];
  const rels = new Map<string, string[]>();
  const other = (id: string): string => (id === SELF_ENTITY_ID ? "self" : id);
  for (const e of edges) {
    const label = e.subtype ? `${e.kind}/${e.subtype}` : e.kind;
    if (entityActors.has(e.src_entity_id)) {
      const list = rels.get(e.src_entity_id) ?? [];
      if (list.length < RELATIONSHIPS_MAX) list.push(`${label} ${other(e.dst_entity_id)}`);
      rels.set(e.src_entity_id, list);
    } else if (entityActors.has(e.dst_entity_id)) {
      const list = rels.get(e.dst_entity_id) ?? [];
      if (list.length < RELATIONSHIPS_MAX) list.push(`${label}← ${other(e.src_entity_id)}`);
      rels.set(e.dst_entity_id, list);
    }
  }

  const entries: RosterEntry[] = entities.slice(0, ROSTER_MAX).map((en) => ({
    ref: en.id,
    name: en.canonical ?? "(unnamed)",
    circle: en.circle,
    provisional: en.provisional === 1,
    nicknames: nicknames.get(en.id) ?? [],
    relationships: rels.get(en.id) ?? [],
    actors: [...(entityActors.get(en.id) ?? [])].sort(),
  }));
  return { entries, unresolved };
}

export function renderRosterEntry(r: RosterEntry): string {
  const bits = [`${r.ref}=${r.name}`];
  if (r.actors.length > 0) bits.push(`as ${r.actors.join("/")}`);
  if (r.circle) bits.push(r.circle);
  if (r.nicknames.length > 0) bits.push(`aka ${r.nicknames.join(", ")}`);
  if (r.relationships.length > 0) bits.push(r.relationships.join(", "));
  if (r.provisional) bits.push("provisional");
  return bits.join(" · ");
}
