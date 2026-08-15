// ===========================================================================
// Brain file HTTP route (Phase 2 API contract §Brain files).
//
//   GET /api/brain/file?path=spaces/goa-trip/space.md -> { path, content }
//
// Additive route module mounted by server/index.ts (same handled-boolean
// pattern as whatsapp-routes.ts). The path is traversal-guarded: it must
// resolve to a real file strictly inside the brain root (mirrors the
// /api/media guard).
// ===========================================================================

import { readFile, stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";

import { ensureBrain } from "./root.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Handle a brain request. Returns true if handled. */
export async function handleBrainRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  // ---- GET /api/brain/file?path=<root-relative markdown path>
  if (method === "GET" && url.pathname === "/api/brain/file") {
    const rel = url.searchParams.get("path");
    if (!rel || !rel.trim().length) {
      sendJson(res, 400, { error: "path required" });
      return true;
    }

    // Resolve + confine to the brain root (defence in depth against traversal).
    const root = ensureBrain();
    const abs = resolve(join(root, rel));
    if (abs === root || !abs.startsWith(root + sep)) {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }

    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return true;
      }
      const content = await readFile(abs, "utf8");
      sendJson(res, 200, { path: rel, content });
    } catch {
      sendJson(res, 404, { error: "file not found" });
    }
    return true;
  }

  return false;
}
