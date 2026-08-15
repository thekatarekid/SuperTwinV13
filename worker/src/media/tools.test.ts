// ===========================================================================
// Toolchain resolution tests (vitest). The two things worth pinning: a binary
// that was never staged resolves to null rather than to a bare name PATH might
// or might not have, and a model id that is not in the catalogue never becomes
// a path at all — the id comes out of app_state, and joining an arbitrary
// string onto a directory is how a settings write turns into a read of
// somewhere else.
//
// run() is exercised against a real child process, because the property being
// tested — an argv ARRAY, never a shell string — is only true of a real spawn.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { setMediaWhisperModel } from "../db/settings.js";
import {
  mediaToolState,
  resolveYtDlpBin,
  resourceCandidates,
  resolveFfmpegBin,
  resolveWhisperBin,
  resolveWhisperModel,
  run,
  selectedWhisperModel,
  whisperModelStates,
  whisperModelsDir,
  WHISPER_MODELS,
} from "./tools.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-tools-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  delete process.env.SUPERTWIN_WHISPER_BIN;
  delete process.env.SUPERTWIN_YTDLP_BIN;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** An executable that writes its own argv, one per line, to `record`. */
function stub(name: string, record: string): string {
  const path = join(tmpDir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, process.argv.slice(2).join("\\n"));
process.stdout.write("out");
process.stderr.write("err");
`,
    { mode: 0o755 },
  );
  return path;
}

describe("binary resolution", () => {
  it("an override that does not exist resolves to null, not to a hopeful name", () => {
    process.env.SUPERTWIN_FFMPEG_BIN = join(tmpDir, "nope");
    process.env.SUPERTWIN_WHISPER_BIN = join(tmpDir, "nope-either");
    expect(resolveFfmpegBin()).toBeNull();
    expect(resolveWhisperBin()).toBeNull();
  });

  it("an override that exists wins", () => {
    const bin = stub("ffmpeg", join(tmpDir, "argv.txt"));
    process.env.SUPERTWIN_FFMPEG_BIN = bin;
    expect(resolveFfmpegBin()).toBe(bin);
  });
});

describe("packaged layout", () => {
  // The bundle is CJS, where esbuild rewrites import.meta to an empty object.
  // Anchoring on the module URL therefore threw and left only a cwd candidate,
  // which is wrong inside the .app — 600 MB of bundled tooling resolved to
  // null. Nothing here may depend on cwd being the repo.
  it("finds a binary beside the module when cwd is somewhere else entirely", () => {
    const app = join(tmpDir, "Contents", "Resources");
    mkdirSync(join(app, "worker"), { recursive: true });
    mkdirSync(join(app, "bin"), { recursive: true });
    writeFileSync(join(app, "bin", "ffmpeg"), "#!/bin/sh\n");

    // resolveFfmpegBin anchors on this module's directory, so point the
    // override at the packaged path and assert it is taken verbatim rather
    // than rebuilt from process.cwd().
    process.env.SUPERTWIN_FFMPEG_BIN = join(app, "bin", "ffmpeg");
    expect(resolveFfmpegBin()).toBe(join(app, "bin", "ffmpeg"));
  });

  it("offers a module-anchored candidate that survives a chdir", () => {
    // The .app puts worker.cjs in Contents/Resources/worker and the binaries in
    // Contents/Resources/bin, so the candidate must be the ".." hop off this
    // module — never process.cwd(), which inside the app is not the repo.
    const candidates = resourceCandidates("bin", "ffmpeg");
    const cwdCandidate = join(process.cwd(), "src-tauri", "resources", "bin", "ffmpeg");

    expect(candidates).toContain(cwdCandidate);
    const anchored = candidates.filter((c) => c !== cwdCandidate);
    expect(anchored).toHaveLength(1);
    expect(anchored[0].endsWith(join("bin", "ffmpeg"))).toBe(true);
  });
});

describe("toolchain state", () => {
  // yt-dlp was staged and resolvable while Settings reported only two binaries,
  // so a bundled 38 MB dependency was invisible to the one screen that exists
  // to say whether it is there.
  it("reports every bundled binary, not just the two that came first", async () => {
    const bin = stub("yt-dlp", join(tmpDir, "argv.txt"));
    process.env.SUPERTWIN_YTDLP_BIN = bin;
    expect(resolveYtDlpBin()).toBe(bin);

    const state = await mediaToolState();
    expect(Object.keys(state)).toEqual(
      expect.arrayContaining(["ffmpeg", "whisper", "ytdlp", "models"]),
    );
    expect(state.ytdlp.present).toBe(true);
  });
});

describe("model resolution", () => {
  it("an id outside the catalogue never becomes a path", () => {
    // The id is a stored setting, so it is a string this process was handed.
    writeFileSync(join(tmpDir, "elsewhere.bin"), "not a model");
    for (const id of ["large-v9", "../../elsewhere", "", "*"]) {
      expect(resolveWhisperModel(id)).toBeNull();
    }
  });

  it("a catalogued model is found under the downloads dir", () => {
    const dir = whisperModelsDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "ggml-small.bin");
    writeFileSync(path, "not really a model");
    expect(resolveWhisperModel("small")).toBe(path);
    expect(resolveWhisperModel("tiny")).toBeNull();
  });

  it("selects what Settings chose, and says when it is not here", () => {
    setMediaWhisperModel("small");
    expect(selectedWhisperModel()).toEqual({ id: "small", path: null });

    mkdirSync(whisperModelsDir(), { recursive: true });
    writeFileSync(join(whisperModelsDir(), "ggml-small.bin"), "x");
    expect(selectedWhisperModel().path).toBe(join(whisperModelsDir(), "ggml-small.bin"));
  });

  it("the catalogue offers no English-only variant", () => {
    expect(WHISPER_MODELS.some((m) => m.id.endsWith(".en"))).toBe(false);
    expect(WHISPER_MODELS.filter((m) => m.bundled)).toHaveLength(1);
  });

  it("reports size on disk, which is not the size it is supposed to be", () => {
    mkdirSync(whisperModelsDir(), { recursive: true });
    writeFileSync(join(whisperModelsDir(), "ggml-tiny.bin"), "half a download");
    const tiny = whisperModelStates().find((m) => m.id === "tiny");
    expect(tiny).toMatchObject({ present: true, bytesOnDisk: 15 });
    expect(tiny?.bytes).toBeGreaterThan(15);
    expect(whisperModelStates().find((m) => m.id === "base")).toMatchObject({
      present: false,
      bytesOnDisk: null,
    });
  });
});

describe("run", () => {
  it("passes an attacker-shaped path as ONE argv element, never through a shell", async () => {
    const record = join(tmpDir, "argv.txt");
    const bin = stub("ffmpeg", record);
    // Everything a shell would act on: a separator, a substitution, a glob, a
    // quote, spaces. Through spawn's argv array it is just a filename.
    const evil = `/media/a b/'; touch ${join(tmpDir, "pwned")} #$(id).mp4`;

    const result = await run(bin, ["-i", evil, "-vn"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(readFileSync(record, "utf8").split("\n")).toEqual(["-i", evil, "-vn"]);
    expect(() => readFileSync(join(tmpDir, "pwned"))).toThrow();
  });

  it("a non-zero exit is data, not a throw — ffmpeg reports duration that way", async () => {
    const bin = join(tmpDir, "exiter");
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nprocess.stderr.write("Duration: 00:00:20.00");\nprocess.exit(1);\n`,
      { mode: 0o755 },
    );
    const result = await run(bin, []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Duration");
  });

  it("rejects when the binary is not there", async () => {
    await expect(run(join(tmpDir, "absent"), [])).rejects.toThrow();
  });

  it("kills a child that outlives its timeout", async () => {
    const bin = join(tmpDir, "sleeper");
    writeFileSync(bin, `#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n`, {
      mode: 0o755,
    });
    await expect(run(bin, [], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it("kills a child when the caller aborts", async () => {
    const bin = join(tmpDir, "sleeper2");
    writeFileSync(bin, `#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n`, {
      mode: 0o755,
    });
    const abort = new AbortController();
    const pending = run(bin, [], { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
