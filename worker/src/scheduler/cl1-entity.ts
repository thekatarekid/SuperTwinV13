// ===========================================================================
// [CODE] The entity FK boundary of the P-CL1 stage — arch §5.2, §5.8.6, §10.3.
//
// `claim_versions.subject_id`, `claim_versions.speaker_id`, `loops.owner_id`
// and `loops.counterparty_id` are all FOREIGN KEYS onto `entities(id)`. Three
// different kinds of string reach this stage looking like they belong there and
// NONE of them do:
//
//   `self`                                the wire's RESERVED ALIAS (§5.2)
//   `whatsapp:ac:9198…@s.whatsapp.net`    an ACTOR id, packed as a speaker
//                                         because the actor had no entity yet
//   `ent_…` for a row that never existed   a hand-edited or half-migrated db
//
// Handing any of them to SQLite is `SqliteError: FOREIGN KEY constraint failed`
// — thrown mid-batch, taking every later claim and EVERY loop of that batch
// with it. That is not a hypothetical: it is what emptied `loops` on a live
// install while the log said `claims=0+0 loops=0`.
//
// So there is exactly ONE way into an entity column from this stage, and it is
// this file. `toEntityId` answers with a VERIFIED id or with null — it reads
// the row, so a value it returns is a value the FK will accept, and a merged
// entity comes back as its survivor. `entityFk` is the assertion for the last
// inch before a write: an id that is not an entity id there is a CODE bug, not
// a model mistake, and it throws NAMING THE OFFENDING VALUE rather than letting
// SQLite report a constraint with no id in the message.
//
// UNKNOWN BEATS WRONG (§5.2.2, §5.8.6). Everything that cannot be bound comes
// back as `unbound` — reported, counted, and written as NULL. A roster miss has
// always been "the model did not say"; an unbindable actor is the same fact
// arriving from the other direction, and neither may become an id.
// ===========================================================================

import { getEntity } from "../entities/registry.js";

/**
 * A string VERIFIED to be a live `entities.id`. The brand is not decoration:
 * `subjectId: EntityId | null` on a write input makes "actor id where an entity
 * id belongs" a compile error rather than a runtime constraint failure, and the
 * only way to mint one is to read the row through this file.
 */
export type EntityId = string & { readonly __entityId: "entity" };

/**
 * The prefix a speaker with no bound entity is packed under.
 *
 * The packer mints an `a<n>` alias for whatever speaker id it is handed, and
 * the parser resolves that alias straight back to that id — so an actor id
 * packed as a speaker comes back looking exactly like a roster entity. It
 * cannot be left bare. Prefixed, it still distinguishes the speakers in the
 * transcript (which is what the model needs), it can never be mistaken for an
 * entity id by any reader, and the id it is hiding is still legible in a
 * diagnostic — `unbound:whatsapp:ac:…` says WHICH actor needs binding.
 */
export const UNBOUND_PREFIX = "unbound:";

/** Pack an actor that identity binding has not reached yet. */
export function unboundToken(actorId: string): string {
  return `${UNBOUND_PREFIX}${actorId}`;
}

/** The actor id inside an unbound token, or null when it is not one. */
export function unboundActorId(token: string | null | undefined): string | null {
  if (typeof token !== "string" || !token.startsWith(UNBOUND_PREFIX)) return null;
  const actorId = token.slice(UNBOUND_PREFIX.length);
  return actorId === "" ? null : actorId;
}

/**
 * A verified entity id, or null.
 *
 * The check is the ROW, not the shape: `ent_` + 24 hex is what `mintEntityId`
 * produces, but the me entity and every test fixture may supply their own id,
 * and the FK cares about existence and nothing else. `getEntity` also follows
 * `merged_into`, so a claim citing a merged-away entity lands on the survivor
 * instead of failing the constraint.
 */
export function toEntityId(id: string | null | undefined): EntityId | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (trimmed === "" || trimmed.startsWith(UNBOUND_PREFIX)) return null;
  const row = getEntity(trimmed);
  return row === null ? null : (row.id as EntityId);
}

/**
 * The last inch before an entity FK. Null passes (a NULL column is a legal
 * answer everywhere this is used); anything else must be a live entity or this
 * throws with the value in the message.
 *
 * Reaching it with a non-entity string means a resolution path bypassed
 * `toEntityId`, which is the bug this file exists to make impossible to ship
 * quietly.
 */
export function entityFk(field: string, id: string | null | undefined): EntityId | null {
  if (id === null || id === undefined || id === "") return null;
  const resolved = toEntityId(id);
  if (resolved === null) {
    const actor = unboundActorId(id);
    throw new Error(
      actor === null
        ? `cl1: ${field} would write ${JSON.stringify(id)} into an entities foreign key — no such entity`
        : `cl1: ${field} would write actor ${JSON.stringify(actor)} into an entities foreign key — ` +
          `that actor has no bound entity`,
    );
  }
  return resolved;
}

/**
 * What one subject / owner / counterparty field resolved to.
 *
 * Exactly one side is populated for a STATED reference. Both are null when the
 * model said nothing at all — "not stated" and "said something unbindable" are
 * different facts and the counters keep them apart.
 */
export interface EntityRef {
  id: EntityId | null;
  /** The raw thing the model named, when it could not be bound. */
  unbound: string | null;
}

const ABSENT: EntityRef = { id: null, unbound: null };

/**
 * Resolve one model-supplied reference against this call's `me`.
 *
 * `self` is the reserved alias (§5.2) and resolves to the me entity — or, on an
 * install where nothing has bound one yet, to `unbound`, because a `self` with
 * no me entity behind it is a reference we cannot honour and NULL beats a
 * wrong id.
 */
export function resolveEntityRef(raw: string | null | undefined, me: EntityId | null): EntityRef {
  if (typeof raw !== "string" || raw.trim() === "") return ABSENT;
  const token = raw.trim();
  if (token === "self") return me === null ? { id: null, unbound: "self" } : { id: me, unbound: null };
  const resolved = toEntityId(token);
  return resolved === null ? { id: null, unbound: token } : { id: resolved, unbound: null };
}
