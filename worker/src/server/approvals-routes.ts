// ===========================================================================
// [CODE] The send-gate endpoints — V6 P1 S4.5 (Build §7.2, Product_V6 §12.4,
// Product_V6_Phase1 §24 rule 2; GoldenEvals V6 P1 §5.14 GATE-A).
//
//   GET  /api/approvals                    every card still open
//   POST /api/approvals            {…}     create the card a tap will act on
//   GET  /api/approvals/:id                one card — exactly what will be sent
//   POST /api/approvals/:id/approve        THE TAP: mints the bound token
//   POST /api/approvals/:id/edit   {…}     edit → the minted token is revoked
//   POST /api/approvals/:id/cancel         walk away
//   POST /api/approvals/:id/send           dispatch the approved payload
//
// The dispatcher is the point of the whole file: it never accepts a token, a
// recipient or a body from the caller. It reads the CARD, uses the token the
// card minted, and sends the card's own payload — so the thing that leaves is
// the thing the card displayed, and a caller who can name a card still cannot
// choose what that card says. The token is consumed against the same payload
// (worker gate) and re-verified by the daemon against its signature and
// binding (daemon gate).
//
// `/api/approvals/mint` (the raw, P0.6 mint) stays where it is in
// whatsapp-routes.ts — it is the modal's tap-time mint for a draft that lives
// in a task run rather than in a card.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  approveSendApproval,
  cancelSendApproval,
  createSendApproval,
  editSendApproval,
  listOpenSendApprovals,
  liveTokenFor,
  markSendApprovalSent,
  readSendApproval,
} from "../approvals/send-approval.js";
import type { Ingestion } from "../ingest/index.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const VERBS = ["approve", "edit", "cancel", "send"] as const;
type Verb = (typeof VERBS)[number];

/**
 * Handle one send-gate request. False for a path this file does not claim
 * (including `/api/approvals/mint`, which whatsapp-routes.ts owns).
 */
export async function handleApprovalsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ingestion: Ingestion | null,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== "/api/approvals" && !path.startsWith("/api/approvals/")) return false;
  if (path === "/api/approvals/mint") return false;

  if (method === "GET" && path === "/api/approvals") {
    sendJson(res, 200, { approvals: listOpenSendApprovals() });
    return true;
  }

  // ---- POST /api/approvals { to, text, to_label?, channel?, space_id?, task_id? }
  if (method === "POST" && path === "/api/approvals") {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const to = str(body.to) ?? "";
    const text = str(body.text) ?? "";
    if (!to.trim() || !text.trim()) {
      sendJson(res, 400, { error: "to and text are required — a card must say what it will send" });
      return true;
    }
    try {
      sendJson(res, 200, {
        approval: createSendApproval({
          channel: str(body.channel),
          to,
          toLabel: str(body.to_label),
          text,
          spaceId: str(body.space_id) ?? null,
          taskId: str(body.task_id) ?? null,
        }),
      });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  const rest = path.slice("/api/approvals/".length);
  const [rawId, rawVerb, ...extra] = rest.split("/");
  const id = decodeURIComponent(rawId ?? "");
  if (!id || extra.length > 0) {
    sendJson(res, 404, { error: "unknown approvals route" });
    return true;
  }

  if (method === "GET" && !rawVerb) {
    const card = readSendApproval(id);
    if (!card) {
      sendJson(res, 404, { error: `unknown approval ${JSON.stringify(id)}` });
      return true;
    }
    sendJson(res, 200, { approval: card });
    return true;
  }

  if (method !== "POST" || !rawVerb || !(VERBS as readonly string[]).includes(rawVerb)) {
    sendJson(res, 404, { error: "unknown approvals route" });
    return true;
  }
  const verb = rawVerb as Verb;

  if (!readSendApproval(id)) {
    sendJson(res, 404, { error: `unknown approval ${JSON.stringify(id)}` });
    return true;
  }

  try {
    switch (verb) {
      // THE TAP. The token goes back to the caller once — the surface that
      // tapped may carry it into a direct send — and the card keeps its own
      // copy so /send needs no token from anyone.
      case "approve": {
        const { card, token } = approveSendApproval(id);
        sendJson(res, 200, {
          approval: card,
          token: token.token,
          action: token.action,
          expires_at: token.expires_at,
        });
        return true;
      }

      // Editing invalidates: the minted token is revoked and the card drops
      // back to pending. There is no "edit and keep the approval".
      case "edit": {
        const body = await readJsonBody(req);
        if (!body) {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        sendJson(res, 200, {
          approval: editSendApproval(id, {
            to: str(body.to),
            toLabel: str(body.to_label),
            text: str(body.text),
          }),
        });
        return true;
      }

      case "cancel":
        sendJson(res, 200, { approval: cancelSendApproval(id) });
        return true;

      case "send": {
        if (!ingestion) {
          sendJson(res, 503, { error: "source adapter not initialized" });
          return true;
        }
        const card = readSendApproval(id)!;
        const token = liveTokenFor(id);
        if (!token) {
          sendJson(res, 403, {
            error:
              card.state === "sent"
                ? "already sent"
                : "this card has not been approved — tap Approve first",
          });
          return true;
        }
        try {
          // The card's OWN payload, never the request's: what leaves is what
          // the card showed. Ingestion consumes the token against exactly
          // these two strings, and the daemon verifies them again.
          await ingestion.sendMessage({ to: card.to, text: card.text, approvalToken: token });
        } catch (err) {
          sendJson(res, 403, { error: (err as Error).message });
          return true;
        }
        sendJson(res, 200, { approval: markSendApprovalSent(id) });
        return true;
      }
    }
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return true;
  }
  return true;
}
