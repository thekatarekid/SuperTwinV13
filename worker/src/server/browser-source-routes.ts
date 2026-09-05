// ===========================================================================
// Browser source connect surface (V6 P1 S1.4; Build §4.2; Product §3.2–3.4).
//
//   GET  /api/sources/browser/discover   every browser, every profile, real
//                                        counts per window (copy-then-read),
//                                        plateau note, Full Disk Access
//                                        message, local-path disclosure.
//                                        Reads nothing into the log.
//   GET  /api/sources/browser/status     consent row · running · event count
//   POST /api/sources/browser/connect    { index_all?, index_from?,
//                                          understand_from?, profiles? }
//                                        → grantConsent('browser') THEN
//                                        supervisor.start('browser')
//
// Order matters at connect (S1.3): the consent row exists BEFORE the watcher
// starts, so the first poll's rows have a consent to be admitted under; the
// import floor is derived from that row by the supervisor (T4-4). Defaults
// are the product's: Index everything, Understand 30 days — the confirm card
// (S1.8) refines both; a body that names `understand_from: null` sends nothing
// to the model until it does.
//
// Mounted by server/index.ts AHEAD of the generic /api/sources/:id router so
// the WhatsApp adapter never answers for the browser. Zero model calls.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { discoverAndCount, discoverProfiles } from "../adapters/browser/index.js";
import { getSourceSupervisor } from "../adapters/supervisor.js";
import { getDb } from "../db/connection.js";
import { ConsentWindowError, captureAllowed, getConsent, grantConsent, type ConsentRow } from "../db/v6core.js";

export const BROWSER_SOURCE = "browser";
/** Product §3.3: Understand defaults to the last 30 days. */
export const DEFAULT_UNDERSTAND_DAYS = 30;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** consents lookups, tolerant of a DB without the 0200 tables. */
function safeConsent(): ConsentRow | null {
  try {
    return getConsent(BROWSER_SOURCE);
  } catch {
    return null;
  }
}

function safeCaptureAllowed(): boolean {
  try {
    return captureAllowed(BROWSER_SOURCE);
  } catch {
    return false;
  }
}

function browserEventCount(): number {
  try {
    return (
      (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE source_id = ?`).get(BROWSER_SOURCE) as
        | { n: number }
        | undefined)?.n ?? 0
    );
  } catch {
    return 0;
  }
}

function consentView(c: ConsentRow | null) {
  if (!c) return null;
  return {
    id: c.id,
    state: c.state,
    granted_at: c.grantedAt,
    index_all: c.indexAll,
    index_from: c.indexFrom,
    understand_from: c.understandFrom,
    profiles: profilesOfScope(c.scope),
  };
}

function profilesOfScope(scope: unknown): string[] {
  const s = scope as { profiles?: unknown } | null | undefined;
  return Array.isArray(s?.profiles) ? s.profiles.filter((p): p is string => typeof p === "string") : [];
}

function isoOrNull(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) throw new RangeError(`${field} must be an ISO-8601 timestamp or null`);
  return new Date(Date.parse(v)).toISOString();
}

export interface ConnectBody {
  indexAll: boolean;
  indexFrom: string | null;
  understandFrom: string | null;
  profiles: string[];
}

/** Parse + default the connect body. Throws RangeError on a malformed field. */
export function parseConnectBody(body: Record<string, unknown>, nowMs: number = Date.now()): ConnectBody {
  const indexFrom = isoOrNull(body.index_from, "index_from") ?? null;
  const indexAll = typeof body.index_all === "boolean" ? body.index_all : indexFrom === null;
  const understandRaw = isoOrNull(body.understand_from, "understand_from");
  const understandFrom =
    understandRaw === undefined
      ? new Date(nowMs - DEFAULT_UNDERSTAND_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : understandRaw;
  const profiles = Array.isArray(body.profiles) ? body.profiles.filter((p): p is string => typeof p === "string" && p !== "") : [];
  if (body.profiles !== undefined && !Array.isArray(body.profiles)) throw new RangeError("profiles must be an array of history paths");
  return { indexAll, indexFrom: indexAll ? null : indexFrom, understandFrom, profiles };
}

export interface BrowserSourceRouteDeps {
  /** Test seam: the profile set to discover/count (default: the real home). */
  discover?: () => ReturnType<typeof discoverProfiles>;
  now?: () => number;
}

export async function handleBrowserSourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BrowserSourceRouteDeps = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/sources/browser/")) return false;
  const method = req.method ?? "GET";
  const discover = deps.discover ?? discoverProfiles;
  const now = deps.now ?? (() => Date.now());
  const supervisor = getSourceSupervisor();

  if (method === "GET" && path === "/api/sources/browser/status") {
    const consent = safeConsent();
    sendJson(res, 200, {
      source: BROWSER_SOURCE,
      connected: safeCaptureAllowed() && consent?.state === "connected",
      running: supervisor ? supervisor.isRunning("browser") : false,
      consent: consentView(consent),
      event_count: browserEventCount(),
    });
    return true;
  }

  if (method === "GET" && path === "/api/sources/browser/discover") {
    let profiles: ReturnType<typeof discoverProfiles> = [];
    try {
      profiles = discover();
    } catch {
      profiles = [];
    }
    const discovery = discoverAndCount(profiles, now());
    const consent = safeConsent();
    sendJson(res, 200, {
      ...discovery,
      connected: safeCaptureAllowed() && consent?.state === "connected",
      consent: consentView(consent),
    });
    return true;
  }

  if (method === "POST" && path === "/api/sources/browser/connect") {
    let parsed: ConnectBody;
    try {
      parsed = parseConnectBody(await readBody(req), now());
    } catch (err) {
      sendJson(res, 400, { error: "bad-request", message: (err as Error).message });
      return true;
    }
    // Everything the card showed rides along on the row (T4-10 in spirit): the
    // profiles chosen and the profiles that existed at the moment of yes.
    let discovered: string[] = [];
    try {
      discovered = discover().map((p) => p.historyPath);
    } catch {
      discovered = [];
    }
    let consent: ConsentRow;
    try {
      consent = grantConsent({
        source: BROWSER_SOURCE,
        indexAll: parsed.indexAll,
        indexFrom: parsed.indexFrom,
        understandFrom: parsed.understandFrom,
        scope: { profiles: parsed.profiles, discovered, connected_via: "library.browser.connect" },
      });
    } catch (err) {
      if (err instanceof ConsentWindowError) {
        sendJson(res, 400, { error: "bad-windows", message: err.message });
        return true;
      }
      sendJson(res, 500, { error: "consent-failed", message: (err as Error).message });
      return true;
    }
    // Consent row first, watcher second — a failed start leaves a connected
    // row the next boot honours; a failed grant starts nothing.
    const outcome = supervisor ? await supervisor.start("browser") : null;
    const started = outcome ? outcome.started || outcome.reason === "already-running" : false;
    sendJson(res, outcome && !started ? 500 : 200, {
      ok: started || !supervisor,
      consent: consentView(consent),
      started,
      running: supervisor ? supervisor.isRunning("browser") : false,
      ...(outcome && !outcome.started && outcome.reason !== "already-running"
        ? { error: "start-failed", reason: outcome.reason, detail: outcome.detail }
        : {}),
    });
    return true;
  }

  return false;
}
