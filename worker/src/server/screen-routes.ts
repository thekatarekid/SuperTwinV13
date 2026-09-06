// ===========================================================================
// Screen source HTTP surface (build P2.1, spec §4.2.2 / §4.3 / §14.9).
//
//   GET  /api/screen/status      adapter + sidecar state (incl. permission,
//                                consent, recordFrom)
//   GET  /api/screen/permission  Accessibility probe — no sidecar spawned
//   POST /api/screen/request-permission  the ASK (V6 S6d) — see below
//   POST /api/screen/record      the explicit "Record from now on" (V6 S1.3)
//   POST /api/screen/pause       {paused}                 kill-switch
//   POST /api/screen/pause-app   {bundle_id, paused}      per-app privacy pause
//
// V6 P1 S6d (L4) — THE ASK. Until now every path here only ever CHECKED, and
// macOS lists an app in Privacy & Security › Accessibility only once something
// calls AXIsProcessTrustedWithOptions with the prompt option. So SuperTwin was
// not in that list at all: the deep link landed the user on a pane with no row
// to tick, and screen capture could never be granted. POST /request-permission
// makes that call (via `screenwatch --request-permission`, attributed by TCC to
// the responsible process — SuperTwinV13.app). /status now always carries
// `permission`, including when the sidecar is not running, so the panel can
// poll the real trust state and flip to capturing without a restart.
//
// The onboarding surface polls /status for `need_permission` and deep-links
// the user to System Settings › Privacy & Security › Accessibility; the
// Library privacy controls (P2.4) drive the pause endpoints.
//
// V6 P1 S1.3 (T4-3/T4-8): the sidecar is no longer running when this surface
// comes up. It spawns only after consent → Accessibility → the explicit
// "Record from now on": POST /record refuses without a connected consent row
// (409 no-consent), refuses while Accessibility is denied (409
// need_permission — the probe never spawns the capturing sidecar), and only
// then writes app_state `screen.record_from` and starts the source.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { getScreenAdapter } from "../adapters/screen/index.js";
import {
  probeAccessibility,
  probeAccessibilityCached,
  requestAccessibility,
} from "../adapters/screen/permission.js";
import {
  armScreenRecording,
  getSourceSupervisor,
  screenRecordFrom,
} from "../adapters/supervisor.js";
import { captureAllowed } from "../db/v6core.js";

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

/**
 * How long /status may reuse a probe answer. Longer than the probe module's
 * default because /status is polled app-wide on a 5 s timer and a spawn per
 * poll would be pure waste; the permission card's own 2 s poll hits
 * /api/screen/permission, which uses the short default.
 */
export const STATUS_PROBE_CACHE_MS = 10_000;

/** consents lookup, tolerant of a test DB without the 0200 tables. */
function safeCaptureAllowed(): boolean {
  try {
    return captureAllowed("screen");
  } catch {
    return false;
  }
}

function safeRecordFrom(): string | null {
  try {
    return screenRecordFrom();
  } catch {
    return null;
  }
}

export async function handleScreenRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/screen/")) return false;

  const adapter = getScreenAdapter();
  const supervisor = getSourceSupervisor();
  const running = supervisor ? supervisor.isRunning("screen") : adapter !== null;

  if (path === "/api/screen/status" && req.method === "GET") {
    const consent = safeCaptureAllowed();
    const recordFrom = safeRecordFrom();
    if (!adapter || !running) {
      // S6d: the not-running branch used to answer with NO `permission` field
      // at all, so the panel could not tell "permission missing" from "nothing
      // captured yet" and showed the wrong card — the empty state — for a
      // source that was in fact blocked. It is the sidecar that is not running;
      // the probe answers without spawning it, and it is memoised so polling
      // this route does not fork a process per hit. A longer memo than the
      // default here on purpose: this route is polled app-wide every 5 s by the
      // onboarding banner, while the gate's own 2 s poll on /permission is what
      // makes a tick in System Settings land quickly.
      const probe = await probeAccessibilityCached({ ttlMs: STATUS_PROBE_CACHE_MS });
      sendJson(res, 200, {
        running: false,
        state: "not_started",
        permission: probe.granted,
        permissionReason: probe.reason,
        ...(probe.detail ? { permissionDetail: probe.detail } : {}),
        consent,
        recordFrom,
        settingsUrl: ACCESSIBILITY_SETTINGS_URL,
      });
      return true;
    }
    sendJson(res, 200, {
      running: true,
      ...adapter.getStatus(),
      consent,
      recordFrom,
      settingsUrl: ACCESSIBILITY_SETTINGS_URL,
    });
    return true;
  }

  // ---- The Accessibility probe: answers without spawning the capturing sidecar.
  // Memoised (PROBE_CACHE_MS) because the panel polls it while the permission
  // card is up; `?fresh=1` forces a spawn.
  if (path === "/api/screen/permission" && req.method === "GET") {
    const fresh = url.searchParams.get("fresh") === "1";
    const probe = fresh ? await probeAccessibility() : await probeAccessibilityCached();
    sendJson(res, 200, { ...probe, settingsUrl: ACCESSIBILITY_SETTINGS_URL });
    return true;
  }

  // ---- THE ASK (S6d/L4). The one call that makes macOS list this app in
  // System Settings › Privacy & Security › Accessibility. It puts up the
  // system dialog; `granted:false` with `prompted:true` means "asked, the row
  // now exists, the user has not ticked it yet" — the caller polls /permission.
  // POST, not GET: it has a side effect on the user's machine, and it must
  // never fire from a stray poll or a prefetch.
  if (path === "/api/screen/request-permission" && req.method === "POST") {
    const probe = await requestAccessibility();
    sendJson(res, 200, {
      ...probe,
      consent: safeCaptureAllowed(),
      settingsUrl: ACCESSIBILITY_SETTINGS_URL,
    });
    return true;
  }

  // ---- "Record from now on" — the third and last gate before the sidecar.
  if (path === "/api/screen/record" && req.method === "POST") {
    if (!safeCaptureAllowed()) {
      sendJson(res, 409, { error: "no-consent", message: "connect the screen source first (no connected consent row)" });
      return true;
    }
    // ttlMs 0 — a gate reads the truth, never a memo; the answer refreshes the
    // memo on its way past, so /status agrees with it on the very next poll.
    const probe = await probeAccessibilityCached({ ttlMs: 0 });
    if (!probe.granted) {
      sendJson(res, 409, {
        error: "need_permission",
        reason: probe.reason,
        ...(probe.detail ? { detail: probe.detail } : {}),
        settingsUrl: ACCESSIBILITY_SETTINGS_URL,
      });
      return true;
    }
    const from = armScreenRecording();
    const outcome = supervisor ? await supervisor.start("screen") : null;
    if (outcome && !outcome.started && outcome.reason !== "already-running") {
      sendJson(res, 500, { error: "start-failed", reason: outcome.reason, detail: outcome.detail, recordFrom: from });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      recordFrom: from,
      running: supervisor ? supervisor.isRunning("screen") : getScreenAdapter() !== null,
      ...(getScreenAdapter()?.getStatus() ?? {}),
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
