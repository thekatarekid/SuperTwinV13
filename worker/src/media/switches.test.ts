// ===========================================================================
// Per-type switch tests (vitest). The one thing worth pinning here is polarity:
// three of these four default OFF, against a codebase where every other boolean
// setting defaults ON, so an unset key is the case most likely to go wrong.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { appStateSet } from "../db/ingest.js";
import {
  DEFAULT_VIDEO_FRAME_INTERVAL_SEC,
  DEFAULT_VIDEO_FRAME_MAX,
  DEFAULT_VIDEO_MAX_HEIGHT,
  setMediaVideoAudioEnabled,
  setMediaVideoFrameIntervalSec,
  setMediaVideoFrameMax,
  setMediaVideoFramesEnabled,
  setMediaVideoMaxHeight,
  setMediaVoiceNotesEnabled,
} from "../db/settings.js";
import { ENRICHMENT_IMAGE_BATCH_SIZE_KEY } from "./batch.js";
import { DEFAULT_IMAGE_BATCH, MAX_IMAGE_BATCH } from "./describe.js";
import {
  anyTranscriptionEnabled,
  frameSampling,
  getMediaBusinessEnabled,
  getMediaImageBatch,
  getMediaImagesEnabled,
  getMediaLinkScrapeEnabled,
  getMediaVideoEnabled,
  linkVideoBounds,
  MEDIA_BUSINESS_ENABLED_KEY,
  MEDIA_IMAGE_BATCH_KEY,
  MEDIA_IMAGES_ENABLED_KEY,
  MEDIA_LINK_SCRAPE_ENABLED_KEY,
  MEDIA_VIDEO_ENABLED_KEY,
  mediaClaimFilter,
  setMediaBusinessEnabled,
  setMediaImageBatch,
  setMediaImagesEnabled,
  setMediaLinkScrapeEnabled,
  setMediaVideoEnabled,
  transcriptClaimFilter,
} from "./switches.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-switches-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("defaults", () => {
  it("reads images, and nothing else, on a fresh install", () => {
    expect(getMediaImagesEnabled()).toBe(true);
    expect(getMediaVideoEnabled()).toBe(false);
    expect(getMediaBusinessEnabled()).toBe(false);
    expect(getMediaLinkScrapeEnabled()).toBe(false);
  });

  it("a value that is neither 1 nor 0 does not flip a default-off switch on", () => {
    for (const key of [
      MEDIA_VIDEO_ENABLED_KEY,
      MEDIA_BUSINESS_ENABLED_KEY,
      MEDIA_LINK_SCRAPE_ENABLED_KEY,
    ]) {
      appStateSet(key, "true");
    }
    expect(getMediaVideoEnabled()).toBe(false);
    expect(getMediaBusinessEnabled()).toBe(false);
    expect(getMediaLinkScrapeEnabled()).toBe(false);

    appStateSet(MEDIA_IMAGES_ENABLED_KEY, "true");
    expect(getMediaImagesEnabled()).toBe(true);
  });
});

describe("round trip", () => {
  it("each switch persists both ways", () => {
    setMediaImagesEnabled(false);
    setMediaVideoEnabled(true);
    setMediaBusinessEnabled(true);
    setMediaLinkScrapeEnabled(true);
    expect(getMediaImagesEnabled()).toBe(false);
    expect(getMediaVideoEnabled()).toBe(true);
    expect(getMediaBusinessEnabled()).toBe(true);
    expect(getMediaLinkScrapeEnabled()).toBe(true);

    setMediaImagesEnabled(true);
    setMediaVideoEnabled(false);
    setMediaBusinessEnabled(false);
    setMediaLinkScrapeEnabled(false);
    expect(getMediaImagesEnabled()).toBe(true);
    expect(getMediaVideoEnabled()).toBe(false);
    expect(getMediaBusinessEnabled()).toBe(false);
    expect(getMediaLinkScrapeEnabled()).toBe(false);
  });
});

describe("image batch size", () => {
  it("defaults to the measured size and round-trips", () => {
    expect(getMediaImageBatch()).toBe(DEFAULT_IMAGE_BATCH);
    setMediaImageBatch(6);
    expect(getMediaImageBatch()).toBe(6);
  });

  it("a nonsense value is the default, not a batch of zero", () => {
    // The value lives under the V2 key now (arch §10.1); these getters are the
    // media panel's spelling of it.
    for (const raw of ["", "lots", "0", "-4"]) {
      appStateSet(ENRICHMENT_IMAGE_BATCH_SIZE_KEY, raw);
      expect(getMediaImageBatch()).toBe(DEFAULT_IMAGE_BATCH);
    }
  });

  it("the legacy media.image_batch key no longer steers the reader", () => {
    appStateSet(MEDIA_IMAGE_BATCH_KEY, "31");
    expect(getMediaImageBatch()).toBe(DEFAULT_IMAGE_BATCH);
  });

  it("is capped, so one call is never asked to hold apart more than it can", () => {
    setMediaImageBatch(500);
    expect(getMediaImageBatch()).toBe(MAX_IMAGE_BATCH);
  });
});

describe("mediaClaimFilter", () => {
  it("mirrors the switches, and always claims documents", () => {
    expect(mediaClaimFilter()).toEqual({
      images: true,
      video: false,
      documents: true,
      business: false,
    });

    setMediaVideoEnabled(true);
    setMediaBusinessEnabled(true);
    setMediaImagesEnabled(false);
    expect(mediaClaimFilter()).toEqual({
      images: false,
      video: true,
      documents: true,
      business: true,
    });
  });
});

describe("transcriptClaimFilter", () => {
  it("claims both kinds on a fresh install — whisper costs no tokens (v6 §6)", () => {
    expect(transcriptClaimFilter()).toEqual({
      voiceNotes: true,
      videoAudio: true,
      business: false,
    });
    expect(anyTranscriptionEnabled()).toBe(true);
  });

  it("voice notes and video audio gate independently", () => {
    setMediaVideoAudioEnabled(false);
    expect(transcriptClaimFilter()).toMatchObject({
      voiceNotes: true,
      videoAudio: false,
    });
    expect(anyTranscriptionEnabled()).toBe(true);

    setMediaVoiceNotesEnabled(false);
    setMediaVideoAudioEnabled(true);
    expect(transcriptClaimFilter()).toMatchObject({
      voiceNotes: false,
      videoAudio: true,
    });
    expect(anyTranscriptionEnabled()).toBe(true);
  });

  it("has a step only while one of them is on", () => {
    setMediaVoiceNotesEnabled(false);
    setMediaVideoAudioEnabled(false);
    expect(anyTranscriptionEnabled()).toBe(false);
  });

  it("carries the business switch, same as the media claim", () => {
    setMediaBusinessEnabled(true);
    expect(transcriptClaimFilter().business).toBe(true);
  });
});

describe("frameSampling", () => {
  it("is off with the spec's bounds on a fresh install", () => {
    expect(frameSampling()).toEqual({
      enabled: false,
      intervalSec: DEFAULT_VIDEO_FRAME_INTERVAL_SEC,
      maxFrames: DEFAULT_VIDEO_FRAME_MAX,
    });
  });

  it("reads the bounds fresh, so a Settings change lands on the next video", () => {
    setMediaVideoFramesEnabled(true);
    setMediaVideoFrameIntervalSec(10);
    setMediaVideoFrameMax(3);
    expect(frameSampling()).toEqual({
      enabled: true,
      intervalSec: 10,
      maxFrames: 3,
    });
  });
});

describe("linkVideoBounds", () => {
  it("answers to the video controls a local clip already answers to", () => {
    expect(linkVideoBounds("wa:x/y")).toEqual({
      eventId: "wa:x/y",
      frames: false,
      intervalSec: DEFAULT_VIDEO_FRAME_INTERVAL_SEC,
      maxFrames: DEFAULT_VIDEO_FRAME_MAX,
      audio: true,
      maxHeight: DEFAULT_VIDEO_MAX_HEIGHT,
    });

    // Turning video frames off has to turn them off for a linked clip too —
    // v7 §4 asks for the existing controls, not a second set beside them.
    setMediaVideoFramesEnabled(true);
    setMediaVideoFrameMax(2);
    setMediaVideoAudioEnabled(false);
    setMediaVideoMaxHeight(720);
    expect(linkVideoBounds("wa:x/y")).toMatchObject({
      frames: true,
      maxFrames: 2,
      audio: false,
      maxHeight: 720,
    });
  });
});
