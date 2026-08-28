// ===========================================================================
// [CODE] The assist trigger gate — build P2.2, spec §10.1. Pre-LLM, in code.
//
// An assist pass may initiate ONLY when both halves hold, and this module is
// the first half plus all the hygiene:
//
//   * NOVELTY: a per-topic accumulator counts distinct, deduplicated events
//     about the same thing — AX captures (content-hash-new only), browser
//     visits, chat messages — joined into one topic by the same machinery
//     understanding uses: bridges (URL/phone/order-id), entity matches, the
//     active episode/space, recency. The gate fires when the accumulator
//     crosses N distinct events (per-category threshold from Settings) of
//     which >= 2 are NEW CONTENT (not re-observations). Repeated identical
//     data (same content hash) increments NOTHING. Cross-source events count
//     double: a WhatsApp message + a browser visit about the same thing is
//     stronger evidence of a live goal than two events from one source
//     (AST-09 asserts this arithmetic in code).
//   * HYGIENE: per-context cooldown after any nudge, suppression after 2
//     dismissals in a context, quiet hours. All clock-injected — the tests
//     mock time, never sleep.
//
// The second half (intent confidence) is the evaluator's (evaluator.ts); a
// topic this gate passes is only a CANDIDATE for one cheap haiku call.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { contentHash, type EventEnvelope } from "../db/eventlog.js";
import {
  assistCooldownMinutes,
  assistSuppressDays,
  assistThreshold,
  inQuietHours,
} from "./settings.js";

// ---------------------------------------------------------------------------
// Topic state
// ---------------------------------------------------------------------------

export interface TopicState {
  topicKey: string;
  category: string | null;
  /** Cross-source-weighted distinct event count (the N the threshold gates). */
  weightedCount: number;
  /** Events that were genuinely new content (>=2 required). */
  newContentCount: number;
  /** Distinct sources, in order of first arrival. */
  sources: string[];
  /** Content hashes already counted — a re-observation increments nothing. */
  seenHashes: string[];
  /** URLs / doc keys already counted — a re-visit counts but is not new content. */
  seenRefs: string[];
  /** The counted event ids, oldest first (the evaluator's tail). */
  eventIds: string[];
  lastEventTs: string | null;
  cooldownUntil: string | null;
  dismissCount: number;
  suppressedUntil: string | null;
}

function parseArr(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function readTopic(topicKey: string): TopicState | null {
  const r = getDb()
    .prepare(`SELECT * FROM assist_topics WHERE topic_key = ?`)
    .get(topicKey) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    topicKey: String(r.topic_key),
    category: (r.category as string | null) ?? null,
    weightedCount: Number(r.weighted_count ?? 0),
    newContentCount: Number(r.new_content_count ?? 0),
    sources: parseArr(r.sources_json as string),
    seenHashes: parseArr(r.seen_hashes_json as string),
    seenRefs: parseArr(r.seen_refs_json as string),
    eventIds: parseArr(r.event_ids_json as string),
    lastEventTs: (r.last_event_ts as string | null) ?? null,
    cooldownUntil: (r.cooldown_until as string | null) ?? null,
    dismissCount: Number(r.dismiss_count ?? 0),
    suppressedUntil: (r.suppressed_until as string | null) ?? null,
  };
}

function writeTopic(t: TopicState, nowIso: string): void {
  getDb()
    .prepare(
      `INSERT INTO assist_topics
         (topic_key, category, weighted_count, new_content_count, sources_json,
          seen_hashes_json, seen_refs_json, event_ids_json, last_event_ts,
          cooldown_until, dismiss_count, suppressed_until, updated_at)
       VALUES (@topic_key, @category, @weighted_count, @new_content_count, @sources_json,
               @seen_hashes_json, @seen_refs_json, @event_ids_json, @last_event_ts,
               @cooldown_until, @dismiss_count, @suppressed_until, @updated_at)
       ON CONFLICT(topic_key) DO UPDATE SET
         category = excluded.category,
         weighted_count = excluded.weighted_count,
         new_content_count = excluded.new_content_count,
         sources_json = excluded.sources_json,
         seen_hashes_json = excluded.seen_hashes_json,
         seen_refs_json = excluded.seen_refs_json,
         event_ids_json = excluded.event_ids_json,
         last_event_ts = excluded.last_event_ts,
         cooldown_until = excluded.cooldown_until,
         dismiss_count = excluded.dismiss_count,
         suppressed_until = excluded.suppressed_until,
         updated_at = excluded.updated_at`,
    )
    .run({
      topic_key: t.topicKey,
      category: t.category,
      weighted_count: t.weightedCount,
      new_content_count: t.newContentCount,
      sources_json: JSON.stringify(t.sources),
      seen_hashes_json: JSON.stringify(t.seenHashes.slice(-200)),
      seen_refs_json: JSON.stringify(t.seenRefs.slice(-200)),
      event_ids_json: JSON.stringify(t.eventIds.slice(-40)),
      last_event_ts: t.lastEventTs,
      cooldown_until: t.cooldownUntil,
      dismiss_count: t.dismissCount,
      suppressed_until: t.suppressedUntil,
      updated_at: nowIso,
    });
}

function freshTopic(topicKey: string, category: string | null): TopicState {
  return {
    topicKey,
    category,
    weightedCount: 0,
    newContentCount: 0,
    sources: [],
    seenHashes: [],
    seenRefs: [],
    eventIds: [],
    lastEventTs: null,
    cooldownUntil: null,
    dismissCount: 0,
    suppressedUntil: null,
  };
}

// ---------------------------------------------------------------------------
// Topic resolution — the same joining machinery understanding uses (§10.1):
// bridges first, then episode/space membership, then a stream fallback.
// ---------------------------------------------------------------------------

/**
 * Resolve the topic an event belongs to. Ladder (strongest join first):
 *   1. a bridge literal the event carries that a SPACE also holds -> space:<id>
 *   2. episode membership whose episode is filed to a space       -> space:<id>
 *   3. any bridge literal (url/phone/order id) the event carries  -> bridge:<kind>:<value>
 *   4. the stream itself (recency join)                           -> stream:<key>
 */
export function topicKeyFor(env: EventEnvelope): string {
  const db = getDb();
  const keys = db
    .prepare(`SELECT kind, value_norm FROM event_bridge_keys WHERE event_id = ?`)
    .all(env.id) as { kind: string; value_norm: string }[];

  for (const k of keys) {
    const hit = db
      .prepare(
        `SELECT space_id FROM space_bridge_keys WHERE kind = ? AND value_norm = ? LIMIT 1`,
      )
      .get(k.kind, k.value_norm) as { space_id: string } | undefined;
    if (hit) return `space:${hit.space_id}`;
  }

  // episode_events stores message RANGES (start/end rowid); membership =
  // the event's rowid falling inside a range of an episode filed to a space.
  const ep = db
    .prepare(
      `SELECT e.space_id FROM episode_events ee
         JOIN episodes e ON e.id = ee.episode_id
         JOIN events ev ON ev.id = ?
        WHERE e.space_id IS NOT NULL
          AND (ee.start_event_id = ev.id OR ee.end_event_id = ev.id
               OR (ee.start_rowid IS NOT NULL AND ee.end_rowid IS NOT NULL
                   AND ev.rowid BETWEEN ee.start_rowid AND ee.end_rowid))
        LIMIT 1`,
    )
    .get(env.id) as { space_id: string } | undefined;
  if (ep) return `space:${ep.space_id}`;

  if (keys.length > 0) {
    // Deterministic: pick the lexicographically-first literal.
    const k = [...keys].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.value_norm.localeCompare(b.value_norm),
    )[0]!;
    return `bridge:${k.kind}:${k.value_norm}`;
  }

  return `stream:${env.streamKey}`;
}

/** Category for a topic (drives the per-category threshold). */
export function topicCategory(env: EventEnvelope): string {
  const text =
    (typeof env.payload.text === "string" ? env.payload.text : "") +
    " " +
    (typeof env.payload.url === "string" ? env.payload.url : "");
  if (/\b(order|cart|checkout|invoice|payment|paid|booking|receipt|refund)\b/i.test(text)) {
    return "transaction";
  }
  if (/\b(paper|research|docs?|documentation|article|study|tutorial|arxiv)\b/i.test(text)) {
    return "research";
  }
  return "default";
}

// ---------------------------------------------------------------------------
// The accumulator
// ---------------------------------------------------------------------------

export interface RecordOutcome {
  topicKey: string;
  /** Whether this event incremented anything at all. */
  counted: boolean;
  /** Whether it counted as NEW CONTENT (vs a re-visit of a known ref). */
  newContent: boolean;
  /** The weight it added (2 when cross-source, else 1). */
  weight: number;
  state: TopicState;
}

/** Stable ref for "same thing observed again": url, doc key, else nothing. */
function contentRef(env: EventEnvelope): string | null {
  if (typeof env.payload.url === "string" && env.payload.url !== "") return env.payload.url;
  if (typeof env.payload.doc_key === "string" && env.payload.doc_key !== "") {
    return String(env.payload.doc_key);
  }
  return null;
}

/**
 * Feed one event into its topic's accumulator (spec §10.1 arithmetic):
 *   - identical content hash already counted -> increments NOTHING;
 *   - a new event from a source the topic has not seen before (once a first
 *     source exists) counts DOUBLE — cross-source evidence;
 *   - a re-visit of a known url/doc key counts as a distinct event but NOT
 *     as new content; genuinely new content bumps both.
 */
export function recordEvent(env: EventEnvelope, opts: { nowMs?: number } = {}): RecordOutcome {
  const eventId = env.id;
  if (!eventId) throw new Error("recordEvent requires a persisted event (missing id)");
  const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();
  const topicKey = topicKeyFor(env);
  const state = readTopic(topicKey) ?? freshTopic(topicKey, topicCategory(env));
  if (state.category == null || state.category === "default") {
    // A later, more specific signal may upgrade the category.
    const cat = topicCategory(env);
    if (cat !== "default") state.category = cat;
    else state.category = state.category ?? "default";
  }

  // The append path computes the hash when the caller didn't; mirror it so
  // "same content observed again" dedups identically here.
  const hash = env.contentHash ?? contentHash(env);
  if (state.seenHashes.includes(hash)) {
    // Re-observation: same page re-captured, same message re-read. Nothing.
    writeTopic(state, nowIso);
    return { topicKey, counted: false, newContent: false, weight: 0, state };
  }

  const source = env.source || "unknown";
  const crossSource = state.sources.length > 0 && !state.sources.includes(source);
  const weight = crossSource ? 2 : 1;

  const ref = contentRef(env);
  const isNewContent = ref == null ? true : !state.seenRefs.includes(ref);

  state.weightedCount += weight;
  if (isNewContent) state.newContentCount += 1;
  if (!state.sources.includes(source)) state.sources.push(source);
  state.seenHashes.push(hash);
  if (ref && !state.seenRefs.includes(ref)) state.seenRefs.push(ref);
  state.eventIds.push(eventId);
  state.lastEventTs = env.ts || nowIso;
  writeTopic(state, nowIso);
  return { topicKey, counted: true, newContent: isNewContent, weight, state };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface GateVerdict {
  ready: boolean;
  reason:
    | "ready"
    | "below_threshold"
    | "insufficient_new_content"
    | "cooldown"
    | "suppressed"
    | "quiet_hours";
}

/** Does this topic clear the code gate right now? Pure read; clock-injected. */
export function gateVerdict(state: TopicState, opts: { nowMs?: number } = {}): GateVerdict {
  const nowMs = opts.nowMs ?? Date.now();

  if (state.suppressedUntil && Date.parse(state.suppressedUntil) > nowMs) {
    return { ready: false, reason: "suppressed" };
  }
  if (state.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs) {
    return { ready: false, reason: "cooldown" };
  }
  if (inQuietHours(nowMs)) {
    return { ready: false, reason: "quiet_hours" };
  }
  const threshold = assistThreshold(state.category);
  if (state.weightedCount < threshold) {
    return { ready: false, reason: "below_threshold" };
  }
  if (state.newContentCount < 2) {
    return { ready: false, reason: "insufficient_new_content" };
  }
  return { ready: true, reason: "ready" };
}

/** After a nudge fires for a topic: start the per-context cooldown + reset. */
export function noteNudged(topicKey: string, opts: { nowMs?: number } = {}): void {
  const nowMs = opts.nowMs ?? Date.now();
  const state = readTopic(topicKey);
  if (!state) return;
  state.cooldownUntil = new Date(nowMs + assistCooldownMinutes() * 60_000).toISOString();
  // The accumulator restarts: the evidence that earned this nudge is spent.
  state.weightedCount = 0;
  state.newContentCount = 0;
  state.eventIds = [];
  writeTopic(state, new Date(nowMs).toISOString());
}

/**
 * A dismissal in this context. Two dismissals -> per-context suppression
 * (spec §10.1 / §14.7.7) for `assist.suppress_days`.
 */
export function noteDismissed(topicKey: string, opts: { nowMs?: number } = {}): void {
  const nowMs = opts.nowMs ?? Date.now();
  const state = readTopic(topicKey) ?? freshTopic(topicKey, null);
  state.dismissCount += 1;
  if (state.dismissCount >= 2) {
    state.suppressedUntil = new Date(
      nowMs + assistSuppressDays() * 24 * 60 * 60_000,
    ).toISOString();
  }
  writeTopic(state, new Date(nowMs).toISOString());
}

/** Explicit positive signal (re-open): lift suppression, clear the strikes. */
export function noteReopened(topicKey: string, opts: { nowMs?: number } = {}): void {
  const state = readTopic(topicKey);
  if (!state) return;
  state.dismissCount = 0;
  state.suppressedUntil = null;
  writeTopic(state, new Date(opts.nowMs ?? Date.now()).toISOString());
}

/** Topics currently clearing the gate (the watcher's candidate list). */
export function readyTopics(opts: { nowMs?: number } = {}): TopicState[] {
  const rows = getDb().prepare(`SELECT topic_key FROM assist_topics`).all() as {
    topic_key: string;
  }[];
  const out: TopicState[] = [];
  for (const r of rows) {
    const state = readTopic(r.topic_key);
    if (state && gateVerdict(state, opts).ready) out.push(state);
  }
  return out;
}
