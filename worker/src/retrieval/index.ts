// ===========================================================================
// Retrieval, assembled (docs/v6-spec.md §1). Three tiers, one entry point:
//
//   tier 1  deterministic  query.ts + dates.ts + retrieve.ts + format.ts
//   tier 2  semantic       embedder.ts + semantic.ts + indexer.ts — off until
//                          the user switches it on and fetches the encoder
//
// The on-disk message dump that used to sit between them is gone (V2 §3.2): a
// plaintext copy of the full history in the user's brain folder is a second
// source of truth, and it was never a product path.
//
// Tier 1 is synchronous and fixes the repro on its own. Tier 2 is the only
// asynchronous part, so there are two entry points rather than one async
// function that is really synchronous: buildContextBlockSync() for callers that
// cannot await (and for the DB-layer tests that call it), and
// buildGroundedContext() for the chat turn, which can.
// ===========================================================================

export {
  isoDate,
  localToday,
  resolveDates,
  weekdayName,
  dateMatchPhrases,
  tsWithinRange,
  MAX_RESOLVED_DATES,
  type CalendarDate,
  type DateRange,
  type DateRelation,
  type DateResolution,
  type ResolvedDate,
} from "./dates.js";
export { planQuery, stemPrefix, STOPWORDS, type QueryPlan } from "./query.js";
export {
  namedChannelIds,
  retrieveContext,
  DATE_WEIGHT,
  DEFAULT_FOCUS_SEED_LIMIT,
  DEFAULT_LEXICAL_LIMIT,
  DEFAULT_SEED_LIMIT,
  LEXICAL_WEIGHT,
  MAX_NAMED_CHANNELS,
  MIN_SEED_LEXICAL,
  RECENCY_HALF_LIFE_DAYS,
  RECENCY_WEIGHT,
  SEMANTIC_WEIGHT,
  type ContextEvent,
  type ContextRole,
  type ContextSection,
  type RetrievalResult,
  type RetrieveOptions,
  type ScoredHit,
  type SemanticSeed,
} from "./retrieve.js";
export {
  focusMatch,
  focusSearch,
  DEFAULT_FOCUS_LIMIT,
  MAX_FOCUS_CHANNELS,
  type FocusOptions,
  type FocusResult,
} from "./focus.js";
export { expandTopics, topicPrefixes, topicSiblings } from "./topics.js";
export {
  formatContextBlock,
  renderEvent,
  renderEventBody,
  shortEventId,
  DEFAULT_CONTEXT_CHARS,
  type FormatOptions,
} from "./format.js";
export {
  embedderStatus,
  embeddingModelDir,
  embeddingModelFilePath,
  embeddingModelFileStates,
  embeddingModelFileUrl,
  embeddingModelPresent,
  embeddingRuntimeInstalled,
  ensureEmbeddingModel,
  forgetEmbedder,
  getEmbedder,
  semanticEnabled,
  setEmbedder,
  EMBEDDING_MODEL,
  embeddingModelBytes,
  type Embedder,
  type EmbedderStatus,
  type EmbeddingFileState,
  type EmbeddingModelSpec,
} from "./embedder.js";
export {
  cosine,
  embeddableText,
  indexSemanticBatch,
  resetSemanticCacheForTests,
  semanticSearch,
  semanticSearchWithin,
  semanticStatus,
  DEFAULT_SEMANTIC_LIMIT,
  MIN_SIMILARITY,
  MIN_SIMILARITY_SIGMAS,
  MIN_SIMILARITY_SIGMAS_IN_POOL,
  type SemanticStatus,
} from "./semantic.js";
export {
  startSemanticIndexer,
  stopSemanticIndexer,
  wakeSemanticIndexer,
} from "./indexer.js";
// V6 S2.2: chunks are the embedded unit (T5-3).
export {
  runChunker,
  cutWindows,
  cutDocument,
  stripUrl,
  CHUNK_TARGET_CHARS,
  type ChunkerReport,
} from "./chunker.js";
export {
  indexChunkBatch,
  vectorSearchChunks,
  rankChunks,
  chunkIndexStatus,
  dropChunkStaging,
  chunkStagingExists,
  DEFAULT_CHUNK_SEARCH_LIMIT,
  type ChunkHit,
  type ChunkSearchOptions,
  type ChunkIndexStatus,
} from "./chunk-index.js";
export { ensureDefaultEmbeddingModelDownload, type FirstRunDownloadOutcome } from "./default-model.js";
// V6 S2.5: structured (SQL over typed fields) and time window (unscored range scan).
export {
  structuredQuery,
  structuredForQuery,
  planStructured,
  resolvePeriod,
  lastMonthRange,
  thisMonthRange,
  MERCHANT_CATEGORIES,
  STATUS_WORDS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_CITATION_ROWS,
  type StructuredOp,
  type StructuredFilters,
  type StructuredQuery,
  type StructuredResult,
  type StructuredRow,
  type StructuredPlan,
  type CurrencySum,
} from "./structured.js";
export {
  resolveTimeWindow,
  timeWindowScan,
  timeWindowForQuery,
  windowFor,
  DAY_PARTS,
  DEFAULT_TIME_WINDOW_LIMIT,
  type DayPart,
  type TimeWindow,
  type TimeWindowEvent,
  type TimeWindowResult,
  type TimeWindowScanOptions,
} from "./time-window.js";

import { readChannelEventIds } from "../db/retrieval.js";
import { formatContextBlock, DEFAULT_CONTEXT_CHARS } from "./format.js";
import {
  namedChannelIds,
  retrieveContext,
  type RetrievalResult,
  type SemanticSeed,
} from "./retrieve.js";
import { indexSemanticBatch, semanticSearch, semanticSearchWithin } from "./semantic.js";

export interface GroundedContextOptions {
  /** The instant of the turn; its LOCAL date is what "sunday" resolves against. */
  now?: Date;
  maxChars?: number;
  seedLimit?: number;
  window?: number;
  /** Minutes either side of a seed, ORed with `window` (default 45). */
  windowMinutes?: number;
  wholeChannelMaxChars?: number;
  lexicalLimit?: number;
  /** How much better a row scores for sitting in a chat the question named. */
  channelBoost?: number;
  /** Turn name resolution off — for measuring what it is worth. */
  resolveNames?: boolean;
  /** Rows the within-chat pass reads per named chat. */
  focusLimit?: number;
  /** Seeds it may contribute. 0 turns the pass off — for measuring it. */
  focusSeedLimit?: number;
  /** Consult the embedding index. Ignored — silently — when there is none. */
  semantic?: boolean;
}

export interface GroundedContext {
  block: string;
  result: RetrievalResult;
}

/**
 * Tier 1, synchronously. This is what every non-chat caller wants: no
 * awaits, no model, no network, and identical behaviour whether or not the
 * embedding index exists.
 */
export function buildGroundedContextSync(
  query: string,
  opts: GroundedContextOptions = {},
): GroundedContext {
  return assemble(opts, retrieveContext({ query, ...opts }));
}

/**
 * Both tiers. Semantic seeds are gathered first (they change WHICH
 * messages get expanded, so they cannot be bolted on afterwards), then the
 * background index is nudged and NOT awaited — a chat turn must never wait on
 * embedding, and with no embedder present it is a no-op anyway.
 */
export async function buildGroundedContext(
  query: string,
  opts: GroundedContextOptions = {},
): Promise<GroundedContext> {
  const semanticSeeds =
    opts.semantic === false ? [] : await safeSemanticSearch(query, opts.now);
  const result = retrieveContext({ query, ...opts, semanticSeeds });
  const context = assemble(opts, result);
  void indexSemanticBatch().catch(() => {
    // Already logged where it happened; a failed index is not a failed turn.
  });
  return context;
}

function assemble(
  opts: GroundedContextOptions,
  result: RetrievalResult,
): GroundedContext {
  return {
    block: formatContextBlock(result, {
      maxChars: opts.maxChars ?? DEFAULT_CONTEXT_CHARS,
    }),
    result,
  };
}

/**
 * Index-wide neighbours, plus the ones a NAMED chat is willing to call
 * neighbours. The two are gated against different distributions on purpose
 * (semantic.ts): the second is measured against the chat the question selected,
 * where the population — and therefore what counts as unusually close — is not
 * the index-wide one.
 *
 * A failure anywhere in here is no seeds, never a failed turn.
 */
async function safeSemanticSearch(query: string, now?: Date): Promise<SemanticSeed[]> {
  const out: SemanticSeed[] = [];
  const seen = new Set<string>();
  const add = (seeds: readonly SemanticSeed[]): void => {
    for (const seed of seeds) {
      if (seen.has(seed.eventId)) continue;
      seen.add(seed.eventId);
      out.push(seed);
    }
  };

  try {
    add(await semanticSearch(query));
  } catch (err) {
    console.error(`[retrieval] semantic search failed: ${(err as Error).message}`);
  }
  try {
    const named = namedChannelIds(query, now ?? new Date());
    if (named.length > 0) add(await semanticSearchWithin(query, readChannelEventIds(named)));
  } catch (err) {
    console.error(`[retrieval] within-chat semantic search failed: ${(err as Error).message}`);
  }
  return out;
}
