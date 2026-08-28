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

/** Import range enum. `all` = no cutoff (epoch 0). P0.6 adds 2y–5y. */
export type Range =
  | "24h"
  | "3d"
  | "7d"
  | "30d"
  | "90d"
  | "180d"
  | "1y"
  | "2y"
  | "3y"
  | "4y"
  | "5y"
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
  "2y",
  "3y",
  "4y",
  "5y",
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

// ---- V13 envelope (spec §6.1, P0.6) ---------------------------------------

export type V13AgeBand = "A" | "B" | "C" | "D";
export type V13Origin = "live" | "backfill";

/** roles {sender, audience[], receiver[], mentions[]} — structural, never guessed. */
export interface V13Roles {
  sender: string;
  audience: string[];
  receiver: string[];
  mentions: string[];
}

/**
 * The spec §6.1 event envelope, built at the adapter boundary (roles from the
 * observed roster, @mentions structural, reply markers in the payload) and
 * carried on the SourceEvent into the events writer, which stamps it onto the
 * event row's v13 columns (0100_v13_core).
 */
export interface V13Envelope {
  /** ULID — time-sortable, unique. */
  id: string;
  ts: string;
  captured_at: string;
  source: string;
  /** Namespaced kind, e.g. "wa.message". */
  kind: string;
  origin: V13Origin;
  age_band: V13AgeBand;
  stream_key: string;
  /** Sender ref ("self" for own messages). */
  actor: string;
  roles: V13Roles;
  payload: Record<string, unknown>;
  content_hash: string;
  blob_refs: string[];
}

/** A message/media/system event (contract §3). Source-neutral. */
export interface SourceEvent {
  /** Stable dedupe key WITHIN the source, e.g. "<chatJID>/<messageID>". */
  external_id: string;
  /** -> streams.external_key (arch §3.3 leak 6: a channel is a stream). */
  stream_ext_id: string;
  /**
   * @deprecated The daemon's wire name for `stream_ext_id`. Adapters normalise
   * it away at the boundary; nothing inside the worker reads it.
   */
  channel_ext_id?: string;
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
  /**
   * Set by the adapter when the source's timestamp was more than five minutes
   * in the future and had to be clamped to now (see ./normalize.ts). Holds what
   * the source claimed, so a wrong phone clock is visible rather than silently
   * absorbed. `ts` is already the clamped value.
   */
  skew_clamped_from?: string;
  /** Small subset of the source's native message info (id/chat/sender/…). */
  raw?: unknown;
  /**
   * The spec §6.1 envelope for this event (P0.6), built by the adapter with
   * structural roles. When present, the events writer stamps it onto the v13
   * columns verbatim; when absent, a minimal envelope is derived (legacy
   * bridge in db/eventlog.ts).
   */
  envelope?: V13Envelope;
}

/** Stream (lane) metadata upsert (contract §3, arch §2). */
export interface Stream {
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

/** @deprecated One release only — the name `channel` is now `stream`. */
export type Channel = Stream;

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

// ---- History depth (shallow-bootstrap detection) --------------------------

/**
 * One HistorySync payload as the daemon reports it (`t:"history_sync"`), already
 * renamed to camelCase at the adapter boundary. Counters are PER PAYLOAD, never
 * cumulative — the worker accumulates (ingest/history-depth.ts).
 *
 * The frame is OPTIONAL: on a daemon that does not emit it every field is simply
 * absent and the shape-only fallback decides. `syncType` is whatsmeow's raw enum
 * name (INITIAL_BOOTSTRAP / FULL / RECENT / ON_DEMAND / …) and is only ever
 * compared as a string, so a new type needs no release here.
 */
export interface HistorySyncPayload {
  syncType: string;
  /** WhatsApp's own 0-100 progress for the sync, when it sends one. */
  progress?: number;
  chats: number;
  chatsInRange: number;
  /** Messages the payload carried, before the range filter. */
  messagesSeen: number;
  messagesInRange: number;
  /** Messages actually emitted to the worker. */
  messagesEmitted: number;
  /** Dropped by the range filter or by mapping. */
  messagesFiltered: number;
  onDemand: boolean;
}

export type HistoryDepthVerdict = "unknown" | "shallow" | "deep";

/** Why {@link HistoryDepth.verdict} says what it says (drives the UI copy). */
export type HistoryDepthReason =
  | "no_history"
  | "healthy_shape"
  | "bulk_received"
  | "bootstrap_only"
  | "sparse_chats"
  | "sparse_after_bulk";

/**
 * The verdict on a settled import: did WhatsApp re-upload the archive, or only
 * the bootstrap batch? Carried on {@link AdapterStatus} and persisted, so the
 * Inbox can state what actually arrived instead of showing a finished import
 * holding one message per chat with no explanation.
 */
export interface HistoryDepth {
  verdict: HistoryDepthVerdict;
  reason: HistoryDepthReason;
  /** Shape read back from the DB after the import went quiet. */
  chats: number;
  messages: number;
  singleMessageChats: number;
  /** Daemon `history_sync` payloads seen; 0 when the daemon reports none. */
  payloads: number;
  bulkPayloads: number;
  syncTypes: string[];
  messagesSeen: number;
  messagesEmitted: number;
  messagesFiltered: number;
  /** False when the daemon sent no payload frames — verdict is shape-only. */
  syncTypesKnown: boolean;
  checkedAt: string;
}

/**
 * What one "Extend history" run actually recovered. `messagesRecovered` counts
 * rows that PERSISTED (dedupe already applied), not rows the daemon emitted, so
 * a run that re-fetched pages already held reports 0 rather than a flattering
 * number. WhatsApp caps an on-demand page at 50 messages per request, so a
 * non-zero result does not mean the chat is exhausted — hence `mayHaveMore`.
 */
export interface ExtendOutcome {
  range: Range;
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  /** Chats the daemon said it paginated (its own `backfill_complete` count). */
  chatsPaginated: number;
  /** Streams that gained at least one NEW row during this run. */
  streamsWithNewMessages: number;
  messagesRecovered: number;
  /** True while more pages could plausibly be waiting behind the 50-msg cap. */
  mayHaveMore: boolean;
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
  | { type: "ingest"; ts: string; streams: string[]; channels: string[] }
  // One HistorySync payload was processed by the daemon. Forwarded verbatim so
  // a subscriber can watch the sync arrive chunk by chunk.
  | { type: "history_sync"; payload: HistorySyncPayload }
  // The settled import has been judged (fires once per quiet window).
  | { type: "history_depth"; depth: HistoryDepth }
  // An "Extend history" run started or finished, with what it recovered.
  | { type: "extend_result"; outcome: ExtendOutcome }
  // Outcome of one `send_message` command (P0.6). `ok:false` covers both the
  // daemon's approval-token refusal (SEND_REFUSED) and a transport failure;
  // `externalId` is the sent message's "<chat>/<id>" on success.
  | { type: "send_result"; ok: boolean; externalId?: string; detail?: string };

/**
 * Live-ingest nudge frame (Rev 2 §R2.2). Emitted (debounced) by the worker
 * after new events are persisted so the UI refetches the Inbox list + open
 * chat. `channels` are the distinct channel ids touched since the last nudge
 * (deduped; may be capped/omitted — presence of the frame is the signal).
 */
export interface IngestNudge {
  type: "ingest";
  ts: string;
  /** Distinct stream ids touched since the last nudge. */
  streams: string[];
  /**
   * @deprecated The same ids under their old name, so the UI keeps working for
   * one release (arch §3.3 leak 6).
   */
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
  /**
   * The verdict on the settled import. Absent until the first quiet window
   * closes; persisted across restarts so the Inbox does not forget.
   */
  historyDepth?: HistoryDepth;
  /** What the most recent "Extend history" run recovered. Persisted. */
  lastExtend?: ExtendOutcome;
}

// ---- HTTP API response shapes (§6) ----------------------------------------

/** GET /api/sources/:source_id/status — same as AdapterStatus. */
export type SourceStatusResponse = AdapterStatus;

/** @deprecated Old name of `SourceStatusResponse`, one release. */
export type WhatsAppStatusResponse = AdapterStatus;

/** One row of GET /api/sources/:source_id/streams (a.k.a. /api/inbox/chats). */
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
  streamId: string | null;
  streamName: string | null;
  /** @deprecated The same value under its old name, one release. */
  channelId: string | null;
  /** @deprecated The same value under its old name, one release. */
  channelName: string | null;
  ts: string | null;
  snippet: string;
  text: string | null;
}
