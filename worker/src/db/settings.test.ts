// ===========================================================================
// Unit tests for db/settings.ts over a real temp SQLite DB: a temp DB per test,
// migrations fresh. Moved here from store/ when store.ts was deleted (V2 §3.2);
// the assertions are the ones that guarded these switches there.
//
// Two things are under test and neither is cosmetic:
//
//   - Default POLARITY. A setting that ships ON must read on when its row is
//     absent; a setting that costs tokens or sends observable traffic must read
//     off. The two differ only on the unset row, which is exactly the row a
//     fresh install has.
//   - The stored KEY NAMES, because they are the persisted contract.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "./connection.js";
import { runMigrations } from "./index.js";
import {
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_MEDIA_RATE_PER_MIN,
  DEFAULT_VIDEO_FRAME_INTERVAL_SEC,
  DEFAULT_VIDEO_FRAME_MAX,
  DEFAULT_VIDEO_MAX_HEIGHT,
  DEFAULT_WHISPER_MODEL,
  DEBUG_EXPORT_KEY,
  getAllSelectedModels,
  getDebugExportEnabled,
  getMediaBackfillEnabled,
  getMediaBusinessEnabled,
  getMediaConcurrency,
  getMediaDescribeEnabled,
  getMediaImagesEnabled,
  getMediaLinkScrapeEnabled,
  getMediaRatePerMin,
  getMediaVideoAudioEnabled,
  getMediaVideoEnabled,
  getMediaVideoFrameIntervalSec,
  getMediaVideoFrameMax,
  getMediaVideoFramesEnabled,
  getMediaVideoMaxHeight,
  getMediaVoiceNotesEnabled,
  getMediaWhisperModel,
  getNotificationsEnabled,
  getProcessEnabled,
  getSelectedModel,
  getSemanticRetrievalPreference,
  MAX_MEDIA_CONCURRENCY,
  MAX_VIDEO_FRAME_MAX,
  MAX_VIDEO_MAX_HEIGHT,
  MEDIA_BUSINESS_ENABLED_KEY,
  MEDIA_CONCURRENCY_KEY,
  MEDIA_IMAGES_ENABLED_KEY,
  MEDIA_LINK_SCRAPE_ENABLED_KEY,
  MEDIA_RATE_PER_MIN_KEY,
  MEDIA_VIDEO_AUDIO_ENABLED_KEY,
  MEDIA_VIDEO_ENABLED_KEY,
  MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY,
  MEDIA_VIDEO_FRAME_MAX_KEY,
  MEDIA_VIDEO_FRAMES_ENABLED_KEY,
  MEDIA_VIDEO_MAX_HEIGHT_KEY,
  MEDIA_VOICE_NOTES_ENABLED_KEY,
  MEDIA_WHISPER_MODEL_KEY,
  MIN_VIDEO_MAX_HEIGHT,
  MODEL_KEY,
  setDebugExportEnabled,
  setMediaBackfillEnabled,
  setMediaBusinessEnabled,
  setMediaConcurrency,
  setMediaDescribeEnabled,
  setMediaImagesEnabled,
  setMediaLinkScrapeEnabled,
  setMediaRatePerMin,
  setMediaVideoAudioEnabled,
  setMediaVideoEnabled,
  setMediaVideoFrameIntervalSec,
  setMediaVideoFrameMax,
  setMediaVideoFramesEnabled,
  setMediaVideoMaxHeight,
  setMediaVoiceNotesEnabled,
  setMediaWhisperModel,
  setNotificationsEnabled,
  setProcessEnabled,
  setSelectedModel,
  setSemanticRetrievalEnabled,
} from "./settings.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-settings-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a raw app_state row (used to seed garbage / legacy values). */
function setRawState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function storedState(): Record<string, string> {
  return Object.fromEntries(
    (
      getDb().prepare(`SELECT key, value FROM app_state`).all() as {
        key: string;
        value: string;
      }[]
    ).map((r) => [r.key, r.value]),
  );
}

describe("media reader settings", () => {
  it("both switches default ON", () => {
    expect(getMediaDescribeEnabled()).toBe(true);
    expect(getMediaBackfillEnabled()).toBe(true);
  });

  it("each switch round-trips independently", () => {
    setMediaDescribeEnabled(false);
    expect(getMediaDescribeEnabled()).toBe(false);
    expect(getMediaBackfillEnabled()).toBe(true);

    setMediaBackfillEnabled(false);
    setMediaDescribeEnabled(true);
    expect(getMediaDescribeEnabled()).toBe(true);
    expect(getMediaBackfillEnabled()).toBe(false);
  });

  it("the throttle defaults to 20/min and round-trips", () => {
    expect(getMediaRatePerMin()).toBe(DEFAULT_MEDIA_RATE_PER_MIN);
    setMediaRatePerMin(5);
    expect(getMediaRatePerMin()).toBe(5);
  });

  it("a garbage or non-positive stored throttle reads as the default", () => {
    setRawState(MEDIA_RATE_PER_MIN_KEY, "not-a-number");
    expect(getMediaRatePerMin()).toBe(DEFAULT_MEDIA_RATE_PER_MIN);
    setRawState(MEDIA_RATE_PER_MIN_KEY, "0");
    expect(getMediaRatePerMin()).toBe(DEFAULT_MEDIA_RATE_PER_MIN);
  });

  it("concurrency defaults to five and round-trips", () => {
    expect(getMediaConcurrency()).toBe(DEFAULT_MEDIA_CONCURRENCY);
    setMediaConcurrency(3);
    expect(getMediaConcurrency()).toBe(3);
  });

  it("a garbage or non-positive concurrency reads as the default, never zero", () => {
    // Zero slots is a queue that never runs, which is not a setting anyone can
    // have meant by typing it.
    for (const raw of ["", "five", "0", "-2"]) {
      setRawState(MEDIA_CONCURRENCY_KEY, raw);
      expect(getMediaConcurrency()).toBe(DEFAULT_MEDIA_CONCURRENCY);
    }
  });

  it("concurrency is capped — the window cannot be spent all at once", () => {
    setMediaConcurrency(500);
    expect(getMediaConcurrency()).toBe(MAX_MEDIA_CONCURRENCY);
  });
});

describe("per-kind media switches", () => {
  it("images default ON and the other three default OFF", () => {
    expect(getMediaImagesEnabled()).toBe(true);
    expect(getMediaVideoEnabled()).toBe(false);
    expect(getMediaBusinessEnabled()).toBe(false);
    expect(getMediaLinkScrapeEnabled()).toBe(false);
  });

  it("each switch round-trips independently", () => {
    setMediaVideoEnabled(true);
    expect(getMediaVideoEnabled()).toBe(true);
    expect(getMediaBusinessEnabled()).toBe(false);
    expect(getMediaLinkScrapeEnabled()).toBe(false);

    setMediaBusinessEnabled(true);
    setMediaLinkScrapeEnabled(true);
    setMediaImagesEnabled(false);
    setMediaVideoEnabled(false);
    expect(getMediaImagesEnabled()).toBe(false);
    expect(getMediaVideoEnabled()).toBe(false);
    expect(getMediaBusinessEnabled()).toBe(true);
    expect(getMediaLinkScrapeEnabled()).toBe(true);
  });

  it("reads a stored value that is neither 0 nor 1 as off, not on", () => {
    // The polarity trap: the ON-by-default getters treat anything but "0" as
    // on, which for these three would ship a reading the user never asked for.
    for (const key of [
      MEDIA_VIDEO_ENABLED_KEY,
      MEDIA_BUSINESS_ENABLED_KEY,
      MEDIA_LINK_SCRAPE_ENABLED_KEY,
    ]) {
      setRawState(key, "");
    }
    expect(getMediaVideoEnabled()).toBe(false);
    expect(getMediaBusinessEnabled()).toBe(false);
    expect(getMediaLinkScrapeEnabled()).toBe(false);
  });

  it("writes each switch under its spec key name", () => {
    setMediaImagesEnabled(false);
    setMediaVideoEnabled(true);
    setMediaBusinessEnabled(true);
    setMediaLinkScrapeEnabled(true);
    const stored = storedState();
    expect(stored[MEDIA_IMAGES_ENABLED_KEY]).toBe("0");
    expect(stored[MEDIA_VIDEO_ENABLED_KEY]).toBe("1");
    expect(stored[MEDIA_BUSINESS_ENABLED_KEY]).toBe("1");
    expect(stored[MEDIA_LINK_SCRAPE_ENABLED_KEY]).toBe("1");
  });
});

describe("video frames and transcription settings", () => {
  it("transcription is on and frames are off on a fresh install (v6 §6)", () => {
    // The two are split on cost, not on kind: whisper is local and costs no
    // tokens, a sampled frame is another image in a model call.
    expect(getMediaVoiceNotesEnabled()).toBe(true);
    expect(getMediaVideoAudioEnabled()).toBe(true);
    expect(getMediaVideoFramesEnabled()).toBe(false);
  });

  it("only an explicit 0 turns transcription off", () => {
    for (const key of [MEDIA_VIDEO_AUDIO_ENABLED_KEY, MEDIA_VOICE_NOTES_ENABLED_KEY]) {
      for (const raw of ["", "true", "yes", "on"]) setRawState(key, raw);
    }
    expect(getMediaVideoAudioEnabled()).toBe(true);
    expect(getMediaVoiceNotesEnabled()).toBe(true);

    setMediaVideoAudioEnabled(false);
    setMediaVoiceNotesEnabled(false);
    expect(getMediaVideoAudioEnabled()).toBe(false);
    expect(getMediaVoiceNotesEnabled()).toBe(false);
  });

  it("a stored frames value that is neither 0 nor 1 reads as off, not on", () => {
    // The polarity trap: ON-by-default is right for the two above and wrong
    // here — it would ship frame sampling on, at tokens nobody asked to spend.
    for (const raw of ["", "true", "yes", "on"]) {
      setRawState(MEDIA_VIDEO_FRAMES_ENABLED_KEY, raw);
      expect(getMediaVideoFramesEnabled()).toBe(false);
    }
  });

  it("voice notes and video audio move independently", () => {
    setMediaVideoAudioEnabled(false);
    expect(getMediaVoiceNotesEnabled()).toBe(true);
    expect(getMediaVideoAudioEnabled()).toBe(false);

    setMediaVideoAudioEnabled(true);
    setMediaVoiceNotesEnabled(false);
    expect(getMediaVoiceNotesEnabled()).toBe(false);
    expect(getMediaVideoAudioEnabled()).toBe(true);
  });

  it("the frame bounds default to 5s and 8 frames, and round-trip", () => {
    expect(getMediaVideoFrameIntervalSec()).toBe(DEFAULT_VIDEO_FRAME_INTERVAL_SEC);
    expect(getMediaVideoFrameMax()).toBe(DEFAULT_VIDEO_FRAME_MAX);
    setMediaVideoFrameIntervalSec(10);
    setMediaVideoFrameMax(3);
    expect(getMediaVideoFrameIntervalSec()).toBe(10);
    expect(getMediaVideoFrameMax()).toBe(3);
  });

  it("a garbage or non-positive frame bound reads as the default", () => {
    for (const raw of ["", "lots", "0", "-4"]) {
      setRawState(MEDIA_VIDEO_FRAME_INTERVAL_SEC_KEY, raw);
      setRawState(MEDIA_VIDEO_FRAME_MAX_KEY, raw);
      expect(getMediaVideoFrameIntervalSec()).toBe(DEFAULT_VIDEO_FRAME_INTERVAL_SEC);
      expect(getMediaVideoFrameMax()).toBe(DEFAULT_VIDEO_FRAME_MAX);
    }
  });

  it("the frame count is capped — one call cannot be handed 200 stills", () => {
    setMediaVideoFrameMax(200);
    expect(getMediaVideoFrameMax()).toBe(MAX_VIDEO_FRAME_MAX);
  });

  it("the download height defaults to 480p and round-trips", () => {
    expect(getMediaVideoMaxHeight()).toBe(DEFAULT_VIDEO_MAX_HEIGHT);
    setMediaVideoMaxHeight(720);
    expect(getMediaVideoMaxHeight()).toBe(720);
    for (const raw of ["", "tall", "0", "-4"]) {
      setRawState(MEDIA_VIDEO_MAX_HEIGHT_KEY, raw);
      expect(getMediaVideoMaxHeight()).toBe(DEFAULT_VIDEO_MAX_HEIGHT);
    }
  });

  it("the download height is clamped at BOTH ends", () => {
    setMediaVideoMaxHeight(4320);
    expect(getMediaVideoMaxHeight()).toBe(MAX_VIDEO_MAX_HEIGHT);
    // Under the floor no site publishes a matching format at all, and every
    // download would silently fall through to whatever it calls "worst".
    setMediaVideoMaxHeight(2);
    expect(getMediaVideoMaxHeight()).toBe(MIN_VIDEO_MAX_HEIGHT);
  });

  it("the whisper model defaults to the one bundled in the .app", () => {
    expect(getMediaWhisperModel()).toBe(DEFAULT_WHISPER_MODEL);
    setMediaWhisperModel("small");
    expect(getMediaWhisperModel()).toBe("small");
    // A blank selection is not a model id; it is nothing chosen.
    setRawState(MEDIA_WHISPER_MODEL_KEY, "   ");
    expect(getMediaWhisperModel()).toBe(DEFAULT_WHISPER_MODEL);
  });

  it("writes each setting under its spec key name", () => {
    setMediaVideoFramesEnabled(true);
    setMediaVideoAudioEnabled(true);
    setMediaVoiceNotesEnabled(true);
    setMediaVideoFrameIntervalSec(7);
    setMediaVideoFrameMax(4);
    setMediaWhisperModel("medium-q5_0");
    const stored = storedState();
    expect(stored["media.video_frames_enabled"]).toBe("1");
    expect(stored["media.video_audio_enabled"]).toBe("1");
    expect(stored["media.voice_notes_enabled"]).toBe("1");
    expect(stored["media.video_frame_interval_sec"]).toBe("7");
    expect(stored["media.video_frame_max"]).toBe("4");
    expect(stored["media.whisper_model"]).toBe("medium-q5_0");
  });
});

describe("notifications and semantic retrieval", () => {
  it("notifications default ON and round-trip", () => {
    expect(getNotificationsEnabled()).toBe(true);
    setNotificationsEnabled(false);
    expect(getNotificationsEnabled()).toBe(false);
  });

  it("an unset semantic preference is null, not false", () => {
    // Null is "the user never chose"; embedder.ts is the caller that knows
    // whether the weights are on disk and is entitled to pick a default.
    expect(getSemanticRetrievalPreference()).toBeNull();
    setSemanticRetrievalEnabled(false);
    expect(getSemanticRetrievalPreference()).toBe(false);
    setSemanticRetrievalEnabled(true);
    expect(getSemanticRetrievalPreference()).toBe(true);
  });
});

describe("debug export (V2 §3.2)", () => {
  it("is OFF on a fresh install — the brain folder is not a product surface", () => {
    expect(getDebugExportEnabled()).toBe(false);
  });

  it("round-trips and stores under settings.debug_export", () => {
    setDebugExportEnabled(true);
    expect(getDebugExportEnabled()).toBe(true);
    expect(storedState()[DEBUG_EXPORT_KEY]).toBe("1");
    setDebugExportEnabled(false);
    expect(getDebugExportEnabled()).toBe(false);
  });

  it("reads a stored value that is neither 0 nor 1 as off", () => {
    for (const raw of ["", "true", "yes", "on"]) {
      setRawState(DEBUG_EXPORT_KEY, raw);
      expect(getDebugExportEnabled()).toBe(false);
    }
  });
});

describe("per-role selected-model store", () => {
  it("defaults the chat role to the empty string when unset", () => {
    expect(getSelectedModel("chat")).toBe("");
  });

  it("round-trips a set value", () => {
    setSelectedModel("chat", "claude-opus-4-8");
    expect(getSelectedModel("chat")).toBe("claude-opus-4-8");
  });

  it("overwrites a prior selection", () => {
    setSelectedModel("chat", "opus");
    setSelectedModel("chat", "haiku");
    expect(getSelectedModel("chat")).toBe("haiku");
  });

  it("storing the empty string represents the default again", () => {
    setSelectedModel("chat", "opus");
    setSelectedModel("chat", "");
    expect(getSelectedModel("chat")).toBe("");
  });

  it("defaults the media role to Haiku when unset", () => {
    expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
  });

  it("round-trips a media selection, and clearing it restores the Haiku default", () => {
    setSelectedModel("media", "sonnet");
    expect(getSelectedModel("media")).toBe("sonnet");
    setSelectedModel("media", "");
    expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
  });

  it("the roles are independent", () => {
    setSelectedModel("chat", "opus");
    expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
    setSelectedModel("media", "haiku");
    expect(getSelectedModel("chat")).toBe("opus");
  });

  it("getAllSelectedModels returns every role", () => {
    setSelectedModel("chat", "opus");
    expect(getAllSelectedModels()).toEqual({
      chat: "opus",
      media: "claude-haiku-4-5-20251001",
    });
  });

  describe("legacy migration fallback", () => {
    it("returns the legacy single-model value for chat when no per-role value is set", () => {
      setRawState(MODEL_KEY, "claude-opus-4-8");
      expect(getSelectedModel("chat")).toBe("claude-opus-4-8");
    });

    it("a per-role value takes precedence over the legacy value", () => {
      setRawState(MODEL_KEY, "claude-opus-4-8");
      setSelectedModel("chat", "haiku");
      expect(getSelectedModel("chat")).toBe("haiku");
    });

    it("the legacy value belongs to chat alone — media keeps its own default", () => {
      setRawState(MODEL_KEY, "claude-opus-4-8");
      expect(getSelectedModel("media")).toBe("claude-haiku-4-5-20251001");
    });

    it("getAllSelectedModels reflects the legacy fallback", () => {
      setRawState(MODEL_KEY, "opus");
      expect(getAllSelectedModels()).toEqual({
        chat: "opus",
        media: "claude-haiku-4-5-20251001",
      });
    });
  });
});

describe("per-process switches", () => {
  it("default ON and move per role", () => {
    expect(getProcessEnabled("chat")).toBe(true);
    expect(getProcessEnabled("media")).toBe(true);
    setProcessEnabled("media", false);
    expect(getProcessEnabled("media")).toBe(false);
    expect(getProcessEnabled("chat")).toBe(true);
    expect(storedState()["process_enabled_media"]).toBe("0");
  });
});
