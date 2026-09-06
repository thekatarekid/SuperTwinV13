// ===========================================================================
// [CODE] The surface router's endpoints — V6 P1 S4.3 (Build §7.1,
// Product_V6_Phase1 §18, Product_V6 §14.3–14.5).
//
//   GET  /api/surfaces/nudge              the one card showing now (or null),
//                                         the unread counter, presence, the
//                                         card duration, and the whole routed
//                                         plan (the panel's Prepared order)
//   GET  /api/surfaces/route              the plan alone — "where would this
//                                         go?", the trust surface behind it
//   POST /api/surfaces/nudge/:id/shown    the card went up (unread +1)
//   POST /api/surfaces/nudge/:id/opened   Open — the dot clears
//   POST /api/surfaces/nudge/:id/not-now  Not now — ranks the kind down
//   POST /api/surfaces/nudge/:id/auto-close  the 60-second close; nothing lost
//
// The nudge window polls the GET and calls one of the POSTs; every POST
// answers with the fresh unread count so the menu-bar glyph never drifts from
// the truth. Nothing here decides WHETHER to show anything — that is the
// router's whole point, and it has no such branch.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  autoCloseCard,
  markCardShown,
  notNowCard,
  nudgeView,
  openCard,
  routeNow,
  unreadCount,
} from "../surfaces/router.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const VERBS = ["shown", "opened", "not-now", "auto-close"] as const;
type Verb = (typeof VERBS)[number];

/** Handle one surface-router request. False for a path it does not claim. */
export async function handleNudgeRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/surfaces/")) return false;

  if (method === "GET" && path === "/api/surfaces/nudge") {
    sendJson(res, 200, nudgeView());
    return true;
  }

  if (method === "GET" && path === "/api/surfaces/route") {
    const plan = routeNow();
    sendJson(res, 200, { ...plan, unread: unreadCount() });
    return true;
  }

  const action = path.match(/^\/api\/surfaces\/nudge\/([^/]+)\/([a-z-]+)$/);
  if (action && method === "POST") {
    const id = decodeURIComponent(action[1]!);
    const verb = action[2] as Verb;
    if (!(VERBS as readonly string[]).includes(verb)) {
      sendJson(res, 404, { error: `unknown nudge verb "${verb}"` });
      return true;
    }
    try {
      if (verb === "shown") {
        // The card that went up is the one the router is showing; stamping any
        // other id would put a card in the unread count that never appeared.
        const plan = routeNow();
        const item = plan.items.find((p) => p.id === id && p.card !== null);
        if (!item) {
          sendJson(res, 409, { error: `${id} is not the card the router is showing`, unread: unreadCount() });
          return true;
        }
        sendJson(res, 200, markCardShown(item));
      } else if (verb === "opened") {
        sendJson(res, 200, openCard(id));
      } else if (verb === "not-now") {
        sendJson(res, 200, notNowCard(id));
      } else {
        sendJson(res, 200, autoCloseCard(id));
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  sendJson(res, 404, { error: "unknown surfaces route" });
  return true;
}
