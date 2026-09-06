// ===========================================================================
// [CODE] The person card — V6 P1 S5.4 (Product_V6 §11.8, Product_V6_Phase1
// §11.6).
//
// One card per person, provisional people included. Everything on it is READ
// from the record at request time — nothing is cached, so a drag (circle), a
// merge or a new message shows immediately:
//
//   fields        name · identities (phone/jid/alias) · provisional · pinned
//   circle        the stored circle + who decided it (user | code:circles)
//   relationship  active relationship claims, with evidence
//   last context  the last message they wrote (or were addressed in)
//   open loops    open tasks they own · their questions on the queue ·
//                 role questions naming them
//   radar         follow-up entries for them (radar.ts)
//   dates         person_dates (0204) with the EFFECTIVE mode + lead time:
//                 plan or wish, per date override → circle default
//   tone          the DM profile and the group profiles, kept apart
//   business      orders · bills · bookings from typed claim columns when the
//                 person is a business
//   how I know    anchors from the provisional-person decisions
// ===========================================================================

import { getDb } from "../db/connection.js";
import { claimsAbout, getToneProfile, type ClaimVersionRow, type ToneProfile } from "../claims/store.js";
import { identitiesOf } from "../entities/identities.js";
import { edgesOf, type EdgeRow } from "../entities/edges.js";
import { getEntity, mergedAliasIds, type Circle, type EntityRow } from "../entities/registry.js";
import { anchorsOf } from "./provisional.js";
import { leadDaysFor, radarForPerson, type RadarEntry } from "./radar.js";
import { addressTermsForScope, type TermClass } from "./address-terms.js";

export type DateMode = "plan" | "wish";

/** Product_V6 §11.8.4 defaults: plan 14 for partner/family, 7 for close friends, wish-only otherwise. */
export const DATE_DEFAULTS: Readonly<Record<Circle, { mode: DateMode; leadDays: number }>> = {
  partner: { mode: "plan", leadDays: 14 },
  family: { mode: "plan", leadDays: 14 },
  close_friends: { mode: "plan", leadDays: 7 },
  friends: { mode: "wish", leadDays: 0 },
  coworkers: { mode: "wish", leadDays: 0 },
  important_services: { mode: "wish", leadDays: 0 },
  old_batchmates: { mode: "wish", leadDays: 0 },
  acquaintances: { mode: "wish", leadDays: 0 },
  businesses: { mode: "wish", leadDays: 0 },
};

export function effectiveDateMode(
  circle: Circle | null,
  row: { mode: string | null; lead_days: number | null },
): { mode: DateMode; leadDays: number; source: string } {
  if (row.mode === "plan" || row.mode === "wish") {
    return { mode: row.mode, leadDays: row.lead_days ?? (row.mode === "plan" ? (circle ? DATE_DEFAULTS[circle].leadDays || 7 : 7) : 0), source: "set for this date" };
  }
  if (circle) return { ...DATE_DEFAULTS[circle], source: `${circle} circle default` };
  return { mode: "wish", leadDays: 0, source: "default (no circle)" };
}

export interface PersonDateView {
  id: string;
  kind: string;
  label: string | null;
  month: number;
  day: number;
  year: number | null;
  mode: DateMode;
  leadDays: number;
  modeSource: string;
  /** Next occurrence at or after `now` (yyyy-mm-dd) and the day the plan opens. */
  next: string;
  opensAt: string;
}

export interface PersonCard {
  id: string;
  name: string | null;
  provisional: boolean;
  userPinned: boolean;
  mergedAliases: string[];
  identities: { kind: string; value: string; source: string | null }[];
  circle: Circle | null;
  circleDecidedBy: string | null;
  relationships: ClaimVersionRow[];
  edges: EdgeRow[];
  lastContext: { ts: string; streamKey: string | null; text: string; byThem: boolean } | null;
  openLoops: {
    tasks: { id: string; title: string; due: string | null; status: string }[];
    questions: { id: string; question: string; kind: string | null }[];
  };
  radar: RadarEntry[];
  radarLeadDays: { days: number; source: string };
  dates: PersonDateView[];
  tone: { dm: ToneProfile | null; groups: ToneProfile[]; addressTerms: TermClass[] };
  business: { orders: ClaimVersionRow[]; bills: ClaimVersionRow[]; bookings: ClaimVersionRow[] } | null;
  howIKnow: Record<string, unknown>[];
  claims: ClaimVersionRow[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** yyyy-mm-dd of the next occurrence at/after today (year-less = yearly). */
export function nextOccurrence(month: number, day: number, year: number | null, now: Date): string {
  if (year !== null) return `${year}-${pad(month)}-${pad(day)}`;
  const y = now.getUTCFullYear();
  const today = now.toISOString().slice(0, 10);
  const thisYear = `${y}-${pad(month)}-${pad(day)}`;
  return thisYear >= today ? thisYear : `${y + 1}-${pad(month)}-${pad(day)}`;
}

export function minusDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function circleDecider(entityId: string): string | null {
  const row = getDb()
    .prepare(`SELECT pass FROM decisions WHERE target_kind IN ('entity','person') AND target_id = ? AND action = 'set_circle' ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(entityId) as { pass: string | null } | undefined;
  return row?.pass ?? null;
}

/**
 * `person_dates` ships with the calendar migration (0204). The card degrades
 * to an empty date list rather than throwing when a build has people without
 * the calendar — the lanes are independent by design.
 */
function hasPersonDates(): boolean {
  return (
    getDb().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_dates'`).get() !== undefined
  );
}

export function personDates(entityId: string, circle: Circle | null, now: Date): PersonDateView[] {
  if (!hasPersonDates()) return [];
  const rows = getDb()
    .prepare(`SELECT id, kind, label, month, day, year, mode, lead_days FROM person_dates WHERE person_entity_id = ? ORDER BY month, day`)
    .all(entityId) as { id: string; kind: string; label: string | null; month: number; day: number; year: number | null; mode: string | null; lead_days: number | null }[];
  return rows.map((r) => {
    const eff = effectiveDateMode(circle, r);
    const next = nextOccurrence(r.month, r.day, r.year, now);
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      month: r.month,
      day: r.day,
      year: r.year,
      mode: eff.mode,
      leadDays: eff.leadDays,
      modeSource: eff.source,
      next,
      opensAt: eff.mode === "plan" ? minusDays(next, eff.leadDays) : next,
    };
  });
}

function businessCard(claims: ClaimVersionRow[], entityId: string): PersonCard["business"] {
  const db = getDb();
  const typed = db
    .prepare(`SELECT claim_key, amount, currency, date, typed_status, merchant, order_id FROM claims WHERE subject_id = ? AND status = 'active'`)
    .all(entityId) as { claim_key: string; amount: number | null; currency: string | null; date: string | null; typed_status: string | null; merchant: string | null; order_id: string | null }[];
  const byKey = new Map(typed.map((t) => [t.claim_key, t]));
  const orders: ClaimVersionRow[] = [];
  const bills: ClaimVersionRow[] = [];
  const bookings: ClaimVersionRow[] = [];
  for (const c of claims) {
    const t = byKey.get(c.claimKey);
    const text = (c.text ?? "").toLowerCase();
    if (t?.order_id || /\border\b|delivered|shipped/.test(text)) orders.push(c);
    else if (/\b(bill|invoice|premium|due|recharge|payment)\b/.test(text) || (t?.amount != null && !/book/.test(text))) bills.push(c);
    else if (/\b(booking|booked|pnr|ticket|flight|hotel|reservation)\b/.test(text)) bookings.push(c);
  }
  return { orders, bills, bookings };
}

/** Build the card. Returns null when the id resolves to no person. */
export function buildPersonCard(id: string, now: Date = new Date()): PersonCard | null {
  const db = getDb();
  const e: EntityRow | null = getEntity(id);
  if (!e || e.type !== "person") return null;
  const aliases = mergedAliasIds(e.id);
  const claims = claimsAbout(e.id);
  const relationships = claims.filter((c) => c.kind === "relationship");
  const marks = aliases.map(() => "?").join(",");
  const last = db
    .prepare(
      `SELECT ts, stream_key, text, actor_entity_id FROM events
        WHERE (actor_entity_id IN (${marks}) OR actor IN (${marks})) AND text IS NOT NULL AND text <> '' AND COALESCE(origin,'live') <> 'eval'
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(...aliases, ...aliases) as { ts: string; stream_key: string | null; text: string; actor_entity_id: string | null } | undefined;
  const tasks = db
    .prepare(`SELECT id, title, due, status FROM tasks WHERE owner_entity_id IN (${marks}) AND status IN ('open','scheduled','needs_input','needs_approval') ORDER BY due IS NULL, due`)
    .all(...aliases) as { id: string; title: string; due: string | null; status: string }[];
  const questions = db
    .prepare(
      `SELECT id, question, kind FROM questions WHERE status = 'open' AND (
         (target_kind = 'entity' AND target_id IN (${marks}))
         OR (target_kind = 'entity_pair' AND (${aliases.map(() => "target_id LIKE ?").join(" OR ")}))
         OR (kind = 'roles' AND (${aliases.map(() => "options_json LIKE ?").join(" OR ")}))
       ) ORDER BY asked_at`,
    )
    .all(...aliases, ...aliases.map((a) => `%${a}%`), ...aliases.map((a) => `%${a}%`)) as { id: string; question: string; kind: string | null }[];
  const circle = e.circle;
  const groupProfiles = db
    .prepare(`SELECT stream_id FROM tone_profiles WHERE stream_id IS NOT NULL AND person_entity_id IS NULL`)
    .all() as { stream_id: string }[];
  const streamsOfPerson = new Set(
    (db.prepare(`SELECT DISTINCT stream_id FROM events WHERE actor_entity_id IN (${marks}) AND stream_id IS NOT NULL`).all(...aliases) as { stream_id: string }[]).map(
      (r) => r.stream_id,
    ),
  );
  const groups = groupProfiles
    .filter((g) => streamsOfPerson.has(g.stream_id))
    .map((g) => getToneProfile(null, g.stream_id))
    .filter((p): p is ToneProfile => p !== null);
  return {
    id: e.id,
    name: e.canonical,
    provisional: e.provisional,
    userPinned: e.userPinned,
    mergedAliases: aliases.filter((a) => a !== e.id),
    identities: identitiesOf(e.id).map((i) => ({ kind: i.kind, value: i.valueNorm, source: i.sourceId })),
    circle,
    circleDecidedBy: circle ? circleDecider(e.id) : null,
    relationships,
    edges: edgesOf(e.id, { status: "active" }),
    lastContext: last ? { ts: last.ts, streamKey: last.stream_key, text: last.text, byThem: last.actor_entity_id !== null && aliases.includes(last.actor_entity_id) } : null,
    openLoops: { tasks, questions },
    radar: radarForPerson(e.id, now),
    radarLeadDays: leadDaysFor(e.id, circle),
    dates: personDates(e.id, circle, now),
    tone: { dm: getToneProfile(e.id, null), groups, addressTerms: addressTermsForScope({ personEntityId: e.id }) },
    business: circle === "businesses" ? businessCard(claims, e.id) : null,
    howIKnow: anchorsOf(e.id),
    claims,
  };
}
