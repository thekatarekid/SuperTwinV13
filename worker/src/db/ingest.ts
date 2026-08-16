// ===========================================================================
// Ingestion data-access (docs/PHASE1_CONTRACT §5, §6).
//
// The Node worker is the SINGLE DB writer. These helpers own the source-agnostic
// ingestion path: upsert sources/streams/actors (+ people), insert events with
// dedupe (INSERT ... ON CONFLICT(source_id, external_id) DO NOTHING), apply the
// mutations that rewrite an already-stored event (edit / revoke / reaction
// removal), and the read queries powering the Inbox API (chats list, message
// paging, FTS search, media resolution) plus the media-reading, transcription
// and link-scraping queues and a tiny app_state key/value store.
//
// Everything uses prepared, parameterized statements. The FTS5 `events_fts` table
// is kept in sync by triggers on `events` (0017_reply_fts) — we ONLY insert into
// `events`, never touch `events_fts` directly.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";
import {
  invalidateEventEmbedding,
  invalidateEventEmbeddingByExternalId,
} from "./embeddings.js";

// ---- app_state keys (Rev 2 §R2.1; arch §3.3 leak 3) -----------------------
// Every key a source owns is namespaced `source.<id>.*`. The old flat keys
// (`whatsapp.import_done`) made a second source impossible to add without
// either colliding or special-casing, which is the same leak as a hardcoded
// `wa:` prefix wearing different clothes.

/** `source.<id>.<name>` — the only shape a source's app_state key may take. */
export function sourceStateKey(sourceId: string, name: string): string {
  return `source.${sourceId}.${name}`;
}

/** "true" once the FIRST backfill/import completes, per source. */
export function importDoneKey(sourceId: string): string {
  return sourceStateKey(sourceId, "import_done");
}
/** The chosen <Range> persisted alongside the import-done flag. */
export function importRangeKey(sourceId: string): string {
  return sourceStateKey(sourceId, "import_range");
}
/** Kill-switch: "1" while this source is paused. */
export function pausedKey(sourceId: string): string {
  return sourceStateKey(sourceId, "paused");
}
/**
 * How "me" appears in this source — the value the manifest's
 * `self_identity.value_getter` reads (a JID for WhatsApp, an address for mail).
 * The KEY is source-neutral on purpose: the generic layer resolves "is this
 * event from me" without knowing what kind of identity it is comparing.
 */
export function selfIdentityKey(sourceId: string): string {
  return sourceStateKey(sourceId, "self_identity");
}

/**
 * SQL fragment resolving the self identity of the source that owns the joined
 * event row. Correlated per row, so one query answers `from_me` for every
 * source at once instead of naming one.
 */
const SELF_IDENTITY_SQL =
  `(SELECT value FROM app_state WHERE key = 'source.' || e.source_id || '.self_identity')`;

// ---- Params + row shapes --------------------------------------------------

export interface UpsertSourceParams {
  id: string;
  type: string;
  name?: string | null;
}

export interface UpsertStreamParams {
  sourceId: string;
  sourceExtId: string;
  name?: string | null;
  kind?: string | null;
  /** Business / official account, as flagged by the daemon (v3 §5). */
  isBusiness?: boolean;
}

/** @deprecated One release only — the name `channel` is now `stream`. */
export type UpsertChannelParams = UpsertStreamParams;

export interface UpsertActorParams {
  sourceId: string;
  sourceExtId: string;
  displayName?: string | null;
  handle?: string | null;
  isSelf?: boolean;
}

export interface InsertEventRow {
  externalId: string;
  sourceId: string;
  sourceType: string;
  /** -> streams.id (arch §6). Was `channelId` before the fold. */
  streamId: string | null;
  actorId: string | null;
  ts: string | null;
  kind: string | null;
  text: string | null;
  mediaPath: string | null;
  rawJson: string | null;
  /**
   * Threading target ref (§R5.3/§R5.4). For kind='reaction' the TARGET message's
   * external_id; for a quoted reply the quoted message's external_id. null otherwise.
   */
  replyToExternalId?: string | null;
  /** Quoted snippet text on a reply row (§R5.4). null for reactions/plain messages. */
  replyToText?: string | null;
  mediaMime?: string | null;
  mediaFilename?: string | null;
  mediaSize?: number | null;
  mediaSha256?: string | null;
  mediaThumbPath?: string | null;
  mediaSeconds?: number | null;
  /** JSON-encoded MediaMeta (width/height/pages/caption/voice/animated). */
  mediaMetaJson?: string | null;
  isForwarded?: boolean;
  /**
   * The link preview carried on the message (v3 §3). A plain-text URL arrives
   * with `linkUrl` alone — WhatsApp attaches no preview to a Conversation.
   */
  linkUrl?: string | null;
  linkTitle?: string | null;
  linkDescription?: string | null;
  linkThumbPath?: string | null;
  linkPreviewType?: string | null;
  /**
   * The event came from history sync (v4 §4b). Absent reads as live, which is
   * what a daemon that does not send the flag means.
   */
  isHistorical?: boolean;
}

/**
 * The low-traffic media fields, kept as JSON in `events.media_meta_json` rather
 * than one column each (media spec §1). Parsed back on every read path.
 */
export interface MediaMeta {
  width?: number;
  height?: number;
  pages?: number;
  caption?: string;
  voice?: boolean;
  animated?: boolean;
}

/** Lifecycle of one media-reading attempt (media spec §4). */
export type MediaDescStatus =
  | "pending"
  | "done"
  | "skipped"
  | "unsupported"
  | "error";

/** Link scraping runs the same lifecycle as media reading (v3 §3). */
export type LinkScrapeStatus = MediaDescStatus;

/** So does transcription (v5 §3) — one lifecycle, one vocabulary. */
export type TranscriptStatus = MediaDescStatus;

/**
 * One frame sampled out of a video (v5 §2). `seconds` is the offset into the
 * clip it was taken at, so the UI can label the sequence and the reader can say
 * what changes between them.
 */
export interface MediaFrame {
  path: string;
  seconds: number;
}

export interface InsertEventResult {
  /** Deterministic events.id — `"<source_id>:" + external_id`. */
  id: string;
  /** true if a new row was written; false if it deduped against an existing row. */
  inserted: boolean;
}

export interface InboxChatRow {
  id: string;
  name: string | null;
  /**
   * The chat's JID (streams.external_key). Lets the UI recover a display
   * value when `name` is empty — and lets it recognise WhatsApp's own system
   * JIDs, which never carry a name. Without this the entire JID-recovery
   * branch of displayName() is dead code in production.
   */
  sourceExtId: string;
  kind: string | null;
  lastText: string | null;
  lastTs: string | null;
  messageCount: number;
}

/** A net-current reaction attached to a message (§R5.3). */
export interface MessageReactionRow {
  emoji: string;
  fromMe: boolean;
  actorName: string | null;
}

/** Quoted-reply block returned on a message (§R5.4). */
export interface MessageReplyRefRow {
  externalId: string;
  text: string | null;
  actorName: string | null;
}

/** Link preview attached to a message (v3 §3). */
export interface MessageLinkRow {
  url: string;
  title: string | null;
  description: string | null;
  thumbPath: string | null;
  previewType: string | null;
  /** Readable page text, once scraping has run. */
  scrapedText: string | null;
}

export interface InboxMessageRow {
  id: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  fromMe: boolean;
  actorName: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaSize: number | null;
  mediaThumbPath: string | null;
  mediaSeconds: number | null;
  mediaMeta: MediaMeta | null;
  /** What the media reader saw in the attachment (media spec §8), or null. */
  mediaDescription: string | null;
  /** Frames sampled out of the video (v5 §2), or null when none were taken. */
  mediaFrames: MediaFrame[] | null;
  /** What whisper heard in the voice note or the video's audio (v5 §3). */
  transcript: string | null;
  /** Set when the sender edited the message; `text` is the edited body (§5). */
  editedAt: string | null;
  /** Set when the sender deleted for everyone; `text`/media are cleared (§5). */
  revokedAt: string | null;
  isForwarded: boolean;
  /** Net-current reactions attached to this message (§R5.3). */
  reactions: MessageReactionRow[];
  /** Quoted-reply block (§R5.4), or null when the message is not a reply. */
  replyTo: MessageReplyRefRow | null;
  /** Link preview (v3 §3), or null when the message carries no URL. */
  link: MessageLinkRow | null;
}

/** One event resolved by id — the media route's row, plus what grounding reads. */
export interface EventMediaRow {
  id: string;
  kind: string | null;
  text: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaSize: number | null;
  mediaSha256: string | null;
  mediaThumbPath: string | null;
  mediaSeconds: number | null;
  mediaMeta: MediaMeta | null;
  mediaDescription: string | null;
  /** Sampled video frames (v5 §2) — files the media route serves by index. */
  mediaFrames: MediaFrame[] | null;
  transcript: string | null;
  /** The link preview's thumbnail — the only file a link event ever has. */
  linkThumbPath: string | null;
}

/** One claimed row of the media-reading queue (media spec §8). */
export interface PendingMediaRow {
  id: string;
  kind: string | null;
  mediaPath: string | null;
  thumbPath: string | null;
  mime: string | null;
  filename: string | null;
  seconds: number | null;
  caption: string | null;
  /**
   * The row came from history sync (v4 §4b) — only a live arrival may jump the
   * backlog. Absent reads as live, the same way the insert path treats a missing
   * flag.
   */
  isHistorical?: boolean;
  /**
   * The event's own instant and the tier of the stream it is in — the two terms
   * of the enrichment queue key (arch §9.2/§9.3, `media/batch.ts`). Never
   * `ingested_at`: insertion order is exactly the wrong order.
   */
  ts?: string | null;
  streamId?: string | null;
  tier?: string | null;
}

/**
 * Which kinds one claim may hand out (v4 §4c). Images and stickers share a
 * prompt and ride one call ("batchable"); a video frame or a document never
 * can ("single"). Asking for one class is how the reader fills a batch without
 * a read-alone row sitting at the head of the claim.
 */
export type MediaKindClass = "batchable" | "single";

/**
 * Which pending media the claim query may hand out (v3 §2). Gating lives HERE
 * rather than at insert time: `media_desc_status` is stamped once, so a switch
 * flipped on later could never reach a row already written off — the claim runs
 * fresh on every cycle, so it can.
 */
export interface MediaClaimFilter {
  /** `media.images_enabled` — image + sticker rows. */
  images: boolean;
  /** `media.video_enabled` — the single thumbnail frame of a video. */
  video: boolean;
  /** Documents have no switch of their own; the reader passes true. */
  documents: boolean;
  /** `media.business_enabled` — rows in business / official-account chats. */
  business: boolean;
}

/** One claimed row of the transcription queue (v5 §3). */
export interface PendingTranscriptRow {
  id: string;
  kind: string | null;
  mediaPath: string | null;
  mime: string | null;
  filename: string | null;
  seconds: number | null;
  /** PTT rather than a music/file attachment (MediaMeta.voice). */
  voice: boolean;
  /** Same live-before-backlog contract as the media queue (v4 §4b). */
  isHistorical?: boolean;
}

/**
 * Which pending transcriptions the claim query may hand out (v5 §3). Gating
 * lives HERE for the same reason it does on media: `transcript_status` is
 * stamped once at insert, so a switch flipped on later can only reach an
 * already-written row through the claim, which runs fresh on every cycle.
 */
export interface TranscriptClaimFilter {
  /** `media.voice_notes_enabled` — voice notes and audio attachments. */
  voiceNotes: boolean;
  /** `media.video_audio_enabled` — the audio track inside a video. */
  videoAudio: boolean;
  /** `media.business_enabled` — rows in business / official-account chats. */
  business: boolean;
}

/**
 * One video that has no poster to show for itself (v7 §3). WhatsApp only ever
 * supplies a thumbnail from the protobuf's JPEGThumbnail, and a history-synced
 * video usually carries none — 10 of the 18 measured — so the frame has to come
 * out of the mp4 that is already on disk.
 */
export interface PendingPosterRow {
  id: string;
  /** The video file. Never null: a row without one cannot be sampled. */
  mediaPath: string;
  /** Clip duration when the daemon reported one, so a poster can be taken inside it. */
  seconds: number | null;
  /** Same live-before-backlog contract as the other queues (v4 §4b). */
  isHistorical?: boolean;
}

/** One claimed row of the link-scraping queue (v3 §3). */
export interface PendingLinkRow {
  id: string;
  url: string;
  /** The preview title, when WhatsApp attached one — else null. */
  title: string | null;
}

/** The outcome of one media-reading attempt, recorded on the event row. */
export interface MediaDescriptionUpdate {
  description?: string | null;
  model?: string | null;
  status: MediaDescStatus;
  error?: string | null;
}

/** The outcome of one transcription attempt, recorded on the event row. */
export interface TranscriptUpdate {
  /** What was heard; the FTS triggers index it on write. */
  transcript?: string | null;
  /** The whisper model that produced it, e.g. "ggml-large-v3-turbo-q5_0". */
  model?: string | null;
  status: TranscriptStatus;
  /**
   * Why it is not a complete transcript. A run that only got part of the way
   * through a long file records what it recovered WITH status 'error' and the
   * reason here — 'done' would pass a partial off as the whole thing (v5 §3),
   * and the lifecycle has no 'partial' of its own to say it with.
   */
  error?: string | null;
}

/** The outcome of one link-scraping attempt, recorded on the event row. */
export interface LinkScrapeUpdate {
  /** Readable page text; the FTS triggers index it on write. */
  scrapedText?: string | null;
  /** The page's own title. Only fills a preview that arrived without one. */
  title?: string | null;
  status: LinkScrapeStatus;
  error?: string | null;
}

/** What a re-scan re-queues (v3 §2, v5 §2/§3). */
export type RescanType =
  | "image"
  | "video"
  | "document"
  | "link"
  | "business"
  | "frames"
  | "transcript";

export interface RescanResult {
  /** Rows moved back to media_desc_status = 'pending'. */
  media: number;
  /** Rows moved back to link_scrape_status = 'pending'. */
  links: number;
  /** Rows moved back to transcript_status = 'pending'. */
  transcripts: number;
  /** Videos whose sampled frames were dropped (the files are swept after). */
  frames: number;
}

export interface SearchHitRow {
  eventId: string;
  streamId: string | null;
  streamName: string | null;
  ts: string | null;
  snippet: string;
  text: string | null;
}

// ---- Internal snake_case rows ---------------------------------------------

interface IdRow {
  id: string;
}

interface RawInboxChatRow {
  id: string;
  name: string | null;
  source_ext_id: string;
  kind: string | null;
  last_text: string | null;
  last_ts: string | null;
  message_count: number;
}

interface RawInboxMessageRow {
  id: string;
  external_id: string | null;
  ts: string | null;
  kind: string | null;
  text: string | null;
  from_me: number | null;
  actor_name: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_filename: string | null;
  media_size: number | null;
  media_thumb_path: string | null;
  media_seconds: number | null;
  media_meta_json: string | null;
  media_description: string | null;
  media_frames_json: string | null;
  transcript: string | null;
  edited_at: string | null;
  revoked_at: string | null;
  is_forwarded: number | null;
  reply_to_external_id: string | null;
  reply_to_text: string | null;
  link_url: string | null;
  link_title: string | null;
  link_description: string | null;
  link_thumb_path: string | null;
  link_preview_type: string | null;
  link_scraped_text: string | null;
}

/** Reaction event rows joined for one channel (§R5.3), ordered oldest → newest. */
interface RawReactionRow {
  target_external_id: string | null;
  emoji: string | null;
  from_me: number | null;
  actor_ext_id: string | null;
  actor_name: string | null;
}

interface RawSearchRow {
  event_id: string;
  stream_id: string | null;
  stream_name: string | null;
  ts: string | null;
  snippet: string;
  text: string | null;
}

interface RawEventMediaRow {
  id: string;
  kind: string | null;
  text: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_filename: string | null;
  media_size: number | null;
  media_sha256: string | null;
  media_thumb_path: string | null;
  media_seconds: number | null;
  media_meta_json: string | null;
  media_description: string | null;
  media_frames_json: string | null;
  transcript: string | null;
  link_thumb_path: string | null;
}

interface RawPendingMediaRow {
  id: string;
  kind: string | null;
  media_path: string | null;
  thumb_path: string | null;
  mime: string | null;
  filename: string | null;
  seconds: number | null;
  caption: string | null;
  is_historical: number | null;
  ts: string | null;
  stream_id: string | null;
  tier: string | null;
}

interface RawPendingTranscriptRow {
  id: string;
  kind: string | null;
  media_path: string | null;
  mime: string | null;
  filename: string | null;
  seconds: number | null;
  voice: number | null;
  is_historical: number | null;
}

interface RawPendingPosterRow {
  id: string;
  media_path: string;
  seconds: number | null;
  is_historical: number | null;
}

interface RawPendingLinkRow {
  id: string;
  url: string;
  title: string | null;
}

// ---------------------------------------------------------------------------
// Prepared-statement cache (same pattern as db/index.ts): rebuild if the handle
// changes (tests swap SUPERTWIN_DB_PATH between files).
// ---------------------------------------------------------------------------

interface IngestStatements {
  db: Database.Database;
  upsertSource: Database.Statement;
  upsertStream: Database.Statement;
  upsertChannel: Database.Statement;
  getStreamId: Database.Statement;
  upsertPerson: Database.Statement;
  upsertActor: Database.Statement;
  getActorId: Database.Statement;
  insertEvent: Database.Statement;
  applyEdit: Database.Statement;
  applyRevoke: Database.Statement;
  deleteReaction: Database.Statement;
  listInboxChats: Database.Statement;
  streamMessages: Database.Statement;
  streamMessagesBefore: Database.Statement;
  streamReactions: Database.Statement;
  searchEvents: Database.Statement;
  getEventMedia: Database.Statement;
  claimPendingMedia: Database.Statement;
  recordMediaDescription: Database.Statement;
  recordMediaFrames: Database.Statement;
  listMediaFrames: Database.Statement;
  claimPendingPosters: Database.Statement;
  recordVideoPoster: Database.Statement;
  claimPendingTranscription: Database.Statement;
  recordTranscript: Database.Statement;
  claimPendingLinks: Database.Statement;
  recordLinkScrape: Database.Statement;
  rescanMedia: Database.Statement;
  rescanFrames: Database.Statement;
  rescanTranscripts: Database.Statement;
  rescanLinks: Database.Statement;
  appStateGet: Database.Statement;
  appStateSet: Database.Statement;
  appStateDelete: Database.Statement;
  countSourceEvents: Database.Statement;
  countSourceStreams: Database.Statement;
  countSourceActors: Database.Statement;
  deleteSourceEvents: Database.Statement;
  deleteSourceStreams: Database.Statement;
  deleteSourceChannels: Database.Statement;
  deleteSourceActors: Database.Statement;
  deleteOrphanPeople: Database.Statement;
}

let stmts: IngestStatements | null = null;

function statements(): IngestStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;

  stmts = {
    db,
    upsertSource: db.prepare(`
      INSERT INTO sources (id, type, name)
      VALUES (@id, @type, @name)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = COALESCE(excluded.name, sources.name)
    `),
    // A stream is one lane inside a source (arch §2, §6) — the V2 table that
    // replaced `channels`. `label` is upgraded by the same rule the legacy
    // mirror uses below: take a real name, never overwrite one with a
    // placeholder or a JID.
    // `is_business` is written here as well as on the legacy mirror below
    // (0023_stream_tiers): the tier rules in ../tiers read it, and reading it
    // off `channels` would be the leak §3.3 note 6 closes. Sticky once set —
    // one frame that omitted the flag must not un-business a channel.
    upsertStream: db.prepare(`
      INSERT INTO streams (id, source_id, external_key, label, stream_kind, is_business)
      VALUES (@id, @sourceId, @sourceExtId, @name, @kind, @isBusiness)
      ON CONFLICT(source_id, external_key) DO UPDATE SET
        label = CASE
          WHEN NULLIF(TRIM(excluded.label), '') IS NOT NULL
               AND instr(excluded.label, '@') = 0
            THEN excluded.label
          WHEN NULLIF(TRIM(streams.label), '') IS NULL
               OR instr(streams.label, '@') > 0
            THEN COALESCE(NULLIF(TRIM(excluded.label), ''), streams.label)
          ELSE streams.label
        END,
        stream_kind = COALESCE(excluded.stream_kind, streams.stream_kind),
        is_business = MAX(streams.is_business, excluded.is_business)
    `),
    // LEGACY MIRROR — `channels` is the V11 table `streams` replaced (arch §3.3
    // leak 6). Every writer here writes the stream row above; this row is kept
    // beside it, with the SAME id, only because the V11 readers this item may
    // not touch (retrieval, focus, chat-grounding, the media queue's business
    // filter) still join it. It dies with the last of them. Nothing new may
    // read it.
    //
    // Upsert on the (source_id, source_ext_id) unique index.
    //
    // Name-update semantics (Rev 2 §R2.4): the daemon re-emits `channel` lines
    // when it learns a better name later, so a conflict must UPDATE the name —
    // but only with a real value. Take the incoming name when it is non-empty
    // AND not JID-looking (no '@'); OR when the stored name is missing/empty or
    // itself JID-looking (so a placeholder gets upgraded). Otherwise keep the
    // existing good name — never clobber it with an empty/number placeholder.
    //
    // is_business is sticky (MAX): the daemon only learns a chat is a business
    // from a verified/official name, which is not on every re-emit, so a later
    // line without it must not un-flag the chat and quietly re-enable media
    // reading the user switched off.
    upsertChannel: db.prepare(`
      INSERT INTO channels (id, source_id, source_ext_id, name, kind, is_business)
      VALUES (@id, @sourceId, @sourceExtId, @name, @kind, @isBusiness)
      ON CONFLICT(source_id, source_ext_id) DO UPDATE SET
        name = CASE
          WHEN NULLIF(TRIM(excluded.name), '') IS NOT NULL
               AND instr(excluded.name, '@') = 0
            THEN excluded.name
          WHEN NULLIF(TRIM(channels.name), '') IS NULL
               OR instr(channels.name, '@') > 0
            THEN COALESCE(NULLIF(TRIM(excluded.name), ''), channels.name)
          ELSE channels.name
        END,
        kind = COALESCE(excluded.kind, channels.kind),
        is_business = MAX(channels.is_business, excluded.is_business)
    `),
    getStreamId: db.prepare(`
      SELECT id FROM streams WHERE source_id = ? AND external_key = ?
    `),
    upsertPerson: db.prepare(`
      INSERT INTO people (id, name, handle)
      VALUES (@id, @name, @handle)
      ON CONFLICT(id) DO NOTHING
    `),
    // display_name follows the same name-update rule as channels (Rev 2 §R2.4):
    // upgrade a JID/empty placeholder to a real name, never downgrade a real
    // name to empty/number. `handle` (a phone number like "+9199…") just takes
    // any non-empty incoming value, never overwritten with empty.
    upsertActor: db.prepare(`
      INSERT INTO actors (id, source_id, source_ext_id, person_id, display_name, handle)
      VALUES (@id, @sourceId, @sourceExtId, @personId, @displayName, @handle)
      ON CONFLICT(source_id, source_ext_id) DO UPDATE SET
        display_name = CASE
          WHEN NULLIF(TRIM(excluded.display_name), '') IS NOT NULL
               AND instr(excluded.display_name, '@') = 0
            THEN excluded.display_name
          WHEN NULLIF(TRIM(actors.display_name), '') IS NULL
               OR instr(actors.display_name, '@') > 0
            THEN COALESCE(NULLIF(TRIM(excluded.display_name), ''), actors.display_name)
          ELSE actors.display_name
        END,
        handle       = COALESCE(NULLIF(TRIM(excluded.handle), ''), actors.handle),
        person_id    = COALESCE(actors.person_id, excluded.person_id)
    `),
    getActorId: db.prepare(`
      SELECT id FROM actors WHERE source_id = ? AND source_ext_id = ?
    `),
    // Dedupe: (source_id, external_id) UNIQUE. DO NOTHING => idempotent.
    //
    // `stream_id` is the column V2 reads (arch §6). `channel_id` is written
    // beside it with the same value for exactly as long as the legacy `channels`
    // mirror above lives — see 0020_v2_core's note on the bridge.
    insertEvent: db.prepare(`
      INSERT INTO events
        (id, source_id, source_type, stream_id, channel_id, actor_id, ts, kind, text, media_path, raw_json, external_id, reply_to_external_id, reply_to_text,
         media_mime, media_filename, media_size, media_sha256, media_thumb_path, media_seconds, media_meta_json, media_desc_status, is_forwarded,
         link_url, link_title, link_description, link_thumb_path, link_preview_type, link_scrape_status,
         is_historical, transcript_status)
      VALUES
        (@id, @sourceId, @sourceType, @streamId, @streamId, @actorId, @ts, @kind, @text, @mediaPath, @rawJson, @externalId, @replyToExternalId, @replyToText,
         @mediaMime, @mediaFilename, @mediaSize, @mediaSha256, @mediaThumbPath, @mediaSeconds, @mediaMetaJson, @mediaDescStatus, @isForwarded,
         @linkUrl, @linkTitle, @linkDescription, @linkThumbPath, @linkPreviewType, @linkScrapeStatus,
         @isHistorical, @transcriptStatus)
      ON CONFLICT(source_id, external_id) DO NOTHING
    `),
    // Edit (media spec §5): the edit event carries the NEW body and updates its
    // target in place — the original row keeps its id, ts and threading, so
    // reactions and quoted replies pointing at it survive the edit.
    applyEdit: db.prepare(`
      UPDATE events
         SET text = @text, edited_at = @editedAt
       WHERE source_id = @sourceId AND external_id = @targetExternalId
    `),
    // Revoke (media spec §5): tombstone the target. The body, the media pointer
    // and the link preview go; kind/ts/actor stay so the UI can render "deleted"
    // in place. All three status columns are cleared with the content they
    // describe: the claim queries already skip revoked rows, so a row left
    // 'pending' would sit in the queue counts forever without anything able to
    // drain it. media_frames_json goes too — dropping the only reference to
    // those files is what gets them swept off disk (v5 §2).
    applyRevoke: db.prepare(`
      UPDATE events
         SET revoked_at = @revokedAt, text = '', media_path = NULL,
             media_desc_status = NULL,
             media_frames_json = NULL,
             transcript_status = NULL,
             link_url = NULL, link_title = NULL, link_description = NULL,
             link_thumb_path = NULL, link_preview_type = NULL,
             link_scraped_text = NULL, link_scrape_status = NULL
       WHERE source_id = @sourceId AND external_id = @targetExternalId
    `),
    // Reaction removal (media spec §6): drop this actor's stored reaction on the
    // target instead of recording an empty one. `actor_id IS @actorId` so an
    // unresolved actor (NULL) still matches its own row.
    deleteReaction: db.prepare(`
      DELETE FROM events
       WHERE source_id = @sourceId
         AND kind = 'reaction'
         AND reply_to_external_id = @targetExternalId
         AND actor_id IS @actorId
    `),
    // Inbox chats: derive lastText/lastTs/messageCount per channel from events.
    // Sorted by lastTs desc. Only channels that have at least one event show up.
    // The last message's text is picked from the row at MAX(ts) (id tie-break so
    // it is deterministic when several events share the newest timestamp).
    //
    // Reactions (§R5.3) are NOT messages: exclude kind='reaction' from BOTH the
    // count/last-ts aggregate AND the last-message pick, so a reaction is never
    // the chat's preview and a chat whose only rows are reactions/system counts
    // as empty (stays hidden per R4.3).
    //
    // lastText (Rev 6 §R6.5, bug 4): the latest non-reaction message's `text`
    // when it is non-empty; otherwise a concise kind/media label so a media-only
    // chat (e.g. a group whose last message is a Video/photo) shows a sensible
    // preview instead of an empty string. A bare-URL text becomes a 🔗 Link
    // label. The CASE runs on the single picked `last` row so it stays one query.
    // A revoked message keeps its original kind (media spec §5 tombstones in
    // place), so revoked_at is checked FIRST — otherwise a deleted photo would
    // still preview as "📷 Photo".
    listInboxChats: db.prepare(`
      SELECT
        c.id              AS id,
        c.label           AS name,
        c.external_key    AS source_ext_id,
        c.stream_kind     AS kind,
        CASE
          WHEN last.revoked_at IS NOT NULL THEN '🚫 Deleted'
          WHEN NULLIF(TRIM(last.text), '') IS NOT NULL
               AND last.text GLOB 'http[s]*://*'
               AND instr(TRIM(last.text), ' ') = 0
            THEN '🔗 Link'
          WHEN NULLIF(TRIM(last.text), '') IS NOT NULL
            THEN last.text
          WHEN last.kind = 'image'    THEN '📷 Photo'
          WHEN last.kind = 'video'    THEN '🎥 Video'
          WHEN last.kind = 'audio'    THEN '🎙️ Audio'
          WHEN last.kind = 'document' THEN '📄 Document'
          WHEN last.kind = 'sticker'  THEN '📷 Sticker'
          WHEN last.kind = 'location' THEN '📍 Location'
          WHEN last.kind = 'contact'  THEN '👤 Contact'
          WHEN last.kind = 'revoked'  THEN '🚫 Deleted'
          ELSE last.text
        END               AS last_text,
        agg.last_ts       AS last_ts,
        agg.message_count AS message_count
      FROM streams c
      JOIN (
        SELECT
          e.stream_id  AS stream_id,
          COUNT(*)     AS message_count,
          MAX(e.ts)    AS last_ts
        FROM events e
        WHERE e.stream_id IS NOT NULL
          AND e.kind IS NOT 'reaction'
        GROUP BY e.stream_id
      ) agg ON agg.stream_id = c.id
      LEFT JOIN events last ON last.id = (
        SELECT e2.id FROM events e2
        WHERE e2.stream_id = c.id AND e2.ts = agg.last_ts
          AND e2.kind IS NOT 'reaction'
        ORDER BY e2.id DESC LIMIT 1
      )
      ORDER BY agg.last_ts DESC
      LIMIT @limit OFFSET @offset
    `),
    // Latest window (Rev 7 §R7.1). Return the NEWEST @limit messages, so a large
    // chat opens on its most-recent messages (the bug was ASC-from-start showing
    // the OLDEST @limit). We ORDER BY e.ts DESC, e.id DESC LIMIT @limit here, then
    // the reader REVERSES the rows to ascending (oldest→newest) so the UI renders
    // top→bottom with the newest at the bottom. The id DESC tiebreak keeps
    // same-ts messages ordered deterministically and pageable (see the cursor
    // query below). actorName resolved via join; fromMe: the actor's source_ext_id
    // equals the stored self JID (app_state). Reactions (§R5.3) are EXCLUDED from
    // the message stream (they attach to their target instead). external_id +
    // reply_to_* are selected so the reader can attach reactions and resolve the
    // quoted-reply block.
    streamMessages: db.prepare(`
      SELECT
        e.id           AS id,
        e.external_id  AS external_id,
        e.ts           AS ts,
        e.kind         AS kind,
        e.text         AS text,
        a.display_name AS actor_name,
        e.media_path   AS media_path,
        e.media_mime       AS media_mime,
        e.media_filename   AS media_filename,
        e.media_size       AS media_size,
        e.media_thumb_path AS media_thumb_path,
        e.media_seconds    AS media_seconds,
        e.media_meta_json  AS media_meta_json,
        e.media_description AS media_description,
        e.media_frames_json AS media_frames_json,
        e.transcript        AS transcript,
        e.edited_at    AS edited_at,
        e.revoked_at   AS revoked_at,
        e.is_forwarded AS is_forwarded,
        e.reply_to_external_id AS reply_to_external_id,
        e.reply_to_text        AS reply_to_text,
        e.link_url             AS link_url,
        e.link_title           AS link_title,
        e.link_description     AS link_description,
        e.link_thumb_path      AS link_thumb_path,
        e.link_preview_type    AS link_preview_type,
        e.link_scraped_text    AS link_scraped_text,
        (a.source_ext_id IS NOT NULL
           AND a.source_ext_id = ${SELF_IDENTITY_SQL})
                       AS from_me
      FROM events e
      LEFT JOIN actors a ON a.id = e.actor_id
      WHERE e.stream_id = @streamId AND e.kind IS NOT 'reaction'
      ORDER BY e.ts DESC, e.id DESC
      LIMIT @limit
    `),
    // Older page (Rev 7 §R7.1). The compound cursor (@beforeTs, @beforeId) is the
    // OLDEST currently-loaded message; return the @limit messages strictly OLDER
    // than it, using (ts, id) as a total order so same-ts messages page with no
    // gap/overlap. Same DESC ordering as the latest window; the reader reverses to
    // ascending. A legacy bare-ts cursor arrives as @beforeId="" so the id branch
    // is never satisfied and this degrades to `e.ts < @beforeTs`.
    streamMessagesBefore: db.prepare(`
      SELECT
        e.id           AS id,
        e.external_id  AS external_id,
        e.ts           AS ts,
        e.kind         AS kind,
        e.text         AS text,
        a.display_name AS actor_name,
        e.media_path   AS media_path,
        e.media_mime       AS media_mime,
        e.media_filename   AS media_filename,
        e.media_size       AS media_size,
        e.media_thumb_path AS media_thumb_path,
        e.media_seconds    AS media_seconds,
        e.media_meta_json  AS media_meta_json,
        e.media_description AS media_description,
        e.media_frames_json AS media_frames_json,
        e.transcript        AS transcript,
        e.edited_at    AS edited_at,
        e.revoked_at   AS revoked_at,
        e.is_forwarded AS is_forwarded,
        e.reply_to_external_id AS reply_to_external_id,
        e.reply_to_text        AS reply_to_text,
        e.link_url             AS link_url,
        e.link_title           AS link_title,
        e.link_description     AS link_description,
        e.link_thumb_path      AS link_thumb_path,
        e.link_preview_type    AS link_preview_type,
        e.link_scraped_text    AS link_scraped_text,
        (a.source_ext_id IS NOT NULL
           AND a.source_ext_id = ${SELF_IDENTITY_SQL})
                       AS from_me
      FROM events e
      LEFT JOIN actors a ON a.id = e.actor_id
      WHERE e.stream_id = @streamId
        AND e.kind IS NOT 'reaction'
        AND (e.ts < @beforeTs OR (e.ts = @beforeTs AND e.id < @beforeId))
      ORDER BY e.ts DESC, e.id DESC
      LIMIT @limit
    `),
    // Reaction events for one channel (§R5.3), oldest → newest so that a later
    // empty-text reaction from an actor (removal) supersedes their earlier one
    // during collapse. actor_ext_id disambiguates who reacted (used as the
    // collapse key); actor_name resolves the display name; from_me flags self.
    streamReactions: db.prepare(`
      SELECT
        e.reply_to_external_id AS target_external_id,
        e.text                 AS emoji,
        a.source_ext_id        AS actor_ext_id,
        a.display_name         AS actor_name,
        (a.source_ext_id IS NOT NULL
           AND a.source_ext_id = ${SELF_IDENTITY_SQL})
                       AS from_me
      FROM events e
      LEFT JOIN actors a ON a.id = e.actor_id
      WHERE e.stream_id = @streamId
        AND e.kind = 'reaction'
        AND e.reply_to_external_id IS NOT NULL
      ORDER BY e.ts ASC, e.id ASC
    `),
    // FTS5 search with snippet highlight. Joined back to events + channels.
    // Reactions (§R5.3) are excluded from results (an emoji is not a message).
    // Column -1 lets FTS pick the matching column, so a hit that lives only in
    // media_description (a described image) still comes back with a snippet
    // instead of an empty one from `text`.
    searchEvents: db.prepare(`
      SELECT
        e.id           AS event_id,
        e.stream_id    AS stream_id,
        c.label        AS stream_name,
        e.ts           AS ts,
        snippet(events_fts, -1, '[', ']', '…', 12) AS snippet,
        e.text         AS text
      FROM events_fts f
      JOIN events e   ON e.rowid = f.rowid
      LEFT JOIN streams c ON c.id = e.stream_id
      WHERE events_fts MATCH @q
        AND e.kind IS NOT 'reaction'
      ORDER BY rank
      LIMIT @limit
    `),
    getEventMedia: db.prepare(`
      SELECT
        id, kind, text, media_path, media_mime, media_filename, media_size,
        media_sha256, media_thumb_path, media_seconds, media_meta_json,
        media_description, media_frames_json, transcript, link_thumb_path
      FROM events WHERE id = ?
    `),
    // Media-reading queue (media spec §8, v3 §2). A revoked row's media is gone,
    // so it can never be read — leave it in the queue but never hand it out.
    //
    // The per-kind, kind-class and business switches are bound flags rather than
    // a built IN-list so this stays ONE prepared statement.
    //
    // Order (v4 §4c): live arrivals first, then the batchable kinds, then newest
    // first. A plain `ts DESC` put whatever landed last at the head, so a single
    // document or video there turned the whole tick into one read while images
    // that could have ridden one call waited. Live-first comes ahead of the kind
    // grouping because a live row must still reach the claim while a long
    // backlog of images is draining.
    claimPendingMedia: db.prepare(`
      SELECT
        e.id                AS id,
        e.kind              AS kind,
        e.media_path        AS media_path,
        e.media_thumb_path  AS thumb_path,
        e.media_mime        AS mime,
        e.media_filename    AS filename,
        e.media_seconds     AS seconds,
        e.is_historical     AS is_historical,
        e.ts                AS ts,
        e.stream_id         AS stream_id,
        s.tier              AS tier,
        CASE WHEN json_valid(e.media_meta_json)
          THEN json_extract(e.media_meta_json, '$.caption')
        END                 AS caption
      FROM events e
      -- is_business still lives on the legacy channels mirror (same ids as
      -- streams) until the flag moves onto streams itself.
      LEFT JOIN channels c ON c.id = e.stream_id
      -- The tier is the enrichment queue's PRIMARY key (arch §9.3): a
      -- promotional blast from an hour ago is worth less than a friend's photo
      -- from last week, and ordering without it is the FIFO defect.
      LEFT JOIN streams s ON s.id = e.stream_id
      WHERE e.media_desc_status = 'pending'
        AND e.media_path IS NOT NULL
        AND e.revoked_at IS NULL
        AND (@business = 1 OR COALESCE(c.is_business, 0) = 0)
        AND (
             (@images    = 1 AND e.kind IN ('image', 'sticker'))
          OR (@video     = 1 AND e.kind = 'video')
          OR (@documents = 1 AND e.kind = 'document')
        )
        AND (@batchable = 0 OR e.kind IN ('image', 'sticker'))
        AND (@single    = 0 OR e.kind NOT IN ('image', 'sticker'))
        -- A video is read through a still, so one with neither a thumbnail nor
        -- sampled frames has nothing to hand over YET (v7 §3). It waits here
        -- rather than being written off, because the poster queue is about to
        -- give it one; 'unsupported' was permanent and this is not.
        AND (e.kind IS NOT 'video'
          OR e.media_thumb_path IS NOT NULL
          OR e.media_frames_json IS NOT NULL)
      -- The queue key, never FIFO (arch §9.2 rule 5): tier first, then the
      -- kinds that can share a call, then recency. is_historical is NOT a sort
      -- term — a live arrival pre-empts through the reader's live set, and
      -- ordering by it here would let a live 2023 photo outrank an hour-old one.
      ORDER BY CASE s.tier
                 WHEN 'T1' THEN 4 WHEN 'T2' THEN 3
                 WHEN 'T3' THEN 2 WHEN 'T4' THEN 1
                 ELSE 2
               END DESC,
               (e.kind NOT IN ('image', 'sticker')) ASC,
               e.ts DESC
      LIMIT @limit
    `),
    recordMediaDescription: db.prepare(`
      UPDATE events
         SET media_description = @description,
             media_desc_model  = @model,
             media_desc_status = @status,
             media_desc_error  = @error,
             media_desc_ts     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id
    `),
    recordMediaFrames: db.prepare(`
      UPDATE events SET media_frames_json = @frames WHERE id = @id
    `),
    // Every frame file the DB still points at. The sampler diffs this against
    // what is on disk and deletes the rest — a revoke and a re-scan both clean
    // up by clearing the column (v5 §2), which is what drops a path from here.
    listMediaFrames: db.prepare(`
      SELECT media_frames_json AS json FROM events WHERE media_frames_json IS NOT NULL
    `),
    // Poster queue (v7 §3): the videos with nothing to show for themselves.
    // Ungated, unlike every other claim here — one local ffmpeg run over a file
    // already on disk spends no tokens and makes no outbound request, so there
    // is no switch for it to wait on. Same live-before-backlog ordering as the
    // other queues (v4 §4b).
    claimPendingPosters: db.prepare(`
      SELECT
        e.id            AS id,
        e.media_path    AS media_path,
        e.media_seconds AS seconds,
        e.is_historical AS is_historical
      FROM events e
      WHERE e.kind = 'video'
        AND e.media_path IS NOT NULL
        AND e.media_thumb_path IS NULL
        AND e.revoked_at IS NULL
      ORDER BY e.is_historical ASC, e.ts DESC
      LIMIT @limit
    `),
    // Writing the path is what takes the row OUT of the claim above, so the
    // NULL guard is the whole re-entrancy story: a thumbnail that arrived from
    // WhatsApp in the meantime is the sender's own frame and outranks ours.
    recordVideoPoster: db.prepare(`
      UPDATE events
         SET media_thumb_path = @thumbPath
       WHERE id = @id
         AND media_thumb_path IS NULL
    `),
    // Transcription queue (v5 §3). Same shape as the media claim: revoked rows
    // stay in place but are never handed out, business chats are gated, and the
    // two audio switches are bound flags so this stays ONE prepared statement.
    //
    // No kind grouping — whisper takes one file at a time, so all the ordering
    // owes is live arrivals ahead of the history backlog (v4 §4b), then newest
    // first.
    claimPendingTranscription: db.prepare(`
      SELECT
        e.id             AS id,
        e.kind           AS kind,
        e.media_path     AS media_path,
        e.media_mime     AS mime,
        e.media_filename AS filename,
        e.media_seconds  AS seconds,
        e.is_historical  AS is_historical,
        CASE WHEN json_valid(e.media_meta_json)
          THEN json_extract(e.media_meta_json, '$.voice')
        END              AS voice
      FROM events e
      -- is_business still lives on the legacy channels mirror (same ids as
      -- streams) until the flag moves onto streams itself.
      LEFT JOIN channels c ON c.id = e.stream_id
      WHERE e.transcript_status = 'pending'
        AND e.media_path IS NOT NULL
        AND e.revoked_at IS NULL
        AND (@business = 1 OR COALESCE(c.is_business, 0) = 0)
        AND (
             (@voiceNotes = 1 AND e.kind = 'audio')
          OR (@videoAudio = 1 AND e.kind = 'video')
        )
      ORDER BY e.is_historical ASC, e.ts DESC
      LIMIT @limit
    `),
    recordTranscript: db.prepare(`
      UPDATE events
         SET transcript        = @transcript,
             transcript_model  = @model,
             transcript_status = @status,
             transcript_error  = @error,
             transcript_ts     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id
    `),
    // Link-scraping queue (v3 §3), newest first. Same business filter as media:
    // fetching a URL is an outbound request the sender can observe, which is
    // exactly what the business switch exists to hold back.
    claimPendingLinks: db.prepare(`
      SELECT
        e.id         AS id,
        e.link_url   AS url,
        e.link_title AS title
      FROM events e
      -- is_business still lives on the legacy channels mirror (same ids as
      -- streams) until the flag moves onto streams itself.
      LEFT JOIN channels c ON c.id = e.stream_id
      WHERE e.link_scrape_status = 'pending'
        AND e.link_url IS NOT NULL
        AND e.revoked_at IS NULL
        AND (@business = 1 OR COALESCE(c.is_business, 0) = 0)
      ORDER BY e.ts DESC
      LIMIT @limit
    `),
    // A scraped title only FILLS a preview that arrived without one — WhatsApp's
    // own title is what the sender saw, so it wins over whatever the page says
    // when we fetch it later.
    recordLinkScrape: db.prepare(`
      UPDATE events
         SET link_scraped_text  = @scrapedText,
             link_title         = COALESCE(NULLIF(TRIM(link_title), ''), @title),
             link_scrape_status = @status,
             link_scrape_error  = @error
       WHERE id = @id
    `),
    // Re-scan (v3 §2): put matching rows back on the queue and drop the previous
    // verdict, so a re-read is not silently merged with a stale description.
    // Revoked rows are skipped — there is nothing left on disk to read.
    rescanMedia: db.prepare(`
      UPDATE events
         SET media_desc_status = 'pending',
             media_description = NULL,
             media_desc_model  = NULL,
             media_desc_error  = NULL,
             media_desc_ts     = NULL
       WHERE media_path IS NOT NULL
         AND revoked_at IS NULL
         AND (
              (@images    = 1 AND kind IN ('image', 'sticker'))
           OR (@video     = 1 AND kind = 'video')
           OR (@documents = 1 AND kind = 'document')
           OR (@business  = 1 AND stream_id IN (
                 -- is_business lives on the legacy channels mirror until the flag
                 -- moves onto streams (the one column the fold has nowhere to put
                 -- yet); the ids are identical, so the filter is the same set.
                 SELECT id FROM channels WHERE is_business = 1
               ))
         )
    `),
    // 'frames' is not 'video' with extra steps: a video re-read keeps the frames
    // it already has (the same clip yields the same stills), while this one
    // drops them so a changed interval or max actually re-samples. The
    // description goes with them — the frames ARE what the reader looked at.
    rescanFrames: db.prepare(`
      UPDATE events
         SET media_frames_json = NULL,
             media_desc_status = 'pending',
             media_description = NULL,
             media_desc_model  = NULL,
             media_desc_error  = NULL,
             media_desc_ts     = NULL
       WHERE media_path IS NOT NULL
         AND revoked_at IS NULL
         AND kind = 'video'
    `),
    rescanTranscripts: db.prepare(`
      UPDATE events
         SET transcript_status = 'pending',
             transcript        = NULL,
             transcript_model  = NULL,
             transcript_error  = NULL,
             transcript_ts     = NULL
       WHERE media_path IS NOT NULL
         AND revoked_at IS NULL
         AND kind IN ('audio', 'video')
    `),
    rescanLinks: db.prepare(`
      UPDATE events
         SET link_scrape_status = 'pending',
             link_scraped_text  = NULL,
             link_scrape_error  = NULL
       WHERE link_url IS NOT NULL
         AND revoked_at IS NULL
    `),
    appStateGet: db.prepare(`SELECT value FROM app_state WHERE key = ?`),
    appStateSet: db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (@key, @value, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    appStateDelete: db.prepare(`DELETE FROM app_state WHERE key = ?`),
    // Reset (Rev 2 §R2.3): count then delete all rows for one source. Deleting
    // events lets the FTS triggers (0017_reply_fts) keep events_fts in sync — we never
    // touch events_fts directly. Order: events → channels → actors → orphan people.
    countSourceEvents: db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE source_id = ?`,
    ),
    countSourceStreams: db.prepare(
      `SELECT COUNT(*) AS n FROM streams WHERE source_id = ?`,
    ),
    countSourceActors: db.prepare(
      `SELECT COUNT(*) AS n FROM actors WHERE source_id = ?`,
    ),
    deleteSourceEvents: db.prepare(`DELETE FROM events WHERE source_id = ?`),
    deleteSourceStreams: db.prepare(`DELETE FROM streams WHERE source_id = ?`),
    // The legacy mirror goes with it (see upsertStream).
    deleteSourceChannels: db.prepare(`DELETE FROM channels WHERE source_id = ?`),
    deleteSourceActors: db.prepare(`DELETE FROM actors WHERE source_id = ?`),
    // People left with no remaining actors after the actor delete.
    deleteOrphanPeople: db.prepare(`
      DELETE FROM people
       WHERE NOT EXISTS (
         SELECT 1 FROM actors a WHERE a.person_id = people.id
       )
    `),
  };
  return stmts;
}

// ---- Sources / streams / actors -------------------------------------------

/** Upsert a source row (idempotent on id). */
export function upsertSource(params: UpsertSourceParams): void {
  statements().upsertSource.run({
    id: params.id,
    type: params.type,
    name: params.name ?? null,
  });
}

/**
 * Upsert a stream by (sourceId, sourceExtId) and return its id. Deterministic
 * id "<sourceId>:st:<sourceExtId>" so re-upserts and lazy upserts converge.
 *
 * Writes the canonical `streams` row AND the legacy `channels` mirror under the
 * same id, in that order — see the statement comments. When the last V11 reader
 * of `channels` is rewritten, the second write and the table go together.
 */
export function upsertStream(params: UpsertStreamParams): string {
  const s = statements();
  const id = streamId(params.sourceId, params.sourceExtId);
  const bind = {
    id,
    sourceId: params.sourceId,
    sourceExtId: params.sourceExtId,
    name: params.name ?? null,
    kind: params.kind ?? null,
    isBusiness: params.isBusiness ? 1 : 0,
  };
  s.upsertStream.run(bind);
  s.upsertChannel.run(bind);
  const row = s.getStreamId.get(params.sourceId, params.sourceExtId) as
    | IdRow
    | undefined;
  return row?.id ?? id;
}

/** @deprecated One release only — the name `channel` is now `stream`. */
export const upsertChannel = upsertStream;

/**
 * Upsert an actor by (sourceId, sourceExtId), create+link a people row, and
 * return the actor id. Deterministic ids so re-upserts converge.
 */
export function upsertActor(params: UpsertActorParams): string {
  const s = statements();
  const aId = actorId(params.sourceId, params.sourceExtId);
  const pId = personId(params.sourceId, params.sourceExtId);

  // Create the person first (FK target). ON CONFLICT DO NOTHING keeps it stable.
  s.upsertPerson.run({
    id: pId,
    name: params.displayName ?? null,
    handle: params.handle ?? null,
  });

  s.upsertActor.run({
    id: aId,
    sourceId: params.sourceId,
    sourceExtId: params.sourceExtId,
    personId: pId,
    displayName: params.displayName ?? null,
    handle: params.handle ?? null,
  });

  const row = s.getActorId.get(params.sourceId, params.sourceExtId) as
    | IdRow
    | undefined;
  return row?.id ?? aId;
}

// ---- Events ---------------------------------------------------------------

/**
 * Insert an event, deduping on (source_id, external_id). Returns whether a new
 * row was written. The id is deterministic: `"<source_id>:" + external_id` —
 * see eventId(). Two sources may legitimately mint the same external_id, and
 * the source id in front of it is what keeps them apart.
 */
export function insertEvent(row: InsertEventRow): InsertEventResult {
  const id = eventId(row.sourceId, row.externalId);
  const info = statements().insertEvent.run({
    id,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    streamId: row.streamId,
    actorId: row.actorId,
    ts: row.ts,
    kind: row.kind,
    text: row.text,
    mediaPath: row.mediaPath,
    rawJson: row.rawJson,
    externalId: row.externalId,
    replyToExternalId: row.replyToExternalId ?? null,
    replyToText: row.replyToText ?? null,
    mediaMime: row.mediaMime ?? null,
    mediaFilename: row.mediaFilename ?? null,
    mediaSize: row.mediaSize ?? null,
    mediaSha256: row.mediaSha256 ?? null,
    mediaThumbPath: row.mediaThumbPath ?? null,
    mediaSeconds: row.mediaSeconds ?? null,
    mediaMetaJson: row.mediaMetaJson ?? null,
    mediaDescStatus: mediaDescStatusFor(row),
    isForwarded: row.isForwarded ? 1 : 0,
    linkUrl: row.linkUrl ?? null,
    linkTitle: row.linkTitle ?? null,
    linkDescription: row.linkDescription ?? null,
    linkThumbPath: row.linkThumbPath ?? null,
    linkPreviewType: row.linkPreviewType ?? null,
    linkScrapeStatus: linkScrapeStatusFor(row),
    isHistorical: row.isHistorical ? 1 : 0,
    transcriptStatus: transcriptStatusFor(row),
  });
  return { id, inserted: info.changes > 0 };
}

/**
 * Apply an edit to its target row (media spec §5): the target keeps its id and
 * ts, `text` becomes the edited body and `edited_at` records when. Returns false
 * when the target has not been ingested yet (out-of-order history sync) — the
 * caller then falls back to inserting the edit as an ordinary event so the new
 * body is never lost.
 */
export function applyEdit(params: {
  sourceId: string;
  targetExternalId: string;
  text: string;
  editedAt: string | null;
}): boolean {
  // Dropped BEFORE the rewrite: losing a vector costs one re-embed, keeping one
  // that describes the pre-edit body costs a wrong semantic hit forever.
  invalidateEventEmbeddingByExternalId(params.sourceId, params.targetExternalId);
  const info = statements().applyEdit.run({
    sourceId: params.sourceId,
    targetExternalId: params.targetExternalId,
    text: params.text,
    editedAt: params.editedAt,
  });
  return info.changes > 0;
}

/**
 * Tombstone a revoked message in place (media spec §5): body and media pointer
 * cleared, `revoked_at` set. Same out-of-order contract as applyEdit — false
 * means the target is not here (yet), so the caller keeps the tombstone event.
 */
export function applyRevoke(params: {
  sourceId: string;
  targetExternalId: string;
  revokedAt: string | null;
}): boolean {
  // The body it was built from is about to be cleared, and a tombstone is never
  // re-embedded — the claim skips revoked rows.
  invalidateEventEmbeddingByExternalId(params.sourceId, params.targetExternalId);
  const info = statements().applyRevoke.run({
    sourceId: params.sourceId,
    targetExternalId: params.targetExternalId,
    revokedAt: params.revokedAt,
  });
  return info.changes > 0;
}

/**
 * Remove one actor's reaction from a target message (media spec §6). WhatsApp
 * signals removal with an empty-emoji reaction; storing that row would leave
 * collapseReactions to net it out on every read, so we delete instead. Returns
 * the number of reaction rows dropped (0 when none was stored).
 */
export function deleteReaction(params: {
  sourceId: string;
  targetExternalId: string;
  actorId: string | null;
}): number {
  return statements().deleteReaction.run({
    sourceId: params.sourceId,
    targetExternalId: params.targetExternalId,
    actorId: params.actorId,
  }).changes;
}

/** Resolve an event by id (used to serve /api/media/:eventId). */
export function getEventById(id: string): EventMediaRow | null {
  const row = statements().getEventMedia.get(id) as RawEventMediaRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    mediaPath: row.media_path,
    mediaMime: row.media_mime,
    mediaFilename: row.media_filename,
    mediaSize: row.media_size,
    mediaSha256: row.media_sha256,
    mediaThumbPath: row.media_thumb_path,
    mediaSeconds: row.media_seconds,
    mediaMeta: parseMediaMeta(row.media_meta_json),
    mediaDescription: row.media_description,
    mediaFrames: parseMediaFrames(row.media_frames_json),
    transcript: row.transcript,
    linkThumbPath: row.link_thumb_path,
  };
}

// ---- Media reading queue (media spec §8) ----------------------------------

/**
 * The `limit` events still waiting to be described, restricted to the kinds
 * `filter` says are switched on and, when `kinds` is given, to one kind class.
 * The worker is the only reader, so there is no claim marker: a row leaves the
 * queue when recordMediaDescription() moves it off 'pending'.
 *
 * Rows come back live-first, then batchable-first, then newest-first (v4 §4c),
 * so the head of a claim is a row that can carry a batch whenever one is
 * waiting. Passing `kinds` narrows harder — "batchable" is a claim the reader
 * can send as a single multi-image call with nothing else mixed in.
 *
 * Every returned row is readable NOW: 'pending' says the media can be read at
 * all, and this query says there is something to look at yet. A video with no
 * still is the difference between the two, and it stays pending until the
 * poster queue gives it one.
 */
export function claimPendingMedia(
  limit: number,
  filter: MediaClaimFilter,
  kinds?: MediaKindClass,
): PendingMediaRow[] {
  const rows = statements().claimPendingMedia.all({
    limit: clampLimit(limit, 20, 500),
    images: filter.images ? 1 : 0,
    video: filter.video ? 1 : 0,
    documents: filter.documents ? 1 : 0,
    business: filter.business ? 1 : 0,
    batchable: kinds === "batchable" ? 1 : 0,
    single: kinds === "single" ? 1 : 0,
  }) as RawPendingMediaRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mediaPath: r.media_path,
    thumbPath: r.thumb_path,
    mime: r.mime,
    filename: r.filename,
    seconds: r.seconds,
    caption: r.caption,
    isHistorical: r.is_historical === 1,
    ts: r.ts,
    streamId: r.stream_id,
    tier: r.tier,
  }));
}

/**
 * The `limit` videos with no poster to show for themselves (v7 §3), live
 * arrivals first then newest first. Every row has a file on disk and no
 * thumbnail beside it; sampling one frame out of that file is what gets a video
 * rendered as a video instead of as a file chip.
 *
 * No switch and no business filter: this reads a file that is already here and
 * makes no outbound request, so there is nothing for it to wait on.
 *
 * There is no claim marker and no status column — a row leaves this queue when
 * recordVideoPoster() writes the path. A file ffmpeg cannot open therefore
 * stays claimable, so the caller must not spin on it: remember the failure for
 * the life of the process, the way the reader already does for its own
 * attempts. A restart retries, which is the right bound for a local decode that
 * costs nothing but a few hundred milliseconds.
 */
export function claimPendingPosters(limit: number): PendingPosterRow[] {
  const rows = statements().claimPendingPosters.all({
    limit: clampLimit(limit, 20, 500),
  }) as RawPendingPosterRow[];
  return rows.map((r) => ({
    id: r.id,
    mediaPath: r.media_path,
    seconds: r.seconds,
    isHistorical: r.is_historical === 1,
  }));
}

/**
 * Record the poster sampled out of a video. Returns false when the row already
 * had a thumbnail (WhatsApp's own, or a poster written by an earlier run), so
 * the caller can tell "mine" from "someone got there first" — the file it just
 * wrote is then referenced by nothing, and is the caller's to delete.
 *
 * A run that produced no frame records NOTHING: a poster path that points at a
 * file ffmpeg never finished writing renders as a broken image, which is worse
 * than the file chip it replaced.
 */
export function recordVideoPoster(id: string, thumbPath: string): boolean {
  return statements().recordVideoPoster.run({ id, thumbPath }).changes > 0;
}

/**
 * The `limit` events still waiting to be transcribed, restricted to what
 * `filter` says is switched on. Same no-claim-marker contract as the media
 * queue: a row leaves it when recordTranscript() moves it off 'pending'.
 *
 * Rows come back live-first then newest-first (v4 §4b). A row is only ever
 * stamped 'pending' for media that CAN carry speech, but whether a given video
 * actually has an audio track is knowable only by probing the file — the caller
 * records 'unsupported' when it finds none.
 */
export function claimPendingTranscription(
  limit: number,
  filter: TranscriptClaimFilter,
): PendingTranscriptRow[] {
  const rows = statements().claimPendingTranscription.all({
    limit: clampLimit(limit, 20, 500),
    voiceNotes: filter.voiceNotes ? 1 : 0,
    videoAudio: filter.videoAudio ? 1 : 0,
    business: filter.business ? 1 : 0,
  }) as RawPendingTranscriptRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mediaPath: r.media_path,
    mime: r.mime,
    filename: r.filename,
    seconds: r.seconds,
    voice: r.voice === 1,
    isHistorical: r.is_historical === 1,
  }));
}

/**
 * The newest `limit` links still waiting to be fetched. Same no-claim-marker
 * contract as the media queue; `business` mirrors the media filter because a
 * fetch is an outbound request to a URL somebody else chose.
 */
export function claimPendingLinks(
  limit: number,
  filter: { business: boolean },
): PendingLinkRow[] {
  const rows = statements().claimPendingLinks.all({
    limit: clampLimit(limit, 20, 500),
    business: filter.business ? 1 : 0,
  }) as RawPendingLinkRow[];
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title }));
}

/**
 * Record the outcome of one media-reading attempt. A 'done' status carries the
 * description, which the events_au trigger indexes into events_fts so grounded
 * chat can find the attachment by what is in it.
 */
export function recordMediaDescription(
  id: string,
  update: MediaDescriptionUpdate,
): void {
  // New words on the row: whatever it was embedded from no longer describes it.
  invalidateEventEmbedding(id);
  statements().recordMediaDescription.run({
    id,
    description: update.description ?? null,
    model: update.model ?? null,
    status: update.status,
    error: update.error ?? null,
  });
}

/**
 * Record the outcome of one transcription attempt. A 'done' status carries the
 * transcript, which the events_au trigger indexes into events_fts so a voice
 * note is searchable by what was said in it (v5 §3).
 */
export function recordTranscript(id: string, update: TranscriptUpdate): void {
  // A voice note reaches the semantic index only through its transcript, which
  // lands minutes after the row itself.
  invalidateEventEmbedding(id);
  statements().recordTranscript.run({
    id,
    transcript: update.transcript ?? null,
    model: update.model ?? null,
    status: update.status,
    error: update.error ?? null,
  });
}

/**
 * Record the frames sampled out of a video (v5 §2), in clip order. An empty
 * list stores NULL rather than `[]`: the column is also the reference that
 * keeps those files alive, and "no frames" must read the same whether sampling
 * never ran or produced nothing.
 */
export function recordMediaFrames(
  id: string,
  frames: readonly MediaFrame[],
): void {
  statements().recordMediaFrames.run({
    id,
    frames: frames.length > 0 ? JSON.stringify(frames) : null,
  });
}

/**
 * Every frame file the DB still points at. The caller diffs this against what
 * is on disk and deletes the difference — that sweep is how a revoked video's
 * frames and a re-scan's dropped frames actually leave the disk (v5 §2).
 */
export function listMediaFramePaths(): string[] {
  const rows = statements().listMediaFrames.all() as { json: string | null }[];
  const paths: string[] = [];
  for (const row of rows) {
    for (const frame of parseMediaFrames(row.json) ?? []) paths.push(frame.path);
  }
  return paths;
}

/**
 * Record the outcome of one link-scraping attempt. A 'done' status carries the
 * page text, which the events_au trigger indexes into events_fts so a link is
 * searchable by what is behind it and not just by its URL.
 */
export function recordLinkScrape(id: string, update: LinkScrapeUpdate): void {
  // A scrape can fill in the link title, which is embedded (the page text is not).
  invalidateEventEmbedding(id);
  statements().recordLinkScrape.run({
    id,
    scrapedText: update.scrapedText ?? null,
    title: update.title ?? null,
    status: update.status,
    error: update.error ?? null,
  });
}

/**
 * Re-queue already-processed rows by type (v3 §2). Each named type drops the
 * stored verdict and puts its rows back on 'pending' — this is the ONLY way a
 * row that was read once gets read again, because flipping a switch must never
 * start hundreds of model calls on its own.
 */
export function rescanMedia(types: readonly RescanType[]): RescanResult {
  const want = new Set(types);
  const s = statements();
  const media =
    want.has("image") || want.has("video") || want.has("document") || want.has("business")
      ? s.rescanMedia.run({
          images: want.has("image") ? 1 : 0,
          video: want.has("video") ? 1 : 0,
          documents: want.has("document") ? 1 : 0,
          business: want.has("business") ? 1 : 0,
        }).changes
      : 0;
  const frames = want.has("frames") ? s.rescanFrames.run().changes : 0;
  const transcripts = want.has("transcript")
    ? s.rescanTranscripts.run().changes
    : 0;
  const links = want.has("link") ? s.rescanLinks.run().changes : 0;
  return { media, links, transcripts, frames };
}

/**
 * The media-reading status an event starts life with (media spec §8): 'pending'
 * for anything the reader can actually look at, 'unsupported' for media it
 * cannot (audio is never transcribed, and a docx/xlsx/zip is only recorded by
 * name), null when there is no media at all.
 *
 * A video is readable because its FILE is here (v7 §3). Reading `unsupported`
 * off a missing WhatsApp thumbnail was a permanent verdict — the claim matches
 * on 'pending' — and it locked out 10 of the 18 videos measured, every one of
 * them an mp4 on disk that the bundled ffmpeg can sample a frame out of.
 */
function mediaDescStatusFor(row: InsertEventRow): MediaDescStatus | null {
  if (!row.mediaPath) return null;
  switch (row.kind) {
    case "image":
    case "sticker":
    case "video":
      return "pending";
    case "document":
      return isReadableDocument(row.mediaMime, row.mediaFilename)
        ? "pending"
        : "unsupported";
    default:
      return "unsupported";
  }
}

/**
 * The transcription status an event starts life with (v5 §3). Like
 * mediaDescStatusFor this decides only what MIGHT carry speech, never what is
 * switched on: audio and video wait for their switch in the claim query, and
 * anything else has no audio track to open. Whether a particular video really
 * has one — a thumbnail-only fallback row (v4 §3) does not — is answered by
 * probing the file, so that verdict is the transcriber's to record.
 */
function transcriptStatusFor(row: InsertEventRow): TranscriptStatus | null {
  if (!row.mediaPath) return null;
  switch (row.kind) {
    case "audio":
    case "video":
      return "pending";
    default:
      return "unsupported";
  }
}

/**
 * The link-scraping status an event starts life with (v3 §3). Like
 * mediaDescStatusFor this decides only what is FETCHABLE, never what is
 * switched on: a scheme is immutable, so a mailto:/tel:/data: URL can be
 * written off for good, while http(s) waits for the switch in the claim query.
 */
function linkScrapeStatusFor(row: InsertEventRow): LinkScrapeStatus | null {
  const url = row.linkUrl?.trim();
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? "pending" : "unsupported";
}

/** pdf / txt / md / csv / json are read directly; everything else is not. */
function isReadableDocument(
  mime: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const m = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (m === "application/pdf" || m === "application/json") return true;
  if (m.startsWith("text/")) return true;
  const name = filename ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return READABLE_DOC_EXTS.has(name.slice(dot + 1).toLowerCase());
}

const READABLE_DOC_EXTS = new Set(["pdf", "txt", "md", "csv", "json"]);

/** Decode `events.media_meta_json`; a corrupt/absent value reads as null. */
function parseMediaMeta(json: string | null): MediaMeta | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as MediaMeta;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decode `events.media_frames_json`. Entries without a usable path are dropped
 * rather than handed on: this list drives both what the UI opens and which
 * files survive the sweep, and a malformed entry would show up there as a
 * missing image or a deleted frame.
 */
function parseMediaFrames(json: string | null): MediaFrame[] | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const frames = parsed.flatMap((entry) => {
    const frame = entry as Partial<MediaFrame> | null;
    if (!frame || typeof frame.path !== "string" || frame.path === "") return [];
    const seconds = Number(frame.seconds);
    return [{ path: frame.path, seconds: Number.isFinite(seconds) ? seconds : 0 }];
  });
  return frames.length > 0 ? frames : null;
}

// ---- Inbox reads ----------------------------------------------------------

export function listInboxChats(opts?: {
  limit?: number;
  offset?: number;
}): InboxChatRow[] {
  const limit = clampLimit(opts?.limit, 100, 500);
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const rows = statements().listInboxChats.all({
    limit,
    offset,
  }) as RawInboxChatRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sourceExtId: r.source_ext_id,
    kind: r.kind,
    lastText: r.last_text,
    lastTs: r.last_ts,
    messageCount: r.message_count,
  }));
}

/**
 * Fetch a page of messages for a channel, NEWEST-first windowed (Rev 7 §R7.1).
 *
 * - No `before`: returns the NEWEST `limit` messages.
 * - With `before` (opaque compound cursor `"<ts>|<id>"` = the OLDEST currently
 *   loaded message): returns the `limit` messages strictly OLDER than the cursor
 *   under the `(ts, id)` total order (so same-ts messages page with no gap or
 *   overlap). A legacy bare-ts cursor (no `|`) is treated as `beforeTs` with an
 *   empty id, degrading to `e.ts < beforeTs` so older callers keep working.
 *
 * Either way the rows are queried DESC then REVERSED to ascending (oldest →
 * newest) so the UI renders them top→bottom with the newest at the bottom, and
 * so the reaction/reply attachment below operates on the returned page. The UI
 * builds the next (older) cursor from the FIRST element as `"<ts>|<id>"` and can
 * infer `hasMore` from `rows.length === limit`.
 */
export function getStreamMessages(opts: {
  streamId: string;
  before?: string | null;
  limit?: number;
}): InboxMessageRow[] {
  const limit = clampLimit(opts.limit, 50, 500);
  const s = statements();
  let rows: RawInboxMessageRow[];
  if (opts.before) {
    const { beforeTs, beforeId } = parseBeforeCursor(opts.before);
    rows = s.streamMessagesBefore.all({
      streamId: opts.streamId,
      beforeTs,
      beforeId,
      limit,
    }) as RawInboxMessageRow[];
  } else {
    rows = s.streamMessages.all({
      streamId: opts.streamId,
      limit,
    }) as RawInboxMessageRow[];
  }

  // Queried DESC (newest first) for correct windowing; reverse to ascending
  // (oldest → newest) for the response and the attachment logic below.
  rows.reverse();

  // Reactions (§R5.3): fetch every reaction row in this channel, collapse to
  // net-current state per (target, actor), and index by target external_id so
  // each message can pick up its own reactions below.
  const reactionRows = s.streamReactions.all({
    streamId: opts.streamId,
  }) as RawReactionRow[];
  const reactionsByTarget = collapseReactions(reactionRows);

  // Quoted replies (§R5.4): resolve the quoted actor's display name from the
  // rows we already have (the quoted message may not be in this page — then
  // actorName stays null and the UI shows the stored snippet alone).
  const actorNameByExternalId = new Map<string, string | null>();
  for (const r of rows) {
    if (r.external_id) actorNameByExternalId.set(r.external_id, r.actor_name);
  }

  return rows.map((r) => {
    const reactions = r.external_id
      ? reactionsByTarget.get(r.external_id) ?? []
      : [];
    let replyTo: MessageReplyRefRow | null = null;
    if (r.reply_to_external_id) {
      replyTo = {
        externalId: r.reply_to_external_id,
        text: r.reply_to_text,
        actorName:
          actorNameByExternalId.get(r.reply_to_external_id) ?? null,
      };
    }
    return {
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      text: r.text,
      fromMe: Boolean(r.from_me),
      actorName: r.actor_name,
      mediaPath: r.media_path,
      mediaMime: r.media_mime,
      mediaFilename: r.media_filename,
      mediaSize: r.media_size,
      mediaThumbPath: r.media_thumb_path,
      mediaSeconds: r.media_seconds,
      mediaMeta: parseMediaMeta(r.media_meta_json),
      mediaDescription: r.media_description,
      mediaFrames: parseMediaFrames(r.media_frames_json),
      transcript: r.transcript,
      editedAt: r.edited_at,
      revokedAt: r.revoked_at,
      isForwarded: Boolean(r.is_forwarded),
      reactions,
      replyTo,
      link: r.link_url
        ? {
            url: r.link_url,
            title: r.link_title,
            description: r.link_description,
            thumbPath: r.link_thumb_path,
            previewType: r.link_preview_type,
            scrapedText: r.link_scraped_text,
          }
        : null,
    };
  });
}

/**
 * Collapse reaction event rows (oldest → newest) into net-current reactions per
 * target message (§R5.3). For each (targetExternalId, actor) we keep only the
 * LATEST reaction; an empty-text reaction (emoji === "") means the actor removed
 * theirs, so that actor is dropped from the target's set. Returns a map from
 * target external_id to the surviving reactions in first-reaction order.
 */
function collapseReactions(
  rows: RawReactionRow[],
): Map<string, MessageReactionRow[]> {
  // Per target: ordered actor keys + their current reaction (null once removed).
  interface TargetState {
    order: string[];
    byActor: Map<string, MessageReactionRow | null>;
  }
  const targets = new Map<string, TargetState>();

  for (const row of rows) {
    const target = row.target_external_id;
    if (!target) continue;
    // Key on the actor's canonical ext id; fall back to a per-row sentinel so an
    // unknown actor's reaction still shows (and can't collide with others).
    const actorKey = row.actor_ext_id ?? `__unknown__:${target}:${row.emoji ?? ""}`;

    let state = targets.get(target);
    if (!state) {
      state = { order: [], byActor: new Map() };
      targets.set(target, state);
    }
    if (!state.byActor.has(actorKey)) state.order.push(actorKey);

    const emoji = row.emoji ?? "";
    if (emoji === "") {
      // Removal: this actor no longer reacts to the target.
      state.byActor.set(actorKey, null);
    } else {
      state.byActor.set(actorKey, {
        emoji,
        fromMe: Boolean(row.from_me),
        actorName: row.actor_name,
      });
    }
  }

  const out = new Map<string, MessageReactionRow[]>();
  for (const [target, state] of targets) {
    const reactions: MessageReactionRow[] = [];
    for (const actorKey of state.order) {
      const current = state.byActor.get(actorKey);
      if (current) reactions.push(current);
    }
    if (reactions.length > 0) out.set(target, reactions);
  }
  return out;
}

/**
 * FTS5 search. `q` is sanitized into a safe MATCH query (quote each token as a
 * phrase) to avoid FTS syntax errors on user punctuation. Returns [] for empty.
 */
export function searchEvents(opts: {
  q: string;
  limit?: number;
}): SearchHitRow[] {
  const match = toFtsMatchQuery(opts.q);
  if (!match) return [];
  const limit = clampLimit(opts.limit, 50, 200);
  const rows = statements().searchEvents.all({
    q: match,
    limit,
  }) as RawSearchRow[];
  return rows.map((r) => ({
    eventId: r.event_id,
    streamId: r.stream_id,
    streamName: r.stream_name,
    ts: r.ts,
    snippet: r.snippet,
    text: r.text,
  }));
}

// ---- app_state ------------------------------------------------------------

export function appStateGet(key: string): string | null {
  const row = statements().appStateGet.get(key) as
    | { value: string | null }
    | undefined;
  return row ? row.value : null;
}

export function appStateSet(key: string, value: string): void {
  statements().appStateSet.run({ key, value });
}

/** Delete an app_state key (no-op if absent). */
export function appStateDelete(key: string): void {
  statements().appStateDelete.run(key);
}

/**
 * Read how "me" appears in a source, or null before it is known. This is what
 * a manifest's `self_identity.value_getter` is built on (arch §2.2 note 4).
 */
export function selfIdentityValue(sourceId: string): string | null {
  return appStateGet(selfIdentityKey(sourceId));
}

/** Record how "me" appears in a source (the daemon learns it at pairing). */
export function setSelfIdentity(sourceId: string, value: string): void {
  if (!value) return;
  appStateSet(selfIdentityKey(sourceId), value);
}

/**
 * Clear a source's persisted import flags (Rev 2 §R2.1) WITHOUT wiping ingested
 * data. Used by standalone `logout` and `relink` (Rev 3 §R3.2) so onboarding
 * restarts from the range picker after the session is dropped.
 */
export function clearImportFlags(sourceId: string): void {
  const s = statements();
  s.appStateDelete.run(importDoneKey(sourceId));
  s.appStateDelete.run(importRangeKey(sourceId));
}

// ---- Reset (Rev 2 §R2.3) --------------------------------------------------

export interface ResetSourceResult {
  events: number;
  streams: number;
  actors: number;
}

/** @deprecated One release only — the name `channel` is now `stream`. */
export type ResetWhatsappResult = ResetSourceResult;

/**
 * Wipe all ingested data for ONE source in a single transaction and clear that
 * source's persisted import flags (arch §3.3 leak 2 — the old helper was called
 * `resetWhatsappData` and defaulted its own source id, so "reset" meant "reset
 * WhatsApp" no matter who asked).
 *
 * Deletes events (FTS auto-syncs via the 0017_reply_fts triggers — we never
 * touch events_fts), then streams + the legacy channels mirror, then actors,
 * then any people orphaned by the actor delete. Watermarks go with their
 * streams (ON DELETE CASCADE).
 *
 * Does NOT touch the source's own session store (whatsmeow keeps its own DB).
 * After reset, /status reports importDone:false so the UI returns to the range
 * picker. Returns the deleted-row counts.
 */
export function resetSourceData(sourceId: string): ResetSourceResult {
  const s = statements();
  const tx = s.db.transaction((): ResetSourceResult => {
    const events = (s.countSourceEvents.get(sourceId) as { n: number }).n;
    const streams = (s.countSourceStreams.get(sourceId) as { n: number }).n;
    const actors = (s.countSourceActors.get(sourceId) as { n: number }).n;

    s.deleteSourceEvents.run(sourceId);
    s.deleteSourceStreams.run(sourceId);
    s.deleteSourceChannels.run(sourceId);
    s.deleteSourceActors.run(sourceId);
    s.deleteOrphanPeople.run();

    s.appStateDelete.run(importDoneKey(sourceId));
    s.appStateDelete.run(importRangeKey(sourceId));

    return { events, streams, actors };
  });
  return tx();
}

// ---- Deterministic id helpers ---------------------------------------------

/**
 * `<source_id>:<external_id>` (arch §3.3 leak 1). The old hardcoded `wa:`
 * prefix was the same leak as the reset helper and the app_state keys: an id
 * space with one source's nickname baked into it, which the second source can
 * only join by pretending to be the first.
 */
export function eventId(sourceId: string, externalId: string): string {
  return `${sourceId}:${externalId}`;
}

/** `<source_id>:st:<external_key>` — one lane inside a source (arch §6). */
export function streamId(sourceId: string, sourceExtId: string): string {
  return `${sourceId}:st:${sourceExtId}`;
}

/** @deprecated One release only — the name `channel` is now `stream`. */
export const channelId = streamId;

export function actorId(sourceId: string, sourceExtId: string): string {
  return `${sourceId}:ac:${sourceExtId}`;
}

function personId(sourceId: string, sourceExtId: string): string {
  return `${sourceId}:pe:${sourceExtId}`;
}

// ---- Small utilities ------------------------------------------------------

function clampLimit(
  raw: number | undefined,
  fallback: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Parse the `before` paging cursor (Rev 7 §R7.1). The canonical form is the
 * opaque string `"<ts>|<id>"` = the OLDEST currently-loaded message, giving a
 * `(ts, id)` total order so same-timestamp messages page cleanly. Only the FIRST
 * `|` splits ts from id (a ts never contains `|`; ids are safe too). A legacy
 * bare-ts cursor (no `|`) yields an empty id so the query degrades to
 * `e.ts < beforeTs`, preserving pre-Rev-7 behaviour.
 */
function parseBeforeCursor(before: string): {
  beforeTs: string;
  beforeId: string;
} {
  const sep = before.indexOf("|");
  if (sep === -1) return { beforeTs: before, beforeId: "" };
  return {
    beforeTs: before.slice(0, sep),
    beforeId: before.slice(sep + 1),
  };
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH string. Each whitespace token
 * becomes a double-quoted phrase (FTS treats `"…"` literally), joined by
 * implicit AND. Strips embedded double-quotes. Returns "" if nothing usable —
 * callers short-circuit to an empty result to avoid an FTS syntax error.
 */
export function toFtsMatchQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}
