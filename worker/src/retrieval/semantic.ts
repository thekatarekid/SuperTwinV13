// Semantic retrieval — tier 3 of docs/v6-spec.md §1.
//
// "Restaurant booking to kar denge nahi?" and "did we book a restaurant" share
// no token and no stem. Lexical retrieval cannot connect them at all; a
// multilingual encoder can, which is the argument for this tier.
//
// Two halves:
//   - INDEX. claimUnembeddedEvents() returns only what has no vector for the
//     ACTIVE (model, dim), so a pass costs the messages that arrived since the
//     last one, a model change re-indexes itself in the background instead of
//     demanding a rebuild, and a transcript landing minutes after ingestion
//     re-embeds because ingest drops the stale vector.
//   - SEARCH. Brute-force cosine over the vectors of one model. 645 events is
//     ~1 MB of floats; the cache below is what keeps that true at 50,000.
//
// Everything here no-ops when there is no embedder. It never throws into a chat
// turn.

import {
  claimUnembeddedEvents,
  countEmbeddableEvents,
  countEventEmbeddings,
  putEventEmbeddings,
  readEventEmbeddings,
  type EmbeddableEventRow,
  type EmbeddingModelKey,
  type EventEmbedding,
} from "../db/embeddings.js";
import {
  embedderStatus,
  getEmbedder,
  semanticEnabled,
  type Embedder,
  type EmbedderAvailability,
} from "./embedder.js";
import type { SemanticSeed } from "./retrieve.js";

/** Events embedded per background pass. One chat turn's worth of catching up. */
export const DEFAULT_INDEX_BATCH = 32;

/** Seeds a semantic search may contribute to one turn. */
export const DEFAULT_SEMANTIC_LIMIT = 6;

/**
 * How far above the corpus mean, in standard deviations, a neighbour has to be
 * to count as one. Measured on 565 real messages: e5's cosines against any
 * query land in a band about 0.02 wide around 0.78, so an absolute cut is
 * either everything or nothing.
 *
 * 2.5σ rather than 2σ because the gate is RELATIVE, and a relative gate always
 * finds something — at 2σ, "who was unwell" (nothing in this history is)
 * returned eight neighbours and turned an empty answer into eight thousand
 * characters of unrelated chat for the model to reason from. At 2.5σ it returns
 * none, and the questions that do have an answer keep every one of theirs.
 */
export const MIN_SIMILARITY_SIGMAS = 2.5;

/**
 * The same gate, for a pool that is ONE chat the question named.
 *
 * A corpus-wide mean and deviation describe a different population, so a
 * within-chat search has to be recalibrated against its own — that much is
 * simply arithmetic. What it is NOT is the reason a health question misses
 * "Exhaustion and cold": measured on the real database with all 595 vectors
 * built, that message is 0.63σ corpus-wide and 0.82σ inside her own chat, 39th
 * of 189, behind "Your parents ?". Recalibrating moves it 0.2σ. The
 * distribution barely changes because her chat IS a third of the corpus.
 *
 * 2.0 rather than 2.5 because a pool that is already the right conversation
 * has less to lose from a marginal neighbour, and measurably no more: at 2.0
 * this pool returns four rows, three of them the illness thread. Below 2.0 it
 * starts returning house-hunting.
 */
export const MIN_SIMILARITY_SIGMAS_IN_POOL = 2;

/** The z-score that scores 1. Above ~5σ the ranking, not the margin, is signal. */
const SIGMAS_AT_FULL_SCORE = 5;

/**
 * Vectors needed before a mean and a deviation describe anything. Under this
 * the gate above cannot fire at all (z is bounded by √(n−1)/√n), so the raw
 * cosine and a plain floor are used instead.
 */
const MIN_CALIBRATION_ROWS = 64;

/** The plain floor, for a corpus too small to calibrate against. */
export const MIN_SIMILARITY = 0.5;

/** How long a read of the whole vector table stays good for. */
const CACHE_TTL_MS = 30_000;

/** Chars of one event handed to the encoder — it truncates at 512 tokens anyway. */
const MAX_EMBEDDED_CHARS = 1200;

export interface SemanticStatus {
  availability: EmbedderAvailability;
  model: string;
  dim: number;
  reason: string;
  /** The stored switch, which is not the same as the tier being usable. */
  enabled: boolean;
  /** Events with a vector in the active space, and events that could have one. */
  indexed: number;
  embeddable: number;
}

let indexing: Promise<number> | null = null;
let cache: { key: string; at: number; count: number; rows: EventEmbedding[] } | null = null;

// ---- Text -----------------------------------------------------------------

/**
 * What of an event gets embedded. The quote is included because a reply is
 * usually the shortest line in the chat and carries none of its own topic;
 * `link_scraped_text` is not, because one vector cannot hold a 40 KB article
 * and lexical search over it already works.
 */
export function embeddableText(row: EmbeddableEventRow): string {
  const parts = [
    row.replyToText ? `re: ${row.replyToText}` : "",
    row.text ?? "",
    row.transcript ?? "",
    row.mediaDescription ?? "",
    row.linkTitle ?? "",
    row.linkDescription ?? "",
  ]
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const joined = parts.join(" · ");
  return joined.length > MAX_EMBEDDED_CHARS
    ? joined.slice(0, MAX_EMBEDDED_CHARS)
    : joined;
}

// ---- Index ----------------------------------------------------------------

/**
 * Embed the next batch of events that have no vector yet. Returns how many were
 * stored — 0 both when there is nothing to do and when there is no embedder,
 * which the caller cannot act on differently anyway.
 *
 * Overlapping calls share one pass: a chat turn fires this and forgets it, and
 * turns can overlap.
 */
export function indexSemanticBatch(limit = DEFAULT_INDEX_BATCH): Promise<number> {
  if (indexing) return indexing;
  indexing = runIndexBatch(limit).finally(() => {
    indexing = null;
  });
  return indexing;
}

async function runIndexBatch(limit: number): Promise<number> {
  const embedder = await getEmbedder();
  if (!embedder) return 0;

  const key = modelKey(embedder);
  const rows = claimUnembeddedEvents(limit, key);
  if (rows.length === 0) return 0;

  // Every claimed row leaves with a vector, even the one whose text is twelve
  // newlines: a row that is claimed and never stored is claimed again next
  // pass, forever, in front of everything behind it.
  const texts = rows.map((row) => embeddableText(row) || (row.kind ?? "message"));

  try {
    const vectors = await embedder.embed(texts, "passage");
    if (vectors.length !== rows.length) {
      throw new Error(
        `embedder returned ${vectors.length} vectors for ${rows.length} events`,
      );
    }
    const stored = putEventEmbeddings(
      rows.map((row, i) => ({ ...key, eventId: row.id, vector: vectors[i] })),
    );
    cache = null;
    return stored;
  } catch (err) {
    console.error(`[retrieval] embedding batch failed: ${(err as Error).message}`);
    return 0;
  }
}

// ---- Search ---------------------------------------------------------------

/**
 * The events closest in meaning to the question. Empty — never an error, never
 * a wait — when the tier is off.
 */
export async function semanticSearch(
  query: string,
  limit = DEFAULT_SEMANTIC_LIMIT,
): Promise<SemanticSeed[]> {
  const probed = await probe(query);
  if (!probed) return [];

  const rows = readVectors(probed.key);
  // A HALF-BUILT index is the one state this must not answer from. Under
  // MIN_CALIBRATION_ROWS the gate below falls back to a flat cosine floor, and
  // e5 scores every message in a real corpus 0.76–0.85 against any question —
  // so the first 32-event batch of a 645-event history would come back whole,
  // as six confident seeds, for anything the user asked. A corpus that is
  // genuinely that small is a different thing and keeps the floor.
  if (rows.length < MIN_CALIBRATION_ROWS && safeEmbeddable() >= MIN_CALIBRATION_ROWS) {
    return [];
  }
  return rank(probed.vector, rows, MIN_SIMILARITY_SIGMAS, limit);
}

/**
 * The same search over ONE pool — the chats a name in the question selected —
 * calibrated against that pool rather than against the corpus.
 *
 * Empty, never an error, when the tier is off, when the pool is empty, or when
 * too little of the pool is indexed to describe a distribution: a chat with 30
 * vectors has no mean worth measuring anything against, and it is small enough
 * to be included whole anyway.
 */
export async function semanticSearchWithin(
  query: string,
  eventIds: readonly string[],
  limit = DEFAULT_SEMANTIC_LIMIT,
): Promise<SemanticSeed[]> {
  if (eventIds.length === 0) return [];
  const probed = await probe(query);
  if (!probed) return [];

  const pool = new Set(eventIds);
  const rows = readVectors(probed.key).filter((row) => pool.has(row.eventId));
  if (rows.length < MIN_CALIBRATION_ROWS) return [];
  return rank(probed.vector, rows, MIN_SIMILARITY_SIGMAS_IN_POOL, limit);
}

/** The query as a vector, plus the space it is in. Null when the tier is off. */
async function probe(
  query: string,
): Promise<{ vector: Float32Array; key: EmbeddingModelKey } | null> {
  const text = query.trim();
  if (text.length === 0) return null;
  const embedder = await getEmbedder();
  if (!embedder) return null;
  try {
    const [vector] = await embedder.embed([text], "query");
    return vector ? { vector, key: modelKey(embedder) } : null;
  } catch (err) {
    console.error(`[retrieval] embedding the query failed: ${(err as Error).message}`);
    return null;
  }
}

function rank(
  probeVector: Float32Array,
  rows: readonly EventEmbedding[],
  sigmas: number,
  limit: number,
): SemanticSeed[] {
  const sims = rows.map((row) => cosine(probeVector, row.vector));
  const score = calibrate(sims, sigmas);

  const scored: SemanticSeed[] = [];
  for (let i = 0; i < rows.length; i++) {
    const similarity = score(sims[i]);
    if (similarity > 0) scored.push({ eventId: rows[i].eventId, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, Math.max(0, limit));
}

/**
 * Turn one query's cosines into the 0..1 the blend in retrieve.ts spends —
 * where 0 means "no closer than anything else in this chat history".
 *
 * It has to be relative, because e5's cosines are not. Every message in a real
 * corpus scores between 0.76 and 0.85 against any question, so 0.83 is a strong
 * match for one query and below average for the next; feeding that raw into
 * `SEMANTIC_WEIGHT * similarity` would hand every event most of a lexical hit's
 * score. What survives here is measured against the rest of the corpus instead:
 * MIN_SIMILARITY_SIGMAS above the mean to be a seed at all.
 *
 * Under MIN_CALIBRATION_ROWS there is nothing to be unusual against, and the
 * raw cosine with a flat floor is the honest answer.
 */
function calibrate(
  sims: readonly number[],
  floor = MIN_SIMILARITY_SIGMAS,
): (sim: number) => number {
  if (sims.length < MIN_CALIBRATION_ROWS) {
    return (sim) => (sim >= MIN_SIMILARITY ? sim : 0);
  }
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const variance = sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length;
  const sd = Math.sqrt(variance);
  // Every vector identical: nothing is nearer than anything else.
  if (!(sd > 0)) return () => 0;

  const span = Math.max(0.5, SIGMAS_AT_FULL_SCORE - floor);
  return (sim) => {
    const sigmas = (sim - mean) / sd;
    if (sigmas < floor) return 0;
    return Math.min(1, (sigmas - floor) / span);
  };
}

/**
 * The whole vector table, cached briefly. The count is part of the validity
 * check, so a background pass that stored something is visible immediately
 * rather than in thirty seconds.
 */
function readVectors(key: EmbeddingModelKey): EventEmbedding[] {
  const id = `${key.model}:${key.dim}`;
  const count = countEventEmbeddings(key);
  const now = Date.now();
  if (cache && cache.key === id && cache.count === count && now - cache.at < CACHE_TTL_MS) {
    return cache.rows;
  }
  const rows = readEventEmbeddings(key);
  cache = { key: id, at: now, count, rows };
  return rows;
}

/** Cosine similarity. Computed with norms rather than assuming unit vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---- Status ---------------------------------------------------------------

/** What the tier is doing, and if it is doing nothing, exactly why. */
export function semanticStatus(): SemanticStatus {
  const status = embedderStatus();
  const key = { model: status.model, dim: status.dim };
  return {
    ...status,
    enabled: semanticEnabled(),
    indexed: safeCount(() => countEventEmbeddings(key)),
    embeddable: safeCount(countEmbeddableEvents),
  };
}

/** How much of the history could have a vector — 0 rather than a throw. */
function safeEmbeddable(): number {
  return safeCount(countEmbeddableEvents);
}

function safeCount(read: () => number): number {
  try {
    return read();
  } catch {
    // A DB that predates 0018 has no vector table; that is "none", not a crash.
    return 0;
  }
}

function modelKey(embedder: Embedder): EmbeddingModelKey {
  return { model: embedder.model, dim: embedder.dim };
}

/** Test hook: drop the cached vector table. */
export function resetSemanticCacheForTests(): void {
  cache = null;
  indexing = null;
}
