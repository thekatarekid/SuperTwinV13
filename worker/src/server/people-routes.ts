// ===========================================================================
// [CODE] People routes — V6 P1 S5.4 (Build §8 lane D; Product_V6_Phase1 §11).
//
//   GET  /api/people/who-i-am          the "Who I am" card, built by processing
//   GET  /api/people/radar             the follow-up radar (?person= filters)
//   GET  /api/people/aliases           survivor id → the tombstones merged into
//                                      it (the alias chips a split drags out)
//   GET  /api/people/:id/card          the person card, read at request time
//   POST /api/people/merge             the drag: {loser, winner} → one person
//   POST /api/people/split             the drag out: {entity_id} → two again
//   POST /api/people/undo              {mutation_id} — the inverse gesture
//   POST /api/people/different         {a, b} — "no, different people"
//   POST /api/people/:id/radar-lead    {days|null} — learn a per-person lead
//   POST /api/people/circles/infer     run the circle inference over the
//                                      unassigned (never over a user's drag)
//
// Reads are code only; zero model calls anywhere in this file. Every write
// leaves a decisions row and, for the two identity gestures, a mutation the
// undo route replays backwards. Registered BEFORE worldmodel-routes, which
// owns /api/people and /api/people/:id/claims.
// ===========================================================================

import type { IncomingMessage, ServerResponse } from "node:http";

import { getDb } from "../db/connection.js";
import { resolveEntityId } from "../entities/registry.js";
import { buildPersonCard } from "../people/card.js";
import { inferCirclesForUnassigned } from "../people/circles.js";
import { aliasChips, markDifferent, mergeByDrag, splitByDrag, undoDrag } from "../people/drag.js";
import { computeRadar, radarForPerson, setRadarLead } from "../people/radar.js";
import { buildWhoIAm } from "../people/who-i-am.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function handlePeopleRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/people/who-i-am") {
    sendJson(res, 200, buildWhoIAm());
    return true;
  }

  if (method === "GET" && path === "/api/people/radar") {
    const person = url.searchParams.get("person");
    const now = url.searchParams.get("now");
    const at = now ? new Date(now) : new Date();
    sendJson(res, 200, { radar: person ? radarForPerson(person, at) : computeRadar(at) });
    return true;
  }

  if (method === "GET" && path === "/api/people/aliases") {
    // One round trip for the whole list: the People screen needs a chip per
    // tombstone, and a call per person would be a call per person.
    const rows = getDb()
      .prepare(
        `SELECT loser.id AS alias_id, loser.canonical AS alias_name, loser.merged_into AS survivor
           FROM entities loser WHERE loser.type = 'person' AND loser.merged_into IS NOT NULL
          ORDER BY loser.created_at, loser.id`,
      )
      .all() as { alias_id: string; alias_name: string | null; survivor: string }[];
    const aliases: Record<string, { id: string; name: string | null }[]> = {};
    for (const r of rows) {
      const survivor = resolveEntityId(r.survivor) ?? r.survivor;
      (aliases[survivor] ??= []).push({ id: r.alias_id, name: r.alias_name });
    }
    sendJson(res, 200, { aliases });
    return true;
  }

  const card = path.match(/^\/api\/people\/([^/]+)\/card$/);
  if (method === "GET" && card) {
    const id = decodeURIComponent(card[1]!);
    const built = buildPersonCard(id);
    if (!built) {
      sendJson(res, 404, { error: `no person ${id}` });
      return true;
    }
    sendJson(res, 200, { card: built, alias_chips: aliasChips(built.id) });
    return true;
  }

  if (method === "POST" && path === "/api/people/merge") {
    const body = await readBody(req);
    const loser = str(body.loser);
    const winner = str(body.winner);
    if (!loser || !winner) {
      sendJson(res, 400, { error: "loser and winner are required" });
      return true;
    }
    const result = mergeByDrag({ loser, winner, reason: str(body.reason) });
    sendJson(res, result.ok ? 200 : 409, result);
    return true;
  }

  if (method === "POST" && path === "/api/people/split") {
    const body = await readBody(req);
    const entityId = str(body.entity_id);
    if (!entityId) {
      sendJson(res, 400, { error: "entity_id is required" });
      return true;
    }
    const result = splitByDrag({ entityId, reason: str(body.reason) });
    sendJson(res, result.ok ? 200 : 409, result);
    return true;
  }

  if (method === "POST" && path === "/api/people/undo") {
    const body = await readBody(req);
    const mutationId = str(body.mutation_id);
    if (!mutationId) {
      sendJson(res, 400, { error: "mutation_id is required" });
      return true;
    }
    const result = undoDrag(mutationId);
    sendJson(res, result.ok ? 200 : 409, result);
    return true;
  }

  if (method === "POST" && path === "/api/people/different") {
    const body = await readBody(req);
    const a = str(body.a);
    const b = str(body.b);
    if (!a || !b) {
      sendJson(res, 400, { error: "a and b are required" });
      return true;
    }
    markDifferent(a, b, str(body.reason) ?? "user said different people");
    sendJson(res, 200, { recorded: true, a, b, permanent: true });
    return true;
  }

  const lead = path.match(/^\/api\/people\/([^/]+)\/radar-lead$/);
  if (method === "POST" && lead) {
    const id = decodeURIComponent(lead[1]!);
    if (!buildPersonCard(id)) {
      sendJson(res, 404, { error: `no person ${id}` });
      return true;
    }
    const body = await readBody(req);
    const days = body.days === null ? null : typeof body.days === "number" && Number.isFinite(body.days) ? Math.max(0, Math.round(body.days)) : undefined;
    if (days === undefined) {
      sendJson(res, 400, { error: "days must be a number, or null to fall back to the circle default" });
      return true;
    }
    setRadarLead(id, days, str(body.reason) ?? "user");
    sendJson(res, 200, { person: id, radar_lead_days: days });
    return true;
  }

  if (method === "POST" && path === "/api/people/circles/infer") {
    const body = await readBody(req);
    const floor = typeof body.min_confidence === "number" ? body.min_confidence : undefined;
    sendJson(res, 200, inferCirclesForUnassigned(floor === undefined ? {} : { minConfidence: floor }));
    return true;
  }

  return false;
}
