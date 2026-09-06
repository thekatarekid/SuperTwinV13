// ===========================================================================
// [CODE] Task list + one-tap closure routes (V6 P1 S5.2, Product_V6 §11.13,
// Product_V6_Phase1 §14).
//
//   GET  /api/tasks?tz=&space=          the ONE prioritized list — sections in
//                                       display order, every row scored with
//                                       its factors (the hover explanation).
//   POST /api/tasks/:id/done            the user says done → closes (hard
//                                       evidence), follow-ups on close.
//   POST /api/tasks/:id/cancel          closes as cancelled, never done.
//   POST /api/tasks/:id/not-yet         answers a "done?" card: stays open,
//                                       asked again after the cooldown.
//
// Read + mutate through tasks/priority.ts and tasks/closure-rules.ts; the
// executor's own /api/tasks/:id/(run|execute|answer|send) live next door in
// executor-routes.ts and are not touched here. Zero model calls.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { answerDone } from "../tasks/closure-rules.js";
import { DEFAULT_TZ, listPrioritizedTasks } from "../tasks/priority.js";

const CLOSE_PATH = /^\/api\/tasks\/([^/]+)\/(done|cancel|not-yet)$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function validTz(tz: string | null): string {
  if (tz === null || tz.trim() === "") return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Handle one task-list route. Returns false for any path it does not claim. */
export async function handleTasksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { now?: () => Date } = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const now = deps.now?.() ?? new Date();

  if (path === "/api/tasks" && req.method === "GET") {
    const list = listPrioritizedTasks({
      now,
      tz: validTz(url.searchParams.get("tz")),
      spaceId: url.searchParams.get("space"),
    });
    sendJson(res, 200, list);
    return true;
  }

  const close = CLOSE_PATH.exec(path);
  if (close && req.method === "POST") {
    const id = decodeURIComponent(close[1]!);
    const answer = close[2] === "done" ? "done" : close[2] === "cancel" ? "cancelled" : "not_yet";
    const result = answerDone(id, answer, now, "user");
    if (!result.ok) {
      sendJson(res, 404, { error: result.error ?? "unknown task" });
      return true;
    }
    sendJson(res, 200, { id, status: result.status, next_step_queued: result.nextStepQueued });
    return true;
  }
  return false;
}
