// ===========================================================================
// [CODE] Library storage routes — V6 P1 S1.8 (Build §4.2; backlog T5-5/6/7).
//
//   GET  /api/library/storage      free disk first, then per source two bars
//                                  (searchable · understood) with bytes per
//                                  tier, the searchable-only note, and the two
//                                  disk budgets
//   POST /api/library/budgets      {events_bytes_per_year?, media_bytes?,
//                                   media_retention_days?} → the budgets
//
// Registered BEFORE handleLibraryRoute in server/index.ts; returns false for
// any path it does not claim (the shared handler contract).
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { BudgetInputError, getDiskBudgets, setDiskBudgets, storageOverview } from "../library/storage.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function handleLibraryStorageRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/library/storage") {
    // V6 P1 S6d L1: the measured half (per-source bars, the two directory
    // walks) is snapshotted; `?refresh=1` forces a re-measure for the panel's
    // own refresh control. Free disk and the budgets are always live.
    sendJson(res, 200, storageOverview(undefined, { refresh: url.searchParams.get("refresh") === "1" }));
    return true;
  }

  if (req.method === "GET" && path === "/api/library/budgets") {
    sendJson(res, 200, { budgets: getDiskBudgets() });
    return true;
  }

  if (req.method === "POST" && path === "/api/library/budgets") {
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "a JSON body with at least one budget field is required" });
      return true;
    }
    const patch: Record<string, unknown> = {};
    for (const k of ["events_bytes_per_year", "media_bytes", "media_retention_days"] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: "a JSON body with at least one budget field is required" });
      return true;
    }
    try {
      sendJson(res, 200, { budgets: setDiskBudgets(patch) });
    } catch (err) {
      if (err instanceof BudgetInputError) {
        sendJson(res, 400, { error: err.message });
        return true;
      }
      throw err;
    }
    return true;
  }

  return false;
}
