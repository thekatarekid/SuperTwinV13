// ===========================================================================
// Transcription tests (vitest). ffmpeg and whisper-cli are stub scripts that
// record their argv, so the assertions are about the actual command lines: that
// `-l auto` is passed (the flag defaults to `en`, so silence about language IS
// forced English), that the WAV is 16 kHz mono, and that a filename somebody
// else chose reaches the child as one argv element.
//
// The hallucination rules get the most attention here, because they are the
// only thing standing between a silent recording and a confident invented
// sentence sitting in the search index looking exactly like something that was
// said. degenerateReason is tested directly on synthetic transcripts, and the
// end-to-end path is tested with a stub whisper that returns one.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import type { PendingTranscriptRow } from "../db/ingest.js";
import { setMediaWhisperModel } from "../db/settings.js";
import { whisperModelsDir } from "./tools.js";
import {
  degenerateReason,
  parseMaxVolumeDb,
  planChunks,
  sparseReason,
  transcribeMedia,
} from "./transcribe.js";

let tmpDir: string;
let mediaDir: string;
let calls: string;
let audio: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-transcribe-"));
  mediaDir = join(tmpDir, "media", "chat");
  mkdirSync(mediaDir, { recursive: true });
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  calls = join(tmpDir, "calls.jsonl");
  audio = join(mediaDir, "MSGID.ogg");
  writeFileSync(audio, "opus");
  // The bundled model resolves out of the .app in production; here it is a
  // file under the downloads dir, which is the same resolution path.
  mkdirSync(whisperModelsDir(), { recursive: true });
  writeFileSync(join(whisperModelsDir(), "ggml-small.bin"), "model");
  setMediaWhisperModel("small");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  delete process.env.SUPERTWIN_WHISPER_BIN;
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * An ffmpeg that records its argv, reports `duration` when probing, writes the
 * requested WAV, and claims `maxDb` for its level.
 */
function stubFfmpeg(
  opts: { duration?: string; maxDb?: number; noAudio?: boolean } = {},
): void {
  const path = join(tmpDir, "ffmpeg");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["ffmpeg", ...argv]) + "\\n");
const out = argv[argv.length - 1];
if (!out.endsWith(".wav")) {
  ${opts.duration ? `process.stderr.write("  Duration: ${opts.duration}, start: 0.0\\n");` : ""}
  process.exit(1);
}
${
  opts.noAudio
    ? `process.stderr.write("Output file does not contain any stream\\n");
process.exit(1);`
    : `fs.writeFileSync(out, "riff");
process.stderr.write("[Parsed_volumedetect_0 @ 0x1] mean_volume: -30.0 dB\\n");
process.stderr.write("[Parsed_volumedetect_0 @ 0x1] max_volume: ${opts.maxDb ?? -3}.0 dB\\n");`
}
`,
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_FFMPEG_BIN = path;
}

/** A whisper-cli that records its argv and prints `text` (or the Nth of them). */
function stubWhisper(text: string | string[], failAt = -1): void {
  const path = join(tmpDir, "whisper-cli");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["whisper", ...argv]) + "\\n");
const texts = ${JSON.stringify(Array.isArray(text) ? text : [text])};
const n = fs.readFileSync(${JSON.stringify(calls)}, "utf8").split("\\n")
  .filter((l) => l.startsWith('["whisper"')).length - 1;
if (n === ${failAt}) { process.stderr.write("failed to decode\\n"); process.exit(3); }
process.stdout.write(" " + (texts[n] ?? texts[texts.length - 1]));
`,
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_WHISPER_BIN = path;
}

function argvOf(): string[][] {
  return readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function whisperCalls(): string[][] {
  return argvOf().filter((c) => c[0] === "whisper");
}

/** Three chunks' worth of speech, dense enough for the 30s each covers. */
const THIRDS = [
  "pehla hissa yahan par hai",
  "doosra hissa yahan par hai",
  "teesra hissa yahan par hai",
];

function row(over: Partial<PendingTranscriptRow> = {}): PendingTranscriptRow {
  return {
    id: "wa:v1",
    kind: "audio",
    mediaPath: audio,
    mime: "audio/ogg",
    filename: "PTT.ogg",
    seconds: 12,
    voice: true,
    ...over,
  };
}

describe("degenerateReason", () => {
  it("passes ordinary speech, in any script", () => {
    expect(
      degenerateReason(
        "Haan bhai, main kal shaam paanch baje aa jaunga. Ghar pe hi rehna," +
          " kuch saamaan bhi lekar aaunga. Papa ko bol dena.",
      ),
    ).toBeNull();
    expect(
      degenerateReason("नमस्ते, मैं कल शाम को आपके घर आऊंगा। कृपया पुष्टि करें।"),
    ).toBeNull();
  });

  it("catches an empty answer", () => {
    expect(degenerateReason("")).toBe("whisper returned no text");
    expect(degenerateReason("   \n  ")).toBe("whisper returned no text");
  });

  it("catches an answer that is only whisper's non-speech markers", () => {
    expect(degenerateReason("[BLANK_AUDIO]")).toBe("only non-speech markers");
    expect(degenerateReason("[MUSIC] (upbeat music) *laughs*")).toBe(
      "only non-speech markers",
    );
  });

  it("catches one phrase repeated — the shape it takes on music", () => {
    const reason = degenerateReason(
      "Subscribe to my channel. Subscribe to my channel. Subscribe to my channel." +
        " Subscribe to my channel.",
    );
    expect(reason).toMatch(/the same phrase repeated 4 times/);
  });

  it("catches a repeated phrase through punctuation and casing changes", () => {
    expect(
      degenerateReason("Thank you! thank you. Thank you? THANK YOU."),
    ).toMatch(/the same phrase repeated/);
  });

  it("catches a small set of phrases cycling", () => {
    expect(
      degenerateReason(
        "Okay. Right. Okay. Right. Okay. Right. Okay. Right. Okay. Right.",
      ),
    ).toMatch(/2 distinct phrases in 10/);
  });

  it("catches a single word held down", () => {
    expect(degenerateReason("you you you you you you you you you")).toMatch(
      /only 1 distinct word in 9/,
    );
  });

  it("catches an n-gram loop with no sentence breaks at all", () => {
    const loop = Array.from({ length: 12 }, () => "the quick brown fox jumps").join(" ");
    expect(degenerateReason(loop)).toMatch(/distinct 4-grams/);
  });

  it("does not fire on a short genuine utterance", () => {
    expect(degenerateReason("Haan haan theek hai.")).toBeNull();
    expect(degenerateReason("Ok.")).toBeNull();
    expect(degenerateReason("Thank you so much bhai.")).toBeNull();
  });

  it("does not fire on real speech that repeats a phrase twice", () => {
    expect(
      degenerateReason(
        "Main aa raha hoon. Bas dus minute. Main aa raha hoon. Tum ready rehna" +
          " please, der ho jayegi warna.",
      ),
    ).toBeNull();
  });
});

describe("sparseReason", () => {
  it("catches the shape music produces — measured, not supposed", () => {
    // Thirty seconds of a tone and thirty seconds of pink noise both came back
    // from the bundled model as "Thank you." Nothing about those two words is
    // structurally wrong; what is wrong is that they are all of half a minute.
    expect(sparseReason("Thank you.", 30)).toBe("only 2 words in 30s of audio");
  });

  it("leaves a short recording alone — two words is a normal voice note", () => {
    expect(sparseReason("Thank you.", 6)).toBeNull();
    expect(sparseReason("Thank you.", 19)).toBeNull();
  });

  it("leaves real speech alone, however sparse", () => {
    const said = "Haan bhai theek hai, main kal aa jaunga shaam tak.";
    expect(sparseReason(said, 30)).toBeNull();
    expect(sparseReason(said, 90)).toBeNull();
  });

  it("says nothing when the length is unknown", () => {
    expect(sparseReason("Thank you.", null)).toBeNull();
  });
});

describe("parseMaxVolumeDb", () => {
  it("reads volumedetect's own line", () => {
    expect(parseMaxVolumeDb("[Parsed_volumedetect_0 @ 0x1] max_volume: -91.0 dB")).toBe(-91);
    expect(parseMaxVolumeDb("max_volume: -1.7 dB")).toBe(-1.7);
    expect(parseMaxVolumeDb("mean_volume: -30.0 dB")).toBeNull();
  });
});

describe("planChunks", () => {
  it("a short file is one chunk covering all of it", () => {
    expect(planChunks(60, 300)).toEqual([{ startSec: 0, durationSec: null }]);
    expect(planChunks(null, 300)).toEqual([{ startSec: 0, durationSec: null }]);
  });

  it("a long file is cut into contiguous chunks", () => {
    expect(planChunks(700, 300)).toEqual([
      { startSec: 0, durationSec: 300 },
      { startSec: 300, durationSec: 300 },
      { startSec: 600, durationSec: 300 },
    ]);
  });
});

describe("transcribeMedia", () => {
  it("decodes to 16 kHz mono and asks whisper to detect the language itself", async () => {
    stubFfmpeg({ duration: "00:00:12.00" });
    stubWhisper("Haan bhai, kal milte hain shaam ko.");

    const result = await transcribeMedia(row());

    expect(result).toEqual({
      transcript: "Haan bhai, kal milte hain shaam ko.",
      status: "done",
      model: "small",
      error: null,
    });

    const decode = argvOf().filter((c) => c[0] === "ffmpeg").at(-1)!;
    expect(decode).toContain("-ar");
    expect(decode[decode.indexOf("-ar") + 1]).toBe("16000");
    expect(decode[decode.indexOf("-ac") + 1]).toBe("1");
    expect(decode).toContain("volumedetect");

    // THE flag. whisper-cli's -l defaults to "en", so passing nothing is
    // passing English — and most of these chats are not English.
    const whisper = whisperCalls()[0];
    expect(whisper[whisper.indexOf("-l") + 1]).toBe("auto");
    expect(whisper).not.toContain("en");
  });

  it("passes an attacker-named file as one argv element, never through a shell", async () => {
    const evil = join(mediaDir, `note b'; touch pwned; echo $(id) *.ogg`);
    writeFileSync(evil, "opus");
    stubFfmpeg({ duration: "00:00:12.00" });
    stubWhisper("theek hai");

    await transcribeMedia(row({ mediaPath: evil }));

    expect(argvOf().filter((c) => c[0] === "ffmpeg")[0]).toContain(evil);
    expect(() => readFileSync(join(mediaDir, "pwned"))).toThrow();
  });

  it("records silence as unsupported WITHOUT asking whisper what it heard", async () => {
    // Measured with the bundled model: six seconds of digital silence comes
    // back as "Thank you." — fluent, confident, and never said.
    stubFfmpeg({ duration: "00:00:06.00", maxDb: -91 });
    stubWhisper("Thank you.");

    const result = await transcribeMedia(row());

    expect(result).toMatchObject({
      transcript: null,
      status: "unsupported",
      error: "the audio is silent",
    });
    expect(whisperCalls()).toHaveLength(0);
  });

  it("records a degenerate answer as unsupported rather than storing it", async () => {
    stubFfmpeg({ duration: "00:00:30.00" });
    stubWhisper("Subscribe to my channel. Subscribe to my channel. Subscribe to my channel.");

    const result = await transcribeMedia(row());

    expect(result.transcript).toBeNull();
    expect(result.status).toBe("unsupported");
    expect(result.error).toMatch(/the same phrase repeated 3 times/);
  });

  it("records half a minute answered in two words as unsupported", async () => {
    stubFfmpeg({ duration: "00:00:30.00" });
    stubWhisper("Thank you.");

    const result = await transcribeMedia(row({ seconds: 30 }));

    expect(result.transcript).toBeNull();
    expect(result.status).toBe("unsupported");
    expect(result.error).toBe("only 2 words in 30s of audio");
  });

  it("records only-markers as unsupported", async () => {
    stubFfmpeg({ duration: "00:00:30.00" });
    stubWhisper("[BLANK_AUDIO]");
    const result = await transcribeMedia(row());
    expect(result).toMatchObject({ transcript: null, status: "unsupported" });
  });

  it("chunks a long file and joins what came back", async () => {
    stubFfmpeg({ duration: "00:01:30.00" });
    stubWhisper(THIRDS);

    const result = await transcribeMedia(row({ seconds: 90 }), { chunkSec: 30 });

    expect(result.status).toBe("done");
    expect(result.transcript).toBe(THIRDS.join(" "));
    expect(whisperCalls()).toHaveLength(3);
    const second = argvOf().filter((c) => c[0] === "ffmpeg")[2];
    expect(second[second.indexOf("-ss") + 1]).toBe("30");
    expect(second[second.indexOf("-t") + 1]).toBe("30");
  });

  it("a chunk that failed is recorded as partial, never as a whole transcript", async () => {
    stubFfmpeg({ duration: "00:01:30.00" });
    stubWhisper(THIRDS, 1);

    const result = await transcribeMedia(row({ seconds: 90 }), { chunkSec: 30 });

    // 'done' would be the lie: what is stored is two thirds of a recording.
    expect(result.status).toBe("error");
    expect(result.transcript).toBe(`${THIRDS[0]} ${THIRDS[2]}`);
    expect(result.error).toMatch(/^partial: 2 of 3 chunks/);
  });

  it("every chunk failing is an error with nothing stored", async () => {
    stubFfmpeg({ duration: "00:00:12.00" });
    stubWhisper(["only chunk"], 0);
    const result = await transcribeMedia(row());
    expect(result.transcript).toBeNull();
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/whisper-cli exit 3/);
  });

  it("a video with no audio track is unsupported, not an error to retry", async () => {
    stubFfmpeg({ duration: "00:00:20.00", noAudio: true });
    stubWhisper("never asked");
    const result = await transcribeMedia(row({ kind: "video", mime: "video/mp4" }));
    expect(result).toMatchObject({
      status: "unsupported",
      error: "the video has no audio track",
    });
    expect(whisperCalls()).toHaveLength(0);
  });

  it("says which binary is missing instead of crashing", async () => {
    process.env.SUPERTWIN_FFMPEG_BIN = join(tmpDir, "absent");
    expect(await transcribeMedia(row())).toMatchObject({
      status: "error",
      error: "ffmpeg is not installed with the app",
    });

    stubFfmpeg({ duration: "00:00:12.00" });
    process.env.SUPERTWIN_WHISPER_BIN = join(tmpDir, "absent");
    expect(await transcribeMedia(row())).toMatchObject({
      status: "error",
      error: "whisper-cli is not installed with the app",
    });
  });

  it("says the model is not here instead of crashing", async () => {
    stubFfmpeg({ duration: "00:00:12.00" });
    stubWhisper("never runs");
    setMediaWhisperModel("large-v3");
    expect(await transcribeMedia(row())).toMatchObject({
      status: "error",
      error: 'the whisper model "large-v3" is not on this machine',
    });
  });

  it("a file that is gone is skipped — retrying cannot bring it back", async () => {
    stubFfmpeg({ duration: "00:00:12.00" });
    stubWhisper("never runs");
    expect(await transcribeMedia(row({ mediaPath: join(mediaDir, "nope.ogg") }))).toMatchObject({
      status: "skipped",
    });
  });

  it("leaves no temp WAVs behind", async () => {
    stubFfmpeg({ duration: "00:01:30.00" });
    stubWhisper(THIRDS);
    const before = readdirCount();
    await transcribeMedia(row({ seconds: 90 }), { chunkSec: 30 });
    expect(readdirCount()).toBe(before);
  });
});

/** How many supertwin-whisper-* temp dirs exist right now. */
function readdirCount(): number {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(tmpdir()).filter((n) => n.startsWith("supertwin-whisper-")).length;
}
