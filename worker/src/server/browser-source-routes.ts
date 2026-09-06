// ===========================================================================
// Browser source connect surface (V6 P1 S1.4; Build §4.2; Product §3.2–3.4).
//
//   GET  /api/sources/browser/discover   every browser, every profile, real
//                                        counts per window (copy-then-read),
//                                        plateau note, Full Disk Access
//                                        message, local-path disclosure.
//                                        Reads nothing into the log.
//   GET  /api/sources/browser/status     consent row · running · event count
//   GET  /api/sources/browser/import     per-profile import progress, read
//                                        from the watcher's process-local
//                                        ledger — ZERO event-log queries, so
//                                        the panel can poll it every couple of
//                                        seconds while the import runs.
//   POST /api/sources/browser/connect    { index_all?, index_from?,
//                                          understand_from?, profiles?,
//                                          card_text?, counts? }
//                                        → grantConsent('browser') THEN
//                                        supervisor.start('browser')
//
// SCOPED IMPORT (S6d L5). The connect card lists every browser and every
// profile it found; the user picks. `profiles` is that pick, as history paths,
// and it is the ONLY thing the watcher reads (adapters/browser
// profilesForConsent). A request that names profiles none of which exist is a
// 400 — an unknown pick must never widen silently back to "all", which is what
// an empty list means for a legacy row. `counts` carries what the card
// measured per chosen profile so the connected view can show progress against
// a real expectation instead of a spinner, and `card_text` is stored verbatim
// with the consent, T4-10 in spirit: the record says what the user saw.
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

import { discoverAndCount, discoverProfiles, getBrowserImportProgress } from "../adapters/browser/index.js";
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
    counts: countsOfScope(c.scope),
    card_text: cardTextOfScope(c.scope),
  };
}

/** Per-history-path visit expectations the connect card measured, if any. */
function countsOfScope(scope: unknown): Record<string, number> {
  const s = scope as { counts?: unknown } | null | undefined;
  const raw = s?.counts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.trunc(v);
  }
  return out;
}

function cardTextOfScope(scope: unknown): string | null {
  const s = scope as { card_text?: unknown } | null | undefined;
  return typeof s?.card_text === "string" && s.card_text !== "" ? s.card_text : null;
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
  /** What the card measured per chosen profile, keyed by history path. */
  counts: Record<string, number>;
  /** The card's own words, stored with the consent so the record says what the user saw. */
  cardText: string | null;
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
  if (body.profiles !== undefined && !Array.isArray(body.profiles)) throw new RangeError("profiles must be an array of history paths");
  const profiles = Array.isArray(body.profiles)
    ? [...new Set(body.profiles.filter((p): p is string => typeof p === "string" && p !== ""))]
    : [];
  const counts: Record<string, number> = {};
  if (body.counts !== undefined) {
    if (!body.counts || typeof body.counts !== "object" || Array.isArray(body.counts)) {
      throw new RangeError("counts must be an object keyed by history path");
    }
    for (const [k, v] of Object.entries(body.counts as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new RangeError(`counts.${k} must be a non-negative number`);
      counts[k] = Math.trunc(v);
    }
  }
  if (body.card_text !== undefined && body.card_text !== null && typeof body.card_text !== "string") {
    throw new RangeError("card_text must be a string");
  }
  const cardText = typeof body.card_text === "string" && body.card_text.trim() !== "" ? body.card_text : null;
  return { indexAll, indexFrom: indexAll ? null : indexFrom, understandFrom, profiles, counts, cardText };
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

  // The panel's live line while history lands (S6d L5). Reads the watcher's
  // in-process ledger and one consent row — no COUNT over the event log, so it
  // is safe to poll every couple of seconds while the importer holds the DB.
  if (method === "GET" && path === "/api/sources/browser/import") {
    const consent = safeConsent();
    const view = consentView(consent);
    sendJson(res, 200, {
      source: BROWSER_SOURCE,
      connected: safeCaptureAllowed() && consent?.state === "connected",
      running: supervisor ? supervisor.isRunning("browser") : false,
      progress: getBrowserImportProgress(view?.counts ?? {}),
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
    // The scoped-import contract: a named pick is honoured EXACTLY, and a pick
    // that matches nothing on this Mac is refused. `[]` still means "every
    // profile" — that is what a row granted before this card existed says —
    // so an unmatched pick must never be allowed to collapse into it.
    let profiles = parsed.profiles;
    if (profiles.length > 0 && discovered.length > 0) {
      const known = new Set(discovered);
      profiles = profiles.filter((p) => known.has(p));
      if (profiles.length === 0) {
        sendJson(res, 400, {
          error: "unknown-profiles",
          message:
            "none of the chosen browser profiles are on this Mac any more — check again and pick from the list",
          discovered,
        });
        return true;
      }
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.counts)) {
      if (profiles.length === 0 || profiles.includes(k)) counts[k] = v;
    }
    let consent: ConsentRow;
    try {
      consent = grantConsent({
        source: BROWSER_SOURCE,
        indexAll: parsed.indexAll,
        indexFrom: parsed.indexFrom,
        understandFrom: parsed.understandFrom,
        scope: {
          profiles,
          discovered,
          counts,
          ...(parsed.cardText ? { card_text: parsed.cardText } : {}),
          connected_via: "library.browser.connect",
        },
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
    // The progress ledger is armed by startBrowserWatcher, so the response
    // already names the chosen profiles as `pending` — the panel can render a
    // real importing view on the very first paint after Connect (S6d L5).
    sendJson(res, outcome && !started ? 500 : 200, {
      ok: started || !supervisor,
      consent: consentView(consent),
      started,
      running: supervisor ? supervisor.isRunning("browser") : false,
      progress: getBrowserImportProgress(counts),
      ...(outcome && !outcome.started && outcome.reason !== "already-running"
        ? { error: "start-failed", reason: outcome.reason, detail: outcome.detail }
        : {}),
    });
    return true;
  }

  return false;
}
