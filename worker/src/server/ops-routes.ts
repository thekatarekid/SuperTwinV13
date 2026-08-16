// ===========================================================================
// [CODE] Ops surface routes — build item 4.4, arch §14.0 (coverage meter on
// every surface) and §14.0c (Settings — processing).
//
// Five reads and four writes, all thin: every number comes out of the module
// that owns it (`scheduler/queue`, `providers/pool`, `claims/undo`, the
// `questions` table) rather than being recomputed here, so the ops surface and
// the scheduler can never disagree about what the pipeline is doing.
//
//   GET  /api/ops/import                 coverage rows + queue depth, one call
//   GET  /api/ops/quarantine             every quarantined unit, newest first
//   POST /api/ops/quarantine/:id/replay  back to `ready` after a fix
//   GET  /api/ops/questions              open questions, oldest first
//   POST /api/ops/questions/:id/answer   record the human's answer
//   GET  /api/ops/lanes                  pause state per lane, live
//   POST /api/ops/lanes/pause            { lane, ms } manual pause
//   POST /api/ops/lanes/resume           { lane } clear a pause early
//   POST /api/ops/runs/:id/undo          reverse-replay one run's mutations
//
// Import progress and depth travel in ONE response for the same reason
// /api/usage is one call: a meter and a backlog composed from two reads can
// disagree mid-run, and a progress bar that disagrees with itself reads as a
// silent failure (§9.7 rule 3).
//
// Undo is not a special code path: `claims/undo.ts` reverse-replays the
// `mutations` ledger and never reverses a human's row. Exactly one run per
// call — the build doc's acceptance is "undo reverses exactly one run".
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { undoRun } from "../claims/undo.js";
import { getDb } from "../db/connection.js";
import { resourcePool, RESOURCE_LIMITS, type LaneKey } from "../providers/pool.js";
import {
  listQuarantined,
  queueDepth,
  readCoverage,
  replayQuarantined,
} from "../scheduler/queue.js";

/** The lanes the ops surface may pause. Anything else is a 400, not a crash. */
export const OPS_LANES = [
  "llm:understanding",
  "llm:enrichment",
  "llm",
  "transcribe",
  "embed",
  "ffmpeg",
  "scrape",
] as const satisfies readonly LaneKey[];
export type OpsLane = (typeof OPS_LANES)[number];

/** Manual pauses are bounded: an hour at most, then the lane resumes itself. */
export const MAX_MANUAL_PAUSE_MS = 60 * 60_000;
export const DEFAULT_MANUAL_PAUSE_MS = 5 * 60_000;

function isOpsLane(v: unknown): v is OpsLane {
  return typeof v === "string" && (OPS_LANES as readonly string[]).includes(v);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Questions — the queue the resolution ladder and triage park questions on
// ---------------------------------------------------------------------------

export interface OpenQuestion {
  id: string;
  kind: string | null;
  targetKind: string | null;
  targetId: string | null;
  question: string;
  options: string[];
  askedAt: string | null;
}

/** Every open question, oldest first — the order they were owed an answer. */
export function listOpenQuestions(limit = 200): OpenQuestion[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, target_kind, target_id, question, options_json, asked_at
         FROM questions WHERE status = 'open'
        ORDER BY asked_at, id LIMIT ?`,
    )
    .all(Math.max(1, Math.floor(limit))) as {
    id: string;
    kind: string | null;
    target_kind: string | null;
    target_id: string | null;
    question: string;
    options_json: string | null;
    asked_at: string | null;
  }[];
  return rows.map((r) => {
    let options: string[] = [];
    try {
      const parsed: unknown = r.options_json ? JSON.parse(r.options_json) : [];
      if (Array.isArray(parsed)) options = parsed.map((v) => String(v));
    } catch {
      options = [];
    }
    return {
      id: r.id,
      kind: r.kind,
      targetKind: r.target_kind,
      targetId: r.target_id,
      question: r.question,
      options,
      askedAt: r.asked_at,
    };
  });
}

/**
 * Record the human's answer. `later` defers — the row stays open and nothing is
 * written, because "later" is a scheduling choice, not an answer. Any other
 * string closes the question with the answer stored verbatim; whatever machinery
 * queued the question reads it from `answer_json`, so recording and applying
 * are separate steps and no amount of route wiring can conflate them.
 */
export function answerQuestion(id: string, answer: string): { ok: boolean; deferred: boolean } {
  if (answer === "later") return { ok: true, deferred: true };
  const changes = getDb()
    .prepare(
      `UPDATE questions
          SET status = 'answered', answer_json = ?,
              answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'open'`,
    )
    .run(JSON.stringify({ answer }), id).changes;
  return { ok: changes > 0, deferred: false };
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** Lane pause state as the surface renders it. */
export interface LaneStateView {
  lane: OpsLane;
  pausedForMs: number;
  paused: boolean;
  /** Configured concurrency ceiling for the class (LLM lanes share `llm`). */
  limit: number;
}

function laneStates(): LaneStateView[] {
  const llmLimit = resourcePool.effectiveLlmLimit();
  return OPS_LANES.map((lane) => {
    const cls = lane.startsWith("llm") ? "llm" : (lane as keyof typeof RESOURCE_LIMITS);
    return {
      lane,
      pausedForMs: resourcePool.pausedForMs(lane),
      paused: resourcePool.isPaused(lane),
      limit: cls === "llm" ? llmLimit : RESOURCE_LIMITS[cls].default,
    };
  });
}

/** Handle an ops request. Returns true when this module owns the path. */
export async function handleOpsRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/ops/")) return false;

  // ---- GET /api/ops/import → the meter and the backlog, one read ----------
  if (method === "GET" && path === "/api/ops/import") {
    sendJson(res, 200, {
      coverage: readCoverage("global", "all"),
      depth: queueDepth(),
      lanes: laneStates(),
    });
    return true;
  }

  // ---- GET /api/ops/quarantine --------------------------------------------
  if (method === "GET" && path === "/api/ops/quarantine") {
    sendJson(res, 200, { items: listQuarantined() });
    return true;
  }

  // ---- POST /api/ops/quarantine/:id/replay --------------------------------
  const replay = path.match(/^\/api\/ops\/quarantine\/([^/]+)\/replay$/);
  if (method === "POST" && replay) {
    const id = decodeURIComponent(replay[1]!);
    const replayed = replayQuarantined(id);
    sendJson(res, replayed ? 200 : 404, { ok: replayed, id });
    return true;
  }

  // ---- GET /api/ops/questions ---------------------------------------------
  if (method === "GET" && path === "/api/ops/questions") {
    sendJson(res, 200, { questions: listOpenQuestions() });
    return true;
  }

  // ---- POST /api/ops/questions/:id/answer ---------------------------------
  const answer = path.match(/^\/api\/ops\/questions\/([^/]+)\/answer$/);
  if (method === "POST" && answer) {
    const id = decodeURIComponent(answer[1]!);
    const body = await readJsonBody(req);
    const value = body?.answer;
    if (typeof value !== "string" || value === "") {
      sendJson(res, 400, { error: "answer (string) required" });
      return true;
    }
    const outcome = answerQuestion(id, value);
    if (!outcome.ok) {
      sendJson(res, 404, { error: "no open question with that id" });
      return true;
    }
    sendJson(res, 200, { ok: true, id, deferred: outcome.deferred });
    return true;
  }

  // ---- GET /api/ops/lanes -------------------------------------------------
  if (method === "GET" && path === "/api/ops/lanes") {
    sendJson(res, 200, { lanes: laneStates() });
    return true;
  }

  // ---- POST /api/ops/lanes/pause { lane, ms? } ----------------------------
  if (method === "POST" && path === "/api/ops/lanes/pause") {
    const body = await readJsonBody(req);
    if (!isOpsLane(body?.lane)) {
      sendJson(res, 400, { error: `lane must be one of ${OPS_LANES.join(", ")}` });
      return true;
    }
    const raw = Number(body?.ms ?? DEFAULT_MANUAL_PAUSE_MS);
    const ms = Number.isFinite(raw)
      ? Math.min(MAX_MANUAL_PAUSE_MS, Math.max(1_000, Math.floor(raw)))
      : DEFAULT_MANUAL_PAUSE_MS;
    resourcePool.pauseLane(body.lane, ms);
    sendJson(res, 200, { ok: true, lane: body.lane, pausedForMs: resourcePool.pausedForMs(body.lane) });
    return true;
  }

  // ---- POST /api/ops/lanes/resume { lane } --------------------------------
  if (method === "POST" && path === "/api/ops/lanes/resume") {
    const body = await readJsonBody(req);
    if (!isOpsLane(body?.lane)) {
      sendJson(res, 400, { error: `lane must be one of ${OPS_LANES.join(", ")}` });
      return true;
    }
    resourcePool.resumeLane(body.lane);
    sendJson(res, 200, { ok: true, lane: body.lane, pausedForMs: 0 });
    return true;
  }

  // ---- POST /api/ops/runs/:id/undo ----------------------------------------
  const undo = path.match(/^\/api\/ops\/runs\/([^/]+)\/undo$/);
  if (method === "POST" && undo) {
    const runId = decodeURIComponent(undo[1]!);
    const result = undoRun(runId, { actor: "user" });
    sendJson(res, 200, result);
    return true;
  }

  sendJson(res, 404, { error: "unknown ops route" });
  return true;
}
