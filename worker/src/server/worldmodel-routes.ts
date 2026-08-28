// ===========================================================================
// [CODE] World-model read routes — build P1.1.
//
//   GET /api/people                       people view (entities+circle+provisional)
//   GET /api/people/:id/claims            active claims about one person
//   GET /api/spaces                       spaces (?status=proposed|active|...)
//   GET /api/spaces/:id/claims            claims a space holds refs to
//   GET /api/claims/:key                  active version + full version history
//   GET /api/tone?person=&stream=         one tone profile
//
// Read-only on purpose: P1.1 owns the schema and its stores; the passes
// (P1.2+) and the review UI (P1.7/P4) own writes. These are the production
// callers for the claims store, the people view and the circle field until
// those lanes land, and they are what the P1 minimal UI lists from.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { activeClaim, claimHistory, claimsAbout, claimsInSpace, getToneProfile } from "../claims/store.js";
import { getDb } from "../db/connection.js";
import { edgesOf } from "../entities/edges.js";
import { openResolutionQuestions } from "../entities/merge.js";
import { circleOf } from "../entities/registry.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Handle one world-model read. Returns false for any path it does not claim
 * (the server's shared handler contract).
 */
export async function handleWorldModelRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET") return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const db = getDb();

  if (path === "/api/people") {
    const rows = db
      .prepare(`SELECT * FROM people ORDER BY last_seen_at DESC NULLS LAST, id`)
      .all();
    // Merge/split questions ride along: the People surface is where the user
    // answers "same person?" (spec §7.3.1) — served, never re-derived here.
    sendJson(res, 200, { people: rows, open_questions: openResolutionQuestions() });
    return true;
  }

  const personClaims = path.match(/^\/api\/people\/([^/]+)\/claims$/);
  if (personClaims) {
    const id = decodeURIComponent(personClaims[1]!);
    sendJson(res, 200, {
      subject: id,
      circle: circleOf(id),
      claims: claimsAbout(id),
      // The person modal's relationship rows (spec §14.6): active edges.
      edges: edgesOf(id, { status: "active" }),
    });
    return true;
  }

  if (path === "/api/spaces") {
    const status = url.searchParams.get("status");
    const rows = status
      ? db.prepare(`SELECT * FROM spaces WHERE status = ? ORDER BY updated_at DESC, created_at DESC`).all(status)
      : db.prepare(`SELECT * FROM spaces ORDER BY updated_at DESC, created_at DESC`).all();
    sendJson(res, 200, { spaces: rows });
    return true;
  }

  const spaceClaims = path.match(/^\/api\/spaces\/([^/]+)\/claims$/);
  if (spaceClaims) {
    const id = decodeURIComponent(spaceClaims[1]!);
    sendJson(res, 200, { space: id, claims: claimsInSpace(id) });
    return true;
  }

  const claimKey = path.match(/^\/api\/claims\/([^/]+)$/);
  if (claimKey) {
    const key = decodeURIComponent(claimKey[1]!);
    const active = activeClaim(key);
    const history = claimHistory(key);
    if (!active && history.length === 0) {
      sendJson(res, 404, { error: `no claim ${key}` });
      return true;
    }
    sendJson(res, 200, { claim_key: key, active, history });
    return true;
  }

  if (path === "/api/tone") {
    const person = url.searchParams.get("person");
    const stream = url.searchParams.get("stream");
    if (!person && !stream) {
      sendJson(res, 400, { error: "person or stream is required" });
      return true;
    }
    sendJson(res, 200, { profile: getToneProfile(person, stream) });
    return true;
  }

  return false;
}
