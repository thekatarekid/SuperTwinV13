// ===========================================================================
// The data filter at capture — V6 P1 S1.7 (Build §4.2 [D]; Product_V6_Phase1
// §Sources 2–3; V6 §"source ─► never-list ─► user lists ─► pause states ─►
// event log").
//
// One predicate at the two single-writer funnels (db/eventlog.appendEvents and
// db/ingest.insertEvent), evaluated BEFORE the consent gate so a dropped event
// leaves no row anywhere — not in events, not in the archive, not in FTS.
// "Applies to index, understanding and search alike" falls out of that: what
// never entered the log cannot be indexed, understood or searched.
//
//   filterCapture(input) → null (admit) | { reason }
//
//   1. NEVER-LIST   fixed, not a setting. Mirrors the sidecar's Privacy.swift
//                   (the Node side is the belt to its suspenders) and adds the
//                   sources the sidecar never sees:
//                     · password-manager windows (bundle-id prefix)
//                     · private / incognito windows (title markers, browsers only)
//                     · secure text fields (AXSecureTextField in the roles)
//                     · WhatsApp status updates (status@broadcast)
//   2. USER LISTS   four app_state lists, editable in Capture & Privacy:
//                     apps    bundle id · app name · bundle prefix ("com.x.")
//                     sites   domain, suffix match (bank.example.com matches
//                             a.bank.example.com; "example.com" matches both)
//                     chats   stream key (WhatsApp jid, browser/screen stream)
//                     senders actor key (contact:… / jid / roles.sender)
//   3. PAUSE STATES private moment (`capture.private_until`, 15 minutes from
//                   the menu bar or the hotkey) and the panel's quick-pause
//                   (`capture.paused_until`). Both are wall-clock deadlines;
//                   expired = not paused, nothing to clear. Per-source pause is
//                   the consent row's state and lives in the consent gate.
//
// The V13 defect CNS-05 names (`pauses-nudges-only`) was the quick-pause key
// being read by the assist watcher alone: ⏸ silenced nudges while capture ran
// on. Reading the same key HERE, at the funnel, fixes it by construction.
//
// Zero model calls; SQLite reads only. Lists are cached per DB handle and
// invalidated by setCaptureList(); the pause deadlines are read per event
// (one PK lookup on app_state) because they change from the tray.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";

// ---- never-list --------------------------------------------------------------

/** Mirror of Privacy.swift `passwordManagerBundlePrefixes` (lowercased). */
export const PASSWORD_MANAGER_BUNDLE_PREFIXES: readonly string[] = [
  "com.1password.",
  "com.agilebits.onepassword",
  "com.bitwarden.",
  "com.lastpass.",
  "com.dashlane.",
  "com.apple.keychainaccess",
  "com.apple.passwords",
  "org.keepassxc.",
  "com.mseven.msecure",
  "in.sinew.enpass",
  "com.nordpass.",
  "com.roboform.",
  "com.keepersecurity.",
  "com.protonmail.pass",
];

/** Browsers whose window titles carry private-mode markers (Privacy.swift). */
export const PRIVATE_MODE_BROWSER_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.safari",
  "com.apple.safaritechnologypreview",
  "com.google.chrome",
  "com.google.chrome.canary",
  "com.google.chrome.beta",
  "company.thebrowser.browser",
  "company.thebrowser.dia",
  "com.brave.browser",
  "com.microsoft.edgemac",
]);

export const PRIVATE_WINDOW_TITLE_MARKERS: readonly string[] = [
  "private browsing",
  "(incognito)",
  "incognito)",
  "(private)",
];

/** AX roles whose text is a secret by definition. */
export const SECURE_FIELD_ROLES: ReadonlySet<string> = new Set([
  "axsecuretextfield",
  "securetextfield",
]);

/** WhatsApp status updates — the one WhatsApp stream that is never captured. */
export const WHATSAPP_STATUS_STREAM = "status@broadcast";

// ---- user lists ---------------------------------------------------------------

export type CaptureListKind = "apps" | "sites" | "chats" | "senders";

export const CAPTURE_LIST_KINDS: readonly CaptureListKind[] = ["apps", "sites", "chats", "senders"];

/**
 * app_state keys. `apps` and `sites` are the keys Capture & Privacy already
 * wrote (settings-routes APP_BLOCKLIST_KEY / DOMAIN_BLOCKLIST_KEY) — until
 * S1.7 nothing read them; now the funnel does.
 */
export const CAPTURE_LIST_KEYS: Readonly<Record<CaptureListKind, string>> = {
  apps: "capture.app_blocklist",
  sites: "capture.domain_blocklist",
  chats: "capture.chat_blocklist",
  senders: "capture.sender_blocklist",
};

/** ISO deadline of the private moment (menu bar / hotkey). */
export const PRIVATE_UNTIL_KEY = "capture.private_until";
/** ISO deadline of the panel's quick-pause (settings/assist-settings CAPTURE_PAUSED_UNTIL_KEY). */
export const QUICK_PAUSE_UNTIL_KEY = "capture.paused_until";

/** The private moment is fifteen minutes. Not a setting. */
export const PRIVATE_MOMENT_MINUTES = 15;

let cacheDb: Database.Database | null = null;
let listCache = new Map<CaptureListKind, string[]>();

function stmt(db: Database.Database, sql: string): Database.Statement {
  return db.prepare(sql);
}

function readList(db: Database.Database, kind: CaptureListKind): string[] {
  const row = stmt(db, `SELECT value FROM app_state WHERE key = ?`).get(CAPTURE_LIST_KEYS[kind]) as
    | { value: string }
    | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/** The stored list (trimmed, empty entries dropped). Cached per DB handle. */
export function readCaptureList(kind: CaptureListKind): string[] {
  const db = getDb();
  if (cacheDb !== db) {
    cacheDb = db;
    listCache = new Map();
  }
  let list = listCache.get(kind);
  if (!list) {
    list = readList(db, kind);
    listCache.set(kind, list);
  }
  return list;
}

/** Replace one list. Deduplicated, trimmed; the funnel sees it on the next event. */
export function setCaptureList(kind: CaptureListKind, values: unknown): string[] {
  const list = Array.isArray(values)
    ? [...new Set(values.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))]
    : [];
  getDb()
    .prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(CAPTURE_LIST_KEYS[kind], JSON.stringify(list));
  invalidateCaptureFilterCache();
  return list;
}

export function readCaptureLists(): Record<CaptureListKind, string[]> {
  return {
    apps: readCaptureList("apps"),
    sites: readCaptureList("sites"),
    chats: readCaptureList("chats"),
    senders: readCaptureList("senders"),
  };
}

/** Drop the list cache (a caller wrote app_state directly). */
export function invalidateCaptureFilterCache(): void {
  cacheDb = null;
  listCache = new Map();
}

// ---- pause states ---------------------------------------------------------------

function readDeadline(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row && row.value !== "" ? row.value : null;
}

function writeDeadline(key: string, iso: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, iso ?? "");
}

function isLive(iso: string | null, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > nowMs;
}

/** The private-moment deadline, or null when none is running. */
export function privateMomentUntil(nowMs: number = Date.now()): string | null {
  const iso = readDeadline(PRIVATE_UNTIL_KEY);
  return isLive(iso, nowMs) ? iso : null;
}

/**
 * Start (or extend) a private moment: capture stops for `minutes` (15 by
 * default) from `nowMs`. Returns the deadline. `endPrivateMoment()` clears it.
 */
export function startPrivateMoment(
  minutes: number = PRIVATE_MOMENT_MINUTES,
  nowMs: number = Date.now(),
): string {
  const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : PRIVATE_MOMENT_MINUTES;
  const until = new Date(nowMs + mins * 60_000).toISOString();
  writeDeadline(PRIVATE_UNTIL_KEY, until);
  return until;
}

export function endPrivateMoment(): void {
  writeDeadline(PRIVATE_UNTIL_KEY, null);
}

/** The panel quick-pause deadline, or null. Same key settings/assist-settings writes. */
export function quickPauseUntil(nowMs: number = Date.now()): string | null {
  const iso = readDeadline(QUICK_PAUSE_UNTIL_KEY);
  return isLive(iso, nowMs) ? iso : null;
}

export interface PauseState {
  /** Either deadline is live. */
  paused: boolean;
  privateUntil: string | null;
  quickPauseUntil: string | null;
}

export function capturePauseState(nowMs: number = Date.now()): PauseState {
  const privateUntil = privateMomentUntil(nowMs);
  const quick = quickPauseUntil(nowMs);
  return { paused: privateUntil !== null || quick !== null, privateUntil, quickPauseUntil: quick };
}

// ---- the predicate -------------------------------------------------------------

export type FilterReason =
  | "never:password-manager"
  | "never:private-window"
  | "never:secure-field"
  | "never:status-broadcast"
  | "list:app"
  | "list:site"
  | "list:chat"
  | "list:sender"
  | "pause:private-moment"
  | "pause:quick-pause";

export interface FilterDrop {
  dropped: true;
  reason: FilterReason;
  /** The list entry / never-list rule that matched (for the log line). */
  match?: string;
}

export interface FilterInput {
  source: string;
  /** Source-native stream key (jid, domain stream, screen stream). */
  streamKey: string | null;
  /** Envelope actor ("contact:rohan", "self", a jid). */
  actor: string | null;
  /** roles.sender when the envelope carries roles. */
  sender?: string | null;
  payload: Record<string, unknown> | null;
  /** Node stream external key when it differs from streamKey (legacy funnel). */
  streamExternalKey?: string | null;
  /** Actor external key on the legacy funnel (`actors.id` minus the source prefix). */
  actorExternalKey?: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h || null;
  } catch {
    return null;
  }
}

/** Domain suffix match: entry `example.com` matches `example.com` and `a.example.com`. */
export function domainMatches(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  let e = entry.toLowerCase().trim().replace(/^\*\./, "").replace(/^www\./, "");
  if (e.includes("/") || e.includes(":")) {
    // Someone pasted a URL — take its host.
    const eh = hostOf(e.startsWith("http") ? e : `https://${e}`);
    if (!eh) return false;
    e = eh.replace(/^www\./, "");
  }
  if (!e) return false;
  return h === e || h.endsWith(`.${e}`);
}

/** App entry: exact bundle id, exact app name (case-insensitive), or bundle prefix ending in ".". */
export function appMatches(bundleId: string | null, appName: string | null, entry: string): boolean {
  const e = entry.toLowerCase().trim();
  if (!e) return false;
  const b = bundleId?.toLowerCase() ?? null;
  const n = appName?.toLowerCase() ?? null;
  if (b !== null && (b === e || (e.endsWith(".") && b.startsWith(e)))) return true;
  return n !== null && n === e;
}

function rolesOf(payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  const roles = payload.roles ?? payload.ax_roles ?? payload.element_roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((r): r is string => typeof r === "string").map((r) => r.toLowerCase());
}

/**
 * The never-list half, pure over the input. Exported so the sidecar-mirror
 * rules can be asserted on their own.
 */
export function neverListVerdict(input: FilterInput): FilterDrop | null {
  const p = input.payload;
  const bundle = str(p?.bundle_id)?.toLowerCase() ?? null;
  if (bundle) {
    for (const prefix of PASSWORD_MANAGER_BUNDLE_PREFIXES) {
      if (bundle.startsWith(prefix)) {
        return { dropped: true, reason: "never:password-manager", match: prefix };
      }
    }
  }
  if (p && p.ax_private === true) return { dropped: true, reason: "never:private-window", match: "ax_private" };
  if (bundle && PRIVATE_MODE_BROWSER_BUNDLES.has(bundle)) {
    const title = str(p?.window_title)?.toLowerCase() ?? "";
    for (const marker of PRIVATE_WINDOW_TITLE_MARKERS) {
      if (title.includes(marker)) return { dropped: true, reason: "never:private-window", match: marker };
    }
  }
  for (const role of rolesOf(p)) {
    if (SECURE_FIELD_ROLES.has(role)) return { dropped: true, reason: "never:secure-field", match: role };
  }
  const stream = (input.streamKey ?? input.streamExternalKey ?? "").toLowerCase();
  if (stream === WHATSAPP_STATUS_STREAM || stream.endsWith(`:${WHATSAPP_STATUS_STREAM}`)) {
    return { dropped: true, reason: "never:status-broadcast", match: WHATSAPP_STATUS_STREAM };
  }
  return null;
}

/** The user-lists half over lists already in hand (pure; the funnel passes the cached lists). */
export function userListVerdict(
  input: FilterInput,
  lists: Record<CaptureListKind, string[]>,
): FilterDrop | null {
  const p = input.payload;
  if (lists.apps.length > 0) {
    const bundle = str(p?.bundle_id);
    const appName = str(p?.app_name) ?? str(p?.app) ?? str(p?.browser);
    if (bundle || appName) {
      for (const e of lists.apps) {
        if (appMatches(bundle, appName, e)) return { dropped: true, reason: "list:app", match: e };
      }
    }
  }
  if (lists.sites.length > 0) {
    const hosts = new Set<string>();
    const domain = str(p?.domain);
    if (domain) hosts.add(domain.toLowerCase());
    for (const k of ["url", "doc_key", "link_url"]) {
      const h = hostOf(str(p?.[k]));
      if (h) hosts.add(h);
    }
    for (const h of hosts) {
      for (const e of lists.sites) {
        if (domainMatches(h, e)) return { dropped: true, reason: "list:site", match: e };
      }
    }
  }
  if (lists.chats.length > 0) {
    const keys = [input.streamKey, input.streamExternalKey].filter((k): k is string => !!k);
    for (const k of keys) {
      for (const e of lists.chats) {
        if (k === e || k.toLowerCase() === e.toLowerCase()) return { dropped: true, reason: "list:chat", match: e };
      }
    }
  }
  if (lists.senders.length > 0) {
    const keys = [input.actor, input.sender, input.actorExternalKey].filter((k): k is string => !!k);
    for (const k of keys) {
      for (const e of lists.senders) {
        const kl = k.toLowerCase();
        const el = e.toLowerCase();
        if (kl === el || kl === `contact:${el}` || kl.endsWith(`:${el}`)) {
          return { dropped: true, reason: "list:sender", match: e };
        }
      }
    }
  }
  return null;
}

/**
 * The filter, in the spec's order: never-list → user lists → pause states.
 * null admits; a FilterDrop means the funnel writes nothing.
 */
export function filterCapture(input: FilterInput, nowMs: number = Date.now()): FilterDrop | null {
  const never = neverListVerdict(input);
  if (never) return never;
  const lists = readCaptureLists();
  const listed = userListVerdict(input, lists);
  if (listed) return listed;
  if (privateMomentUntil(nowMs) !== null) return { dropped: true, reason: "pause:private-moment" };
  if (quickPauseUntil(nowMs) !== null) return { dropped: true, reason: "pause:quick-pause" };
  return null;
}
