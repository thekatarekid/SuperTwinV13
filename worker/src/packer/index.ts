// ===========================================================================
// The context packer (build P1.2, spec §6.4 + §4.5) — public surface.
//
//   pack.ts     packOrientContext(): the anti-starvation assembler
//   spaces.ts   candidate spaces via the four retrieval lanes + recency
//   history.ts  thread history / episodes / roster / cross-source blocks
//   digest.ts   content economy: digest lines, L0/L1/L2 serving, escalation
//               metric
//
// Production caller: the brain consumer (worker/src/brain/consumer.ts) packs
// every delta bundle through here before its Orient call.
// ===========================================================================

export {
  packOrientContext,
  DEFAULT_PACK_MAX_CHARS,
  type PackOptions,
  type PackedContext,
} from "./pack.js";
export {
  candidateSpaces,
  recentContextSpaces,
  salientTokens,
  type CandidateSpace,
  type CandidateOptions,
} from "./spaces.js";
export {
  crossSourceEpisodes,
  streamContext,
  streamEpisodes,
  threadHistory,
  THREAD_HISTORY_MIN,
  THREAD_HISTORY_MAX,
  type EpisodeSummary,
  type HistoryEvent,
  type RosterEntry,
  type StreamContext,
} from "./history.js";
export {
  codeDigestFields,
  digestLineFor,
  distillContent,
  ensureDigests,
  escalationRate,
  estimateTokens,
  heavyContentOf,
  newServeCounters,
  readCachedDigest,
  recordContextStats,
  renderDigestLine,
  serveContent,
  CONTENT_KINDS,
  type DigestLine,
  type EscalationRate,
  type FidelityLevel,
  type ServeCounters,
} from "./digest.js";
