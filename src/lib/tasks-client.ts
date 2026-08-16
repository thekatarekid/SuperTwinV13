// [CODE] The read/write API behind the Tasks surface — arch §14.7, build
// item 3.10.
//
// A task is a LOOP whose owner is you. That sentence is the surface's entire
// safety property, and it is encoded here rather than assumed:
//
//  1. `ownerIsSelf` IS ON EVERY ROW. The worker decides it (it knows which
//     entity is `self`); the surface partitions on it (tasks/partition.ts) so
//     a loop owned by another person can never reach a task list, even if the
//     worker mislabels its section. Two independent guards, on purpose.
//  2. EXPLICIT AND IMPLICIT ARE DIFFERENT LISTS WITH DIFFERENT VERBS (§14.7
//     rule 1) — so `origin` is a closed enum, not a flag.
//  3. `possibly_done` DOES NOT EXIST (phase-3 gate). The done check is a
//     QUESTION with a quote and two answers; nothing parks in limbo.
//  4. A LAPSED TASK SAYS WHY, including "born lapsed" — `stateReason` is
//     required whenever `state` is `lapsed`, and the surface prints it.
//  5. REJECTING A SUGGESTION TEACHES. `rejectSuggestion` writes a user-sourced
//     preference claim (§14.7 rule 2); there is no delete verb on this client.

import { getJson, pathId, qs, sendJson } from "./api-http";
import type { CoverageClient, GestureActor, MutationReceipt } from "./surfaces-client";

// ---------------------------------------------------------------------------
// Vocabulary (§11.4, §11.5)
// ---------------------------------------------------------------------------

export const LOOP_STATES = ["open", "latent", "done", "lapsed", "dropped"] as const;
export type LoopState = (typeof LOOP_STATES)[number];

/** The two states a task list may show. `done`/`dropped`/`lapsed` are history. */
export const TASK_STATES: readonly LoopState[] = ["open", "latent"];

export const LOOP_ORIGINS = ["explicit", "implicit"] as const;
export type LoopOrigin = (typeof LOOP_ORIGINS)[number];

/** `au` never comes from code (item 3.8); `cx` is context, never a to-do. */
export const TRIAGES = ["auto", "approve", "context"] as const;
export type Triage = (typeof TRIAGES)[number];

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

export interface LoopEvidenceView {
  eventId: string;
  /** VERBATIM. "i'll send you that villa link tonight" (§6). */
  quote: string;
  at: string | null;
  episodeId: string | null;
}

export interface TaskView {
  id: string;
  intent: string;
  origin: LoopOrigin;
  state: LoopState;
  /** Required reading when lapsed: `born_lapsed`, `past_due_no_recurrence`, … */
  stateReason: string | null;
  /** The worker's sentence for it — printed as-is, never re-worded. */
  stateNote: string | null;
  triage: Triage;
  /** The worker's answer to "is this yours?". The surface still re-checks it. */
  ownerIsSelf: boolean;
  ownerLabel: string;
  counterpartyLabel: string | null;
  dueAt: string | null;
  dueLabel: string | null;
  recurrence: string | null;
  nextOccurrenceAt: string | null;
  /** A promoted arc — the space this task is grouped under (§14.7). */
  spaceId: string | null;
  spaceLabel: string | null;
  confidence: number | null;
  /** For implicit tasks: "inferred from: …" — the reasoning, verbatim. */
  inferredFrom: string | null;
  /** Live output on a still-open session (§14.0b): marked, updated in place. */
  provisional: boolean;
  /** "◍ 1 voice note still transcribing" (§14.0b rule 5). */
  pendingNote: string | null;
  updatedAt: string | null;
  evidence: LoopEvidenceView[];
}

/** §14.7's "DID YOU DO THIS?" — one tap, with the evidence quote. */
export interface DoneCheckView {
  id: string;
  loopId: string;
  intent: string;
  /** "I saw a booking.com link at 21:04" — the worker's own observation. */
  observation: string;
  quote: string;
  at: string | null;
}

/** §14.7's "WAITING ON OTHERS": context only. Never a to-do. */
export interface WaitingItemView {
  id: string;
  personLabel: string;
  intent: string;
  dueLabel: string | null;
}

export interface TasksPage {
  /** Every loop the worker considers relevant. Partitioning happens client-side. */
  tasks: TaskView[];
  doneChecks: DoneCheckView[];
  waitingOnOthers: WaitingItemView[];
}

export interface TaskQuery {
  origin?: LoopOrigin | null;
  spaceId?: string | null;
  q?: string;
}

export type TaskGestureKind = "done" | "drop" | "snooze";

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface TasksClient extends CoverageClient {
  listTasks(query: TaskQuery, signal?: AbortSignal): Promise<TasksPage>;
  markTask(
    p: GestureActor & { id: string; gesture: TaskGestureKind; until?: string },
  ): Promise<MutationReceipt>;
  /** "yes, track it" — an implicit suggestion the user adopted. */
  acceptSuggestion(p: GestureActor & { id: string }): Promise<MutationReceipt>;
  /** "not useful" — writes a user preference claim. Permanent, and teaching. */
  rejectSuggestion(p: GestureActor & { id: string }): Promise<MutationReceipt>;
  answerDoneCheck(
    p: GestureActor & { id: string; done: boolean },
  ): Promise<MutationReceipt>;
}

export const tasksClient: TasksClient = {
  getCoverage: (signal) => getJson("/api/coverage", signal),

  listTasks: (query, signal) =>
    getJson<TasksPage>(
      `/api/tasks${qs({
        origin: query.origin ?? undefined,
        space: query.spaceId ?? undefined,
        q: query.q,
      })}`,
      signal,
    ),

  markTask: ({ id, gesture, until, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/tasks/${pathId(id)}/${gesture}`, { until, actor }),

  acceptSuggestion: ({ id, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/tasks/${pathId(id)}/accept`, { actor }),

  rejectSuggestion: ({ id, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/tasks/${pathId(id)}/reject`, { actor }),

  answerDoneCheck: ({ id, done, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/questions/${pathId(id)}`, { done, actor }),
};
