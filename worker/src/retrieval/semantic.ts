// Semantic retrieval and the T0 fusion — V6 P1 S2.4 (Build §5.2, Product_V6
// §23, T5-2). Tier 3 of docs/v6-spec.md §1 before that.
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
//   - SEARCH. BOUNDED. The previous shape loaded every vector into a process
//     cache and linear-scanned it — 192 ms at 100 K vectors, 2 s at 1 M, and
//     one year of screen is 300 K. It is gone. A query now costs:
//
//       candidates   FTS5 top FTS_CANDIDATE_LIMIT by bm25 (3–13 ms at 221 K
//                    docs)  ∪  the events under the top CHUNK_CANDIDATE_LIMIT
//                    chunk vectors (chunk-index.ts — one vector per 2 k window,
//                    a table small by design)
//       vectors      the event vectors of THOSE ids, read by id — never the
//                    table. A corpus smaller than the bound is read whole,
//                    because whole is then a bounded set.
//       rank()       the calibrated cosine gate, verbatim, over that set.
//       RRF          the vector list and the lexical list fused by reciprocal
//                    rank at k = RRF_K — BM25 and cosine are not one scale.
//       reranker     the fused top RERANK_WINDOW re-read as (question, passage)
//                    pairs by the local cross-encoder (reranker.ts) when one is
//                    present; the RRF order stands when none is.
//
//     `semanticScanStats()` counts what every query read; `fullVectorScans` is
//     the number that must stay 0 (RET-01's hard gate).
//
// Everything here no-ops when there is no embedder. It never throws into a chat
// turn, and it makes zero model calls in the `claude` sense — the encoder and
// the reranker are local ONNX.

import {
  claimUnembeddedEvents,
  countEmbeddableEvents,
  countEventEmbeddings,
  lexicalBranchCount,
  lexicalCandidateEventIds,
  putEventEmbeddings,
  readEventEmbeddingsBounded,
  readEventEmbeddingsByIds,
  type EmbeddableEventRow,
  type EmbeddingModelKey,
  type EventEmbedding,
} from "../db/embeddings.js";
import { readEventsByIds, type ContextEventRow } from "../db/retrieval.js";
import { rankChunks } from "./chunk-index.js";
import {
  embedderStatus,
  getEmbedder,
  semanticEnabled,
  type Embedder,
  type EmbedderAvailability,
} from "./embedder.js";
import { planQuery, type QueryPlan } from "./query.js";
import { getReranker, type Reranker } from "./reranker.js";
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

/** Chars of one event handed to the encoder — it truncates at 512 tokens anyway. */
const MAX_EMBEDDED_CHARS = 1200;

// ---- Fusion bounds (T5-2, Build §5.2) ---------------------------------------

/** Lexical candidates per query: FTS5 top-N by bm25. Also the size a corpus may be read whole at. */
export const FTS_CANDIDATE_LIMIT = 2000;

/** Chunk vectors consulted per query; their events join the candidate set. */
export const CHUNK_CANDIDATE_LIMIT = 40;

/**
 * A term in at least this many events is dropped from the candidate MATCH. It
 * carries no candidate signal — every one of those events would tie — and
 * ranking it costs bm25 over all of them: measured 135 ms for a word in each
 * of 300 K rows, against 0.2 ms to discover that it is (LIMIT-capped count).
 * Only the fusion layer's candidate list is pruned; retrieve.ts's own lexical
 * pass is untouched. When EVERY term is that common the plan's full expression
 * is used as written — bounded by FTS_CANDIDATE_LIMIT, just not cheap.
 */
export const MAX_CANDIDATE_TERM_DF = 5000;

/** Reciprocal-rank-fusion constant. 60 is the value the method was published with. */
export const RRF_K = 60;

/** Fused candidates the cross-encoder re-reads. */
export const RERANK_WINDOW = 50;

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

/** One fused hit — what the packer's T0 pass and the bar consume. */
export interface HybridHit {
  eventId: string;
  /** What the list is ordered by: the reranker's 0..1 when it ran on this row, else the RRF sum. */
  score: number;
  /** 1-based position in the lexical (bm25) list, or null when bm25 did not return it. */
  lexicalRank: number | null;
  /** 1-based position in the gated vector list, or null when the gate did not admit it. */
  vectorRank: number | null;
  /** rank()'s calibrated 0..1, when the vector gate admitted the row. */
  similarity: number | null;
  /** The cross-encoder's 0..1, when it ran on this row. */
  rerankScore: number | null;
  /** Σ 1/(k + rank) over the lists the row appeared in. */
  rrf: number;
}

export interface HybridSearchOptions {
  limit?: number;
  /** The instant of the turn; dates in the question resolve against its local day. */
  now?: Date;
  /** Restrict every list to these events (the chat a question named). */
  pool?: readonly string[];
  /** Skip the cross-encoder even when one is present — for measuring it. */
  rerank?: boolean;
}

/** What one query read. `fullVectorScans` is the RET-01 gate and stays 0. */
export interface SemanticScanStats {
  queries: number;
  /** Event vectors decoded across all queries. */
  vectorRowsRead: number;
  /** Reads of the whole vector table with no bound. There is no code path that does this. */
  fullVectorScans: number;
  last: {
    lexical: number;
    chunkHits: number;
    candidates: number;
    vectorRows: number;
    reranked: number;
    reranker: string | null;
  } | null;
}

let indexing: Promise<number> | null = null;
let stats: SemanticScanStats = { queries: 0, vectorRowsRead: 0, fullVectorScans: 0, last: null };

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

/** The same composition, from the row shape retrieval reads — what the reranker is shown. */
export function passageText(row: ContextEventRow): string {
  return embeddableText({
    id: row.id,
    ts: row.ts,
    channelId: row.channelId,
    kind: row.kind,
    text: row.text,
    mediaDescription: row.mediaDescription,
    transcript: row.transcript,
    linkTitle: row.linkTitle,
    linkDescription: row.linkDescription,
    replyToText: row.replyToText,
  });
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
    return putEventEmbeddings(
      rows.map((row, i) => ({ ...key, eventId: row.id, vector: vectors[i] })),
    );
  } catch (err) {
    console.error(`[retrieval] embedding batch failed: ${(err as Error).message}`);
    return 0;
  }
}

// ---- Search ---------------------------------------------------------------

/**
 * The events closest in meaning to the question — the rows the calibrated
 * vector gate admits, ordered by the fusion (RRF with the lexical list, then
 * the reranker over the top window). Empty — never an error, never a wait —
 * when the tier is off.
 *
 * `similarity` is the reranker's 0..1 when one ran on the row, else rank()'s
 * calibrated 0..1; either way it is what retrieve.ts spends as
 * `SEMANTIC_WEIGHT * similarity`.
 */
export async function semanticSearch(
  query: string,
  limit = DEFAULT_SEMANTIC_LIMIT,
): Promise<SemanticSeed[]> {
  const probed = await probe(query);
  if (!probed) return [];

  // A HALF-BUILT index is the one state this must not answer from. Under
  // MIN_CALIBRATION_ROWS the gate below falls back to a flat cosine floor, and
  // e5 scores every message in a real corpus 0.76–0.85 against any question —
  // so the first 32-event batch of a 645-event history would come back whole,
  // as six confident seeds, for anything the user asked. A corpus that is
  // genuinely that small is a different thing and keeps the floor.
  const indexed = safeCount(() => countEventEmbeddings(probed.key));
  if (indexed < MIN_CALIBRATION_ROWS && safeEmbeddable() >= MIN_CALIBRATION_ROWS) {
    return [];
  }
  const hits = await fuse(query, probed, {
    limit,
    sigmas: MIN_SIMILARITY_SIGMAS,
    vectorOnly: true,
    indexed,
  });
  return toSeeds(hits);
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
  const hits = await fuse(query, probed, {
    limit,
    sigmas: MIN_SIMILARITY_SIGMAS_IN_POOL,
    vectorOnly: true,
    pool: eventIds,
    minRows: MIN_CALIBRATION_ROWS,
  });
  return toSeeds(hits);
}

/**
 * T0 hybrid (Product_V6 §23 — "lexical ∪ vector → RRF → cross-encoder"): the
 * fused list itself, lexical-only rows included, for the packer and the bar.
 * Degrades to the lexical list alone when there is no encoder — a bounded FTS
 * read is still retrieval — and to the RRF order when there is no reranker.
 * Never throws.
 */
export async function hybridSearch(query: string, opts: HybridSearchOptions = {}): Promise<HybridHit[]> {
  const probed = await probe(query);
  return fuse(query, probed, {
    limit: opts.limit ?? RERANK_WINDOW,
    sigmas: opts.pool ? MIN_SIMILARITY_SIGMAS_IN_POOL : MIN_SIMILARITY_SIGMAS,
    vectorOnly: false,
    pool: opts.pool,
    now: opts.now,
    rerank: opts.rerank,
  });
}

function toSeeds(hits: readonly HybridHit[]): SemanticSeed[] {
  return hits.map((h) => ({
    eventId: h.eventId,
    similarity: h.rerankScore ?? h.similarity ?? 0,
  }));
}

interface FuseOptions {
  limit: number;
  sigmas: number;
  /** Emit only rows the vector gate admitted (semanticSearch); false = the whole fused list. */
  vectorOnly: boolean;
  pool?: readonly string[];
  now?: Date;
  rerank?: boolean;
  /** Already-counted rows in the space, to save a second COUNT. */
  indexed?: number;
  /** Refuse a pool with fewer vectors than this (the within-chat calibration floor). */
  minRows?: number;
}

/**
 * The pipeline. Every read is bounded; see the header for the shape.
 */
async function fuse(
  query: string,
  probed: { vector: Float32Array; key: EmbeddingModelKey; embedder: Embedder } | null,
  opts: FuseOptions,
): Promise<HybridHit[]> {
  const limit = Math.max(0, opts.limit);
  const pool = opts.pool ? new Set(opts.pool.filter((id) => typeof id === "string" && id !== "")) : null;
  if (pool && pool.size === 0) return [];
  const inPool = (id: string): boolean => !pool || pool.has(id);

  // 1. Lexical candidates: FTS5 top-N by bm25. A MATCH expression FTS5 cannot
  //    parse must never break a turn — no lexical list, not no answer.
  let lexical: string[] = [];
  try {
    const match = candidateMatch(planQuery(query, opts.now ?? new Date()));
    if (match.length > 0) {
      lexical = lexicalCandidateEventIds(match, FTS_CANDIDATE_LIMIT).filter(inPool);
    }
  } catch {
    lexical = [];
  }

  // 2. Vector candidates and the gated vector list.
  let vectorRanked: SemanticSeed[] = [];
  let chunkHits = 0;
  let vectorRows = 0;
  let candidates = lexical.length;
  if (probed) {
    const chunkEvents: string[] = [];
    try {
      for (const hit of rankChunks(probed.vector, probed.embedder.model, { limit: CHUNK_CANDIDATE_LIMIT })) {
        chunkHits++;
        for (const id of hit.chunk.eventIds) if (inPool(id)) chunkEvents.push(id);
      }
    } catch {
      // A DB without the chunk tables, or a chunk vector of another width: no chunk candidates.
    }
    const rows = readCandidateVectors(probed.key, lexical, chunkEvents, pool, opts.indexed);
    vectorRows = rows.length;
    candidates = rows.candidates;
    if (opts.minRows !== undefined && rows.length < opts.minRows) {
      recordScan(lexical.length, chunkHits, candidates, vectorRows, 0, null);
      return [];
    }
    vectorRanked = rank(probed.vector, rows, opts.sigmas, Math.max(limit, RERANK_WINDOW));
  }

  // 3. RRF over the two lists.
  const vectorIds = vectorRanked.map((s) => s.eventId);
  const fused = rrfFuse([vectorIds, lexical], RRF_K);
  const vectorRankOf = new Map(vectorIds.map((id, i) => [id, i + 1]));
  const similarityOf = new Map(vectorRanked.map((s) => [s.eventId, s.similarity]));
  const lexicalRankOf = new Map<string, number>();
  lexical.forEach((id, i) => {
    if (!lexicalRankOf.has(id)) lexicalRankOf.set(id, i + 1);
  });

  const ids = opts.vectorOnly ? vectorIds : [...fused.keys()];
  const hits: HybridHit[] = ids.map((id) => ({
    eventId: id,
    score: fused.get(id) ?? 0,
    lexicalRank: lexicalRankOf.get(id) ?? null,
    vectorRank: vectorRankOf.get(id) ?? null,
    similarity: similarityOf.get(id) ?? null,
    rerankScore: null,
    rrf: fused.get(id) ?? 0,
  }));
  hits.sort((a, b) => b.rrf - a.rrf || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));

  // 4. The cross-encoder over the top window. The window is re-ordered by its
  //    score; everything past the window keeps its RRF order behind it.
  let reranked = 0;
  let rerankerName: string | null = null;
  if (opts.rerank !== false && hits.length > 0) {
    const reranker = await safeReranker();
    if (reranker) {
      rerankerName = reranker.model;
      const window = hits.slice(0, RERANK_WINDOW);
      const rest = hits.slice(RERANK_WINDOW);
      try {
        const rows = new Map(readEventsByIds(window.map((h) => h.eventId)).map((r) => [r.id, r]));
        const passages = window.map((h) => {
          const row = rows.get(h.eventId);
          return row ? passageText(row) : "";
        });
        const scores = await reranker.score(query, passages);
        if (scores.length !== window.length) {
          throw new Error(`reranker returned ${scores.length} scores for ${window.length} passages`);
        }
        window.forEach((h, i) => {
          const s = passages[i] ? clamp01(scores[i]) : 0;
          h.rerankScore = s;
          h.score = s;
        });
        window.sort((a, b) => (b.score - a.score) || (b.rrf - a.rrf));
        reranked = window.length;
        hits.splice(0, hits.length, ...window, ...rest);
      } catch (err) {
        console.error(`[retrieval] reranker failed, keeping the fused order: ${(err as Error).message}`);
      }
    }
  }

  recordScan(lexical.length, chunkHits, candidates, vectorRows, reranked, rerankerName);
  return hits.slice(0, limit);
}

/**
 * The event vectors a query is allowed to look at. Never the table:
 *
 *   - a pool (one chat) at or under the bound is read whole BY ID;
 *   - a pool over the bound is read as its candidates plus the first
 *     FTS_CANDIDATE_LIMIT pool ids, so the calibration still has the pool's
 *     shape to measure against;
 *   - a corpus at or under the bound is read with a LIMIT — the whole table,
 *     because whole is then a bounded set;
 *   - a corpus over the bound is read as the candidate ids only.
 */
function readCandidateVectors(
  key: EmbeddingModelKey,
  lexical: readonly string[],
  chunkEvents: readonly string[],
  pool: Set<string> | null,
  indexed: number | undefined,
): EventEmbedding[] & { candidates: number } {
  let rows: EventEmbedding[];
  let candidates: number;
  if (pool) {
    const ids = pool.size <= FTS_CANDIDATE_LIMIT
      ? [...pool]
      : uniq([...lexical, ...chunkEvents, ...[...pool].slice(0, FTS_CANDIDATE_LIMIT)]);
    candidates = ids.length;
    rows = readEventEmbeddingsByIds(key, ids);
  } else {
    const total = indexed ?? safeCount(() => countEventEmbeddings(key));
    if (total <= FTS_CANDIDATE_LIMIT) {
      candidates = total;
      rows = readEventEmbeddingsBounded(key, FTS_CANDIDATE_LIMIT);
    } else {
      const ids = uniq([...lexical, ...chunkEvents]);
      candidates = ids.length;
      rows = readEventEmbeddingsByIds(key, ids);
    }
  }
  return Object.assign(rows, { candidates });
}

/**
 * The plan's MATCH with its ubiquitous branches removed (MAX_CANDIDATE_TERM_DF).
 * Mirrors planQuery's construction — quoted terms, quoted prefixes with `*`,
 * quoted phrases, OR-joined — so what is pruned is a branch, never a character.
 * Exported for the test that measures it.
 */
export function candidateMatch(plan: QueryPlan): string {
  if (plan.match.length === 0) return "";
  const branches = [
    ...plan.terms.map((t) => `"${t}"`),
    ...plan.prefixes.map((p) => `"${p}"*`),
    ...plan.phrases.map((p) => `"${p}"`),
  ];
  if (branches.length === 0) return plan.match;
  const kept = branches.filter((b) => lexicalBranchCount(b, MAX_CANDIDATE_TERM_DF) < MAX_CANDIDATE_TERM_DF);
  return kept.length > 0 ? kept.join(" OR ") : plan.match;
}

/**
 * Reciprocal rank fusion. Each list is an ordering, best first; a row's score
 * is Σ 1/(k + rank) over the lists that contain it (1-based rank, first
 * occurrence counts). Position, not score — BM25's negative log-odds and a
 * cosine are not comparable, and this is the standard way not to pretend they
 * are. Ties are the caller's to break.
 */
export function rrfFuse(lists: readonly (readonly string[])[], k = RRF_K): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (seen.has(id)) continue;
      seen.add(id);
      out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return out;
}

async function safeReranker(): Promise<Reranker | null> {
  try {
    return await getReranker();
  } catch {
    return null;
  }
}

function recordScan(
  lexical: number,
  chunkHits: number,
  candidates: number,
  vectorRows: number,
  reranked: number,
  reranker: string | null,
): void {
  stats = {
    queries: stats.queries + 1,
    vectorRowsRead: stats.vectorRowsRead + vectorRows,
    fullVectorScans: stats.fullVectorScans,
    last: { lexical, chunkHits, candidates, vectorRows, reranked, reranker },
  };
}

/** What the fusion layer has read since the last reset. */
export function semanticScanStats(): SemanticScanStats {
  return { ...stats, last: stats.last ? { ...stats.last } : null };
}

/** The query as a vector, plus the space it is in. Null when the tier is off. */
async function probe(
  query: string,
): Promise<{ vector: Float32Array; key: EmbeddingModelKey; embedder: Embedder } | null> {
  const text = query.trim();
  if (text.length === 0) return null;
  const embedder = await getEmbedder();
  if (!embedder) return null;
  try {
    const [vector] = await embedder.embed([text], "query");
    return vector ? { vector, key: modelKey(embedder), embedder } : null;
  } catch (err) {
    console.error(`[retrieval] embedding the query failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The calibrated cosine gate over ONE bounded set of rows — kept verbatim from
 * the full-scan shape (T5-2: "rank() kept verbatim, just handed a bounded
 * set"). Exported so RET-01 can run it over the whole table as the reference
 * the bounded pipeline is measured against.
 */
export function rank(
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
 *
 * Over a CANDIDATE set (a corpus past FTS_CANDIDATE_LIMIT) the population is
 * the candidates, which lean towards the question by construction — so the
 * gate is a little stricter than it was corpus-wide. That is the trade T5-2
 * made, and RET-01 measures what it costs: top-10 overlap ≥ 90%.
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

function uniq(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
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

/**
 * Test hook. There is no vector cache any more (S2.4 deleted it); the name
 * stays because every suite calls it. Resets the in-flight index pass and the
 * scan counters.
 */
export function resetSemanticCacheForTests(): void {
  indexing = null;
  stats = { queries: 0, vectorRowsRead: 0, fullVectorScans: 0, last: null };
}
