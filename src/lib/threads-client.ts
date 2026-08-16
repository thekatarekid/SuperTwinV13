// [CODE] The read/write API behind the Threads surface — arch §14.4 (arcs),
// build item 2.7.
//
// A thread is an arc. The surface lists ALL of them, promoted to a space or
// not, because "promoted" is a field on `arcs` (brief rule 6) and not a
// different kind of object — hiding the unpromoted ones would hide most of what
// the binder actually did.
//
// The shapes here exist to make one sentence enforceable: **binding signals in
// precedence order with measured values.**
//
//  1. THE RUNG IS A NUMBER, NOT A WORD. `rung: 1|2|3|4` is the §11.2 ladder
//     position, and the surface sorts by it. If the client shipped a
//     pre-sorted list the order would be the worker's opinion; sorting on the
//     rung means precedence order is a property of the data.
//  2. A SIGNAL WITHOUT A MEASURED VALUE IS NOT A SIGNAL. `value` and `measure`
//     travel together — `J=0.75`, `0.71`, `conf 0.90`, `exact` — and a null
//     value renders as "not measured" rather than as blank. This is the item's
//     acceptance criterion: EVERY membership row shows its signal and value.
//  3. `un` IS A QUESTION, NOT A STATE. P-AG2's unsure verdict goes to the user
//     (§11.2 rule 5), so it lives in its own queue with the model's reasoning
//     verbatim, and nothing is bound while it waits.

import { getJson, pathId, qs, sendJson } from "./api-http";
import type { CoverageClient, GestureActor, MutationReceipt } from "./surfaces-client";

// ---------------------------------------------------------------------------
// State (§14.4's `[live 18][dormant 24][archived 61]`)
// ---------------------------------------------------------------------------

export const ARC_STATES = ["live", "dormant", "archived"] as const;
export type ArcState = (typeof ARC_STATES)[number];

// ---------------------------------------------------------------------------
// Binding signals — the core of the surface
// ---------------------------------------------------------------------------

/** The §11.2 ladder rung. 1 is a shared literal; 4 is a model's opinion. */
export type ArcRung = 1 | 2 | 3 | 4;

/** How to read a signal's `value`. */
export type SignalMeasure = "exact" | "jaccard" | "score" | "confidence";

export interface BindingSignalView {
  id: string;
  rung: ArcRung;
  /** `url`, `attendees`, `overlap`, `adjudicated` — the signal's own name. */
  signal: string;
  /** The literal or the measurement. Null is "not measured", never zero. */
  value: string | number | null;
  measure: SignalMeasure | null;
  /** The pair it bound: `web ↔ wa`, `mmt ep`. */
  between: string;
  /** The episode this signal admitted, when it admitted one. */
  episodeId: string | null;
  /** Rung ④'s stated reason, verbatim. Null on the code and [ML] rungs. */
  reason: string | null;
}

/** One dot on the source-contribution timeline — §14.4's core visual. */
export interface ArcContribution {
  episodeId: string;
  /** `wa`, `web`, `gmail`, `cal`, `mmt` — short, because it labels a tick. */
  sourceLabel: string;
  at: string;
}

/** One membership row: an episode, and (via `bindings`) why it is in the arc. */
export interface ArcEpisodeView {
  episodeId: string;
  label: string | null;
  sourceLabel: string;
  at: string | null;
}

export interface ArcView {
  id: string;
  label: string | null;
  state: ArcState;
  pinned: boolean;
  /** Promotion is a FIELD on the arc (brief rule 6), not a separate object. */
  promotedSpaceId: string | null;
  promotedLabel: string | null;
  /** Precedence order is derived from `rung`, not from this array's order. */
  bindings: BindingSignalView[];
  episodes: ArcEpisodeView[];
  contributions: ArcContribution[];
  anchors: { id: string; label: string }[];
  sourceCount: number;
  /** Older cohorts are still landing — "⟳ still growing" (§14.4). */
  stillGrowing: boolean;
  /** The horizon the growth is waiting on, e.g. "90d+". */
  growingNote: string | null;
  /** Minted this pass, no id a user can rely on yet (§11.2). */
  provisional: boolean;
  lastActiveAt: string | null;
}

export interface ArcsPage {
  arcs: ArcView[];
  counts: Record<ArcState, number>;
}

export interface ArcQuery {
  state?: ArcState | null;
  q?: string;
  pinnedOnly?: boolean;
}

// ---------------------------------------------------------------------------
// The unsure queue (§11.2 rule 5)
// ---------------------------------------------------------------------------

export interface ArcQuestionView {
  id: string;
  episodeId: string;
  episodeLabel: string | null;
  arcId: string;
  arcLabel: string | null;
  /** P-AG2's reasoning, verbatim. */
  reasoning: string;
  confidence: number | null;
  askedAt: string | null;
}

export type ArcAnswer = "same" | "separate" | "later";

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ThreadsClient extends CoverageClient {
  listArcs(query: ArcQuery, signal?: AbortSignal): Promise<ArcsPage>;
  listArcQuestions(signal?: AbortSignal): Promise<ArcQuestionView[]>;

  removeArcEpisode(p: GestureActor & { id: string; episodeId: string }): Promise<MutationReceipt>;
  splitArc(p: GestureActor & { id: string; episodeIds: string[] }): Promise<MutationReceipt>;
  mergeArc(p: GestureActor & { id: string; into: string }): Promise<MutationReceipt>;
  pinArc(p: GestureActor & { id: string; pinned: boolean }): Promise<MutationReceipt>;
  relabelArc(p: GestureActor & { id: string; label: string }): Promise<MutationReceipt>;
  answerArcQuestion(p: GestureActor & { id: string; answer: ArcAnswer }): Promise<MutationReceipt>;
}

export const threadsClient: ThreadsClient = {
  getCoverage: (signal) => getJson("/api/coverage", signal),

  listArcs: (query, signal) =>
    getJson<ArcsPage>(
      `/api/arcs${qs({
        state: query.state ?? undefined,
        q: query.q,
        pinned: query.pinnedOnly ? "1" : undefined,
      })}`,
      signal,
    ),

  listArcQuestions: (signal) => getJson<ArcQuestionView[]>("/api/arcs/questions", signal),

  removeArcEpisode: ({ id, episodeId, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/arcs/${pathId(id)}/remove-episode`, {
      episodeId,
      actor,
    }),

  splitArc: ({ id, episodeIds, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/arcs/${pathId(id)}/split`, { episodeIds, actor }),

  mergeArc: ({ id, into, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/arcs/${pathId(id)}/merge`, { into, actor }),

  pinArc: ({ id, pinned, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/arcs/${pathId(id)}/pin`, { pinned, actor }),

  relabelArc: ({ id, label, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/arcs/${pathId(id)}/relabel`, { label, actor }),

  answerArcQuestion: ({ id, answer, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/arcs/questions/${pathId(id)}`, { answer, actor }),
};
