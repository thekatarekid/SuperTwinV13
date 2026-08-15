// ===========================================================================
// The rule v5 §3 exists for: whisper answers silence and music with fluent,
// confident, invented text, and once that text is stored nothing downstream can
// tell it from something somebody said — not the row, not events_fts, not the
// context block a chat turn is grounded on.
//
// Every other transcription test stubs one layer of this. Here neither the
// transcriber nor the queue is stubbed: a stub whisper-cli answers the real
// transcribeMedia running inside a real MediaQueue against a real DB, so what is
// asserted is what a voice note actually leaves behind — that the verdict is
// 'unsupported', that the invented sentence is in no column, that it never
// became a description, and that a chat turn cannot retrieve it.
//
// The control case at the end is not decoration. Every "nothing was stored"
// assertion above it would pass just as happily on a pipeline that never ran,
// and a guard proven only by a pipeline that does nothing is not proven at all.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { insertEvent, upsertSource } from "../db/ingest.js";
import { searchEventHits } from "../server/chat-grounding.js";
import {
  setMediaRatePerMin,
  setMediaVoiceNotesEnabled,
  setMediaWhisperModel,
} from "../store/store.js";
import type { DescribeBatchResult, DescribeResult } from "./describe.js";
import { MediaQueue } from "./queue.js";
import { whisperModelsDir } from "./tools.js";

let tmpDir: string;
let queue: MediaQueue | null = null;
/** Ids the description reader was handed — the transcriber's must never be one. */
let described: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-hallucination-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_MEDIA_DIR = join(tmpDir, "media");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  mkdirSync(join(tmpDir, "media"), { recursive: true });
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  described = [];

  setMediaVoiceNotesEnabled(true);
  // Real timers, because the children are real processes: the throttle has to
  // be short enough that settle() is not sitting through it.
  setMediaRatePerMin(600);
  mkdirSync(whisperModelsDir(), { recursive: true });
  writeFileSync(join(whisperModelsDir(), "ggml-small.bin"), "model");
  setMediaWhisperModel("small");
});

afterEach(() => {
  queue?.stop();
  queue = null;
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_MEDIA_DIR;
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  delete process.env.SUPERTWIN_WHISPER_BIN;
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * An ffmpeg that reports `durationSec` when probed and decodes an audibly loud
 * WAV, so the silence guard passes and whisper is actually asked.
 */
function stubFfmpeg(durationSec: number): void {
  const path = join(tmpDir, "ffmpeg");
  const mm = String(Math.floor(durationSec / 60)).padStart(2, "0");
  const ss = String(durationSec % 60).padStart(2, "0");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const out = process.argv[process.argv.length - 1];
if (!out.endsWith(".wav")) {
  process.stderr.write("  Duration: 00:${mm}:${ss}.00, start: 0.0\\n");
  process.exit(1);
}
fs.writeFileSync(out, "riff");
process.stderr.write("[Parsed_volumedetect_0 @ 0x1] max_volume: -3.0 dB\\n");
`,
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_FFMPEG_BIN = path;
}

/** A whisper-cli that answers every file with `text`. */
function stubWhisper(text: string): void {
  const path = join(tmpDir, "whisper-cli");
  writeFileSync(
    path,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(` ${text}\n`)});
`,
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_WHISPER_BIN = path;
}

/** A pending voice note with a real file behind it. */
function seedVoiceNote(): string {
  const mediaPath = join(tmpDir, "media", "VOICE.ogg");
  writeFileSync(mediaPath, "opus");
  return insertEvent({
    externalId: "voice",
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId: null,
    actorId: null,
    ts: "2026-07-02T10:00:00.000Z",
    kind: "audio",
    // Empty on purpose: the transcript is then the only thing that could put
    // any of these words into the row or the index.
    text: "",
    mediaPath,
    rawJson: null,
    mediaMime: "audio/ogg; codecs=opus",
    mediaSeconds: 12,
    mediaMetaJson: JSON.stringify({ voice: true }),
  }).id;
}

interface StoredRow {
  transcript: string | null;
  transcript_status: string | null;
  transcript_error: string | null;
  media_description: string | null;
  media_desc_status: string | null;
}

function stored(id: string): StoredRow {
  return getDb()
    .prepare(
      `SELECT transcript, transcript_status, transcript_error,
              media_description, media_desc_status
         FROM events WHERE id = ?`,
    )
    .get(id) as StoredRow;
}

/** Rows the full-text index would return for a search — any column of it. */
function ftsHits(match: string): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH ?`)
      .get(match) as { n: number }
  ).n;
}

const READ: DescribeResult = {
  description: "a description of something else entirely",
  status: "done",
  model: "haiku",
  error: null,
};

/**
 * Run the real queue until the row leaves 'pending'. The description reader is
 * the only stub, and only so that being called at all is observable.
 */
async function settle(id: string): Promise<StoredRow> {
  queue = new MediaQueue({
    describe: async (row) => {
      described.push(row.id);
      return READ;
    },
    describeBatch: async (rows): Promise<DescribeBatchResult> => {
      const results = new Map<string, DescribeResult>();
      for (const row of rows) {
        described.push(row.id);
        results.set(row.id, READ);
      }
      return { results, call: READ };
    },
  });
  queue.start();

  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = stored(id);
    if (row.transcript_status !== "pending") return row;
    if (Date.now() > deadline) {
      throw new Error(
        `${id} never settled; last error: ${row.transcript_error ?? "none"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a whisper answer that cannot be believed", () => {
  it("one phrase repeated is unsupported, is stored nowhere, and is unsearchable", async () => {
    stubFfmpeg(12);
    stubWhisper(
      "Subscribe to my channel. Subscribe to my channel." +
        " Subscribe to my channel. Subscribe to my channel.",
    );
    const id = seedVoiceNote();

    const row = await settle(id);

    expect(row.transcript).toBeNull();
    expect(row.transcript_status).toBe("unsupported");
    expect(row.transcript_error).toMatch(/the same phrase repeated 4 times/);

    // The other half of the rule. A transcript is not a description, and a
    // rejected one is not a description either: the column is untouched, and
    // the reader that writes it was never handed this row.
    expect(row.media_description).toBeNull();
    expect(row.media_desc_status).toBe("unsupported");
    expect(described).toEqual([]);

    // And nothing whisper made up is findable, so it cannot arrive in a chat
    // turn's context block reading exactly like something that was said.
    expect(ftsHits('"subscribe"')).toBe(0);
    expect(searchEventHits("who said subscribe to my channel")).toEqual([]);
  });

  it("an answer that is only whisper's silence marker is unsupported too", async () => {
    stubFfmpeg(12);
    stubWhisper("[BLANK_AUDIO]");
    const id = seedVoiceNote();

    const row = await settle(id);

    expect(row.transcript).toBeNull();
    expect(row.transcript_status).toBe("unsupported");
    expect(row.transcript_error).toBe("only non-speech markers");
    expect(row.media_description).toBeNull();
    expect(described).toEqual([]);
  });

  it("control: speech IS stored, and IS retrievable — the guard is not a mute", async () => {
    stubFfmpeg(12);
    stubWhisper("Haan bhai, kal shaam paanch baje ghar aa jaunga.");
    const id = seedVoiceNote();

    const row = await settle(id);

    expect(row.transcript).toBe("Haan bhai, kal shaam paanch baje ghar aa jaunga.");
    expect(row.transcript_status).toBe("done");
    expect(row.transcript_error).toBeNull();
    // Still not a description — that column belongs to the model, not whisper.
    expect(row.media_description).toBeNull();

    expect(ftsHits('"baje"')).toBe(1);
    expect(searchEventHits("kab aa rahe ho shaam paanch baje").map((h) => h.id)).toEqual([id]);
  });
});
