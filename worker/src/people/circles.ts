// ===========================================================================
// [CODE] Circles — V6 P1 S5.4 (Product_V6 §11.5 "Circles" + "Applicability",
// Product_V6_Phase1 §11.4, CIR-01..03, CRM-05).
//
// A circle is INFERRED from content, tone, claims and metadata. Reply volume
// is one weak signal, worth at most a tenth of a circle's weight: a quiet
// family group outranks a chatty acquaintance group, always. The inference is
// code over signals the record already holds — kin terms and care topics in
// the text, contact names ("Ma", "Papa"), relationship claims, the group's
// size and whether the user ever replied, the business tier — and every
// verdict states its reasons. The user overrides by drag (setCircle by
// 'user'); code never writes over a user's circle.
//
// Circles drive, downstream:
//   processing priority   circlePriority() — the rank the brief and nudges use
//   applicability         applicability() — "everyone submit by Friday" in a
//                         180-member never-replied group is a note at most;
//                         Ma saying it in Family is a task (CIR-03)
//   lead times            card.ts (dates), radar.ts (follow-ups)
//   ownership             decide's "whose task" reads the circle too
// ===========================================================================

import { getDb } from "../db/connection.js";
import { claimsAbout } from "../claims/store.js";
import { CIRCLES, circleOf, getEntity, listEntities, setCircle, type Circle } from "../entities/registry.js";

export interface CircleSignals {
  /** The saved contact / push name. */
  contactName?: string | null;
  /** Group label when the subject is a group stream. */
  groupLabel?: string | null;
  /** Active relationship claim texts about the person ("Riya — cousin"). */
  relationshipClaims?: string[];
  /** A sample of what they (or the group) say. */
  sampleTexts?: string[];
  isGroup?: boolean;
  memberCount?: number | null;
  /** Replies BY the user in the stream — the weak signal. */
  userReplyCount?: number;
  /** Messages by them. */
  theirMessageCount?: number;
  /** Business tier when the stream is a business (1..4), else null. */
  businessTier?: number | null;
  isBusiness?: boolean;
  /** Days observed, to read sparseness ("5 messages over 6 months" is not spam). */
  spanDays?: number | null;
}

export interface CircleInference {
  circle: Circle | null;
  confidence: number;
  reasons: string[];
  /** Which signal families fired — content · tone · claims · metadata · volume. */
  signals: string[];
}

const KIN_NAMES = /^(ma|maa|mum|mom|mummy|mother|amma|papa|dad|father|baba|pa|bhai|didi|nani|nana|dadi|dada|chacha|chachi|mama|mami|bua|mausi|masi|tau|tai)\b/i;
const KIN_WORDS =
  /\b(ma|maa|mummy|mom|papa|dad|father|mother|beta|beti|son|daughter|sister|brother|cousin|didi|nani|nana|dadi|dada|chacha|chachi|mama|mami|bua|mausi|masi|family|ghar|parents|convocation|wife|husband|shaadi)\b/i;
const CARE_TOPICS = /\b(doctor|appointment|medicine|medicines|tablet|bp|sugar|hospital|checkup|check-up|report|surgery|health|dawai|tabiyat)\b/i;
const PARTNER_WORDS = /\b(love you|jaan|babe|baby|wife|husband|girlfriend|boyfriend|partner|fiance|fiancé|fiancée|anniversary)\b/i;
const WORK_WORDS = /\b(deck|demo|sprint|standup|stand-up|client|meeting|project|manager|team|review|deadline|jira|pr|release|office|colleague|coworker|co-worker|boss)\b/i;
const SERVICE_ROLES = /\b(maid|cook|driver|plumber|electrician|carpenter|doctor|dentist|tutor|teacher|school|nurse|physio|gardener|watchman|guard|painter|mechanic|tailor|milkman|dhobi|aunty maid|helper|nanny|caretaker|society|landlord)\b/i;
const SERVICE_TOPICS = /\b(salary|coming at|aa rahi|aa raha|leave|chutti|holiday|payment due|fees|fee|appointment|invoice|bill|due on)\b/i;
const BATCHMATE_WORDS = /\b(batch|batchmate|batchmates|alumni|reunion|school friends|college|hostel|class of)\b/i;
const CLOSE_WORDS = /\b(close friend|best friend|bestie|bff|goa gang|trip|gang)\b/i;
const MEME_WORDS = /\b(meme|memes|lol|lmao|rofl|forwarded|forward|joke|jokes|good morning|gm|🙏)\b/i;

/** Relationship claim → circle, the claim half of the inference. */
export function circleFromRelationship(text: string): Circle | null {
  const t = text.toLowerCase();
  if (/\b(wife|husband|partner|girlfriend|boyfriend|fianc)/.test(t)) return "partner";
  if (/\b(mother|father|ma\b|papa|mom|dad|sister|brother|cousin|son|daughter|aunt|uncle|grand|nephew|niece|in-law|family|kid|child)/.test(t)) return "family";
  if (/\b(close friend|best friend|bestie)/.test(t)) return "close_friends";
  if (/\b(coworker|co-worker|colleague|manager|teammate|team|boss|client|works with|works at)/.test(t)) return "coworkers";
  if (/\b(doctor|maid|cook|driver|plumber|electrician|tutor|teacher|landlord|dentist|physio|nurse|caretaker|helper|vendor|service)/.test(t)) return "important_services";
  if (/\b(batchmate|classmate|alumni|school friend|college friend)/.test(t)) return "old_batchmates";
  if (/\b(acquaintance|neighbour|neighbor|society)/.test(t)) return "acquaintances";
  if (/\b(business|shop|store|company|brand|bank|insurer|airline|delivery)/.test(t)) return "businesses";
  if (/\bfriend\b/.test(t)) return "friends";
  return null;
}

/** Infer a circle from signals. Pure. Returns null when nothing fired. */
export function inferCircle(s: CircleSignals): CircleInference {
  const reasons: string[] = [];
  const signals = new Set<string>();
  const votes = new Map<Circle, number>();
  const vote = (c: Circle, w: number, why: string, sig: string): void => {
    votes.set(c, (votes.get(c) ?? 0) + w);
    reasons.push(why);
    signals.add(sig);
  };
  const texts = (s.sampleTexts ?? []).join(" \n ");
  const name = (s.contactName ?? "").trim();
  const label = (s.groupLabel ?? "").trim();

  // ---- metadata: business first, then group scale ---------------------------
  if (s.isBusiness || (s.businessTier != null && s.businessTier >= 2)) {
    vote("businesses", 1.0, `business channel${s.businessTier != null ? ` (tier ${s.businessTier})` : ""}`, "metadata");
  }
  if (s.isGroup && (s.memberCount ?? 0) >= 50 && (s.userReplyCount ?? 0) === 0) {
    vote("acquaintances", 0.7, `${s.memberCount}-member group the user never replied in`, "metadata");
  }
  if (KIN_NAMES.test(name)) vote("family", 0.9, `contact name "${name}" is a kin term`, "metadata");
  if (/^family|\bfamily\b|ghar|parivar/i.test(label)) vote("family", 0.8, `group label "${label}"`, "metadata");
  if (/\b(office|work|project|team|falcon|sprint)\b/i.test(label)) vote("coworkers", 0.7, `group label "${label}" reads as work`, "metadata");
  if (/\b(batch|alumni|school|college|reunion)\b/i.test(label)) vote("old_batchmates", 0.7, `group label "${label}"`, "metadata");
  if (/\b(society|apartments|residents|rwa|tower|block)\b/i.test(label)) vote("acquaintances", 0.7, `group label "${label}" is a residents' group`, "metadata");

  // ---- claims ---------------------------------------------------------------
  for (const claim of s.relationshipClaims ?? []) {
    const c = circleFromRelationship(claim);
    if (c) vote(c, 0.9, `relationship claim "${claim}"`, "claims");
  }

  // ---- content + tone -------------------------------------------------------
  if (texts !== "") {
    if (KIN_WORDS.test(texts)) vote("family", 0.5, "kin terms in the content", "content");
    if (CARE_TOPICS.test(texts) && (KIN_WORDS.test(texts) || KIN_NAMES.test(name))) vote("family", 0.3, "care topics with kin context", "content");
    if (PARTNER_WORDS.test(texts)) vote("partner", 0.6, "partner register in the content", "tone");
    if (WORK_WORDS.test(texts)) vote("coworkers", 0.5, "work vocabulary in the content", "content");
    if (SERVICE_ROLES.test(texts) && SERVICE_TOPICS.test(texts)) vote("important_services", 0.8, "a service role with a service topic (salary · timing · fees)", "content");
    else if (SERVICE_ROLES.test(texts)) vote("important_services", 0.4, "a service role named", "content");
    if (BATCHMATE_WORDS.test(texts)) vote("old_batchmates", 0.5, "batchmate vocabulary", "content");
    if (CLOSE_WORDS.test(texts)) vote("close_friends", 0.4, "close-friend register (trips, gang)", "tone");
    if (MEME_WORDS.test(texts) && !KIN_WORDS.test(texts)) vote("acquaintances", 0.3, "forwards and memes carry no relationship content", "content");
  }

  // ---- volume: the WEAK signal — a tenth of a vote, tie-break only ---------
  const replies = s.userReplyCount ?? 0;
  if (votes.size === 0) {
    if (s.isGroup && (s.memberCount ?? 0) >= 50) vote("acquaintances", 0.4, "large group, no relationship content", "metadata");
    else if (replies >= 20) vote("friends", 0.4, `the user replies often (${replies}) and nothing else says more`, "volume");
    else if (replies > 0) vote("friends", 0.3, `some replies (${replies}), no other signal`, "volume");
    else if ((s.theirMessageCount ?? 0) > 0) vote("acquaintances", 0.3, "one-sided traffic, no relationship content", "volume");
  } else if (replies > 0) {
    // Reply volume nudges friends-vs-acquaintances only; it never lifts a circle above family.
    const f = votes.get("friends");
    if (f !== undefined) votes.set("friends", f + Math.min(0.1, replies / 400));
    reasons.push(`reply volume ${replies} counted as a weak signal (≤ 0.1)`);
    signals.add("volume");
  }

  if (votes.size === 0) return { circle: null, confidence: 0, reasons: ["no signal"], signals: [] };
  const [circle, weight] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { circle, confidence: Math.min(0.95, Math.round(weight * 100) / 100), reasons, signals: [...signals] };
}

/**
 * CIR-02: an important-services person whose traffic carries a PERIODIC
 * payment ("salary 6000 for feb", "fees due on the 5th") is a recurrence
 * CANDIDATE — a hint the calendar lane turns into a rule, and only ever with
 * a confirm suggestion. The CRM notices the pattern; it does not schedule it.
 */
const PERIOD_WORDS = /\b(salary|fees|fee|rent|maintenance|emi|premium|subscription|monthly|every month|har mahine|per month)\b/i;
const MONTH_WORDS =
  /\b(jan|feb|march|mar|april|apr|may|june|jun|july|jul|aug|august|sept|sep|september|oct|october|nov|november|dec|december|this month|last month|is mahine)\b/i;

export interface RecurrenceHint {
  candidate: boolean;
  cadence: "monthly" | null;
  why: string;
  quotes: string[];
}

export function serviceRecurrenceHint(texts: readonly string[]): RecurrenceHint {
  const quotes = texts.filter((t) => PERIOD_WORDS.test(t));
  if (quotes.length === 0) return { candidate: false, cadence: null, why: "no periodic payment language", quotes: [] };
  const dated = quotes.filter((t) => MONTH_WORDS.test(t) || /\b\d{1,2}(st|nd|rd|th)?\b/.test(t));
  if (dated.length === 0) {
    return { candidate: false, cadence: null, why: "payment language with no period named", quotes };
  }
  return {
    candidate: true,
    cadence: "monthly",
    why: `a periodic payment named with its period (${dated.length} message(s)) — a candidate for the calendar, never a rule on its own`,
    quotes: dated,
  };
}

// ---- priority --------------------------------------------------------------

/** Base weight per circle for processing priority / brief inclusion. */
export const CIRCLE_WEIGHT: Readonly<Record<Circle, number>> = {
  partner: 1.0,
  family: 0.9,
  close_friends: 0.8,
  coworkers: 0.65,
  friends: 0.6,
  important_services: 0.55,
  old_batchmates: 0.3,
  acquaintances: 0.25,
  businesses: 0.2,
};

export const UNASSIGNED_WEIGHT = 0.35;

export interface PriorityInput {
  id: string;
  circle: Circle | null;
  /** Replies by the user (weak). */
  userReplyCount?: number;
  /** Content urgency the caller already judged (0..1) — care topic, deadline. */
  contentUrgency?: number;
}

export interface PriorityRow extends PriorityInput {
  score: number;
  explanation: string;
}

/**
 * Processing priority. Circle weight dominates; reply volume adds at most 0.1;
 * content urgency adds at most 0.2. A family group with 4 replies scores
 * 0.9 + 0.01 = 0.91; a memes group with 40 replies scores 0.25 + 0.1 = 0.35.
 */
export function circlePriority(p: PriorityInput): PriorityRow {
  const base = p.circle ? CIRCLE_WEIGHT[p.circle] : UNASSIGNED_WEIGHT;
  const volume = Math.min(0.1, (p.userReplyCount ?? 0) / 400);
  const urgency = Math.min(0.2, Math.max(0, p.contentUrgency ?? 0) * 0.2);
  const score = Math.round((base + volume + urgency) * 1000) / 1000;
  return {
    ...p,
    score,
    explanation: `circle ${p.circle ?? "unassigned"} ${base} + volume ${volume.toFixed(3)} (weak, ≤ 0.1) + urgency ${urgency.toFixed(2)}`,
  };
}

export function rankByPriority(items: readonly PriorityInput[]): PriorityRow[] {
  return items.map(circlePriority).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// ---- applicability ---------------------------------------------------------

export type Applicability = "task" | "note" | "ignore";

export interface ApplicabilityInput {
  circle: Circle | null;
  isGroup: boolean;
  memberCount?: number | null;
  /** Has the user EVER replied in this stream? */
  userReplied: boolean;
  /** The message addresses the user by name / DM / reply (structural or roster). */
  directAddress: boolean;
}

export const BROADCAST_GROUP_MIN = 50;

/**
 * Whether "everyone must do X" is the user's task. Tier, circle and
 * engagement together — the same words weigh differently by where they land.
 */
export function applicability(i: ApplicabilityInput): { verdict: Applicability; reason: string } {
  if (i.directAddress) return { verdict: "task", reason: "addressed to the user directly" };
  if (i.isGroup && (i.memberCount ?? 0) >= BROADCAST_GROUP_MIN && !i.userReplied) {
    return { verdict: "note", reason: `${i.memberCount}-member group the user never replied in — a broadcast is a note at most` };
  }
  if (i.circle === "businesses" || i.circle === "acquaintances" || i.circle === "old_batchmates") {
    return { verdict: i.userReplied ? "note" : "ignore", reason: `${i.circle} circle: low applicability` };
  }
  if (i.circle === "partner" || i.circle === "family" || i.circle === "close_friends" || i.circle === "coworkers") {
    return { verdict: "task", reason: `${i.circle} circle${i.isGroup ? " in a small group" : ""}: asks apply to the user` };
  }
  return { verdict: i.userReplied ? "task" : "note", reason: `${i.circle ?? "unassigned"} circle; ${i.userReplied ? "the user engages here" : "no engagement"}` };
}

// ---- inference over the record ---------------------------------------------

export interface InferenceReport {
  considered: number;
  assigned: { id: string; circle: Circle; confidence: number; reasons: string[] }[];
  skipped: { id: string; why: string }[];
}

function userSetCircle(entityId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM decisions WHERE target_kind IN ('entity','person') AND target_id = ? AND action IN ('set_circle','set_relationship') AND pass = 'user' LIMIT 1`)
    .get(entityId);
  return row !== undefined;
}

/** Signals for one person, read from the record. */
export function signalsForPerson(entityId: string, sampleLimit = 40): CircleSignals {
  const db = getDb();
  const e = getEntity(entityId);
  const claims = claimsAbout(entityId, "relationship").map((c) => c.text ?? "").filter((t) => t !== "");
  const sample = db
    .prepare(`SELECT text FROM events WHERE actor_entity_id = ? AND text IS NOT NULL AND text <> '' ORDER BY ts DESC LIMIT ?`)
    .all(entityId, sampleLimit) as { text: string }[];
  const their = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE actor_entity_id = ?`).get(entityId) as { n: number }).n;
  // Replies by the user in the DM stream(s) this person speaks in.
  const replies = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE actor = 'self' AND stream_id IN (SELECT DISTINCT stream_id FROM events WHERE actor_entity_id = ? AND stream_id IS NOT NULL)`,
      )
      .get(entityId) as { n: number }
  ).n;
  return {
    contactName: e?.canonical ?? null,
    relationshipClaims: claims,
    sampleTexts: sample.map((s) => s.text),
    isGroup: false,
    userReplyCount: replies,
    theirMessageCount: their,
  };
}

/**
 * Assign circles to every unassigned person the record can say something
 * about. Skips user-set circles and provisional name-only people with no
 * signal. Zero model calls; every write is a decisions row.
 */
export function inferCirclesForUnassigned(opts: { minConfidence?: number } = {}): InferenceReport {
  const floor = opts.minConfidence ?? 0.5;
  const report: InferenceReport = { considered: 0, assigned: [], skipped: [] };
  for (const e of listEntities({ type: "person" })) {
    if (circleOf(e.id) !== null) continue;
    report.considered += 1;
    if (userSetCircle(e.id)) {
      report.skipped.push({ id: e.id, why: "user-set" });
      continue;
    }
    const inf = inferCircle(signalsForPerson(e.id));
    if (!inf.circle || inf.confidence < floor) {
      report.skipped.push({ id: e.id, why: inf.circle ? `below floor (${inf.confidence})` : "no signal" });
      continue;
    }
    setCircle(e.id, inf.circle, { decidedBy: "code:circles", reason: inf.reasons.join(" · "), confidence: inf.confidence });
    report.assigned.push({ id: e.id, circle: inf.circle, confidence: inf.confidence, reasons: inf.reasons });
  }
  return report;
}

export { CIRCLES };
