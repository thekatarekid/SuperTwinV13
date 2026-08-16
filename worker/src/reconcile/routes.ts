// ===========================================================================
// [CODE] POST /api/reconcile/run · GET /api/reconcile/status — item 2.6.
//
// The manual caller. It is a thin shell over {@link runReconcile} on purpose:
// the third cadence must be the SAME job as the cohort boundary and the nightly
// timer, or "undo that reconcile" means two different things depending on who
// started it. Nothing here decides anything — it parses, it calls, it answers
// with the job's own report.
//
// `status` is deliberately read-only. A surface polling for the coverage meter
// or the budget line must not be able to start a pass by looking at it.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  STEADY_CALL_BUDGET,
  lastNightlyAt,
  lastReconcileRun,
  modelCallsToday,
  nightlyDue,
  pendingProvisionalCount,
  reconcileSteps,
  runReconcile,
} from "./index.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** `{}` for an empty body, `undefined` for one that is not JSON (→ 400). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return undefined;
  }
}

/** Handle a reconcile request. Returns true when it owned the request. */
export async function handleReconcileRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (method === "GET" && path === "/api/reconcile/status") {
    const now = Date.now();
    const spent = modelCallsToday(now);
    sendJson(res, 200, {
      lastNightlyAt: lastNightlyAt(),
      nightlyDue: nightlyDue(now),
      pendingProvisionals: pendingProvisionalCount(),
      budget: { limit: STEADY_CALL_BUDGET, spentToday: spent, remaining: Math.max(0, STEADY_CALL_BUDGET - spent) },
      steps: reconcileSteps().map((s) => ({ name: s.name, modelCalls: s.modelCalls })),
      lastRun: lastReconcileRun(),
    });
    return true;
  }

  if (method === "POST" && path === "/api/reconcile/run") {
    const body = await readJsonBody(req);
    if (body === undefined) {
      sendJson(res, 400, { error: "body must be JSON" });
      return true;
    }
    const batchId = typeof body.batchId === "string" && body.batchId !== "" ? body.batchId : undefined;
    const mode = body.mode === "bootstrap" || body.mode === "reprocess" ? body.mode : "steady";
    sendJson(res, 200, runReconcile({ trigger: "manual", mode, ...(batchId ? { batchId } : {}) }));
    return true;
  }

  return false;
}
