// ===========================================================================
// Source-neutral ingestion types (docs/PHASE1_CONTRACT §3, §6, §7).
//
// These types are the integration surface between:
//   - the SourceAdapter implementations (WhatsApp today, more later),
//   - the ingestion writer + in-memory status,
//   - and the worker HTTP/SSE API.
//
// They are load-bearing and MIRRORED into `src/lib/worker-client.ts` for the UI
// (same pattern as the Phase-0 provider types). Keep names + shapes in sync with
// the contract. This module is types-only (no runtime code).
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

/**
 * Link preview carried on an event (v3 §3). `url` is whatsmeow's `MatchedText`
 * — the canonical URL on an ExtendedTextMessage. A plain `Conversation` carries
 * no preview at all, so a URL found in plain text arrives with `url` alone.
 */
export interface Link {
  url: string;
  title?: string;
  description?: string;
  /** JPEGThumbnail written next to the message's media, when one was sent. */
  thumb_path?: string;
  preview_type?: string;
}

/**
 * Quoted-reply reference carried on an event (contract §R5.4). Points at the
 * message this event quotes. `text` is the extracted quoted snippet; `actor_ext_id`
 * is the canonical sender of the quoted message (→ actors.source_ext_id).
 */
export interface ReplyTo {
  /** The quoted message's external_id, "<chatJID>/<StanzaID>". */
  external_id: string;
  /** Extracted quoted text (may be ""). */
  text: string;
  /** Canonical sender of the quoted message. */
  actor_ext_id: string;
}

/** A message/media/system event (contract §3). Source-neutral. */
export interface SourceEvent {
  /** Stable dedupe key WITHIN the source, e.g. "<chatJID>/<messageID>". */
  external_id: string;
  /** -> channels.source_ext_id */
  channel_ext_id: string;
  /** -> actors.source_ext_id (self JID for from_me). */
  actor_ext_id: string;
  /** Message timestamp, ISO-8601 UTC ms. */
  ts: string;
  kind: EventKind;
  /**
   * Body / caption / ''. For `kind:"reaction"` this is the emoji ("" = the
   * actor removed their reaction).
   */
  text: string;
  /** null when no media. */
  media?: MediaInfo | null;
  /** null/omitted when the message carries no URL (v3 §3). */
  link?: Link | null;
  from_me: boolean;
  /**
   * Quoted-reply reference (contract §R5.4). null/omitted when the event does
   * not quote another message.
   */
  reply_to?: ReplyTo | null;
  /**
   * For `kind:"reaction"` (contract §R5.3): the TARGET message's external_id.
   * (For quoted replies the target ref instead travels via `reply_to`.) The
   * worker maps this straight to `events.reply_to_external_id`.
   */
  reply_to_external_id?: string | null;
  /**
   * The edited message's external_id. The event carries the NEW body: the writer
   * updates the target row in place instead of inserting a second row.
   */
  edit_of_external_id?: string | null;
  /**
   * The revoked ("delete for everyone") message's external_id. The writer
   * tombstones the target row instead of inserting the revoke event.
   */
  revoke_of_external_id?: string | null;
  is_forwarded?: boolean;
  /**
   * The event came from history sync rather than arriving live (v4 §4b). Both
   * travel the same callback, and only a genuine arrival may jump the media
   * queue, so absent reads as live — which is what an older daemon means.
   */
  is_historical?: boolean;
  /** Canonical ext ids of the actors @-mentioned in the body. */
  mentioned_ext_ids?: string[];
  /** Small subset of the source's native message info (id/chat/sender/…). */
  raw?: unknown;
}

/** Chat metadata upsert (contract §3). */
export interface Channel {
  source_ext_id: string;
  name: string;
  kind: "dm" | "group" | (string & {});
  /**
   * Business / official account (v3 §5). Derived by the daemon from the
   * verified / official-account name; `media.business_enabled` gates media
   * reading and link fetching on these chats.
   */
  is_business: boolean;
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

/** Raw progress as emitted by the daemon (snake_case, §1). */
export interface DaemonProgress {
  phase: "backfill" | "live";
  chats_done: number;
  chats_total: number;
  messages: number;
  done: boolean;
  range?: Range;
}

export interface SourceError {
  code: string;
  message: string;
}

/**
 * A status update surfaced to consumers via `onStatus`. Discriminated by
 * `type`; unifies the daemon's status/qr/progress/paired/error lines into one
 * callback stream (contract §7), plus the worker-synthesised `ingest` nudge
 * (Rev 2 §R2.2) fanned out on the same SSE so the UI refreshes on new events.
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
  | { type: "error"; code: string; message: string; fatal: boolean }
  | { type: "ingest"; ts: string; channels: string[] };

/**
 * Live-ingest nudge frame (Rev 2 §R2.2). Emitted (debounced) by the worker
 * after new events are persisted so the UI refetches the Inbox list + open
 * chat. `channels` are the distinct channel ids touched since the last nudge
 * (deduped; may be capped/omitted — presence of the frame is the signal).
 */
export interface IngestNudge {
  type: "ingest";
  ts: string;
  channels: string[];
}

/** Adapter status snapshot returned by `getStatus()` and the status API. */
export interface AdapterStatus {
  state: SourceState;
  paired: boolean;
  paused: boolean;
  jid?: string;
  pushName?: string;
  progress?: Progress;
  lastError?: SourceError;
  /** True once the FIRST backfill completed (Rev 2 §R2.1). Survives restart. */
  importDone?: boolean;
  /** The chosen import range, persisted with importDone (Rev 2 §R2.1). */
  importRange?: Range;
}

// ---- HTTP API response shapes (§6) ----------------------------------------

/** GET /api/whatsapp/status — same as AdapterStatus. */
export type WhatsAppStatusResponse = AdapterStatus;

/** One row of GET /api/inbox/chats. */
export interface InboxChat {
  id: string;
  name: string | null;
  kind: string | null;
  lastText: string | null;
  lastTs: string | null;
  messageCount: number;
}

/**
 * A single net-current reaction on a message (contract §R5.3). One entry per
 * actor who currently reacts (a later empty-text reaction from an actor removes
 * theirs, so removed reactions never appear here).
 */
export interface MessageReaction {
  /** The reaction emoji (never ""). */
  emoji: string;
  /** True if the self user placed this reaction. */
  fromMe: boolean;
  /** Display name of the reacting actor, or null if unknown. */
  actorName: string | null;
}

/**
 * Quoted-reply block returned on a message (contract §R5.4). Present when the
 * message quotes another; the target may or may not be in the imported set.
 */
export interface MessageReplyRef {
  /** The quoted message's external_id. */
  externalId: string;
  /** Stored quoted snippet text (may be ""). */
  text: string | null;
  /** Display name of the quoted actor if resolvable, else null. */
  actorName: string | null;
}

/**
 * Link preview returned on a message (v3 §3). `scrapedText` is present only
 * once link scraping ran — it is off by default.
 */
export interface MessageLink {
  url: string;
  title: string | null;
  description: string | null;
  previewType: string | null;
  scrapedText: string | null;
  /** Served like `mediaUrl` — the stored path never leaves the worker. */
  thumbUrl?: string;
}

/**
 * One frame sampled out of a video (v5 §2). `seconds` is the offset into the
 * clip; the file is served like `mediaUrl` because the stored path is absolute
 * and never leaves the worker.
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
  mediaUrl?: string;
  /**
   * Media metadata from the `media_*` columns (media spec §4). Sent only
   * alongside `mediaUrl`: a revoked message has no media_path left, so its
   * stored description must not travel either.
   */
  mediaMime?: string | null;
  mediaFilename?: string | null;
  mediaSize?: number | null;
  /** Audio + video duration. */
  mediaSeconds?: number | null;
  /** What the media reader saw in the attachment (media spec §8). */
  mediaDescription?: string | null;
  /**
   * Frames sampled across a video (v5 §2), in clip order. Absent until frame
   * sampling is switched on, and absent on a revoked row — the files it pointed
   * at are swept.
   */
  mediaFrames?: MessageFrame[];
  /**
   * What whisper heard in a voice note or a video's audio (v5 §3). Local and
   * token-free, but off by default, so it is absent until it is switched on.
   */
  transcript?: string | null;
  /** Set when the sender edited the message; `text` is the edited body (§5). */
  editedAt: string | null;
  /** Set when the sender deleted for everyone; `text`/media are cleared (§5). */
  revokedAt: string | null;
  isForwarded: boolean;
  /**
   * Net-current reactions attached to this message (contract §R5.3). Reaction
   * rows never appear as standalone messages — they are folded in here.
   */
  reactions: MessageReaction[];
  /** Quoted-reply block (contract §R5.4), or null when not a reply. */
  replyTo: MessageReplyRef | null;
  /** Link preview (v3 §3), or null when the message carries no URL. */
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
