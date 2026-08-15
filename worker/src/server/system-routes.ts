// ===========================================================================
// System API routes — run history, log files, the brain-wiki folder, and the
// 👍/👎 evaluations the Chat tab posts.
//
// These are the pieces of the old phase-3 route module that survive in V8:
// everything the Settings screen reads. The task-queue, chat write-access and
// executor routes that lived alongside them are gone with the task engine.
//
// Same handled-boolean shape as the other route modules: `handleSystemRoute`
// returns true when it owns the request, false to fall through.
// ===========================================================================

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { brainRoot } from "../brain/index.js";
import { ensureLogsDir } from "../logs.js";
import * as store from "../store/store.js";

/** Rows one /api/runs page may ask for, and how deep into history it may start. */
const MAX_RUNS_PAGE = 1000;
const MAX_RUNS_OFFSET = 100_000;

/** Injectable deps. Only the folder-reveal seam, so tests never pop a Finder window. */
export interface SystemDeps {
  /**
   * Reveal a folder in the OS file browser. Injectable so tests can stub it —
   * the real default shells `open <dir>` on macOS (and would pop a Finder
   * window, holding the temp dir open and racing teardown). Optional: falls
   * back to {@link defaultOpenPath} when unset (production).
   */
  openPath?: (dir: string) => void;
}

/**
 * Default folder-reveal: best-effort `open <dir>` on macOS. Never throws — a
 * spawn failure (or a non-darwin host) is silently ignored.
 */
export function defaultOpenPath(dir: string): void {
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", [dir], { stdio: "ignore" });
      child.on("error", () => {
        /* best-effort — reveal never throws */
      });
    }
  } catch {
    /* best-effort */
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A query number held between two bounds; anything unreadable is `fallback`. */
function clamp(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Best-effort recursive file count under `dir` (skips `.git`). Never throws. */
function countFilesRecursive(dir: string): number {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      if (e.isDirectory()) n += countFilesRecursive(join(dir, e.name));
      else if (e.isFile()) n += 1;
    }
  } catch {
    /* unreadable / missing dir → count what we have */
  }
  return n;
}

/** Handle a system request. Returns true when handled. */
export async function handleSystemRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SystemDeps = {},
): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // ======================= Runs viewer =====================================

  // ---- GET /api/runs?limit=&offset= → one page of the LLM calls the worker
  // has made, newest first. `offset` is what lets the viewer reach every run
  // rather than only the newest page: a short page means there are no older
  // ones, so nothing has to count the table to know when to stop.
  if (method === "GET" && path === "/api/runs") {
    const limit = clamp(url.searchParams.get("limit"), 100, 1, MAX_RUNS_PAGE);
    const offset = clamp(url.searchParams.get("offset"), 0, 0, MAX_RUNS_OFFSET);
    // The store reads with LIMIT alone, and its sort is over the whole table
    // whatever that limit is, so the page is cut from the front of one read.
    sendJson(res, 200, { runs: store.listRuns(offset + limit).slice(offset) });
    return true;
  }

  // ======================= Logs ============================================

  // ---- GET /api/logs/info → { dir, files }
  if (method === "GET" && path === "/api/logs/info") {
    const dir = ensureLogsDir();
    let files: { name: string; size: number; modified: string }[] = [];
    try {
      files = readdirSync(dir)
        .map((name) => {
          try {
            const st = statSync(join(dir, name));
            if (!st.isFile()) return null;
            return { name, size: st.size, modified: st.mtime.toISOString() };
          } catch {
            return null;
          }
        })
        .filter(
          (f): f is { name: string; size: number; modified: string } =>
            f !== null,
        );
    } catch {
      files = [];
    }
    sendJson(res, 200, { dir, files });
    return true;
  }

  // ---- POST /api/logs/reveal → best-effort `open <logsDir>` (macOS).
  if (method === "POST" && path === "/api/logs/reveal") {
    const dir = ensureLogsDir();
    (deps.openPath ?? defaultOpenPath)(dir);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ======================= Brain wiki folder ===============================

  // ---- GET /api/brain/info → { dir, fileCount }
  if (method === "GET" && path === "/api/brain/info") {
    const dir = brainRoot();
    sendJson(res, 200, { dir, fileCount: countFilesRecursive(dir) });
    return true;
  }

  // ---- POST /api/brain/reveal → best-effort `open <brainRoot>` (macOS).
  if (method === "POST" && path === "/api/brain/reveal") {
    const dir = brainRoot();
    (deps.openPath ?? defaultOpenPath)(dir);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ======================= Evaluations =====================================
  // Kept from the phase-2 route module: the chat 👍/👎 buttons post here. The
  // quality/digest reports that also read these rows are out of scope, but the
  // signal is cheap to record and the thumbs are part of grounded chat.

  // ---- POST /api/evaluations
  if (method === "POST" && path === "/api/evaluations") {
    const body = (await readJsonBody(req)) as
      | {
          output_type?: unknown;
          output_id?: unknown;
          verdict?: unknown;
          note?: unknown;
        }
      | undefined;
    const outputId = typeof body?.output_id === "string" ? body.output_id : null;
    const verdict = body?.verdict;
    if (
      !body ||
      !store.isEvalOutputType(body.output_type) ||
      !outputId ||
      (verdict !== "up" && verdict !== "down")
    ) {
      sendJson(res, 400, {
        error: "output_type, output_id and verdict (up|down) required",
      });
      return true;
    }
    store.addEvaluation({
      outputType: body.output_type,
      outputId,
      verdict,
      note: typeof body.note === "string" ? body.note : null,
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- GET /api/evaluations/summary
  if (method === "GET" && path === "/api/evaluations/summary") {
    sendJson(res, 200, { by_type: store.evaluationSummary() });
    return true;
  }

  return false;
}
