// [CODE] The read/write API behind the Ops surface — build item 4.4.
//
// Every shape mirrors `worker/src/server/ops-routes.ts` field for field. The
// surface renders what the worker measured and never recomputes: the coverage
// fraction, the pause countdown and the undo receipt are the worker's numbers,
// because an ops panel that disagrees with the scheduler about what the
// pipeline is doing is worse than no panel at all.

import { getJson, pathId, sendJson } from "./api-http";

// ---------------------------------------------------------------------------
// Import progress (§9.7 rule 3 — monotonic, legible)
// ---------------------------------------------------------------------------

export interface OpsCoverageRow {
  scopeKind: "global" | "source" | "stream";
  scopeId: string;
  horizon: string;
  totalUnits: number;
  doneUnits: number;
  /** done/total as the worker computed it; the UI only formats it. */
  fraction: number;
}

/** `work_queue` rows by state — the backlog beside the meter. */
export type OpsQueueDepth = Record<"ready" | "running" | "done" | "paused" | "quarantined", number>;

// ---------------------------------------------------------------------------
// Lanes (§9.4 — two lanes, neither may stall the pipeline)
// ---------------------------------------------------------------------------

export const OPS_LANES = [
  "llm:understanding",
  "llm:enrichment",
  "llm",
  "transcribe",
  "embed",
  "ffmpeg",
  "scrape",
] as const;
export type OpsLane = (typeof OPS_LANES)[number];

export interface LaneStateView {
  lane: OpsLane;
  pausedForMs: number;
  paused: boolean;
  limit: number;
}

export interface OpsImportView {
  coverage: OpsCoverageRow[];
  depth: OpsQueueDepth;
  lanes: LaneStateView[];
}

// ---------------------------------------------------------------------------
// Quarantine (§9.7 — per-unit quarantine so the rest keep moving)
// ---------------------------------------------------------------------------

export interface QuarantinedUnitView {
  id: string;
  unitKind: string;
  unitId: string;
  cohortId: string | null;
  stage: string;
  priority: number;
  attempts: number;
  state: string;
  createdAt: string | null;
}

// ---------------------------------------------------------------------------
// Questions — the ladder's terminus is a human, never a guess
// ---------------------------------------------------------------------------

export interface OpenQuestionView {
  id: string;
  kind: string | null;
  targetKind: string | null;
  targetId: string | null;
  question: string;
  options: string[];
  askedAt: string | null;
}

// ---------------------------------------------------------------------------
// Undo — reverse-replay of one run's mutations ledger
// ---------------------------------------------------------------------------

export interface UndoRunResult {
  runId: string;
  reversed: string[];
  skippedUserMutations: string[];
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface OpsClient {
  getImport(signal?: AbortSignal): Promise<OpsImportView>;
  listQuarantine(signal?: AbortSignal): Promise<QuarantinedUnitView[]>;
  replayQuarantined(id: string): Promise<{ ok: boolean; id: string }>;
  listQuestions(signal?: AbortSignal): Promise<OpenQuestionView[]>;
  answerQuestion(id: string, answer: string): Promise<{ ok: boolean; deferred: boolean }>;
  pauseLane(lane: OpsLane, ms?: number): Promise<{ ok: boolean; pausedForMs: number }>;
  resumeLane(lane: OpsLane): Promise<{ ok: boolean }>;
  undoRun(runId: string): Promise<UndoRunResult>;
}

export const httpOpsClient: OpsClient = {
  getImport: (signal) => getJson<OpsImportView>("/api/ops/import", signal),
  listQuarantine: async (signal) =>
    (await getJson<{ items: QuarantinedUnitView[] }>("/api/ops/quarantine", signal)).items,
  replayQuarantined: (id) =>
    sendJson<{ ok: boolean; id: string }>("POST", `/api/ops/quarantine/${pathId(id)}/replay`, {}),
  listQuestions: async (signal) =>
    (await getJson<{ questions: OpenQuestionView[] }>("/api/ops/questions", signal)).questions,
  answerQuestion: (id, answer) =>
    sendJson<{ ok: boolean; deferred: boolean }>("POST", `/api/ops/questions/${pathId(id)}/answer`, { answer }),
  pauseLane: (lane, ms) =>
    sendJson<{ ok: boolean; pausedForMs: number }>("POST", "/api/ops/lanes/pause", { lane, ms }),
  resumeLane: (lane) => sendJson<{ ok: boolean }>("POST", "/api/ops/lanes/resume", { lane }),
  undoRun: (runId) => sendJson<UndoRunResult>("POST", `/api/ops/runs/${pathId(runId)}/undo`, {}),
};
