// ===========================================================================
// [CODE] People surface routes — arch §14.1/§14.8, build item 3.10.
//
// The read/write API behind `src/tabs/PeopleTab.tsx`: one page read and the
// two gestures §14.8 allows on a person.
//
//   GET  /api/people?tier=&q=      counts per tier, then the people
//   POST /api/people/:id/pin       { pinned }
//   POST /api/people/:id/rename    { canonical }
//
// PEOPLE IS NOT A TABLE. There is a legacy `people` table left over from the
// V11 phases and this module never reads it: a V2 person is `entities` narrowed
// to `person`, COMPOSED with its identities, its `related_to` edge to `me`, the
// claims it is the subject of, the arcs it anchors, the loops that run between
// the two of you, and the contact rhythm measured off `events`. A second table
// of people would be a second answer to "who is this", which is exactly what
// the entity graph exists to stop.
//
// THE TIER IS COMPUTED, NEVER STORED. `inner_circle` is bidirectional traffic
// in ≥8 of the last 12 weeks and nothing else — no column, no flag, no model
// call. The measurements the ladder ran on ship WITH the tier so the surface
// can re-derive it (`src/tabs/people/tier.ts`) and print the arithmetic; the
// two ladders are deliberately duplicated and must agree, and the surface
// renders the disagreement rather than hiding it if they ever do not.
//
// EVERY QUOTE IS VERBATIM OR THE ROW DOES NOT RENDER. §6's "no evidence, no
// write" has a reading rule to match: a claim or a loop with no `evidence` row
// is skipped here rather than shipped with an empty quote, because the surface
// promises that everything on it can be clicked through to what was said.
//
// AN EMPTY DATABASE IS A NORMAL STATE. Before the derivation pipeline has run
// there are no person entities, no rhythm and no loops, and the answer is a
// well-formed `{ counts: {…0}, people: [] }` rather than a 500.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { readSpaces } from "../arcs/promote-store.js";
import { activeClaims, type ClaimVersionRow } from "../claims/store.js";
import { getDb } from "../db/connection.js";
import { meEntityId } from "../entities/binding.js";
import { edgeEvidence, edgesOf } from "../entities/edges.js";
import { identitiesOf } from "../entities/identities.js";
import { logMutation } from "../entities/merge.js";
import {
  getEntity,
  listEntities,
  mergedAliasIds,
  pinEntity,
  renameEntity,
  resolveEntityId,
  type EntityRow,
} from "../entities/registry.js";
import { loopHorizon } from "../loops/state.js";
import { USER_ACTOR, elideIdentityValue, type MutationReceipt } from "./entities-routes.js";

/** The four tiers, strongest first — the order the chips and the ladder use. */
export const PERSON_TIERS = ["inner_circle", "active", "dormant", "archived"] as const;
export type PersonTier = (typeof PERSON_TIERS)[number];

/**
 * The ladder's thresholds. These are the SAME numbers `src/tabs/people/tier.ts`
 * runs on; the browser re-derives the tier to print the arithmetic, so a change
 * to one of these without the other is a visible disagreement on every card.
 */
export const INNER_CIRCLE_WEEKS = 8;
export const INNER_CIRCLE_WINDOW_WEEKS = 12;
const DAYS_DORMANT = 91; // ~3 months
const DAYS_ARCHIVED = 365; // 12 months

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** How many people one page carries. A filter narrows; it never paginates. */
export const PEOPLE_PAGE_LIMIT = 200;

/** The two loop states that are still running (`loops/state.ts` TASK_STATES). */
const OPEN_LOOP_STATES = ["open", "latent"] as const;

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

// ---------------------------------------------------------------------------
// The view shapes — mirrors of `src/lib/people-client.ts`
// ---------------------------------------------------------------------------

export interface ContactStats {
  bidirectionalWeeks12: number;
  bidirectionalLast4Weeks: boolean;
  daysSinceContact: number | null;
  reciprocity: number | null;
  reciprocityWindow: string | null;
  rhythmLabel: string | null;
}

export interface PersonIdentityView {
  id: string;
  kind: string;
  /** Already elided — "9177…03", never the whole number (§14.1). */
  value: string;
  sourceLabel: string | null;
  decidedBy: string | null;
}

export interface PersonClaimView {
  id: string;
  kind: string;
  text: string;
  confidence: number | null;
  attribution: string | null;
  decidedBy: string | null;
  quote: string;
  eventId: string | null;
}

export interface PersonThreadView {
  arcId: string;
  label: string;
  state: string;
  lastActiveAt: string | null;
}

export interface PersonSpaceView {
  spaceId: string;
  label: string;
  archetype: string | null;
}

export interface PersonLoopView {
  id: string;
  intent: string;
  direction: "you_owe_them" | "they_owe_you";
  dueLabel: string | null;
  quote: string;
}

export interface PersonRecommendationView {
  claimId: string;
  text: string;
  at: string | null;
  quote: string;
}

export interface PersonTimelineEntry {
  at: string;
  label: string;
  sourceLabel: string | null;
}

export interface PersonView {
  id: string;
  label: string;
  relationship: string | null;
  relationshipQuote: string | null;
  tier: PersonTier;
  stats: ContactStats;
  pinned: boolean;
  provisional: boolean;
  identities: PersonIdentityView[];
  claims: PersonClaimView[];
  threads: PersonThreadView[];
  sharedSpaces: PersonSpaceView[];
  openLoops: PersonLoopView[];
  recommendations: PersonRecommendationView[];
  timeline: PersonTimelineEntry[];
}

export interface PeoplePage {
  counts: Record<PersonTier, number>;
  people: PersonView[];
}

// ---------------------------------------------------------------------------
// The tier ladder
// ---------------------------------------------------------------------------

/**
 * §14.1's ladder, evaluated STRONGEST FIRST, thresholds inclusive at the
 * boundary they name. The last rung is the one worth reading twice: contact
 * inside three months that is not bidirectional inside four weeks is still a
 * live relationship, just a one-sided or a slow one, and `active` is the honest
 * floor — `dormant` would overstate the silence.
 */
export function deriveTier(stats: ContactStats): PersonTier {
  if (stats.bidirectionalWeeks12 >= INNER_CIRCLE_WEEKS) return "inner_circle";
  if (stats.bidirectionalLast4Weeks) return "active";
  const days = stats.daysSinceContact;
  if (days === null) return "archived";
  if (days >= DAYS_ARCHIVED) return "archived";
  if (days >= DAYS_DORMANT) return "dormant";
  return "active";
}

// ---------------------------------------------------------------------------
// Contact rhythm — measured off `events`, once per request
// ---------------------------------------------------------------------------

/**
 * Every JSON-array walk on this surface answers with an empty map rather than
 * throwing: a column holding something that is not JSON would take the whole
 * page down, and "nothing derived yet" is the honest reading of a corpus the
 * pipeline has not touched. Same idiom as the entities surface's `tally`.
 */
function jsonPairs(sql: string): { key: string; value: string }[] {
  try {
    return (getDb().prepare(sql).all() as { key: string | null; value: string | null }[])
      .filter((r): r is { key: string; value: string } => Boolean(r.key) && Boolean(r.value));
  } catch {
    return [];
  }
}

interface RhythmBuckets {
  /** weeks-ago index (0 = this week) → count. Only the last 12 are kept. */
  received: Map<number, number>;
  sent: Map<number, number>;
  lastReceivedAt: string | null;
  lastSentAt: string | null;
}

interface RhythmTables {
  /** entity id (any alias) → their own messages, bucketed by week. */
  receivedByEntity: Map<string, Map<number, number>>;
  /** stream id → your messages in it, bucketed by week. */
  sentByStream: Map<string, Map<number, number>>;
  lastReceivedByEntity: Map<string, string>;
  lastSentByStream: Map<string, string>;
  /** entity id (any alias) → the streams they are a participant of. */
  streamsByEntity: Map<string, string[]>;
}

function bucket(into: Map<string, Map<number, number>>, key: string, week: number, n: number): void {
  let weeks = into.get(key);
  if (!weeks) {
    weeks = new Map();
    into.set(key, weeks);
  }
  weeks.set(week, (weeks.get(week) ?? 0) + n);
}

/**
 * The rhythm reads, four of them, for the whole page.
 *
 * RECEIVED is attributed by ACTOR and SENT by STREAM, and the asymmetry is the
 * point: in a five-person group every inbound message has exactly one author,
 * but an outbound one is addressed to the room. Counting your own message as
 * contact with each participant is what "you talk to this group" means; counting
 * someone else's message as contact with everyone else in it would not be.
 *
 * The week index is `floor(days_ago / 7)`, computed by SQLite so the grouping
 * happens in the query rather than over every row of `events`. A `ts` SQLite
 * cannot parse yields NULL and is dropped — an unreadable timestamp is not week
 * zero.
 */
function rhythmTables(nowIso: string, floorIso: string): RhythmTables {
  const db = getDb();
  const receivedByEntity = new Map<string, Map<number, number>>();
  const sentByStream = new Map<string, Map<number, number>>();

  const weekExpr = `CAST((julianday(?) - julianday(ts)) / 7.0 AS INTEGER)`;

  for (const row of db
    .prepare(
      `SELECT actor_entity_id AS key, ${weekExpr} AS week, COUNT(*) AS n
         FROM events
        WHERE is_self = 0 AND actor_entity_id IS NOT NULL AND ts IS NOT NULL AND ts >= ?
        GROUP BY key, week`,
    )
    .all(nowIso, floorIso) as { key: string; week: number | null; n: number }[]) {
    if (row.week === null) continue;
    bucket(receivedByEntity, row.key, row.week, row.n);
  }

  for (const row of db
    .prepare(
      `SELECT stream_id AS key, ${weekExpr} AS week, COUNT(*) AS n
         FROM events
        WHERE is_self = 1 AND stream_id IS NOT NULL AND ts IS NOT NULL AND ts >= ?
        GROUP BY key, week`,
    )
    .all(nowIso, floorIso) as { key: string; week: number | null; n: number }[]) {
    if (row.week === null) continue;
    bucket(sentByStream, row.key, row.week, row.n);
  }

  // `daysSinceContact` is not windowed — "12 years ago" is a real answer and the
  // one that puts a person in `archived` — so the last-contact reads carry no
  // floor, unlike the two above.
  const lastReceivedByEntity = new Map<string, string>();
  for (const row of db
    .prepare(
      `SELECT actor_entity_id AS key, MAX(ts) AS last_ts
         FROM events
        WHERE is_self = 0 AND actor_entity_id IS NOT NULL AND ts IS NOT NULL
        GROUP BY key`,
    )
    .all() as { key: string; last_ts: string | null }[]) {
    if (row.last_ts) lastReceivedByEntity.set(row.key, row.last_ts);
  }

  const lastSentByStream = new Map<string, string>();
  for (const row of db
    .prepare(
      `SELECT stream_id AS key, MAX(ts) AS last_ts
         FROM events
        WHERE is_self = 1 AND stream_id IS NOT NULL AND ts IS NOT NULL
        GROUP BY key`,
    )
    .all() as { key: string; last_ts: string | null }[]) {
    if (row.last_ts) lastSentByStream.set(row.key, row.last_ts);
  }

  const streamsByEntity = new Map<string, string[]>();
  for (const pair of jsonPairs(
    `SELECT je.value AS key, s.id AS value
       FROM streams s, json_each(COALESCE(s.participant_entity_ids, '[]')) je`,
  )) {
    const list = streamsByEntity.get(pair.key);
    if (list) list.push(pair.value);
    else streamsByEntity.set(pair.key, [pair.value]);
  }

  return { receivedByEntity, sentByStream, lastReceivedByEntity, lastSentByStream, streamsByEntity };
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/** Everything the ladder and the card need about one person's traffic. */
function bucketsFor(aliasIds: readonly string[], tables: RhythmTables): RhythmBuckets {
  const received = new Map<number, number>();
  const sent = new Map<number, number>();
  let lastReceivedAt: string | null = null;
  let lastSentAt: string | null = null;
  const streams = new Set<string>();

  for (const id of aliasIds) {
    for (const [week, n] of tables.receivedByEntity.get(id) ?? []) {
      received.set(week, (received.get(week) ?? 0) + n);
    }
    lastReceivedAt = maxIso(lastReceivedAt, tables.lastReceivedByEntity.get(id) ?? null);
    for (const streamId of tables.streamsByEntity.get(id) ?? []) streams.add(streamId);
  }
  for (const streamId of streams) {
    for (const [week, n] of tables.sentByStream.get(streamId) ?? []) {
      sent.set(week, (sent.get(week) ?? 0) + n);
    }
    lastSentAt = maxIso(lastSentAt, tables.lastSentByStream.get(streamId) ?? null);
  }

  return { received, sent, lastReceivedAt, lastSentAt };
}

function sumWeeks(weeks: Map<number, number>, upTo: number): number {
  let total = 0;
  for (const [week, n] of weeks) if (week >= 0 && week < upTo) total += n;
  return total;
}

/**
 * "≈ 2× a week", the observed cadence and nothing more. The wording drops a
 * rung when the numbers do — a per-week figure below 1 read as "0× a week"
 * would be a measurement that says nothing, so it is reported per month, and
 * below that as the raw count over the window it was counted in.
 */
function rhythmLabel(total: number): string | null {
  if (total <= 0) return null;
  const perWeek = total / INNER_CIRCLE_WINDOW_WEEKS;
  if (perWeek >= 1) return `≈ ${Math.round(perWeek)}× a week`;
  const perMonth = perWeek * 4.34;
  if (perMonth >= 1) return `≈ ${Math.round(perMonth)}× a month`;
  return `${total} in the last ${INNER_CIRCLE_WINDOW_WEEKS} weeks`;
}

function contactStats(buckets: RhythmBuckets, nowMs: number): ContactStats {
  let bidirectionalWeeks12 = 0;
  for (let week = 0; week < INNER_CIRCLE_WINDOW_WEEKS; week += 1) {
    if ((buckets.received.get(week) ?? 0) > 0 && (buckets.sent.get(week) ?? 0) > 0) {
      bidirectionalWeeks12 += 1;
    }
  }

  // "Any bidirectional exchange in the last 4 weeks" is measured over the whole
  // 4-week span, not per week: a message out on Monday and a reply three weeks
  // later is an exchange, and splitting it across two buckets would erase it.
  const bidirectionalLast4Weeks = sumWeeks(buckets.received, 4) > 0 && sumWeeks(buckets.sent, 4) > 0;

  const lastContact = maxIso(buckets.lastReceivedAt, buckets.lastSentAt);
  const lastMs = lastContact ? Date.parse(lastContact) : NaN;
  const daysSinceContact = Number.isFinite(lastMs)
    ? Math.max(0, Math.floor((nowMs - lastMs) / DAY_MS))
    : null;

  const sent = sumWeeks(buckets.sent, INNER_CIRCLE_WINDOW_WEEKS);
  const received = sumWeeks(buckets.received, INNER_CIRCLE_WINDOW_WEEKS);
  const total = sent + received;

  return {
    bidirectionalWeeks12,
    bidirectionalLast4Weeks,
    daysSinceContact,
    // Never a ratio without its denominator (§14.1): reciprocity and the window
    // it was measured over are written and cleared together.
    reciprocity: total > 0 ? Math.round((sent / total) * 100) / 100 : null,
    reciprocityWindow: total > 0 ? `the last ${INNER_CIRCLE_WINDOW_WEEKS} weeks` : null,
    rhythmLabel: rhythmLabel(total),
  };
}

// ---------------------------------------------------------------------------
// Evidence, quotes and the composed page
// ---------------------------------------------------------------------------

interface QuoteRow {
  subjectId: string;
  eventId: string;
  quote: string;
}

/**
 * The verbatim quote per claim / loop.
 *
 * `claims/store.ts` has `evidenceOf`, but it answers with EVENT IDS — the read
 * it was written for is "which events back this claim", not "what was said".
 * The surface may not render a claim without the words, so the `quote` column
 * is read here, for every subject of a kind at once, and the earliest event id
 * wins so the same quote renders on every reload.
 */
function firstQuotes(subjectKind: string): Map<string, QuoteRow> {
  const out = new Map<string, QuoteRow>();
  for (const row of getDb()
    .prepare(
      `SELECT subject_id, event_id, quote FROM evidence
        WHERE subject_kind = ? ORDER BY subject_id, event_id`,
    )
    .all(subjectKind) as { subject_id: string; event_id: string; quote: string }[]) {
    if (!out.has(row.subject_id)) {
      out.set(row.subject_id, { subjectId: row.subject_id, eventId: row.event_id, quote: row.quote });
    }
  }
  return out;
}

/** event id → the source it came from, named. Blank when the row is gone. */
function eventSourceLabels(): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of getDb()
    .prepare(
      `SELECT e.id AS event_id, COALESCE(s.name, e.source_id) AS label
         FROM events e LEFT JOIN sources s ON s.id = e.source_id
        WHERE e.source_id IS NOT NULL`,
    )
    .all() as { event_id: string; label: string | null }[]) {
    if (row.label) out.set(row.event_id, row.label);
  }
  return out;
}

/** identity source id → the source's name, for the identity lines. */
function sourceNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of getDb().prepare(`SELECT id, name FROM sources`).all() as {
    id: string;
    name: string | null;
  }[]) {
    out.set(row.id, row.name && row.name.trim() !== "" ? row.name : row.id);
  }
  return out;
}

interface ArcRow {
  id: string;
  label: string;
  state: string;
  lastActiveAt: string | null;
}

/** entity id (any alias) → the arcs it anchors. One walk for the whole page. */
function arcsByAnchor(): Map<string, ArcRow[]> {
  const out = new Map<string, ArcRow[]>();
  let rows: {
    entity_id: string | null;
    id: string;
    label: string | null;
    user_label: string | null;
    state: string | null;
    last_evidence_at: string | null;
  }[];
  try {
    rows = getDb()
      .prepare(
        `SELECT je.value AS entity_id, a.id, a.label, a.user_label, a.state, a.last_evidence_at
           FROM arcs a, json_each(COALESCE(a.anchor_entity_ids, '[]')) je
          ORDER BY a.last_evidence_at DESC, a.id`,
      )
      .all() as typeof rows;
  } catch {
    return out;
  }
  for (const row of rows) {
    if (!row.entity_id) continue;
    const arc: ArcRow = {
      id: row.id,
      // A user label beats the derived one — the human renamed it for a reason.
      label: row.user_label?.trim() || row.label?.trim() || row.id,
      state: row.state ?? "live",
      lastActiveAt: row.last_evidence_at,
    };
    const list = out.get(row.entity_id);
    if (list) list.push(arc);
    else out.set(row.entity_id, [arc]);
  }
  return out;
}

interface LoopRow {
  id: string;
  intent: string | null;
  direction: string | null;
  ownerId: string | null;
  counterpartyId: string | null;
  dueUtc: string | null;
  nextOccurrenceUtc: string | null;
}

/**
 * The still-running loops. `loops` has no store module of its own — `state.ts`
 * owns the derivation and `promote-store.ts` reads them per arc — so the one
 * query this surface needs is written here, filtered to the two states
 * `loops/state.ts` calls running.
 */
function openLoopRows(): LoopRow[] {
  const marks = OPEN_LOOP_STATES.map(() => "?").join(",");
  return (
    getDb()
      .prepare(
        `SELECT id, intent, direction, owner_id, counterparty_id, due_utc, next_occurrence_utc
           FROM loops WHERE state IN (${marks}) ORDER BY due_utc IS NULL, due_utc, id`,
      )
      .all(...OPEN_LOOP_STATES) as {
      id: string;
      intent: string | null;
      direction: string | null;
      owner_id: string | null;
      counterparty_id: string | null;
      due_utc: string | null;
      next_occurrence_utc: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    intent: r.intent,
    direction: r.direction,
    ownerId: r.owner_id,
    counterpartyId: r.counterparty_id,
    dueUtc: r.due_utc,
    nextOccurrenceUtc: r.next_occurrence_utc,
  }));
}

/** "due 2026-08-28 · this week". Null when nobody ever fixed a date (§5.3). */
function dueLabel(loop: LoopRow, now: number): string | null {
  const due = loop.dueUtc ?? loop.nextOccurrenceUtc;
  if (!due) return null;
  const day = due.slice(0, 10);
  const horizon = loopHorizon(due, now);
  return horizon === "none" ? `due ${day}` : `due ${day} · ${horizon}`;
}

/**
 * What to call a person. `canonical` when somebody named them, otherwise the
 * first alias anybody used, and the id as the last resort — never a blank,
 * because an unnamed row still has to be clickable.
 */
function labelOf(row: EntityRow): string {
  const canonical = (row.canonical ?? "").trim();
  if (canonical !== "") return canonical;
  const alias = identitiesOf(row.id).find((i) => i.kind === "alias");
  return alias ? alias.valueNorm : row.id;
}

/** Search is over the name, the id and the identity values — not the graph. */
function matchesQuery(row: EntityRow, needle: string): boolean {
  if (needle === "") return true;
  if (labelOf(row).toLowerCase().includes(needle)) return true;
  if (row.id.toLowerCase().includes(needle)) return true;
  return identitiesOf(row.id).some((i) => i.valueNorm.toLowerCase().includes(needle));
}

interface PageTables {
  rhythm: RhythmTables;
  /** `claims_active` once for the page, not once per person. */
  claims: ClaimVersionRow[];
  claimQuotes: Map<string, QuoteRow>;
  loopQuotes: Map<string, QuoteRow>;
  eventSources: Map<string, string>;
  sources: Map<string, string>;
  arcs: Map<string, ArcRow[]>;
  loops: LoopRow[];
  /** arc id → the space it was promoted into, `promote-store.readSpaces`. */
  spaces: Map<string, { label: string; archetype: string | null }>;
  meId: string | null;
  nowMs: number;
}

function personView(row: EntityRow, t: PageTables): PersonView {
  const aliasIds = mergedAliasIds(row.id);
  const aliasSet = new Set(aliasIds);
  const stats = contactStats(bucketsFor(aliasIds, t.rhythm), t.nowMs);

  const identities: PersonIdentityView[] = identitiesOf(row.id).map((identity) => ({
    id: identity.id,
    kind: identity.kind,
    value: elideIdentityValue(identity.valueNorm),
    sourceLabel: identity.sourceId === null ? null : (t.sources.get(identity.sourceId) ?? identity.sourceId),
    decidedBy: identity.decidedBy,
  }));

  // The relationship is a CLAIM about the two of you, so it is the `related_to`
  // edge between this person and `me` — never a column, and never an edge to
  // somebody else, which would be a fact about their life, not about yours.
  let relationship: string | null = null;
  let relationshipQuote: string | null = null;
  if (t.meId !== null) {
    for (const edge of edgesOf(row.id, { kind: "related_to", status: "active" })) {
      const otherRaw = aliasSet.has(edge.srcEntityId) ? edge.dstEntityId : edge.srcEntityId;
      if ((resolveEntityId(otherRaw) ?? otherRaw) !== t.meId) continue;
      relationship = edge.subtype ?? edge.kind;
      relationshipQuote = edgeEvidence(edge.id)[0]?.quote ?? null;
      break;
    }
  }

  const claims: PersonClaimView[] = [];
  const recommendations: PersonRecommendationView[] = [];
  for (const claim of t.claims) {
    const subject = claim.subjectId !== null && aliasSet.has(claim.subjectId);
    const spoke = claim.speakerId !== null && aliasSet.has(claim.speakerId);
    if (!subject && !(spoke && claim.kind === "recommendation")) continue;
    // No evidence row, no render (§6). An empty quote would be the surface
    // asserting something it cannot show the words for.
    const evidence = t.claimQuotes.get(claim.id);
    if (!evidence) continue;
    if (subject) {
      claims.push({
        id: claim.id,
        kind: claim.kind ?? "fact",
        text: claim.text ?? "",
        confidence: claim.confidence,
        attribution: claim.attribution,
        decidedBy: claim.decidedBy,
        quote: evidence.quote,
        eventId: evidence.eventId,
      });
    }
    // Recommendations are what THEY told YOU — keyed on the speaker, not the
    // subject, because "Rohan says try Toit" is a fact about Toit and a fact
    // about Rohan, and only the second belongs on this card.
    if (spoke && claim.kind === "recommendation") {
      recommendations.push({
        claimId: claim.id,
        text: claim.text ?? "",
        at: claim.statedAt,
        quote: evidence.quote,
      });
    }
  }

  const threads: PersonThreadView[] = [];
  const sharedSpaces: PersonSpaceView[] = [];
  const seenArcs = new Set<string>();
  for (const id of aliasIds) {
    for (const arc of t.arcs.get(id) ?? []) {
      if (seenArcs.has(arc.id)) continue;
      seenArcs.add(arc.id);
      threads.push({ arcId: arc.id, label: arc.label, state: arc.state, lastActiveAt: arc.lastActiveAt });
      const space = t.spaces.get(arc.id);
      if (space) sharedSpaces.push({ spaceId: arc.id, label: space.label, archetype: space.archetype });
    }
  }

  // A loop is on this card only when it runs BETWEEN the two of you. Somebody
  // else's loop with a third party is their business, and item 3.10's "no tasks
  // on a person" is only true if this filter is.
  const openLoops: PersonLoopView[] = [];
  for (const loop of t.loops) {
    if (t.meId === null) break;
    const owner = loop.ownerId === null ? null : (resolveEntityId(loop.ownerId) ?? loop.ownerId);
    const other = loop.counterpartyId === null ? null : (resolveEntityId(loop.counterpartyId) ?? loop.counterpartyId);
    const youOwe = owner === t.meId && other !== null && aliasSet.has(other);
    const theyOwe = other === t.meId && owner !== null && aliasSet.has(owner);
    if (!youOwe && !theyOwe) continue;
    const evidence = t.loopQuotes.get(loop.id);
    if (!evidence) continue;
    // The ids decide the direction, not the stored string: `party_pair` and its
    // neighbours are DERIVED (§4.5), and a `direction` that disagreed with the
    // two entity ids would be the wrong half of the card to believe.
    openLoops.push({
      id: loop.id,
      intent: loop.intent ?? "",
      direction: youOwe ? "you_owe_them" : "they_owe_you",
      dueLabel: dueLabel(loop, t.nowMs),
      quote: evidence.quote,
    });
  }

  // The timeline is what the graph already dated: when they first appear, when
  // a relation started, when they were last heard from. Nothing is inferred —
  // an undated edge simply has no entry.
  const timeline: PersonTimelineEntry[] = [];
  if (row.firstSeenAt) timeline.push({ at: row.firstSeenAt, label: "first message", sourceLabel: null });
  for (const edge of edgesOf(row.id, { status: "active" })) {
    if (!edge.validFrom) continue;
    const evidence = edgeEvidence(edge.id)[0];
    timeline.push({
      at: edge.validFrom,
      label: edge.subtype ? `${edge.kind}:${edge.subtype}` : edge.kind,
      sourceLabel: evidence ? (t.eventSources.get(evidence.eventId) ?? null) : null,
    });
  }
  if (row.lastSeenAt && row.lastSeenAt !== row.firstSeenAt) {
    timeline.push({ at: row.lastSeenAt, label: "last message", sourceLabel: null });
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    id: row.id,
    label: labelOf(row),
    relationship,
    relationshipQuote,
    tier: deriveTier(stats),
    stats,
    pinned: row.userPinned,
    provisional: row.provisional,
    identities,
    claims,
    threads,
    sharedSpaces,
    openLoops,
    recommendations,
    timeline,
  };
}

const TIER_RANK: Readonly<Record<PersonTier, number>> = {
  inner_circle: 0,
  active: 1,
  dormant: 2,
  archived: 3,
};

function isPersonTier(value: unknown): value is PersonTier {
  return typeof value === "string" && (PERSON_TIERS as readonly string[]).includes(value);
}

export function peoplePage(params: URLSearchParams): PeoplePage {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const floorIso = new Date(nowMs - INNER_CIRCLE_WINDOW_WEEKS * WEEK_MS).toISOString();
  const meId = meEntityId();

  const spaces = new Map<string, { label: string; archetype: string | null }>();
  for (const space of readSpaces({ includeArchived: true })) {
    spaces.set(space.id, {
      label: space.userLabel?.trim() || space.label?.trim() || space.id,
      archetype: space.archetype,
    });
  }

  const tables: PageTables = {
    rhythm: rhythmTables(nowIso, floorIso),
    claims: activeClaims(),
    claimQuotes: firstQuotes("claim"),
    loopQuotes: firstQuotes("loop"),
    eventSources: eventSourceLabels(),
    sources: sourceNames(),
    arcs: arcsByAnchor(),
    loops: openLoopRows(),
    spaces,
    meId,
    nowMs,
  };

  // `me` is a person entity and is deliberately not on this surface: People is
  // the relationships, and a card for yourself would have no relationship, no
  // reciprocity and no direction to sort its loops into.
  const rows = listEntities({ type: "person" }).filter((row) => row.id !== meId);
  const views = rows.map((row) => personView(row, tables));

  // The chips count the whole corpus, not the filtered page — a filter that
  // rewrote its own counts would tell the user their people disappeared.
  const counts: Record<PersonTier, number> = {
    inner_circle: 0,
    active: 0,
    dormant: 0,
    archived: 0,
  };
  for (const view of views) counts[view.tier] += 1;

  const tierParam = params.get("tier");
  const tier = isPersonTier(tierParam) ? tierParam : null;
  const needle = (params.get("q") ?? "").trim().toLowerCase();
  const byId = new Map(rows.map((row) => [row.id, row]));

  const people = views
    .filter((view) => (tier === null || view.tier === tier) && matchesQuery(byId.get(view.id)!, needle))
    // Pinned first — a pin is the human saying this one matters — then the
    // ladder, then whoever was heard from most recently.
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
      const ad = a.stats.daysSinceContact ?? Number.MAX_SAFE_INTEGER;
      const bd = b.stats.daysSinceContact ?? Number.MAX_SAFE_INTEGER;
      if (ad !== bd) return ad - bd;
      return a.label.localeCompare(b.label);
    })
    .slice(0, PEOPLE_PAGE_LIMIT);

  return { counts, people };
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** The person behind an id, or null when it is not one. Follows merges. */
function readPerson(id: string): EntityRow | null {
  const row = getEntity(id);
  return row && row.type === "person" ? row : null;
}

/** Handle a people request. Returns true when this module owns the path. */
export async function handlePeopleRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path !== "/api/people" && !path.startsWith("/api/people/")) return false;

  // ---- GET /api/people?tier=&q= -------------------------------------------
  if (method === "GET" && path === "/api/people") {
    sendJson(res, 200, peoplePage(url.searchParams));
    return true;
  }

  // ---- POST /api/people/:id/pin { pinned } --------------------------------
  const pin = path.match(/^\/api\/people\/([^/]+)\/pin$/);
  if (method === "POST" && pin) {
    const id = decodeURIComponent(pin[1]!);
    const body = await readJsonBody(req);
    if (typeof body?.pinned !== "boolean") {
      sendJson(res, 400, { error: "pinned (boolean) required" });
      return true;
    }
    const row = readPerson(id);
    if (!row) {
      sendJson(res, 404, { error: "no person with that id" });
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
        reason: "people surface: pin",
      }),
    );
    return true;
  }

  // ---- POST /api/people/:id/rename { canonical } --------------------------
  const rename = path.match(/^\/api\/people\/([^/]+)\/rename$/);
  if (method === "POST" && rename) {
    const id = decodeURIComponent(rename[1]!);
    const body = await readJsonBody(req);
    const canonical = typeof body?.canonical === "string" ? body.canonical.trim() : "";
    if (canonical === "") {
      sendJson(res, 400, { error: "canonical (non-empty string) required" });
      return true;
    }
    const row = readPerson(id);
    if (!row) {
      sendJson(res, 404, { error: "no person with that id" });
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
        reason: "people surface: rename",
      }),
    );
    return true;
  }

  sendJson(res, 404, { error: "unknown people route" });
  return true;
}
