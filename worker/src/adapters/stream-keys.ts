// ===========================================================================
// Stream keys (V6 P1 S3.4 — Product_V6 §11.1, P1 §5.1, backlog T2-10).
//
// A stream is WHERE events happen. Structural, never topical:
//
//   wa:<jid>                                    one chat
//   browser:<browser>:<profile>:<domain>:<day>  one domain on one day
//   screen:<bundleId>:<session>                 one app session (30-min idle gap)
//   doc:<path>                                  one document, whichever app shows it
//
// Every key is deterministic from the event's own facts, so re-reading the
// same source rows reproduces the same key (append idempotency, cursor
// identity) and a worker restart lands on the same stream. `day` is the UTC
// calendar day — the same convention the day-bundler uses for its bundles
// (scheduler/v6/bundle.ts dayOf), so a browser stream never straddles two
// history bundles. Fresh database in V6 P1: no re-key migration.
//
// The four sources import their builder from here; `adapters/browser/chains.ts`
// re-exports them because the build plan names that file as the home.
// ===========================================================================

/** Idle gap that closes a screen app session (T2-10). */
export const SCREEN_SESSION_GAP_MS = 30 * 60 * 1000;

/** Profile slot when the source has none (Safari, tests). */
export const DEFAULT_BROWSER_PROFILE = "default";

/** Domain slot for a visit whose URL has no host (about:, file:, data:). */
export const UNKNOWN_DOMAIN = "unknown";

// ---- Builders --------------------------------------------------------------

/** `wa:<jid>` — the chat's JID as the daemon spells it. */
export function waStreamKey(jid: string): string {
  return `wa:${jid}`;
}

/** `browser:<browser>:<profile>:<domain>:<day>`. */
export function browserStreamKey(browser: string, profile: string | undefined, domain: string, day: string): string {
  return `browser:${browser}:${normaliseProfile(profile)}:${domain || UNKNOWN_DOMAIN}:${day}`;
}

/** `screen:<bundleId>:<session>`. */
export function screenStreamKey(bundleId: string, session: string): string {
  return `screen:${bundleId}:${session}`;
}

/** `doc:<path>` — an absolute filesystem path. */
export function docStreamKey(path: string): string {
  return `doc:${path}`;
}

// ---- Slots -----------------------------------------------------------------

/** UTC calendar day of a unix-ms timestamp, `YYYY-MM-DD`. */
export function utcDayOf(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/**
 * Chromium profile directories are `Default`, `Profile 1`, …; Safari has none.
 * Lower-cased, whitespace → `-`, colons out (the key separator), empty → default.
 */
export function normaliseProfile(profile: string | undefined | null): string {
  const p = (profile ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/:/g, "-");
  return p.length > 0 ? p : DEFAULT_BROWSER_PROFILE;
}

/** Compact session id from the session's first frame: `20260906T120000Z`. */
export function sessionIdOf(startMs: number): string {
  return new Date(startMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Inverse of sessionIdOf; NaN when the id is not one. */
export function sessionStartMs(session: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(session);
  if (!m) return Number.NaN;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

/**
 * The document behind a screen frame's `doc_key`, when it names a file: the
 * sidecar fills doc_key from AXDocument (a `file://` URL or a path), else the
 * focused web URL, else the window title. Only the file forms are documents
 * in the §11.1 sense; a URL or a title stays an app-session frame.
 */
export function docPathOf(docKey: string | null | undefined): string | null {
  if (!docKey) return null;
  const k = docKey.trim();
  if (k.startsWith("file://")) {
    try {
      const u = new URL(k);
      const p = decodeURIComponent(u.pathname);
      return p.length > 0 ? p : null;
    } catch {
      return null;
    }
  }
  if (k.startsWith("/") && k.length > 1) return k;
  return null;
}

// ---- Parsing -----------------------------------------------------------------

export type ParsedStreamKey =
  | { kind: "wa"; jid: string }
  | { kind: "browser"; browser: string; profile: string; domain: string; day: string }
  | { kind: "screen"; bundleId: string; session: string }
  | { kind: "doc"; path: string };

/** Structured view of a canonical key; null for anything else (legacy, `bar:`…). */
export function parseStreamKey(key: string): ParsedStreamKey | null {
  if (key.startsWith("wa:")) {
    const jid = key.slice(3);
    return jid ? { kind: "wa", jid } : null;
  }
  if (key.startsWith("doc:")) {
    const path = key.slice(4);
    return path ? { kind: "doc", path } : null;
  }
  if (key.startsWith("screen:")) {
    const rest = key.slice(7);
    const i = rest.indexOf(":");
    if (i <= 0 || i === rest.length - 1) return null;
    return { kind: "screen", bundleId: rest.slice(0, i), session: rest.slice(i + 1) };
  }
  if (key.startsWith("browser:")) {
    const parts = key.split(":");
    if (parts.length !== 5 || parts.some((p) => p.length === 0)) return null;
    return { kind: "browser", browser: parts[1]!, profile: parts[2]!, domain: parts[3]!, day: parts[4]! };
  }
  return null;
}

// ---- Screen sessions -----------------------------------------------------------

export interface ScreenSessionSeed {
  bundleId: string;
  session: string;
  lastTsMs: number;
}

/**
 * One session per app (bundle id) until the app is idle for the gap. The
 * session id is the first frame's timestamp, so it is stable across restarts
 * once the tracker is seeded with the last frame each app wrote (the adapter
 * does that from the events table at boot).
 */
export class ScreenSessionTracker {
  private readonly open = new Map<string, { session: string; lastMs: number }>();

  constructor(private readonly gapMs: number = SCREEN_SESSION_GAP_MS) {}

  /** Resume a session already on disk; a newer seed for the same app wins. */
  seed(seed: ScreenSessionSeed): void {
    const cur = this.open.get(seed.bundleId);
    if (!cur || seed.lastTsMs > cur.lastMs) {
      this.open.set(seed.bundleId, { session: seed.session, lastMs: seed.lastTsMs });
    }
  }

  /** Session for a frame of `bundleId` at `tsMs`; opens a new one after the idle gap. */
  sessionFor(bundleId: string, tsMs: number): string {
    const cur = this.open.get(bundleId);
    if (cur && tsMs - cur.lastMs <= this.gapMs) {
      if (tsMs > cur.lastMs) cur.lastMs = tsMs;
      return cur.session;
    }
    const session = sessionIdOf(tsMs);
    this.open.set(bundleId, { session, lastMs: tsMs });
    return session;
  }

  /** Drop an app's open session (disconnect / delete verbs). */
  forget(bundleId: string): void {
    this.open.delete(bundleId);
  }

  /** Bundle ids with an open session (tests, status). */
  openSessions(): ScreenSessionSeed[] {
    return [...this.open.entries()].map(([bundleId, s]) => ({ bundleId, session: s.session, lastTsMs: s.lastMs }));
  }
}
