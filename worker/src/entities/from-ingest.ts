// ===========================================================================
// [CODE] Entities from ingest — build P1.1 (spec §7.2 rung 1, §7.3.1).
//
// The structural rung of the resolution ladder runs at capture: every actor a
// source announces becomes (or touches) an entity, bound by its source-native
// identity (jid) plus the phone the jid encodes. Zero model calls, conf 1.0.
//
// A metadata-minted person is PROVISIONAL (spec §7.3.1) until confirmed by a
// merge, a user action or richer evidence; the self actor is not — "me" is
// never a provisional person. Group jids become `group` entities so a roster
// entry never masquerades as a human.
//
// Called from ingest/index.ts onActor(); failures never block ingest.
// ===========================================================================

import { findIdentity, phoneFromJid, putIdentity } from "./identities.js";
import { createEntity, touchEntity, renameEntity, readEntityRaw, resolveEntityId } from "./registry.js";

export interface IngestActor {
  sourceId: string;
  /** Source-native id, e.g. '9198…@s.whatsapp.net' or '1602…@g.us'. */
  jid: string;
  displayName?: string | null;
  isSelf?: boolean;
  /** ISO-8601 sighting time (defaults to now). */
  seenAt?: string | null;
}

const DECIDER = "code:ingest";

/**
 * Ensure an entity exists for a source actor, bound by its jid identity.
 * Returns the (merge-resolved) entity id, or null when the jid is unusable.
 * Idempotent: the same actor lands on the same entity on every call.
 */
export function ensureEntityForActor(actor: IngestActor): string | null {
  const jid = (actor.jid ?? "").trim();
  if (jid === "") return null;
  const seenAt = actor.seenAt ?? new Date().toISOString();

  const existing = findIdentity(actor.sourceId, "jid", jid);
  if (existing) {
    const id = resolveEntityId(existing.entityId);
    if (!id) return null;
    touchEntity(id, seenAt);
    // A name learned later is still a name: fill in a missing canonical, but
    // never overwrite one (renames are the user's / a judged merge's).
    const row = readEntityRaw(id);
    if (row && row.canonical === null && actor.displayName) {
      renameEntity(id, actor.displayName);
    }
    return id;
  }

  const isGroup = jid.endsWith("@g.us");
  const entity = createEntity({
    type: isGroup ? "group" : "person",
    canonical: actor.displayName?.trim() ? actor.displayName.trim() : null,
    // "Me" is never provisional; everyone else metadata mints is (spec §7.3.1).
    provisional: actor.isSelf ? false : true,
    seenAt,
  });

  putIdentity({
    entityId: entity.id,
    sourceId: actor.sourceId,
    kind: "jid",
    value: jid,
    confidence: 1,
    decidedBy: DECIDER,
  });

  // The phone a user jid encodes is a CROSS-SOURCE identity (spec §7.2): filed
  // with source_id NULL so a future email/contacts source joins on it.
  if (!isGroup && !actor.isSelf) {
    const phone = phoneFromJid(jid);
    if (phone) {
      try {
        putIdentity({
          entityId: entity.id,
          sourceId: null,
          kind: "phone",
          value: phone,
          confidence: 1,
          decidedBy: DECIDER,
        });
      } catch {
        // A phone already bound elsewhere is a merge candidate, not an error;
        // the retrieve-then-judge lane (P1.x) owns that decision.
      }
    }
  }

  return entity.id;
}
