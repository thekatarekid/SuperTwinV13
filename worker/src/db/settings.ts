// ===========================================================================
// [CODE] app_state settings + model selection (V2 §3.2).
//
// This is what survived `store/store.ts`: the key/value settings layer that the
// media reader, the retrieval encoder, the model picker and the server routes
// all read. The 1,864-line spaces/goals/milestones/tasks ontology around it is
// gone — it had zero runtime callers and encoded a model this build rejects.
//
// Every helper here is a typed view over ONE `app_state` row. Reads go through
// `appStateGet` / `appStateSet` (db/ingest.ts) so there is a single prepared
// statement for the table rather than a second cache of the same two queries.
//
// Default polarity is deliberate and NOT factorable into a shared helper: a
// setting that ships ON reads `!== "0"` (unset means on), a setting that must
// be opted into reads `=== "1"` (unset means off). Those two differ exactly on
// the unset row, which is the case that decides what a fresh install does.
// ===========================================================================

import { appStateGet, appStateSet } from "./ingest.js";
import type { ModelRole } from "../providers/claude-local/models.js";

// ---- app_state keys ---------------------------------------------------------

/**
 * Legacy single-model key (pre per-role selection). Kept ONLY for the migration
 * fallback read in getSelectedModel — rows are never deleted. New writes go to
 * the per-role keys below.
 */
export const MODEL_KEY = "selected_model";
/** Per-role selected-model keys (empty string = subscription default). */
export const MODEL_KEY_BY_ROLE: Record<ModelRole, string> = {
  chat: "selected_model_chat",
  media: "selected_model_media",
};
/**
 * What a role falls back to when the user has not picked anything. Chat inherits
 * the subscription default (""); media reading is a high-volume background job,
 * so it pins the cheapest vision-capable model instead.
 */
export const MODEL_DEFAULT_BY_ROLE: Record<ModelRole, string> = {
  chat: "",
  media: "claude-haiku-4-5-20251001",
};
/** Per-process on/off toggle key prefix (app_state 'process_enabled_<role>'). */
export const PROCESS_ENABLED_KEY_PREFIX = "process_enabled_";

/** macOS notifications toggle (default ON; value "0" disables). */
export const NOTIFICATIONS_ENABLED_KEY = "notifications.enabled";
/** Media reader: describe media as it arrives (default ON; value "0" disables). */
export const MEDIA_DESCRIBE_ENABLED_KEY = "media.describe_enabled";
/** Media reader: work through the history-sync backlog (default ON). */
export const MEDIA_BACKFILL_ENABLED_KEY = "media.backfill_enabled";
/** Media reader: photos and stickers (default ON). */
export const MEDIA_IMAGES_ENABLED_KEY = "media.images_enabled";
/** Media reader: the single thumbnail frame of a video (default OFF). */
export const MEDIA_VIDEO_ENABLED_KEY = "media.video_enabled";
/** Media reader: media in business / official-account chats (default OFF). */
export const MEDIA_BUSINESS_ENABLED_KEY = "media.business_enabled";
/**
 * Link scraper: fetch the pages links point at (default OFF). Fetching one is
 * an outbound request to a URL chosen by whoever sent the message, and is
 * observable by them — so it stays off until the user asks for it.
 */
export const MEDIA_LINK_SCRAPE_ENABLED_KEY = "media.link_scrape_enabled";
/** Media reader: descriptions per minute the backfill queue may request. */
export const MEDIA_RATE_PER_MIN_KEY = "media.rate_per_min";
export const DEFAULT_MEDIA_RATE_PER_MIN = 20;
/** Media reader: work units in flight at once (v6 §5). A batch counts as one. */
export const MEDIA_CONCURRENCY_KEY = "media.concurrency";
export const DEFAULT_MEDIA_CONCURRENCY = 5;
/**
 * Ceiling on that. Each slot holds a CLI child and a model call open, so a
 * nonsense value spends the five-hour subscription window in one burst — the
 * refusal the queue then has to back off from.
 */
export const MAX_MEDIA_CONCURRENCY = 20;
/**
 * Sample frames across a video instead of reading its one thumbnail (v5 §2,
 * default OFF). Frames are the only one of the three below that costs tokens,
 * which is why it is also the only one an install has to opt into.
 */
export const MEDIA_VIDEO_FRAMES_ENABLED_KEY = "media.video_frames_enabled";
/** Transcribe the audio track inside a video (v6 §6, default ON). */
export const MEDIA_VIDEO_AUDIO_ENABLED_KEY = "media.video_audio_enabled";
/** Transcribe voice notes and audio attachments (v6 §6, default ON). */
export const MEDIA_VOICE_NOTES_ENABLED_KEY = "media.voice_notes_enabled";
/** Seconds between sampled frames. */
export const MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY = "media.video_frame_interval_sec";
/** Ceiling on frames per video, however long it runs. */
export const MEDIA_VIDEO_FRAME_MAX_KEY = "media.video_frame_max";
/**
 * Tallest video the link reader will fetch (v7 §4). It only bites where we get
 * to choose the file — a linked video we download — because an attachment
 * arrives at whatever resolution it was sent at.
 */
export const MEDIA_VIDEO_MAX_HEIGHT_KEY = "media.video_max_height";
/** whisper.cpp model id (no `ggml-` prefix, no `.bin`). */
export const MEDIA_WHISPER_MODEL_KEY = "media.whisper_model";
export const DEFAULT_VIDEO_FRAME_INTERVAL_SEC = 5;
export const DEFAULT_VIDEO_FRAME_MAX = 8;
/**
 * Both frame bounds are clamped because together they decide how many images
 * one model call is asked to hold apart: an interval of 0 would divide by
 * nothing, and 200 frames would overrun the answer and cost the whole call.
 */
export const MAX_VIDEO_FRAME_INTERVAL_SEC = 3600;
export const MAX_VIDEO_FRAME_MAX = 20;
/**
 * 480p, because nothing downstream can use more: a sampled frame is downscaled
 * to 768 px on its longest edge, and whisper hears the audio track whatever the
 * picture was. Every pixel above this is bandwidth spent on a file that is
 * deleted minutes later.
 */
export const DEFAULT_VIDEO_MAX_HEIGHT = 480;
/** Below this nothing is legible in a frame; above it, see the default's note. */
export const MIN_VIDEO_MAX_HEIGHT = 144;
export const MAX_VIDEO_MAX_HEIGHT = 1080;
/** The model shipped inside the .app, so transcription works with no network. */
export const DEFAULT_WHISPER_MODEL = "large-v3-turbo-q5_0";

/** Semantic retrieval (tier 3). Off until the user fetches the encoder. */
export const RETRIEVAL_SEMANTIC_ENABLED_KEY = "retrieval.semantic_enabled";

/**
 * Debug export (V2 §3.2). The markdown brain is not a product surface any more:
 * the file routes that read it are mounted only when this flag is on, so a
 * default install never serves `<brain>/**` over HTTP at all.
 */
export const DEBUG_EXPORT_KEY = "settings.debug_export";

// ---- Boolean/number readers -------------------------------------------------

/** ON by default: unset reads true, only an explicit "0" turns it off. */
function readOnByDefault(key: string): boolean {
  const v = appStateGet(key);
  return v == null ? true : v !== "0";
}

/** OFF by default: unset reads false, only an explicit "1" turns it on. */
function readOffByDefault(key: string): boolean {
  const v = appStateGet(key);
  return v == null ? false : v === "1";
}

function writeFlag(key: string, v: boolean): void {
  appStateSet(key, v ? "1" : "0");
}

/** A positive integer setting, clamped; the default when unset or garbage. */
function readClampedInt(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = appStateGet(key);
  const n = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

// ---- Notifications ----------------------------------------------------------

/** macOS notifications toggle. Default ON — off only when explicitly set to "0". */
export function getNotificationsEnabled(): boolean {
  return readOnByDefault(NOTIFICATIONS_ENABLED_KEY);
}

export function setNotificationsEnabled(v: boolean): void {
  writeFlag(NOTIFICATIONS_ENABLED_KEY, v);
}

// ---- Debug export -----------------------------------------------------------

/**
 * Whether the debug-export routes are mounted. Default OFF: the brain folder is
 * a debug artefact, so serving it has to be asked for.
 */
export function getDebugExportEnabled(): boolean {
  return readOffByDefault(DEBUG_EXPORT_KEY);
}

export function setDebugExportEnabled(v: boolean): void {
  writeFlag(DEBUG_EXPORT_KEY, v);
}

// ---- Media reader settings ---------------------------------------------------

/** Describe media as it arrives. Default ON — off only when explicitly "0". */
export function getMediaDescribeEnabled(): boolean {
  return readOnByDefault(MEDIA_DESCRIBE_ENABLED_KEY);
}

export function setMediaDescribeEnabled(v: boolean): void {
  writeFlag(MEDIA_DESCRIBE_ENABLED_KEY, v);
}

/** Work through the already-imported media backlog. Default ON. */
export function getMediaBackfillEnabled(): boolean {
  return readOnByDefault(MEDIA_BACKFILL_ENABLED_KEY);
}

export function setMediaBackfillEnabled(v: boolean): void {
  writeFlag(MEDIA_BACKFILL_ENABLED_KEY, v);
}

/** Photos and stickers. Default ON — the media the reader was built for. */
export function getMediaImagesEnabled(): boolean {
  return readOnByDefault(MEDIA_IMAGES_ENABLED_KEY);
}

export function setMediaImagesEnabled(v: boolean): void {
  writeFlag(MEDIA_IMAGES_ENABLED_KEY, v);
}

/**
 * Video thumbnails. Default OFF, so the test is inverted from every switch
 * above: an unset key must read false. An unset key is exactly the case that
 * decides whether a fresh install ships this reading or not.
 */
export function getMediaVideoEnabled(): boolean {
  return readOffByDefault(MEDIA_VIDEO_ENABLED_KEY);
}

export function setMediaVideoEnabled(v: boolean): void {
  writeFlag(MEDIA_VIDEO_ENABLED_KEY, v);
}

/** Media in business / official-account chats. Default OFF (inverted test). */
export function getMediaBusinessEnabled(): boolean {
  return readOffByDefault(MEDIA_BUSINESS_ENABLED_KEY);
}

export function setMediaBusinessEnabled(v: boolean): void {
  writeFlag(MEDIA_BUSINESS_ENABLED_KEY, v);
}

/** Fetch link targets. Default OFF (inverted test) — it is observable traffic. */
export function getMediaLinkScrapeEnabled(): boolean {
  return readOffByDefault(MEDIA_LINK_SCRAPE_ENABLED_KEY);
}

export function setMediaLinkScrapeEnabled(v: boolean): void {
  writeFlag(MEDIA_LINK_SCRAPE_ENABLED_KEY, v);
}

/**
 * What the user CHOSE, or null if they never have. Null is not "off": the
 * encoder ships inside the app now, and the caller that knows whether the
 * weights are actually on disk (retrieval/embedder.ts) is the one entitled to
 * pick a default. Reading the unset row as `false` here is what left the index
 * at 0 of 595 rows on every install that never opened Settings.
 */
export function getSemanticRetrievalPreference(): boolean | null {
  const v = appStateGet(RETRIEVAL_SEMANTIC_ENABLED_KEY);
  return v == null ? null : v === "1";
}

export function setSemanticRetrievalEnabled(v: boolean): void {
  writeFlag(RETRIEVAL_SEMANTIC_ENABLED_KEY, v);
}

/** Backfill throttle in descriptions/minute; the default when unset or garbage. */
export function getMediaRatePerMin(): number {
  return readClampedInt(
    MEDIA_RATE_PER_MIN_KEY,
    DEFAULT_MEDIA_RATE_PER_MIN,
    1,
    Number.MAX_SAFE_INTEGER,
  );
}

export function setMediaRatePerMin(n: number): void {
  appStateSet(MEDIA_RATE_PER_MIN_KEY, String(Math.floor(n)));
}

/** Work units the queue may have in flight; the default when unset or garbage. */
export function getMediaConcurrency(): number {
  return readClampedInt(
    MEDIA_CONCURRENCY_KEY,
    DEFAULT_MEDIA_CONCURRENCY,
    1,
    MAX_MEDIA_CONCURRENCY,
  );
}

export function setMediaConcurrency(n: number): void {
  appStateSet(MEDIA_CONCURRENCY_KEY, String(Math.floor(n)));
}

// ---- Video frames and transcription (v5 §2/§3, v6 §6) ------------------------
//
// Frame sampling reads OFF-by-default, for the reason spelled out on
// getMediaVideoEnabled: an unset key is exactly the case that decides whether a
// fresh install ships work nobody asked for, and a frame costs tokens.
//
// The two transcription switches are ON by default because whisper is local and
// costs no tokens (v6 §6). The polarity is the whole difference between the two
// groups, so they cannot share a reader.

/** Sample frames across a video rather than reading its thumbnail. Default OFF. */
export function getMediaVideoFramesEnabled(): boolean {
  return readOffByDefault(MEDIA_VIDEO_FRAMES_ENABLED_KEY);
}

export function setMediaVideoFramesEnabled(v: boolean): void {
  writeFlag(MEDIA_VIDEO_FRAMES_ENABLED_KEY, v);
}

/** Transcribe the audio track inside a video. Default ON — it costs no tokens. */
export function getMediaVideoAudioEnabled(): boolean {
  return readOnByDefault(MEDIA_VIDEO_AUDIO_ENABLED_KEY);
}

export function setMediaVideoAudioEnabled(v: boolean): void {
  writeFlag(MEDIA_VIDEO_AUDIO_ENABLED_KEY, v);
}

/** Transcribe voice notes and audio attachments. Default ON, same reason. */
export function getMediaVoiceNotesEnabled(): boolean {
  return readOnByDefault(MEDIA_VOICE_NOTES_ENABLED_KEY);
}

export function setMediaVoiceNotesEnabled(v: boolean): void {
  writeFlag(MEDIA_VOICE_NOTES_ENABLED_KEY, v);
}

/** Seconds between sampled frames; the default when unset or garbage. */
export function getMediaVideoFrameIntervalSec(): number {
  return readClampedInt(
    MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY,
    DEFAULT_VIDEO_FRAME_INTERVAL_SEC,
    1,
    MAX_VIDEO_FRAME_INTERVAL_SEC,
  );
}

export function setMediaVideoFrameIntervalSec(n: number): void {
  appStateSet(MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY, String(Math.floor(n)));
}

/** Ceiling on frames per video; the default when unset or garbage. */
export function getMediaVideoFrameMax(): number {
  return readClampedInt(
    MEDIA_VIDEO_FRAME_MAX_KEY,
    DEFAULT_VIDEO_FRAME_MAX,
    1,
    MAX_VIDEO_FRAME_MAX,
  );
}

export function setMediaVideoFrameMax(n: number): void {
  appStateSet(MEDIA_VIDEO_FRAME_MAX_KEY, String(Math.floor(n)));
}

/**
 * Tallest linked video the reader will fetch; the default when unset or
 * garbage. Clamped at both ends, unlike the settings above: a value under the
 * floor would match no published format at all and quietly send every download
 * to whatever the site calls "worst".
 */
export function getMediaVideoMaxHeight(): number {
  return readClampedInt(
    MEDIA_VIDEO_MAX_HEIGHT_KEY,
    DEFAULT_VIDEO_MAX_HEIGHT,
    MIN_VIDEO_MAX_HEIGHT,
    MAX_VIDEO_MAX_HEIGHT,
  );
}

export function setMediaVideoMaxHeight(n: number): void {
  appStateSet(MEDIA_VIDEO_MAX_HEIGHT_KEY, String(Math.floor(n)));
}

/**
 * Selected whisper model id. Defaults to the one bundled in the .app, so
 * transcription works on a machine that has never been online; whether the id
 * names a model that exists is the transcriber's to answer, not this getter's.
 */
export function getMediaWhisperModel(): string {
  const id = appStateGet(MEDIA_WHISPER_MODEL_KEY)?.trim();
  return id ? id : DEFAULT_WHISPER_MODEL;
}

export function setMediaWhisperModel(id: string): void {
  appStateSet(MEDIA_WHISPER_MODEL_KEY, id.trim());
}

// ---- Model selection ---------------------------------------------------------

/**
 * Per-LLM-process on/off. Default ON when unset. Each role uses its own
 * 'process_enabled_<role>' key.
 */
export function getProcessEnabled(role: ModelRole): boolean {
  return readOnByDefault(`${PROCESS_ENABLED_KEY_PREFIX}${role}`);
}

export function setProcessEnabled(role: ModelRole, enabled: boolean): void {
  writeFlag(`${PROCESS_ENABLED_KEY_PREFIX}${role}`, enabled);
}

/**
 * Selected Claude model id for a role, falling back to the role's default
 * (MODEL_DEFAULT_BY_ROLE) when unset. Migration fallback: if this role has no
 * per-role value yet AND the legacy single-model key is set, return the legacy
 * value so existing installs keep their prior choice.
 */
export function getSelectedModel(role: ModelRole): string {
  const own = appStateGet(MODEL_KEY_BY_ROLE[role]);
  if (own) return own;
  if (role === "chat") {
    const legacy = appStateGet(MODEL_KEY);
    if (legacy) return legacy;
  }
  return MODEL_DEFAULT_BY_ROLE[role];
}

/** Persist the selected model id for a role. Storing "" represents/clears to default. */
export function setSelectedModel(role: ModelRole, id: string): void {
  appStateSet(MODEL_KEY_BY_ROLE[role], id);
}

/**
 * Every role selection at once (each via getSelectedModel → legacy fallback).
 * Iterates the role key map so new roles are picked up automatically (§3.7).
 */
export function getAllSelectedModels(): Record<ModelRole, string> {
  const out = {} as Record<ModelRole, string>;
  for (const role of Object.keys(MODEL_KEY_BY_ROLE) as ModelRole[]) {
    out[role] = getSelectedModel(role);
  }
  return out;
}
