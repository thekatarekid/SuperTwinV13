// ===========================================================================
// [CODE] Assist artifact + nudge routes — build P2.3 (spec §10.5/§10.6, §14.7).
//
//   GET  /api/assist/panel            everything the menu-bar panel renders:
//                                     needs-you (approvals/questions), the
//                                     Prepared list (assist ◆ + executor ◇),
//                                     the Today strip, nudge + pause state
//   GET  /api/assist/nudge            the newest unseen artifact (or null)
//   GET  /api/artifacts?status=&limit=
//   POST /api/artifacts/:id/seen      open (clears the ● dot everywhere)
//   POST /api/artifacts/:id/dismiss   graded negative; parks in Prepared/older
//   POST /api/artifacts/:id/reopen    dismissed -> seen (restarts positive signal)
//   POST /api/artifacts/:id/graduate  through the Critic gate -> durable task
//   POST /api/artifacts/:id/signal    {signal} graded reconcile telemetry
//   POST /api/assist/pause            {minutes} | {until:null} capture quick-pause
//
// Same handler contract as every other route module: returns false for a
// path it does not claim.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  getArtifact,
  graduateArtifact,
  latestUnseen,
  listArtifacts,
  recordSignal,
  setArtifactStatus,
  type ArtifactStatus,
} from "../assist/artifacts.js";
import {
  getCapturePausedUntil,
  setCapturePausedUntil,
} from "../assist/settings.js";
import { unreadCount } from "../surfaces/router.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const STATUSES: readonly ArtifactStatus[] = ["new", "seen", "dismissed", "graduated", "expired"];

/** The §14.7 panel payload, assembled in one read. */
export function panelSnapshot(nowMs: number = Date.now()): Record<string, unknown> {
  const db = getDb();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  // NEEDS YOU: executor/decide outcomes that need action — approvals first,
  // then questions (fixed order, spec §14.7.1). Proposals ride as questions.
  const approvals = db
    .prepare(
      `SELECT id, title, space_id, risk_class FROM tasks
        WHERE status = 'needs_approval' ORDER BY updated_at DESC, created_at DESC LIMIT 10`,
    )
    .all();
  const questions = db
    .prepare(
      `SELECT id, title, space_id FROM tasks
        WHERE status = 'needs_input' ORDER BY updated_at DESC, created_at DESC LIMIT 10`,
    )
    .all();
  // PREPARED: done work only — new/seen pinned newest-first, dismissed in the
  // "older" drawer (nothing vanishes, spec §14.7.5).
  const rows = listArtifacts({ limit: 30 });
  const prepared = rows.filter((a) => a.status === "new" || a.status === "seen");
  const older = rows.filter((a) => a.status === "dismissed");
  const nudge = latestUnseen();
  const todayRows = db
    .prepare(
      `SELECT id, title, due FROM tasks
        WHERE status IN ('open','scheduled') AND due IS NOT NULL AND substr(due, 1, 10) <= ?
        ORDER BY due ASC LIMIT 6`,
    )
    .all(today);
  return {
    needs_you: { approvals, questions },
    prepared,
    older,
    nudge,
    today: todayRows,
    capture_paused_until: getCapturePausedUntil() || null,
    // V6 P1 S4.3: cards shown but not opened — the menu-bar icon's counter.
    unread: unreadCount(),
  };
}

/**
 * Handle one assist route. Returns false for any path it does not claim
 * (the server's shared handler contract).
 */
export async function handleAssistRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/assist/panel") {
    sendJson(res, 200, panelSnapshot());
    return true;
  }

  if (req.method === "GET" && path === "/api/assist/nudge") {
    sendJson(res, 200, { artifact: latestUnseen() });
    return true;
  }

  if (req.method === "GET" && path === "/api/artifacts") {
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      sendJson(res, 400, { error: `unknown status "${status}"` });
      return true;
    }
    sendJson(res, 200, {
      artifacts: listArtifacts({
        ...(status ? { status: status as ArtifactStatus } : {}),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
    return true;
  }

  const action = path.match(/^\/api\/artifacts\/([^/]+)\/(seen|dismiss|reopen|graduate|signal)$/);
  if (action && req.method === "POST") {
    const id = decodeURIComponent(action[1]!);
    const verb = action[2]!;
    const artifact = getArtifact(id);
    if (!artifact) {
      sendJson(res, 404, { error: `unknown artifact ${id}` });
      return true;
    }
    try {
      if (verb === "seen") {
        sendJson(res, 200, { artifact: setArtifactStatus(id, "seen", { by: "user" }) });
      } else if (verb === "dismiss") {
        recordSignal(id, "dismissed");
        sendJson(res, 200, { artifact: setArtifactStatus(id, "dismissed", { by: "user" }) });
      } else if (verb === "reopen") {
        recordSignal(id, "opened_dwelled");
        sendJson(res, 200, { artifact: setArtifactStatus(id, "seen", { by: "user" }) });
      } else if (verb === "graduate") {
        const result = await graduateArtifact(id);
        sendJson(res, result.status === "failed" ? 502 : 200, {
          result,
          artifact: getArtifact(id),
        });
      } else {
        const body = await readBody(req);
        const signal = typeof body.signal === "string" ? body.signal : "";
        const { weight } = recordSignal(id, signal);
        sendJson(res, 200, { recorded: signal, weight });
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.method === "POST" && path === "/api/assist/pause") {
    const body = await readBody(req);
    const before = getCapturePausedUntil() || null;
    let until: string | null = null;
    if (typeof body.until === "string" && body.until !== "") until = body.until;
    else if (typeof body.minutes === "number" && Number.isFinite(body.minutes) && body.minutes > 0) {
      until = new Date(Date.now() + body.minutes * 60_000).toISOString();
    }
    setCapturePausedUntil(until);
    // Trust surface: the pause itself is a recorded, reversible decision.
    writeDecision({
      pass: "user",
      targetKind: "capture",
      targetId: "global",
      action: until ? "pause" : "resume",
      old: { until: before },
      new: { until },
    });
    sendJson(res, 200, { capture_paused_until: until });
    return true;
  }

  return false;
}
