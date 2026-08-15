// ===========================================================================
// Deterministic retrieval — tier 1 of docs/v6-spec.md §1.
//
// The measured failure was structural, not statistical. ONE flat
// `SELECT … ORDER BY rank LIMIT 8` was the whole of retrieval, so the answer to
// "Do i have anything planned on sunday" — a Swiggy booking eight messages
// further down the SAME chat, in a chat that is 18 messages long in total —
// could not be reached from the question no matter how the ranking was tuned.
// It shares no token with it.
//
// What is here, in the order it runs:
//
//   1. plan the query: stopwords out, dates in (query.ts);
//   1a. resolve the NAMES in it to chats (v7 §6): retrieval had no concept of
//       "who", so "how is pranjali's health" degraded to a topic search for
//       `health`. A name selects the conversation instead of competing as a
//       bm25 token nothing indexes;
//   2. rank with bm25 COLUMN WEIGHTS, blending recency and a date hit;
//   3. take a handful of SEEDS — a scraped page is never one — and expand
//      around each one —
//        - the whole chat when the whole chat fits the budget (the repro chat
//          is 1085 chars; the context block it defeated already cost more),
//        - otherwise the window around the seed: +/-8 messages OR +/-45
//          minutes, whichever reaches further, because +/-8 spans five minutes
//          in a chat that talks and three weeks in one that does not,
//        - plus the quoted-reply thread in both directions;
//   4. hand the sections to format.ts, which spends the char budget — per
//      SECTION, so a chat nobody asked about cannot outbid the one they did.
//
// The semantic tier does not live here: it arrives as extra SEEDS through
// `semanticSeeds`, so this module stays synchronous and works identically with
// the embedding index absent (which is its default state).
// ===========================================================================

import {
  DEFAULT_WHOLE_CHANNEL_MAX_CHARS,
  DEFAULT_WINDOW,
  DEFAULT_WINDOW_MINUTES,
  readChannelWindow,
  readEventsByIds,
  readReplyChain,
  readWholeChannel,
  resolveChannelsByName,
  searchEventsRanked,
  type ChannelNameMatch,
  type ContextEventRow,
  type EventsFtsColumn,
  type FtsColumnWeights,
  type RankedEventHit,
} from "../db/retrieval.js";
import { tsWithinRange } from "./dates.js";
import { focusSearch, DEFAULT_FOCUS_LIMIT } from "./focus.js";
import { planQuery, type QueryPlan } from "./query.js";

// ---- Tunables -------------------------------------------------------------

/**
 * Candidates pulled from FTS before blending. The old `LIMIT 8` was applied to
 * a bm25 ordering that could not see recency or dates, so the booking (rank 25)
 * was cut before anything had a chance to reconsider it.
 */
export const DEFAULT_LEXICAL_LIMIT = 40;

/** Seeds expanded around. More than this and the block is all context, no signal. */
export const DEFAULT_SEED_LIMIT = 6;

/** Weight of the blended terms. Lexical rank is the unit everything else is in. */
export const LEXICAL_WEIGHT = 1;
export const SEMANTIC_WEIGHT = 0.8;
/**
 * Recency is a TERM, not an ordering: "what did we decide" almost always means
 * the most recent time it was decided, but a strong old match still wins over a
 * weak new one.
 */
export const RECENCY_WEIGHT = 0.35;
/** Half-weight at this age. Chats move on in weeks, not years. */
export const RECENCY_HALF_LIFE_DAYS = 30;
/**
 * An event that HAPPENED on the day the question is about. Deliberately below
 * a full lexical rank: the booking for Sunday was sent on the Tuesday before.
 */
export const DATE_WEIGHT = 0.5;

/**
 * Chats a question's names may select at once (v7 §6, lever 1). A question
 * naming three people is asking about three people; one naming eight has
 * matched something that is not a name.
 */
export const MAX_NAMED_CHANNELS = 4;

/**
 * Lexical strength, relative to the best hit in the same set, below which a row
 * may not be a SEED (v7 §6, lever 4). Measured: several seeds of the health
 * query were scraped YouTube pages scoring 0.02–0.15, alive only on recency
 * weight — each of them then bought a window of a chat nobody asked about.
 * A weak row is still returned and still readable; it just does not get to
 * decide what the block is about.
 */
export const MIN_SEED_LEXICAL = 0.2;

/**
 * Seeds the within-chat pass (focus.ts) may contribute, on top of the
 * corpus-wide ones. Its own allowance rather than a share of DEFAULT_SEED_LIMIT
 * because the two are not competing for the same thing: the corpus-wide seeds
 * decide WHICH chats the block is about, and these decide which parts of the
 * chat the question already named. Six covers the measured illness thread —
 * three days, five distinct clusters — with one spare.
 */
export const DEFAULT_FOCUS_SEED_LIMIT = 6;

// ---- Result shapes --------------------------------------------------------

/** Why an event is in the context block. */
export type ContextRole = "hit" | "window" | "reply" | "channel";

export interface ContextEvent extends ContextEventRow {
  role: ContextRole;
  /** Blended score, on hits only. */
  score: number | null;
  /** Cut from the column that actually matched; null on non-hits. */
  snippet: string | null;
  matchedColumn: EventsFtsColumn | null;
  /** Messages between this one and the nearest hit in its section. */
  distanceToHit: number;
  /**
   * Minutes to the nearest hit, which is not always the same hit: the window
   * is "N messages OR M minutes", so how far out a line is has to be asked in
   * both units. Null when nothing in the section is datable.
   */
  minutesToHit: number | null;
}

export interface ContextSection {
  channelId: string | null;
  channelName: string | null;
  /** The whole chat is here, not a window around a hit. */
  whole: boolean;
  /** Non-reaction events the chat holds in total. */
  channelEventCount: number;
  channelCharCount: number;
  events: ContextEvent[];
  /** Best blended score of any hit in the section — the section's rank. */
  score: number;
}

export interface SemanticSeed {
  eventId: string;
  /** Cosine similarity, already normalised to 0..1 by the semantic tier. */
  similarity: number;
}

export interface RetrievalResult {
  plan: QueryPlan;
  sections: ContextSection[];
  /** Every ranked hit considered, best blended first (diagnostics). */
  ranked: ScoredHit[];
  /** Seeds that came from the embedding index rather than from FTS. */
  semanticSeedIds: string[];
  /** Chats a name in the question pointed at, best first. */
  namedChannels: ChannelNameMatch[];
  /** What the within-chat pass ran, and what it found (diagnostics). */
  focus: {
    channelIds: string[];
    match: string;
    expanded: string[];
    hitIds: string[];
  };
}

export interface ScoredHit {
  hit: RankedEventHit;
  /** bm25 strength, 1 for the best hit in the set. */
  lexical: number;
  semantic: number;
  recency: number;
  onDate: boolean;
  score: number;
}

export interface RetrieveOptions {
  query: string;
  /** The instant the question was asked; its LOCAL date resolves "sunday". */
  now?: Date;
  lexicalLimit?: number;
  seedLimit?: number;
  window?: number;
  /** Minutes either side of a seed, ORed with `window` (default 45). */
  windowMinutes?: number;
  /** Chars a chat may cost before it is windowed instead of included whole. */
  wholeChannelMaxChars?: number;
  weights?: FtsColumnWeights;
  /** How much better a row scores for sitting in a chat the question named. */
  channelBoost?: number;
  /** Turn name resolution off — for measuring what it is worth. */
  resolveNames?: boolean;
  /** Extra seeds from the embedding index (tier 3). */
  semanticSeeds?: readonly SemanticSeed[];
  /** Rows the within-chat pass reads per named chat. */
  focusLimit?: number;
  /** Seeds it may contribute. 0 turns the pass off — for measuring it. */
  focusSeedLimit?: number;
}

// ---------------------------------------------------------------------------

/**
 * Rank, blend, seed and expand. Synchronous by design: SQLite is, and the tier
 * that is not (embeddings) hands its results in rather than being awaited here.
 */
export function retrieveContext(opts: RetrieveOptions): RetrievalResult {
  const now = opts.now ?? new Date();
  const plan = planQuery(opts.query, now);
  const namedChannels = opts.resolveNames === false ? [] : resolveNames(plan);
  const boosted = boostedChannelIds(namedChannels);
  const focusSeedLimit = clamp(opts.focusSeedLimit, DEFAULT_FOCUS_SEED_LIMIT, 32);
  // The pass is what a NAME buys: with no chat selected there is no pool to be
  // narrow, and the expansion would be a corpus-wide recall grab.
  const focused =
    boosted.length > 0 && focusSeedLimit > 0
      ? focusSearch({
          channelIds: boosted,
          plan,
          limit: opts.focusLimit ?? DEFAULT_FOCUS_LIMIT,
          weights: opts.weights,
        })
      : { hits: [], match: "", expanded: [] };

  const empty: RetrievalResult = {
    plan,
    sections: [],
    ranked: [],
    semanticSeedIds: [],
    namedChannels,
    focus: {
      channelIds: boosted,
      match: focused.match,
      expanded: focused.expanded,
      hitIds: focused.hits.map((h) => h.id),
    },
  };
  if (plan.match.length === 0 && (opts.semanticSeeds?.length ?? 0) === 0) {
    return empty;
  }

  // A MATCH expression FTS5 cannot parse must never break a chat turn: the
  // question still gets answered, just without retrieval.
  let hits: RankedEventHit[] = [];
  if (plan.match.length > 0) {
    try {
      hits = searchEventsRanked({
        match: plan.match,
        limit: opts.lexicalLimit ?? DEFAULT_LEXICAL_LIMIT,
        weights: opts.weights,
        boostChannelIds: boosted,
        channelBoost: opts.channelBoost,
      });
    } catch {
      hits = [];
    }
  }

  const semanticSeeds = opts.semanticSeeds ?? [];
  const semanticById = new Map(semanticSeeds.map((s) => [s.eventId, s.similarity]));
  const known = new Set([...hits, ...focused.hits].map((h) => h.id));
  // Semantic-only ids are hydrated into the same row shape so a hit found by
  // meaning is indistinguishable from one found by word downstream.
  const semanticOnly = readEventsByIds(
    semanticSeeds.map((s) => s.eventId).filter((id) => !known.has(id)),
  );

  const ranked = blend(hits, focused.hits, semanticOnly, semanticById, plan, now);
  // A question whose ONLY evidence is a scraped page is a question about that
  // page, so the filter falls back rather than answering nothing.
  const worthy = ranked.filter(seedWorthy);
  const marks = worthy.length > 0 ? worthy : ranked;

  // Two seed passes over two pools, each ordered by its own scale. The
  // corpus-wide one decides which chats the block is about; the within-chat one
  // decides which parts of the chat the question already named, and gets its own
  // allowance so a broadcast that says "health" three times cannot spend it.
  const focusIds = new Set(focused.hits.map((h) => h.id));
  const corpusIds = new Set([
    ...hits.map((h) => h.id),
    ...semanticSeeds.map((s) => s.eventId),
  ]);
  const seeds = pickSeeds(
    marks.filter((m) => corpusIds.has(m.hit.id)),
    opts,
  );
  const focusSeeds = pickSeeds(
    marks.filter((m) => focusIds.has(m.hit.id)),
    { ...opts, seedLimit: focusSeedLimit },
    seeds,
  );
  const allSeeds = [...seeds, ...focusSeeds];
  if (allSeeds.length === 0) return { ...empty, ranked };

  return {
    ...empty,
    ranked,
    semanticSeedIds: semanticSeeds.map((s) => s.eventId),
    sections: expand(allSeeds, marks, boosted, opts),
  };
}

/**
 * The hits worth expanding AROUND, which is not the same as the best hits.
 * Two hits an hour apart in one chat are one seed: the window around either
 * already carries the other. The measured health query spent five of its six
 * seeds on a single 27-minute cluster and cut the one seed that was somewhere
 * else — the day the cold started.
 *
 * Everything dropped here is still a hit, still ranked and still MARKED as a
 * hit if the expansion reaches it (see `expand`). It just does not buy a second
 * copy of a window it is already inside.
 */
function pickSeeds(
  ranked: readonly ScoredHit[],
  opts: RetrieveOptions,
  already: readonly ScoredHit[] = [],
): ScoredHit[] {
  const limit = clamp(opts.seedLimit, DEFAULT_SEED_LIMIT, 32);
  const spreadMs =
    clamp(opts.windowMinutes, DEFAULT_WINDOW_MINUTES, 24 * 60) * 60_000;
  const covered = [...already];
  const out: ScoredHit[] = [];
  for (const candidate of ranked) {
    if (out.length >= limit) break;
    if (covered.some((seed) => alreadyCovered(seed, candidate, spreadMs))) continue;
    covered.push(candidate);
    out.push(candidate);
  }
  return out;
}

function alreadyCovered(seed: ScoredHit, candidate: ScoredHit, spreadMs: number): boolean {
  if (!seed.hit.channelId || seed.hit.channelId !== candidate.hit.channelId) return false;
  const a = Date.parse(seed.hit.ts ?? "");
  const b = Date.parse(candidate.hit.ts ?? "");
  // Undatable rows cover nothing: there is no way to know what a window round
  // one of them would reach.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= spreadMs;
}

// ---- Names ----------------------------------------------------------------

/**
 * The chats the question named. Never throws into a turn: a database that
 * predates the lookup, or a token that resolves to nothing, is "no name in this
 * question" and the search runs unboosted.
 */
function resolveNames(plan: QueryPlan): ChannelNameMatch[] {
  try {
    return resolveChannelsByName(plan.names);
  } catch {
    return [];
  }
}

/**
 * Which resolutions actually SELECT a chat, rather than merely sharing a word
 * with one. A name in a question ADDRESSES somebody, so it is the whole name or
 * the front of it: "pranjali" addresses Pranjali Sharma. A word from the middle
 * of a title does not — the measured health query resolves `health` to a
 * marketing broadcast called "Orange Health Updates", and boosting that is the
 * failure this lever exists to fix rather than a smaller version of it.
 *
 * The cost is a surname on its own ("how is sharma doing"), which stays an
 * ordinary word search. That is the right way round: missing a boost costs
 * ranking, and boosting the wrong chat costs the answer.
 */
/**
 * The chats one question SELECTS, resolved from scratch. The async entry point
 * needs them before `retrieveContext` runs — the within-chat semantic pool is
 * decided by the name, and a seed cannot be bolted on after the expansion that
 * was supposed to be built around it. Two small indexed lookups, so resolving
 * twice costs less than threading the result back out.
 */
export function namedChannelIds(query: string, now: Date): string[] {
  return boostedChannelIds(resolveNames(planQuery(query, now)));
}

function boostedChannelIds(named: readonly ChannelNameMatch[]): string[] {
  const ids: string[] = [];
  for (const match of named) {
    const name = match.via === "actor" ? match.actorName : match.channelName;
    if (!match.exact && firstWord(name) !== match.token) continue;
    if (!ids.includes(match.channelId)) ids.push(match.channelId);
    if (ids.length >= MAX_NAMED_CHANNELS) break;
  }
  return ids;
}

/** Lowercased, as `resolveChannelsByName` normalises the token it matched. */
function firstWord(name: string | null): string {
  const [first] = (name ?? "").trim().toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return first;
}

/**
 * Whether a hit may be expanded around. Meaning and dates speak for themselves;
 * a word match has to be a real one. `link_scraped_text` is excluded outright
 * even when it is strong, because a page nobody in the chat wrote or read
 * cannot be the reason a conversation is worth reading.
 */
function seedWorthy(scored: ScoredHit): boolean {
  if (scored.semantic > 0 || scored.onDate) return true;
  if (scored.hit.matchedColumn === "link_scraped_text") return false;
  return scored.lexical >= MIN_SEED_LEXICAL;
}

// ---- Blending -------------------------------------------------------------

function blend(
  hits: readonly RankedEventHit[],
  focusHits: readonly RankedEventHit[],
  semanticOnly: readonly ContextEventRow[],
  semanticById: ReadonlyMap<string, number>,
  plan: QueryPlan,
  now: Date,
): ScoredHit[] {
  // bm25 is negative-better and unbounded, so it is normalised against the best
  // hit in THIS result set — the absolute value means nothing on its own. The
  // within-chat rows are normalised against the best of THEIRS: a different
  // query over a different pool, and putting the two raw numbers on one scale
  // is the same category error as gating a chat against the corpus mean. A row
  // both passes found keeps its CORPUS number, so nothing the within-chat pass
  // does can reorder the search that decides which chats the block is about.
  const lexicalById = new Map<string, number>();
  for (const group of [focusHits, hits]) {
    const best = group.reduce((acc, h) => Math.min(acc, h.score), 0);
    const scale = best < 0 ? Math.abs(best) : 1;
    for (const hit of group) {
      lexicalById.set(hit.id, hit.score < 0 ? Math.abs(hit.score) / scale : 0);
    }
  }

  const byId = new Map<string, RankedEventHit>();
  for (const hit of [...hits, ...focusHits]) if (!byId.has(hit.id)) byId.set(hit.id, hit);
  const rows: RankedEventHit[] = [
    ...byId.values(),
    ...semanticOnly.map((row) => ({
      ...row,
      score: 0,
      matchedColumn: "text" as EventsFtsColumn,
      matchedColumnIndex: 0,
      snippet: firstText(row),
    })),
  ];

  const scored = rows.map((hit) => {
    const lexical = lexicalById.get(hit.id) ?? 0;
    const semantic = semanticById.get(hit.id) ?? 0;
    const recency = recencyScore(hit.ts, now);
    const onDate = plan.dates.ranges.some((r) => tsWithinRange(hit.ts, r));
    return {
      hit,
      lexical,
      semantic,
      recency,
      onDate,
      score:
        LEXICAL_WEIGHT * lexical +
        SEMANTIC_WEIGHT * semantic +
        RECENCY_WEIGHT * recency +
        (onDate ? DATE_WEIGHT : 0),
    };
  });

  return scored.sort((a, b) => b.score - a.score || compareByTime(b.hit, a.hit));
}

/** 1 for something said now, halving every RECENCY_HALF_LIFE_DAYS. */
function recencyScore(ts: string | null, now: Date): number {
  if (!ts) return 0;
  const at = new Date(ts).getTime();
  if (Number.isNaN(at)) return 0;
  const ageDays = Math.max(0, (now.getTime() - at) / 86_400_000);
  return 1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** Something to show for a semantic-only hit, which matched no column. */
function firstText(row: ContextEventRow): string {
  const candidates = [row.text, row.transcript, row.mediaDescription, row.linkTitle];
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c.trim();
  }
  return "";
}

// ---- Expansion ------------------------------------------------------------

function expand(
  seeds: readonly ScoredHit[],
  marks: readonly ScoredHit[],
  boosted: readonly string[],
  opts: RetrieveOptions,
): ContextSection[] {
  const windowSize = clamp(opts.window, DEFAULT_WINDOW, 200);
  const wholeMax = clamp(
    opts.wholeChannelMaxChars,
    DEFAULT_WHOLE_CHANNEL_MAX_CHARS,
    200_000,
  );

  // Sections keyed by channel, in seed order — the first seed to name a channel
  // is the best-scoring one, so the sections come out ranked.
  const order: string[] = [];
  const byChannel = new Map<string, ScoredHit[]>();
  for (const seed of seeds) {
    const key = seed.hit.channelId ?? "";
    if (!byChannel.has(key)) {
      byChannel.set(key, []);
      order.push(key);
    }
    byChannel.get(key)!.push(seed);
  }

  const byId = new Map(marks.map((m) => [m.hit.id, m]));

  const sections: ContextSection[] = [];
  for (const key of order) {
    const channelSeeds = byChannel.get(key)!;
    const rows = new Map<string, ContextEvent>();

    let whole = false;
    let channelEventCount = 0;
    let channelCharCount = 0;

    if (key !== "") {
      const chat = readWholeChannel({ channelId: key, maxChars: wholeMax });
      channelEventCount = chat.eventCount;
      channelCharCount = chat.charCount;
      if (chat.withinBudget) {
        whole = true;
        for (const row of chat.events) add(rows, row, "channel");
      }
    }

    if (!whole) {
      for (const seed of channelSeeds) {
        for (const row of readChannelWindow({
          eventId: seed.hit.id,
          before: windowSize,
          after: windowSize,
          beforeMinutes: opts.windowMinutes,
          afterMinutes: opts.windowMinutes,
        })) {
          add(rows, row, "window");
        }
      }
    }

    // The reply chain runs whether or not the window covered it: a reply can be
    // days later, which is exactly the case in the repro chat.
    for (const seed of channelSeeds) {
      for (const row of readReplyChain({ eventId: seed.hit.id })) {
        add(rows, row, "reply");
      }
    }

    // Hits last, so they overwrite whatever role they arrived under and keep
    // their snippet and score. EVERY hit the expansion reached is marked, not
    // only the ones that were expanded around: a hit that lost its seed to a
    // neighbour is still the row that matched, and a line that answers the
    // question should not read as small talk because of what else was nearby.
    const hitIds = new Set<string>();
    for (const id of [...rows.keys()]) {
      const mark = byId.get(id);
      if (!mark) continue;
      hitIds.add(id);
      rows.set(id, {
        ...(mark.hit as ContextEventRow),
        role: "hit",
        score: mark.score,
        snippet: mark.hit.snippet,
        matchedColumn: mark.hit.matchedColumn,
        distanceToHit: 0,
        minutesToHit: 0,
      });
    }

    const events = [...rows.values()].sort(compareByTime);
    annotateProximity(events, hitIds);
    sections.push({
      channelId: key === "" ? null : key,
      channelName: events.find((e) => e.channelName)?.channelName ?? null,
      whole,
      channelEventCount,
      channelCharCount,
      events,
      score: channelSeeds[0].score,
    });
  }

  // The chat the question NAMED goes first whatever found the rows in it. The
  // blend cannot express that on its own: a marketing broadcast that says
  // "health" three times, sent this morning, outscores the line about the
  // person the question is about — and the section order is what the char
  // budget is divided by.
  return sections.sort(
    (a, b) =>
      namedRank(a.channelId, boosted) - namedRank(b.channelId, boosted) ||
      b.score - a.score,
  );
}

function namedRank(channelId: string | null, boosted: readonly string[]): number {
  const at = channelId === null ? -1 : boosted.indexOf(channelId);
  return at === -1 ? boosted.length : at;
}

function add(
  rows: Map<string, ContextEvent>,
  row: ContextEventRow,
  role: ContextRole,
): void {
  if (rows.has(row.id)) return;
  rows.set(row.id, {
    ...row,
    role,
    score: null,
    snippet: null,
    matchedColumn: null,
    distanceToHit: 0,
    minutesToHit: null,
  });
}

/**
 * How far each event sits from the nearest hit, in BOTH of the window's units.
 * This is what the budget spends last: the neighbour beside a hit explains it,
 * and the far edge is why the window has one.
 *
 * The nearest hit by message count and the nearest by clock are not always the
 * same row, and each is recorded against its own — a line 46 messages but 27
 * minutes from the answer is in the same conversation, and a line 8 messages
 * but three weeks away is not.
 */
function annotateProximity(events: ContextEvent[], hitIds: ReadonlySet<string>): void {
  const hitIndexes = events.flatMap((e, i) => (hitIds.has(e.id) ? [i] : []));
  if (hitIndexes.length === 0) return;
  const at = events.map((e) => Date.parse(e.ts ?? ""));
  events.forEach((event, i) => {
    let best = Number.MAX_SAFE_INTEGER;
    let bestMinutes: number | null = null;
    for (const h of hitIndexes) {
      best = Math.min(best, Math.abs(h - i));
      if (!Number.isFinite(at[i]) || !Number.isFinite(at[h])) continue;
      const minutes = Math.abs(at[i] - at[h]) / 60_000;
      bestMinutes = bestMinutes === null ? minutes : Math.min(bestMinutes, minutes);
    }
    event.distanceToHit = best;
    event.minutesToHit = bestMinutes;
  });
}

function compareByTime(a: ContextEventRow, b: ContextEventRow): number {
  const at = a.ts ?? "";
  const bt = b.ts ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function clamp(raw: number | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}
