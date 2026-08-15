// ===========================================================================
// The within-chat pass.
//
// Retrieval had exactly two modes, and a question about a PERSON fits neither:
//
//   - a window around a lexical hit reaches what was said AT THE TIME. The
//     evidence about someone's health is spread over days — "Exhaustion and
//     cold" on the 27th, "Already taking meds" on the 28th, the doctors on the
//     29th — so it is neither near the hit nor near itself. ±45 minutes and ±60
//     rows structurally cannot reach it.
//   - whole-chat inclusion reaches all of it, and cannot fit: her chat is 231
//     events and 33,313 rendered chars against caps of 120 and 12,000.
//
// The missing mode is the obvious one: the messages in THAT chat that are about
// THAT topic. Once a name has selected a conversation, the conversation is the
// candidate pool and how far a row sits from another row stops being a
// question worth asking.
//
// Two things make it work where a corpus-wide search does not:
//
//   - the pool is one chat, so bm25 orders 234 messages against each other
//     instead of 751, and there is no marketing broadcast in it to lose to;
//   - the query is EXPANDED (topics.ts). health -> cold, meds, medicine,
//     doctor, antibiotics, tabiyat, dawai, bimar … which is affordable exactly
//     because the pool is narrow. Corpus-wide the same expansion would return
//     the pharmacy and the insurance helpline on every health question.
// ===========================================================================

import {
  searchChannelRanked,
  type FtsColumnWeights,
  type RankedEventHit,
} from "../db/retrieval.js";
import type { QueryPlan } from "./query.js";
import { expandTopics, topicPrefixes } from "./topics.js";

/**
 * Rows read from each named chat. Generous because they are not all injected:
 * a handful become seeds and the rest are only MARKED if the expansion reaches
 * them anyway, so the cost of a large number is one indexed query.
 */
export const DEFAULT_FOCUS_LIMIT = 24;

/**
 * Chats the within-chat pass runs over. `boostedChannelIds` already caps the
 * names at MAX_NAMED_CHANNELS; this is the second guard, on the read.
 */
export const MAX_FOCUS_CHANNELS = 4;

export interface FocusOptions {
  channelIds: readonly string[];
  plan: QueryPlan;
  limit?: number;
  weights?: FtsColumnWeights;
}

export interface FocusResult {
  hits: RankedEventHit[];
  /** The expanded MATCH, so a diagnostic can show what was actually searched. */
  match: string;
  /** Words the topic map added. Empty when the question named no known topic. */
  expanded: string[];
}

/**
 * The FTS expression the within-chat pass searches with: what the question
 * said, plus what it meant.
 *
 * Date phrases are deliberately left out. They exist to bridge "sunday" to
 * "02 Aug 2026" in a corpus-wide search; inside a chat the question named they
 * only pull the day's small talk in ahead of the topic.
 */
export function focusMatch(plan: QueryPlan): { match: string; expanded: string[] } {
  const expanded = expandTopics([...plan.terms, ...plan.prefixes]);
  const prefixed = new Set(topicPrefixes(expanded));
  const branches = [
    ...plan.terms.map((t) => `"${t}"`),
    ...plan.prefixes.map((p) => `"${p}"*`),
    ...expanded.map((w) => (prefixed.has(w) ? `"${w}"*` : `"${w}"`)),
  ];
  return { match: [...new Set(branches)].join(" OR "), expanded };
}

/**
 * Rank every message in the named chats against the expanded question. Never
 * throws into a turn: an expression FTS5 cannot parse is no focus rows, and the
 * corpus-wide search still ran.
 */
export function focusSearch(opts: FocusOptions): FocusResult {
  const { match, expanded } = focusMatch(opts.plan);
  const channels = opts.channelIds.slice(0, MAX_FOCUS_CHANNELS);
  if (match.length === 0 || channels.length === 0) {
    return { hits: [], match, expanded };
  }

  const hits: RankedEventHit[] = [];
  for (const channelId of channels) {
    try {
      hits.push(
        ...searchChannelRanked({
          channelId,
          match,
          limit: opts.limit ?? DEFAULT_FOCUS_LIMIT,
          weights: opts.weights,
        }),
      );
    } catch {
      // A pathological MATCH must cost this pass and nothing else.
    }
  }
  return { hits, match, expanded };
}
