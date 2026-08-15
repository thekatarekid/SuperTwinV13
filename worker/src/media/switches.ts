// ===========================================================================
// The media reader's per-type switches and its batch size (v3 §2).
//
// Same app_state shape as the reader's describe/backfill toggles, with the
// opposite default on three of the four: a video frame, a business chat and a
// link fetch each cost tokens or make an outbound request the sender can
// observe, so none of them happens until it is asked for. Every other boolean
// getter in the app reads `!== "0"` and therefore defaults ON — these read
// `=== "1"` instead, or they would ship enabled.
//
// None of this gates a row when it is WRITTEN: media_desc_status and
// link_scrape_status are stamped once at insert, so a switch turned on later can
// only reach already-stored rows through the claim query, which runs fresh on
// every cycle.
// ===========================================================================

import {
  appStateGet,
  appStateSet,
  type MediaClaimFilter,
  type TranscriptClaimFilter,
} from "../db/ingest.js";
import {
  getMediaVideoAudioEnabled,
  getMediaVideoFrameIntervalSec,
  getMediaVideoFrameMax,
  getMediaVideoFramesEnabled,
  getMediaVideoMaxHeight,
  getMediaVoiceNotesEnabled,
} from "../store/store.js";
import { DEFAULT_IMAGE_BATCH, MAX_IMAGE_BATCH } from "./describe.js";
import type { LinkVideoBounds } from "./linkvideo.js";

export const MEDIA_IMAGES_ENABLED_KEY = "media.images_enabled";
export const MEDIA_VIDEO_ENABLED_KEY = "media.video_enabled";
export const MEDIA_BUSINESS_ENABLED_KEY = "media.business_enabled";
export const MEDIA_LINK_SCRAPE_ENABLED_KEY = "media.link_scrape_enabled";
export const MEDIA_IMAGE_BATCH_KEY = "media.image_batch";

/** Read images and stickers. Default ON — off only when explicitly "0". */
export function getMediaImagesEnabled(): boolean {
  const v = appStateGet(MEDIA_IMAGES_ENABLED_KEY);
  return v !== null ? v !== "0" : true;
}

export function setMediaImagesEnabled(v: boolean): void {
  appStateSet(MEDIA_IMAGES_ENABLED_KEY, v ? "1" : "0");
}

/** Read the single thumbnail frame of a video. Default OFF. */
export function getMediaVideoEnabled(): boolean {
  return appStateGet(MEDIA_VIDEO_ENABLED_KEY) === "1";
}

export function setMediaVideoEnabled(v: boolean): void {
  appStateSet(MEDIA_VIDEO_ENABLED_KEY, v ? "1" : "0");
}

/** Read media and fetch links in business / official-account chats. Default OFF. */
export function getMediaBusinessEnabled(): boolean {
  return appStateGet(MEDIA_BUSINESS_ENABLED_KEY) === "1";
}

export function setMediaBusinessEnabled(v: boolean): void {
  appStateSet(MEDIA_BUSINESS_ENABLED_KEY, v ? "1" : "0");
}

/**
 * Fetch what is behind a link. Default OFF: the request goes to a URL somebody
 * else chose, and it tells them this machine opened their message.
 */
export function getMediaLinkScrapeEnabled(): boolean {
  return appStateGet(MEDIA_LINK_SCRAPE_ENABLED_KEY) === "1";
}

export function setMediaLinkScrapeEnabled(v: boolean): void {
  appStateSet(MEDIA_LINK_SCRAPE_ENABLED_KEY, v ? "1" : "0");
}

/**
 * Images per CLI call. Read on every cycle rather than at startup, so a change
 * lands on the next claim; clamped both ways because the value decides how many
 * files one model call is asked to hold apart, and a nonsense one costs either
 * the whole batching win (1) or a whole answer (too many).
 */
export function getMediaImageBatch(): number {
  const n = Number(appStateGet(MEDIA_IMAGE_BATCH_KEY));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IMAGE_BATCH;
  return Math.min(Math.floor(n), MAX_IMAGE_BATCH);
}

export function setMediaImageBatch(n: number): void {
  appStateSet(MEDIA_IMAGE_BATCH_KEY, String(Math.floor(n)));
}

/** What the claim query may hand out now. Documents have no switch of their own. */
export function mediaClaimFilter(): MediaClaimFilter {
  return {
    images: getMediaImagesEnabled(),
    video: getMediaVideoEnabled(),
    documents: true,
    business: getMediaBusinessEnabled(),
  };
}

/**
 * The v5 switches live in store.ts with the rest of the settings surface the
 * server reads; what belongs here is only the shape the claim wants. Voice
 * notes and video audio gate independently — someone who wants their voice
 * notes read has not thereby asked for every forwarded clip to be transcribed.
 */
export function transcriptClaimFilter(): TranscriptClaimFilter {
  return {
    voiceNotes: getMediaVoiceNotesEnabled(),
    videoAudio: getMediaVideoAudioEnabled(),
    business: getMediaBusinessEnabled(),
  };
}

/** True when either transcription switch is on — i.e. the queue has a step. */
export function anyTranscriptionEnabled(): boolean {
  return getMediaVoiceNotesEnabled() || getMediaVideoAudioEnabled();
}

/** How a video is sampled, read fresh so a Settings change lands next cycle. */
export function frameSampling(): {
  enabled: boolean;
  intervalSec: number;
  maxFrames: number;
} {
  return {
    enabled: getMediaVideoFramesEnabled(),
    intervalSec: getMediaVideoFrameIntervalSec(),
    maxFrames: getMediaVideoFrameMax(),
  };
}

/**
 * What may be done with the video behind a link (v7 §4). Every field is one of
 * the controls a local video already answers to — v7 §4 asks for the existing
 * ones rather than a second set, so turning video frames off turns them off for
 * a linked clip too. Only the height cap is new, and only because a download is
 * the one case where we get to choose the file.
 */
export function linkVideoBounds(eventId: string): LinkVideoBounds {
  return {
    eventId,
    frames: getMediaVideoFramesEnabled(),
    intervalSec: getMediaVideoFrameIntervalSec(),
    maxFrames: getMediaVideoFrameMax(),
    audio: getMediaVideoAudioEnabled(),
    maxHeight: getMediaVideoMaxHeight(),
  };
}
