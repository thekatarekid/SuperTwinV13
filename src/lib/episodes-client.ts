// [CODE] The read/write API behind the Episodes surface — arch §14.3, build
// item 2.7.
//
// An episode is a set of sessions that got there for a reason, and §14.3 makes
// the reason the content of the surface: every session row is a PROVENANCE row
// (`seed` / `ATTACHED conf 0.93 "continues the Amara booking"` / `SPLIT from
// session Wed 20:40`), and `[ why? ]` renders the PERSISTED verdict — "the
// exact candidates the model saw and its stated reason".
//
// Three shape decisions follow from that sentence and are worth stating:
//
//  1. THE VERDICT IS STORED, NOT RECONSTRUCTED. `EpisodeVerdictView` is what
//     `episode_verdicts` holds — candidates in the order the model saw them,
//     its decision, its reason verbatim. A surface that re-derived "why" would
//     be showing today's reasoning for yesterday's decision.
//  2. A CODE RULE HAS NO VERDICT AND SAYS SO. The 1:1 default spends no model
//     call (§11.1), so `verdict` is null and `decidedBy` carries `code:1v1`.
//     Null renders as "no model was asked", never as a blank.
//  3. EVERY MEMBERSHIP ROW CARRIES ITS SIGNAL AND ITS VALUE — the item's
//     acceptance criterion. `decidedBy` is the signal, `confidence` the value,
//     and both are on the row rather than looked up from somewhere else.

import { getJson, pathId, qs, sendJson } from "./api-http";
import type { CoverageClient, GestureActor, MutationReceipt } from "./surfaces-client";

// ---------------------------------------------------------------------------
// Filters (§14.3's `[open 22][closed·concluded 61][closed·faded 31]`)
// ---------------------------------------------------------------------------

/**
 * The three state buckets the head offers. `closed` splits by OUTCOME because
 * §11.1 rule 5's fade is the clock's doing and a conclusion is the episode's —
 * a surface that showed one "closed 92" would hide that difference.
 */
export const EPISODE_STATE_FILTERS = ["open", "concluded", "faded"] as const;
export type EpisodeStateFilter = (typeof EPISODE_STATE_FILTERS)[number];

export const EPISODE_STATE_LABEL: Record<EpisodeStateFilter, string> = {
  open: "open",
  concluded: "closed·concluded",
  faded: "closed·faded",
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** How a session came to be in this episode. */
export type EpisodeProvenance = "seed" | "attached" | "split";

/** One candidate as the model was shown it — same order, same labels. */
export interface VerdictCandidate {
  episodeId: string;
  label: string | null;
  lastActiveAt: string | null;
}

/** The persisted `episode_verdicts` row `[ why? ]` renders. Never rebuilt. */
export interface EpisodeVerdictView {
  id: string;
  /** `at` | `nw` | `sp` — the wire decision, verbatim (§5). */
  decision: string;
  /** The model's stated reason, verbatim and unelided (brief rule 9). */
  reason: string;
  confidence: number | null;
  /** Exactly the candidate set the model saw, in the order it saw it. */
  candidates: VerdictCandidate[];
  model: string | null;
  createdAt: string | null;
}

/** One membership row: a session, and why it is in this episode. */
export interface EpisodeSessionView {
  sessionId: string;
  streamLabel: string;
  startedAt: string | null;
  provenance: EpisodeProvenance;
  /** THE SIGNAL — `code:1v1`, `agent:p-ep2`, `ml`, `user`. Never invented. */
  decidedBy: string | null;
  /** THE VALUE — null means nobody measured one, which is not zero. */
  confidence: number | null;
  /** One-line reason. Empty when a code rule needed none. */
  reason: string;
  /** `split` only: the session this topic was cut out of, and how many topics. */
  splitFromSessionId: string | null;
  splitTopicCount: number | null;
  /** Null when no model was asked — see rule 2 in the header. */
  verdict: EpisodeVerdictView | null;
  /** The session is still open, so this row is live output (§14.0b). */
  sessionOpen: boolean;
}

export interface EpisodeView {
  id: string;
  label: string | null;
  labelSource: string | null;
  state: "open" | "closed";
  /** `concluded` | `faded` | any outcome the model or user set. Null while open. */
  outcome: string | null;
  sourceLabel: string;
  streamId: string | null;
  streamLabel: string;
  startedAt: string | null;
  lastActiveAt: string | null;
  /** How long it has been quiet — the 14-day fade clock, as measured (§11.1). */
  quietDays: number | null;
  sessions: EpisodeSessionView[];
  entities: { id: string; label: string }[];
  /** The arc it belongs to, when one has been bound. */
  arc: { id: string; label: string | null } | null;
  /** Minted this pass and not yet reconciled — live output (§14.0b). */
  provisional: boolean;
  /** An episode that was split OUT of another can be merged back. */
  splitFromEpisodeId: string | null;
}

export interface EpisodesPage {
  episodes: EpisodeView[];
  /** Whole-corpus totals for the head chips, not this page's. */
  counts: Record<EpisodeStateFilter, number>;
  streams: { id: string; label: string }[];
}

export interface EpisodeQuery {
  state?: EpisodeStateFilter | null;
  streamId?: string | null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface EpisodesClient extends CoverageClient {
  listEpisodes(query: EpisodeQuery, signal?: AbortSignal): Promise<EpisodesPage>;

  /** Pull one session out; it becomes its own episode. */
  detachSession(p: GestureActor & { id: string; sessionId: string }): Promise<MutationReceipt>;
  /** Cut this episode in two at the named sessions. */
  splitEpisode(p: GestureActor & { id: string; sessionIds: string[] }): Promise<MutationReceipt>;
  /** Undo a split: fold this episode back into the one it came from. */
  mergeEpisode(p: GestureActor & { id: string; into: string }): Promise<MutationReceipt>;
  relabelEpisode(p: GestureActor & { id: string; label: string }): Promise<MutationReceipt>;
  closeEpisode(p: GestureActor & { id: string; outcome: string }): Promise<MutationReceipt>;
}

export const episodesClient: EpisodesClient = {
  getCoverage: (signal) => getJson("/api/coverage", signal),

  listEpisodes: (query, signal) =>
    getJson<EpisodesPage>(
      `/api/episodes${qs({
        state: query.state ?? undefined,
        stream: query.streamId ?? undefined,
      })}`,
      signal,
    ),

  detachSession: ({ id, sessionId, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/episodes/${pathId(id)}/detach`, { sessionId, actor }),

  splitEpisode: ({ id, sessionIds, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/episodes/${pathId(id)}/split`, { sessionIds, actor }),

  mergeEpisode: ({ id, into, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/episodes/${pathId(id)}/merge`, { into, actor }),

  relabelEpisode: ({ id, label, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/episodes/${pathId(id)}/relabel`, { label, actor }),

  closeEpisode: ({ id, outcome, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/episodes/${pathId(id)}/close`, { outcome, actor }),
};
