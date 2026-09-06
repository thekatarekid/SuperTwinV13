// ===========================================================================
// [CODE] Follow-up radar — V6 P1 S5.4 (Product_V6 §11.8.3, CRM-01, CRM-02).
//
// Who owes the user a reply, and who the user owes. Computed by code over the
// event log — no model — from the last exchange in each stream:
//
//   i_owe     the other party's last message asks something and the user has
//             not written since → the user owes a reply.
//   they_owe  the user's last message asks something and nobody answered →
//             a reply is owed to the user.
//
// Each entry carries a follow-up time (asked + the circle's lead time; learned
// per person via person_prefs) — the moment the twin starts acting. Sameer
// (coworker, lead 3 days) asked on Tuesday → start Friday (CRM-01).
//
// Scope: DMs and small groups the user takes part in. A 180-member group the
// user never replied in has NO radar (CRM-02) — a broadcast is not a debt.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { circleOf, getEntity, type Circle } from "../entities/registry.js";
import { BROADCAST_GROUP_MIN } from "./circles.js";

export const RADAR_LEAD_DAYS: Readonly<Record<Circle, number>> = {
  partner: 1,
  family: 2,
  close_friends: 2,
  friends: 5,
  coworkers: 3,
  important_services: 3,
  old_batchmates: 7,
  acquaintances: 7,
  businesses: 5,
};
export const RADAR_LEAD_DEFAULT = 5;
/** Groups at or above this size are never on the radar. */
export const RADAR_GROUP_CAP = BROADCAST_GROUP_MIN;

const DAY_MS = 86_400_000;
const ASK_WORDS = /\b(can you|could you|will you|would you|pls|please|kya|kab|kahan|kaise|kyun|when|where|how|what|which|who|any update|update\?|let me know|bata|batao|send|share|confirm|reply|revert|\?)/i;

export type RadarDirection = "i_owe" | "they_owe";

export interface RadarEntry {
  personId: string | null;
  personName: string | null;
  circle: Circle | null;
  direction: RadarDirection;
  streamKey: string;
  streamId: string | null;
  isGroup: boolean;
  askedAt: string;
  askText: string;
  eventId: string;
  leadDays: number;
  /** askedAt + leadDays — when the twin starts acting. */
  followUpAt: string;
  /** Days since the ask at `now`. */
  ageDays: number;
  overdue: boolean;
}

/** Is this text an ask — a question or a request? Pure. */
export function looksLikeAsk(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (/\?\s*$/.test(t)) return true;
  return ASK_WORDS.test(t) && !/^(ok|okay|done|haan|yes|thanks|thank you|👍|✅)/i.test(t);
}

export function leadDaysFor(personId: string | null, circle: Circle | null): { days: number; source: string } {
  if (personId) {
    const pref = getDb().prepare(`SELECT radar_lead_days FROM person_prefs WHERE person_entity_id = ?`).get(personId) as
      | { radar_lead_days: number | null }
      | undefined;
    if (pref && pref.radar_lead_days !== null) return { days: pref.radar_lead_days, source: "learned for this person" };
  }
  if (circle) return { days: RADAR_LEAD_DAYS[circle], source: `${circle} circle default` };
  return { days: RADAR_LEAD_DEFAULT, source: "default (no circle)" };
}

export function setRadarLead(personId: string, days: number | null, reason = "user"): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO person_prefs (person_entity_id, radar_lead_days, notes, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(person_entity_id) DO UPDATE SET radar_lead_days = excluded.radar_lead_days, notes = excluded.notes, updated_at = excluded.updated_at`,
  ).run(personId, days, reason);
}

interface LastRow {
  id: string;
  ts: string;
  actor: string | null;
  actor_entity_id: string | null;
  text: string | null;
  stream_id: string | null;
  stream_key: string;
  roles_json: string | null;
}

function audienceSize(rolesJson: string | null): number {
  if (!rolesJson) return 0;
  try {
    const r = JSON.parse(rolesJson) as { audience?: unknown };
    return Array.isArray(r.audience) ? r.audience.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The radar at `now`. One entry per stream at most — the last exchange decides.
 * `origin = 'eval'` rows are ignored like every other lane does.
 */
export function computeRadar(now: Date = new Date(), opts: { streamKeys?: string[] } = {}): RadarEntry[] {
  const db = getDb();
  const keys = opts.streamKeys
    ? opts.streamKeys
    : (db.prepare(`SELECT DISTINCT stream_key FROM events WHERE stream_key IS NOT NULL AND kind LIKE 'wa.%' AND COALESCE(origin,'live') <> 'eval'`).all() as { stream_key: string }[]).map(
        (r) => r.stream_key,
      );
  const out: RadarEntry[] = [];
  for (const key of keys) {
    const rows = db
      .prepare(
        `SELECT id, ts, actor, actor_entity_id, text, stream_id, stream_key, roles_json FROM events
          WHERE stream_key = ? AND kind LIKE 'wa.%' AND COALESCE(origin,'live') <> 'eval' AND text IS NOT NULL AND text <> ''
          ORDER BY ts DESC, id DESC LIMIT 6`,
      )
      .all(key) as LastRow[];
    if (rows.length === 0) continue;
    const last = rows[0]!;
    const isGroup = key.includes("@g.us") || key.includes("-group");
    const members = Math.max(...rows.map((r) => audienceSize(r.roles_json)));
    const userEver = (db.prepare(`SELECT 1 FROM events WHERE stream_key = ? AND actor = 'self' LIMIT 1`).get(key) as unknown) !== undefined;
    if (isGroup && (members >= RADAR_GROUP_CAP || !userEver)) continue; // CRM-02
    const lastIsSelf = last.actor === "self";
    if (!looksLikeAsk(last.text ?? "")) continue;
    let personId: string | null = null;
    if (lastIsSelf) {
      // They owe: the other party of the DM (or, in a small group, nobody in particular).
      const other = rows.find((r) => r.actor !== "self");
      personId = other?.actor_entity_id ?? null;
      if (!personId && !isGroup) continue; // a monologue, not a debt
    } else {
      personId = last.actor_entity_id;
    }
    const circle = personId ? circleOf(personId) : null;
    const lead = leadDaysFor(personId, circle);
    const askedMs = Date.parse(last.ts);
    const followUpMs = askedMs + lead.days * DAY_MS;
    const ageDays = Math.floor((now.getTime() - askedMs) / DAY_MS);
    out.push({
      personId,
      personName: personId ? (getEntity(personId)?.canonical ?? null) : null,
      circle,
      direction: lastIsSelf ? "they_owe" : "i_owe",
      streamKey: key,
      streamId: last.stream_id,
      isGroup,
      askedAt: last.ts,
      askText: last.text ?? "",
      eventId: last.id,
      leadDays: lead.days,
      followUpAt: new Date(followUpMs).toISOString(),
      ageDays,
      overdue: now.getTime() >= followUpMs,
    });
  }
  return out.sort((a, b) => Date.parse(a.followUpAt) - Date.parse(b.followUpAt));
}

export function radarForPerson(personId: string, now: Date = new Date()): RadarEntry[] {
  return computeRadar(now).filter((e) => e.personId === personId);
}
