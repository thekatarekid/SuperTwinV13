// ===========================================================================
// [CODE] The brief's endpoints — V6 P1 S4.6 (Build §7.2 lane B; Product_V6
// §14.4 item 7 "one card: needs you, today, what moved since the last brief").
//
//   GET  /api/brief                 the standing brief card: prose, the ledger
//                                   it was composed from, the delta that
//                                   justified it, and whether it is unread
//   GET  /api/brief/history?limit=  the last N briefs (the timeline entry)
//   POST /api/brief/:id/seen        the card was opened — the ● clears
//   POST /api/brief/run             compose now ({"force":true} to write one
//                                   even with no delta — the user asked)
//
// The card is its own surface, not a nudge: nothing here touches the router,
// the artifacts table or the unread nudge counter. `null` is a normal answer
// — before the first set time, and on any day nothing moved.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  latestBrief,
  listBriefs,
  markBriefSeen,
  readBriefTimes,
  runBrief,
  type BriefRow,
} from "../brief/index.js";
import { briefTimes } from "../brief/schedule.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The card shape the UI renders. */
export function briefView(row: BriefRow | null): Record<string, unknown> {
  return {
    brief: row
      ? {
          id: row.id,
          slot: row.slot,
          tz: row.tz,
          composed_at: row.composedAt,
          since: row.since,
          text: row.text,
          ledger: row.ledger,
          delta_rows: row.deltaRows,
          model_calls: row.modelCalls,
          run_id: row.runId,
          unread: row.seenAt === null,
        }
      : null,
    times: briefTimes(readBriefTimes()),
  };
}

/** Handle one brief request. False for a path it does not claim. */
export async function handleBriefRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== "/api/brief" && !path.startsWith("/api/brief/")) return false;

  if (method === "GET" && path === "/api/brief") {
    sendJson(res, 200, briefView(latestBrief()));
    return true;
  }

  if (method === "GET" && path === "/api/brief/history") {
    const limit = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("limit") ?? 20);
    sendJson(res, 200, {
      briefs: listBriefs(Number.isFinite(limit) ? limit : 20).map((b) => ({
        id: b.id,
        slot: b.slot,
        composed_at: b.composedAt,
        text: b.text,
        delta_rows: b.deltaRows,
        unread: b.seenAt === null,
      })),
    });
    return true;
  }

  if (method === "POST" && path === "/api/brief/run") {
    const body = await readJsonBody(req);
    const report = await runBrief({ force: body.force === true });
    sendJson(res, 200, {
      status: report.status,
      reason: report.reason ?? null,
      model_calls: report.modelCalls,
      violations: report.violations,
      ...briefView(report.brief),
    });
    return true;
  }

  const seen = /^\/api\/brief\/([^/]+)\/seen$/.exec(path);
  if (method === "POST" && seen) {
    const row = markBriefSeen(decodeURIComponent(seen[1]!));
    if (!row) {
      sendJson(res, 404, { error: "unknown brief" });
      return true;
    }
    sendJson(res, 200, briefView(row));
    return true;
  }

  sendJson(res, 404, { error: `no brief route for ${method} ${path}` });
  return true;
}
