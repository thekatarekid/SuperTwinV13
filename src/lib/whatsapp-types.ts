// ===========================================================================
// WhatsApp + Inbox contract types — MIRRORED from worker/src/adapters/types.ts
// (docs/PHASE1_CONTRACT §3, §6). Kept local so the UI has no cross-package
// import (same pattern the Phase-0 provider types used in worker-client.ts).
//
// These are types-only mirrors plus the small runtime helpers the UI needs
// (RANGES list, isRange guard, human range labels). Keep names + shapes in
// sync with the worker source of truth.
// ===========================================================================

// ---- Range (§3) -----------------------------------------------------------

/** Import range enum. `all` = no cutoff (epoch 0). */
export type Range =
  | "24h"
  | "3d"
  | "7d"
  | "30d"
  | "90d"
  | "180d"
  | "1y"
  | "all";

/** All valid Range values, in ascending duration order. */
export const RANGES: readonly Range[] = [
  "24h",
  "3d",
  "7d",
  "30d",
  "90d",
  "180d",
  "1y",
  "all",
] as const;

export function isRange(v: unknown): v is Range {
  return typeof v === "string" && (RANGES as readonly string[]).includes(v);
}

/** Human-readable labels for the import/extend range picker. */
export const RANGE_LABELS: Record<Range, string> = {
  "24h": "Last 24 hours",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "180d": "Last 180 days",
  "1y": "Last year",
  all: "Entire history",
};

/** Default range for a first import — small, per the Phase-1 spec ("default small for testing"). */
export const DEFAULT_IMPORT_RANGE: Range = "7d";

// ---- Daemon connection lifecycle state (§1 State enum) --------------------

export type SourceState =
  | "starting"
  | "need_pairing"
  | "pairing"
  | "connected"
  | "syncing"
  | "online"
  | "reconnecting"
  | "logged_out"
  | "error";

// ---- Media (§3 Event.media) -----------------------------------------------

export interface MediaInfo {
  path: string;
  mime?: string;
  filename?: string;
  size?: number;
  sha256?: string;
  /** JPEGThumbnail written next to `path`; the only readable frame of a video. */
  thumb_path?: string;
  width?: number;
  height?: number;
  /** Audio + video duration. */
  seconds?: number;
  /** Document page count. */
  pages?: number;
  caption?: string;
  /** PTT / voice note. */
  voice?: boolean;
  /** Animated sticker or gif-playback video. */
  animated?: boolean;
}

export type EventKind =
  | "message"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "revoked"
  | "reaction"
  | "system"
  | "poll"
  | "poll_vote"
  | "live_location"
  | "call";

/** A message/media/system event (contract §3). Source-neutral. */
export interface SourceEvent {
  external_id: string;
  channel_ext_id: string;
  actor_ext_id: string;
  ts: string;
  kind: EventKind;
  text: string;
  media?: MediaInfo | null;
  from_me: boolean;
  raw?: unknown;
}

/** Chat metadata upsert (contract §3). */
export interface Channel {
  source_ext_id: string;
  name: string;
  kind: "dm" | "group" | (string & {});
}

/** Sender metadata upsert (contract §3). */
export interface Actor {
  source_ext_id: string;
  display_name: string;
  handle?: string;
  is_self: boolean;
}

// ---- Progress + status (§1, §6) -------------------------------------------

/** Backfill/live progress (API shape; camelCase). */
export interface Progress {
  phase: "backfill" | "live";
  chatsDone: number;
  chatsTotal: number;
  messages: number;
  done: boolean;
  range?: Range;
}

export interface SourceError {
  code: string;
  message: string;
}

/**
 * A status update surfaced over the SSE stream (contract §6/§7). Discriminated
 * by `type`; unifies the daemon's status/qr/progress/paired/error lines into a
 * single frame stream.
 */
export type StatusUpdate =
  | {
      type: "status";
      state: SourceState;
      detail?: string;
      jid?: string;
      pushName?: string;
    }
  | { type: "qr"; code: string; timeoutS: number }
  | { type: "paired"; jid: string; pushName: string }
  | { type: "progress"; progress: Progress }
  | { type: "backfill_complete"; range: Range; chats: number; messages: number }
  // R2.2 live-ingest nudge: debounced frame emitted when new events persist.
  // `channels` = distinct channel ids touched since the last nudge (may be
  // capped/omitted — presence of the frame is the signal to refetch).
  | { type: "ingest"; ts: string; channels?: string[] }
  | { type: "error"; code: string; message: string; fatal: boolean };

/** Adapter status snapshot returned by GET /api/whatsapp/status. */
export interface AdapterStatus {
  state: SourceState;
  paired: boolean;
  paused: boolean;
  jid?: string;
  pushName?: string;
  progress?: Progress;
  lastError?: SourceError;
  /**
   * R2.1: true once the FIRST backfill has completed. When paired && importDone
   * the UI skips the range picker and goes straight to the Inbox. Treat a
   * missing value as `false` (degrade gracefully if the worker predates R2.1).
   */
  importDone?: boolean;
  /** R2.1: the range chosen for the persisted import, if known. */
  importRange?: Range;
}

/** Result of POST /api/whatsapp/reset (R2.3). */
export interface ResetResult {
  ok: boolean;
  cleared?: { events: number; channels: number; actors: number };
}

/** GET /api/whatsapp/status — same as AdapterStatus. */
export type WhatsAppStatusResponse = AdapterStatus;

// ---- HTTP API response shapes (§6) ----------------------------------------

// ---- Display helpers (name/number fallback) -------------------------------

/**
 * Best-effort display name for a chat/actor. Prefers a real resolved name from
 * the API; only when the API hands back an empty/placeholder name (or a raw
 * number/JID) do we pretty-print a phone number instead. We NEVER invent a
 * name — an unresolved contact falls back to a formatted number, and only a
 * value we cannot phone-format falls back to a neutral placeholder.
 *
 * `sourceExtId` (the row's JID, e.g. "919731006976@s.whatsapp.net") is the
 * source of the fallback number: after the Go/worker fix a business/notification
 * chat arrives with an EMPTY name (never the number), so we recover the display
 * from the JID here. When absent (older worker), we still degrade gracefully —
 * if the name itself is number-ish we pretty-print it, else the placeholder.
 *
 *   ("Mom", …)                                  -> "Mom"
 *   (null, "919731006976@s.whatsapp.net")        -> "+91 97310 06976"
 *   ("919731006976@s.whatsapp.net", …)           -> "+91 97310 06976"
 *   ("919731006976", …)                          -> "+91 97310 06976"
 *   (null, "19602432098323@lid")                  -> fallback placeholder
 *   (null, "120363...@g.us") / (null, undefined) -> fallback placeholder
 *
 * A `@lid` JID's local part is a WhatsApp privacy identifier (NOT a phone
 * number), so we never pretty-print it — that would fabricate a bogus number.
 * Only real phone-number JIDs (`@s.whatsapp.net`, `@c.us`) are formatted.
 */
export function displayName(
  name: string | null | undefined,
  sourceExtId?: string | null,
  fallback = "Unknown",
): string {
  const trimmed = (name ?? "").trim();
  // Empty / null / whitespace or a WhatsApp privacy-masked number
  // ("+91••••••15") is not a usable name (contract §1, §R7.3): recover the
  // number from the row's JID (source_ext_id) when we have one, else fall back
  // cleanly — never render raw stars or an empty label.
  if (trimmed.length === 0 || isMaskedNumber(trimmed)) {
    return wellKnownName(sourceExtId) ?? prettyFromSource(sourceExtId) ?? fallback;
  }
  // A resolved human name (has letters, isn't a formatted number): keep as-is.
  if (!looksLikeJidOrNumber(trimmed)) return trimmed;
  // A number/JID stored as the name (pre-fix rows / older worker): pretty-print
  // the name itself; if that fails, try the JID, then the placeholder.
  return (
    wellKnownName(trimmed) ??
    prettyPhone(trimmed) ??
    wellKnownName(sourceExtId) ??
    prettyFromSource(sourceExtId) ??
    fallback
  );
}

/**
 * JIDs owned by WhatsApp itself. Their local part is NOT a phone number ("0" is
 * the PSA/announcements account), so prettyPhone() correctly refuses to format
 * it — leaving these chats with no label at all. WhatsApp ships no name for
 * them through any readable channel; its own clients hardcode the label too.
 *
 * The daemon applies the same label at ingestion (officialAccountName in
 * sources/whatsapp-go/internal/wa/helpers.go); this is the render-side safety
 * net for rows already in the DB from before that fix.
 *
 * Deliberately excludes status@broadcast — the Status/Stories feed is not the
 * WhatsApp account and is asserted to render as the neutral placeholder.
 */
const WELL_KNOWN_JID_NAMES = new Map<string, string>([
  ["0@s.whatsapp.net", "WhatsApp"],
  ["0@c.us", "WhatsApp"],
  ["16505361212@s.whatsapp.net", "WhatsApp"],
  ["16505361212@c.us", "WhatsApp"],
]);

/** Well-known label for a JID, or null. Accepts a JID in either position. */
function wellKnownName(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase();
  if (t.length === 0) return null;
  return WELL_KNOWN_JID_NAMES.get(t) ?? null;
}

/**
 * WhatsApp JID servers whose local part IS the actual phone number. Only these
 * may be pretty-printed as a number. A `@lid` JID's local part is a privacy
 * identifier (NOT a phone number), and `@g.us`/`@newsletter`/`@broadcast` are
 * group/channel ids — prettyPhone() on any of them would fabricate a bogus
 * "+CC …" number, which violates the "never show a fabricated number" goal.
 */
const PHONE_JID_SERVERS = new Set(["s.whatsapp.net", "c.us"]);

/**
 * prettyPhone() over a chat/actor's JID (source_ext_id), or null when absent or
 * not a phone-number JID. A JID with a server suffix is only phone-formatted
 * when the server is a real phone-number server (see PHONE_JID_SERVERS); a `@lid`
 * or group/channel JID returns null so the caller falls back to a neutral label
 * rather than a fabricated number. A bare number (no server) keeps its behavior.
 */
function prettyFromSource(sourceExtId: string | null | undefined): string | null {
  const s = (sourceExtId ?? "").trim();
  if (s.length === 0) return null;
  const at = s.indexOf("@");
  if (at !== -1 && !PHONE_JID_SERVERS.has(s.slice(at + 1))) return null;
  return prettyPhone(s);
}

/** True when the string is a bare phone number or a whatsapp JID (not a name). */
function looksLikeJidOrNumber(s: string): boolean {
  const local = s.includes("@") ? s.slice(0, s.indexOf("@")) : s;
  return /^\+?\d[\d\s-]*$/.test(local);
}

/** Mask glyphs WhatsApp uses to redact a privacy-masked number's middle. */
const MASK_GLYPHS = /[*.·•‧∙⋅∗✱⁎●○…＊．]/gu;
/** Only phone-ish characters (digits, separators, mask glyphs). */
const PHONE_ISH_MASK = /^[\d+()/~ *.·•‧∙⋅∗✱⁎●○…＊．-]+$/u;

/**
 * True when a string is a WhatsApp privacy-masked number — a phone-shaped value
 * whose middle is redacted with mask glyphs (asterisks/bullets/mid-dots), e.g.
 * "+91••••••15" or "+91 ***** **015". Requires ≥2 mask glyphs, NO letters (a
 * real name has letters) and only phone-ish characters otherwise, so ordinary
 * names/numbers are never misclassified. We never SYNTHESIZE these — WhatsApp
 * hands them to us as a contact's name and we must not render the raw stars
 * (contract §R7.3).
 */
export function isMaskedNumber(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;
  if (/\p{L}/u.test(t)) return false; // a real name has letters
  const masks = t.match(MASK_GLYPHS);
  if (!masks || masks.length < 2) return false;
  return PHONE_ISH_MASK.test(t);
}

/**
 * Format a phone-number JID / bare number as a readable international number.
 * Uses a small, safe heuristic: a leading "91" (India, the primary user) is
 * grouped as "+91 XXXXX XXXXX"; other numbers get a generic "+CC rest" split.
 * Returns null for values that don't look like a usable phone number (e.g. a
 * group JID whose local part isn't a phone number).
 */
export function prettyPhone(jidOrNumber: string): string | null {
  const local = jidOrNumber.includes("@")
    ? jidOrNumber.slice(0, jidOrNumber.indexOf("@"))
    : jidOrNumber;
  const digits = local.replace(/[^\d]/g, "");
  // WhatsApp phone numbers are ~10–15 digits (E.164). Anything wildly off (a
  // group id can be 18+ digits) isn't a phone number we should pretty-print.
  if (digits.length < 8 || digits.length > 15) return null;

  // India (+91): 12 digits total (91 + 10-digit mobile) → "+91 XXXXX XXXXX".
  if (digits.startsWith("91") && digits.length === 12) {
    const n = digits.slice(2);
    return `+91 ${n.slice(0, 5)} ${n.slice(5)}`;
  }
  // Generic: assume a 1–3 digit country code, then group the rest in blocks.
  const cc = digits.length > 11 ? digits.slice(0, digits.length - 10) : digits.slice(0, 1);
  const rest = digits.slice(cc.length);
  const blocks = rest.replace(/(\d{3,4})(?=\d)/g, "$1 ").trim();
  return `+${cc} ${blocks}`;
}

/** One row of GET /api/inbox/chats. */
export interface InboxChat {
  id: string;
  name: string | null;
  kind: string | null;
  /**
   * The chat's WhatsApp JID (channels.source_ext_id), e.g.
   * "919731006976@s.whatsapp.net". Used to prettyPhone() a phone-number
   * fallback when `name` is empty/placeholder (a business/notification chat
   * arrives nameless after the Go/worker fix). Optional for backward-compat
   * with a worker that predates this — degrade to the neutral placeholder.
   */
  sourceExtId?: string | null;
  lastText: string | null;
  lastTs: string | null;
  messageCount: number;
}

/**
 * A reaction attached to a message (R5.3). The worker collapses reaction events
 * onto their target message: `getChannelMessages` never returns reaction rows in
 * the stream, only these attached entries. `emoji` is the reaction glyph; a
 * removed reaction is dropped by the worker rather than surfaced here.
 */
export interface Reaction {
  emoji: string;
  fromMe: boolean;
  actorName: string | null;
}

/**
 * The quoted-message reference on a reply (R5.4). Present when a message quotes
 * another. `text` is the (possibly empty) quoted snippet; `externalId` is the
 * quoted target's stable id; `actorName` is the quoted sender if resolvable.
 */
export interface ReplyTo {
  externalId: string;
  text: string | null;
  actorName: string | null;
  /** The quoted sender's JID (actors.source_ext_id), for a phone-number
   * fallback when `actorName` is empty/placeholder. Optional (older worker). */
  actorSourceExtId?: string | null;
}

/**
 * A link preview attached to a message (v3 §3). `title`/`description`/`thumbUrl`
 * are what WhatsApp itself sent with the message; `scrapedText` is the readable
 * text of the page the link points at, fetched by the worker only when link
 * fetching is switched on. That text is nobody's words — the UI must label it
 * the way it labels a media description.
 */
export interface MessageLink {
  url: string;
  title: string | null;
  description: string | null;
  previewType: string | null;
  scrapedText: string | null;
  /** Served like `mediaUrl`; the stored thumbnail path never leaves the worker. */
  thumbUrl?: string;
}

/**
 * One frame sampled out of a video (v5 §2). `seconds` is where in the clip it
 * was taken, so the strip can be labelled rather than read as N unrelated
 * stills. Served like `mediaUrl` — the stored path never leaves the worker.
 */
export interface MessageFrame {
  url: string;
  seconds: number;
}

/** One row of GET /api/inbox/chats/:id/messages. */
export interface InboxMessage {
  id: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  fromMe: boolean;
  actorName: string | null;
  /** Relative "/api/media/:eventId" when the message carries media. */
  mediaUrl?: string;
  /**
   * Relative "/api/media/:eventId/thumb" — the stored poster frame, and the only
   * readable part of a video. Absent when the row has no thumbnail on disk.
   */
  mediaThumbUrl?: string;
  /**
   * Media metadata from the `media_*` columns (docs/rich-media-spec.md §4).
   * All optional: a text message carries none of them, and a worker that
   * predates the media migration omits them entirely.
   */
  mediaMime?: string | null;
  mediaFilename?: string | null;
  mediaSize?: number | null;
  /** Audio/video duration in seconds. */
  mediaSeconds?: number | null;
  /**
   * The picture's own pixel size, when WhatsApp sent it. The <img> is given
   * these so the browser reserves the right box before the bytes decode — an
   * image that grows from nothing to its full height after paint is what makes
   * a scrolled-back thread jump (v7 §5). Null when the row carries no
   * dimensions; absent on a worker that predates them.
   */
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  /**
   * What the media model read out of the attachment (`media_description`).
   * Model-written, never the sender's words — the UI must label it as such.
   */
  mediaDescription?: string | null;
  /**
   * v5 §2: frames sampled across a video, in clip order. Absent until frame
   * sampling is switched on, and absent on a revoked row — the files it pointed
   * at are swept. These are N stills, NOT the whole video.
   */
  mediaFrames?: MessageFrame[];
  /**
   * v5 §3: what whisper heard in a voice note or a video's audio. Machine-read
   * like `mediaDescription`, never the sender's words — the UI must label it as
   * such. Absent until transcription is switched on.
   */
  transcript?: string | null;
  /**
   * Set when the sender edited the message; `text` is the edited body. An edit
   * rewrites the ORIGINAL row (spec §5), so this marker is the only thing that
   * distinguishes an edited message from one that was always this way.
   */
  editedAt?: string | null;
  /**
   * Set when the sender deleted for everyone. A revoke also tombstones the
   * original row rather than inserting a `revoked` event, so `kind` still reads
   * image/message while `text` and the media are gone — without this the bubble
   * would render empty.
   */
  revokedAt?: string | null;
  isForwarded?: boolean;
  /**
   * R5.3: reactions attached to this message (WhatsApp-style emoji chips). The
   * worker excludes reaction events from the stream and attaches them here.
   * Absent/empty on older workers — render nothing in that case.
   */
  reactions?: Reaction[];
  /**
   * R5.4: the quoted message this one replies to, or null/absent when not a
   * reply. Older workers omit it entirely — degrade to no quoted block.
   */
  replyTo?: ReplyTo | null;
  /**
   * The link preview, or null/absent when the message carries no URL. Absent on
   * a worker that predates links — render nothing in that case.
   */
  link?: MessageLink | null;
}

/** One row of GET /api/inbox/search. */
export interface SearchHit {
  eventId: string;
  channelId: string | null;
  channelName: string | null;
  ts: string | null;
  snippet: string;
  text: string | null;
}
