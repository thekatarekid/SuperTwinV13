// ===========================================================================
// The context packer (V6 P1 S3.2; Build §6.1; Product_V6_Phase1 §7) — public
// surface.
//
//   pack.ts     packOrientContext(): the T0 assembler — [NOW] [ROSTER]
//               [OPEN TASKS] [CALENDAR] [CANDIDATE SPACES] <untrusted>
//               [BRIDGED] [THREAD S<k>] [EPISODES] [BUNDLE] </untrusted>
//   spaces.ts   candidate spaces from retrieval, hard cap 5, never enumerated
//   history.ts  episode-bounded thread history, episodes, cross-source
//   roster.ts   resolved people, relationships, nicknames, unresolved
//   agenda.ts   open tasks (scoped) and the calendar window
//   budget.ts   the character budget and the floor/ceiling allowance
//   thin.ts     thin-context decision and the hold-once policy
//   bridged.ts  the [BRIDGED] block (S2.6)
//   digest.ts   content economy: digest lines, L0/L1/L2 serving
//
// Production caller: brain/orient.ts packs every bundle through here before
// its Orient call. Zero model calls inside the packer, ever.
// ===========================================================================

export {
  bandPolicyLine,
  eventIdentityHead,
  fmtTs,
  neutralise,
  packBundleKey,
  packOrientContext,
  DEFAULT_PACK_MAX_CHARS,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  type PackOptions,
  type PackStats,
  type PackedContext,
} from "./pack.js";
export {
  candidateSpaces,
  salientTokens,
  MAX_CANDIDATE_SPACES,
  type CandidateSpace,
  type CandidateOptions,
} from "./spaces.js";
export {
  crossSourceEpisodes,
  fetchQuoted,
  quotedRefs,
  streamEpisodes,
  streamFacts,
  threadHistory,
  HISTORY_CHARS_PER_STREAM,
  HISTORY_RUN_UP,
  HISTORY_STREAMS,
  type EpisodeSummary,
  type HistoryEvent,
  type StreamFacts,
} from "./history.js";
export { buildRoster, renderRosterEntry, ROSTER_MAX, type Roster, type RosterEntry } from "./roster.js";
export {
  calendarItems,
  openTasks,
  renderCalendarItem,
  renderOpenTask,
  CALENDAR_DAYS_AHEAD,
  CALENDAR_MAX,
  OPEN_TASKS_MAX,
  type CalendarItem,
  type OpenTask,
} from "./agenda.js";
export {
  clip,
  clipBody,
  eventAllowance,
  historyAllowance,
  EVENT_TEXT_CEILING,
  EVENT_TEXT_FLOOR,
  PACK_BUDGET_CHARS,
} from "./budget.js";
export {
  clearThinHold,
  decideThin,
  holdThinOnce,
  isThinHeld,
  THIN_CONTEXT_INSTRUCTION,
  type ThinDecision,
  type ThinPolicy,
  type ThinSignals,
} from "./thin.js";
export { bridgedBlock, bridgedLines, renderBridgedBlock, BRIDGED_HEADER } from "./bridged.js";
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
