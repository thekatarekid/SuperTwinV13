// ===========================================================================
// [CODE] Spaces routes — V6 P1 S5.1 (Build §8 lane A; Product_V6 §11.11).
//
//   GET  /api/spaces/list                 grouped by life area + dormant bucket
//   GET  /api/spaces/:id/view             the space view (goal · summary ·
//                                         latest · plan · milestones · tasks ·
//                                         follow-ups · episodes · enrichment ·
//                                         people · birth) with why-targets
//   GET  /api/spaces/:id/sweep-preview    what the activation sweep would pull
//                                         in — retrieval only, zero calls
//   POST /api/spaces/:id/wake             dormant → active with old evidence
//                                         (the WOKEN birth; a user ask here,
//                                         the calendar's lead time elsewhere)
//   POST /api/spaces/:id/enrichment       record one fetch {kind, url, content}
//                                         — hashed in code; unchanged → no call
//   POST /api/spaces/:id/refile           the drag: {life_area} re-files the
//                                         space; {episode_id, to_space_id|null}
//                                         re-files one episode out of it
//
// Reads are code only. Writes are decisions rows like every other change.
// Returns false for any path it does not claim (the shared handler contract).
// Registered BEFORE worldmodel-routes, which owns /api/spaces and
// /api/spaces/:id/claims.
// ===========================================================================

import type { IncomingMessage, ServerResponse } from "node:http";

import { recordEnrichmentFetch } from "../spaces/enrichment.js";
import { sweepPreview, wakeSpace } from "../spaces/birth.js";
import { isLifeArea, refileEpisode, refileSpace } from "../spaces/refile.js";
import { spaceView, spacesList } from "../spaces/view.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export async function handleSpacesRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/spaces/list") {
    sendJson(res, 200, spacesList());
    return true;
  }

  const view = path.match(/^\/api\/spaces\/([^/]+)\/view$/);
  if (view && method === "GET") {
    const id = decodeURIComponent(view[1]!);
    const body = spaceView(id);
    if (!body) {
      sendJson(res, 404, { error: `no space ${id}` });
      return true;
    }
    sendJson(res, 200, body);
    return true;
  }

  const preview = path.match(/^\/api\/spaces\/([^/]+)\/sweep-preview$/);
  if (preview && method === "GET") {
    const id = decodeURIComponent(preview[1]!);
    sendJson(res, 200, sweepPreview(id));
    return true;
  }

  const wake = path.match(/^\/api\/spaces\/([^/]+)\/wake$/);
  if (wake && method === "POST") {
    const id = decodeURIComponent(wake[1]!);
    const body = (await readBody(req)) as { signal?: unknown } | undefined;
    const signal = typeof body?.signal === "string" && body.signal.trim() !== "" ? body.signal.trim() : "user";
    const outcome = wakeSpace({ spaceId: id, signal, by: "user" });
    sendJson(res, outcome.woke ? 200 : 409, outcome);
    return true;
  }

  const refile = path.match(/^\/api\/spaces\/([^/]+)\/refile$/);
  if (refile && method === "POST") {
    const id = decodeURIComponent(refile[1]!);
    const body = (await readBody(req)) as
      | { life_area?: unknown; episode_id?: unknown; to_space_id?: unknown }
      | undefined;
    if (typeof body?.episode_id === "string") {
      const to =
        body.to_space_id === null || body.to_space_id === undefined
          ? null
          : typeof body.to_space_id === "string"
            ? body.to_space_id
            : undefined;
      if (to === undefined) {
        sendJson(res, 400, { error: "to_space_id must be a space id or null (unsorted)" });
        return true;
      }
      const outcome = refileEpisode(body.episode_id, to, "user");
      sendJson(res, outcome.moved ? 200 : 409, outcome);
      return true;
    }
    if (typeof body?.life_area !== "string" || !isLifeArea(body.life_area)) {
      sendJson(res, 400, { error: "refile needs {life_area} or {episode_id, to_space_id}" });
      return true;
    }
    const outcome = refileSpace(id, body.life_area, "user");
    sendJson(res, outcome.moved ? 200 : 409, outcome);
    return true;
  }

  const enrich = path.match(/^\/api\/spaces\/([^/]+)\/enrichment$/);
  if (enrich && method === "POST") {
    const id = decodeURIComponent(enrich[1]!);
    const body = (await readBody(req)) as { kind?: unknown; url?: unknown; content?: unknown } | undefined;
    if (typeof body?.kind !== "string" || typeof body?.url !== "string" || typeof body?.content !== "string") {
      sendJson(res, 400, { error: "enrichment needs {kind, url, content}" });
      return true;
    }
    if (!spaceView(id)) {
      sendJson(res, 404, { error: `no space ${id}` });
      return true;
    }
    sendJson(res, 200, recordEnrichmentFetch({ spaceId: id, kind: body.kind, url: body.url, content: body.content }));
    return true;
  }

  return false;
}
