// ===========================================================================
// Screen source HTTP surface (build P2.1, spec §4.2.2 / §4.3 / §14.9).
//
//   GET  /api/screen/status      adapter + sidecar state (incl. permission)
//   POST /api/screen/pause       {paused}                 kill-switch
//   POST /api/screen/pause-app   {bundle_id, paused}      per-app privacy pause
//
// The onboarding surface polls /status for `need_permission` and deep-links
// the user to System Settings › Privacy & Security › Accessibility; the
// Library privacy controls (P2.4) drive the pause endpoints.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getScreenAdapter } from "../adapters/screen/index.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The deep link the UI opens for the Accessibility permission (spec P2.1
 * onboarding). Served from here so the UI never hardcodes an OS URL.
 */
export const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export async function handleScreenRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/screen/")) return false;

  const adapter = getScreenAdapter();

  if (path === "/api/screen/status" && req.method === "GET") {
    if (!adapter) {
      sendJson(res, 200, {
        running: false,
        state: "not_started",
        settingsUrl: ACCESSIBILITY_SETTINGS_URL,
      });
      return true;
    }
    sendJson(res, 200, {
      running: true,
      ...adapter.getStatus(),
      settingsUrl: ACCESSIBILITY_SETTINGS_URL,
    });
    return true;
  }

  if (path === "/api/screen/pause" && req.method === "POST") {
    if (!adapter) {
      sendJson(res, 409, { error: "screen watcher not running" });
      return true;
    }
    const body = await readBody(req);
    if (typeof body.paused !== "boolean") {
      sendJson(res, 400, { error: "paused (boolean) required" });
      return true;
    }
    await adapter.pause(body.paused);
    sendJson(res, 200, { ok: true, ...adapter.getStatus() });
    return true;
  }

  if (path === "/api/screen/pause-app" && req.method === "POST") {
    if (!adapter) {
      sendJson(res, 409, { error: "screen watcher not running" });
      return true;
    }
    const body = await readBody(req);
    const bundleId = typeof body.bundle_id === "string" ? body.bundle_id.trim() : "";
    if (!bundleId || typeof body.paused !== "boolean") {
      sendJson(res, 400, { error: "bundle_id (string) and paused (boolean) required" });
      return true;
    }
    await adapter.pauseApp(bundleId, body.paused);
    sendJson(res, 200, { ok: true, ...adapter.getStatus() });
    return true;
  }

  return false;
}
