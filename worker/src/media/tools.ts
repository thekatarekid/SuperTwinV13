// ===========================================================================
// Finding the bundled media toolchain (v5 §1).
//
// ffmpeg, whisper-cli and the default whisper model are Tauri *resources*, not
// externalBin: externalBin appends a target triple to the filename and is only
// reachable through Rust's sidecar API, and the process that spawns these is
// this Node worker, which has none. Resources are copied verbatim, so the two
// layouts are:
//
//   packaged   <App>.app/Contents/Resources/{bin,models}/…   — one level up
//              from the worker bundle, which is what the Rust shell chdirs into
//   dev        <repo>/src-tauri/resources/{bin,models}/…     — cwd is the repo
//
// The packaged candidate is anchored to this module rather than to cwd so it
// survives a chdir. There is deliberately NO fallback to a bare "ffmpeg" on
// PATH: a Tauri app launched from Finder inherits a minimal PATH, and the whole
// reason these are bundled is that the machine may have neither. A candidate
// that does not exist on disk resolves to null, and the caller turns that into
// a stated error rather than a spawn that fails with ENOENT much later.
//
// Downloaded models live OUTSIDE the .app, under the SuperTwinV11 home, so an
// app update never re-downloads them.
// ===========================================================================

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_WHISPER_MODEL,
  getMediaWhisperModel,
} from "../store/store.js";

/** One selectable whisper model. `bytes` is what the download costs. */
export interface WhisperModel {
  id: string;
  label: string;
  bytes: number;
  /** Shipped inside the .app — present with no network, and never deletable. */
  bundled: boolean;
}

/**
 * The selector (v5 §4). English-only `.en` variants are deliberately absent:
 * these chats are Hindi, Marathi, English and code-switched Hinglish, and an
 * English-only model cannot serve them at all.
 */
export const WHISPER_MODELS: readonly WhisperModel[] = [
  { id: "tiny", label: "Tiny", bytes: 77_691_713, bundled: false },
  { id: "base", label: "Base", bytes: 147_951_465, bundled: false },
  { id: "small", label: "Small", bytes: 487_601_967, bundled: false },
  { id: "medium-q5_0", label: "Medium (q5_0)", bytes: 539_212_467, bundled: false },
  {
    id: DEFAULT_WHISPER_MODEL,
    label: "Large v3 turbo (q5_0)",
    bytes: 574_041_195,
    bundled: true,
  },
  { id: "large-v3-turbo", label: "Large v3 turbo", bytes: 1_623_251_309, bundled: false },
  { id: "large-v3-q5_0", label: "Large v3 (q5_0)", bytes: 1_080_732_101, bundled: false },
  { id: "large-v3", label: "Large v3", bytes: 3_095_033_483, bundled: false },
];

/**
 * Where this module sits on disk, in whichever form it is running.
 *
 * esbuild rewrites `import.meta` to an empty object in the CJS worker bundle,
 * so `import.meta.url` is undefined there and `fileURLToPath` throws — which
 * silently cost us the packaged path and left 600 MB of bundled tooling
 * unreachable inside the .app. CJS defines `__dirname`, so prefer it and keep
 * the module URL for a real ESM run.
 */
function moduleDir(): string | null {
  if (typeof __dirname === "string" && __dirname.length > 0) return __dirname;
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/** The bundled resource root for a given subdirectory, both layouts, in order. */
export function resourceCandidates(...parts: string[]): string[] {
  const out: string[] = [];
  // Packaged: the bundle is Contents/Resources/worker/worker.cjs, so the
  // resources sit one level up. Anchored to the module, not cwd, so a chdir
  // cannot lose them.
  const dir = moduleDir();
  if (dir) out.push(resolve(join(dir, "..", ...parts)));
  out.push(resolve(join(process.cwd(), "src-tauri", "resources", ...parts)));
  return out;
}

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** An explicit override always wins, so tests and ops can point elsewhere. */
function override(name: string): string | null {
  const v = process.env[name];
  return v && v.trim().length > 0 ? resolve(v.trim()) : null;
}

/**
 * The staged ffmpeg, or null when it was never staged. Not cached: a test that
 * points SUPERTWIN_FFMPEG_BIN at a stub between cases must see the new value,
 * and an existsSync per transcription is free next to decoding audio.
 */
export function resolveFfmpegBin(): string | null {
  const explicit = override("SUPERTWIN_FFMPEG_BIN");
  if (explicit) return existsSync(explicit) ? explicit : null;
  return firstExisting(resourceCandidates("bin", "ffmpeg"));
}

/** The staged whisper-cli, or null when it was never staged. */
export function resolveWhisperBin(): string | null {
  const explicit = override("SUPERTWIN_WHISPER_BIN");
  if (explicit) return existsSync(explicit) ? explicit : null;
  return firstExisting(resourceCandidates("bin", "whisper-cli"));
}

/** The staged yt-dlp, or null when it was never staged. */
export function resolveYtDlpBin(): string | null {
  const explicit = override("SUPERTWIN_YTDLP_BIN");
  if (explicit) return existsSync(explicit) ? explicit : null;
  return firstExisting(resourceCandidates("bin", "yt-dlp"));
}

/** Where downloaded (non-bundled) models live: <home>/models, per v5 §1. */
export function whisperModelsDir(): string {
  const home =
    process.env.SUPERTWIN_HOME && process.env.SUPERTWIN_HOME.trim().length
      ? process.env.SUPERTWIN_HOME
      : join(homedir(), "SuperTwinV11");
  return resolve(join(home, "models"));
}

/**
 * Where a model id's file is, if it is on disk. The id is looked up in the
 * catalogue before any path is built from it: the value comes out of app_state,
 * and joining an arbitrary string onto a directory is how a settings write
 * turns into a read of somewhere else entirely.
 */
export function resolveWhisperModel(id: string): string | null {
  const known = WHISPER_MODELS.find((m) => m.id === id);
  if (!known) return null;
  const file = `ggml-${id}.bin`;
  const candidates = known.bundled
    ? [...resourceCandidates("models", file), join(whisperModelsDir(), file)]
    : [join(whisperModelsDir(), file)];
  return firstExisting(candidates);
}

/** The model the transcriber will use, resolved. Null when it is not on disk. */
export function selectedWhisperModel(): { id: string; path: string | null } {
  const id = getMediaWhisperModel();
  return { id, path: resolveWhisperModel(id) };
}

/** One model as Settings shows it: size, and whether it is here yet (v5 §4). */
export interface WhisperModelState extends WhisperModel {
  present: boolean;
  /** Bytes actually on disk — a half-finished download is not the full size. */
  bytesOnDisk: number | null;
  selected: boolean;
}

export function whisperModelStates(): WhisperModelState[] {
  const selected = getMediaWhisperModel();
  return WHISPER_MODELS.map((m) => {
    const path = resolveWhisperModel(m.id);
    let bytesOnDisk: number | null = null;
    if (path) {
      try {
        bytesOnDisk = statSync(path).size;
      } catch {
        // raced with a delete — it counts as absent
      }
    }
    return {
      ...m,
      present: bytesOnDisk !== null,
      bytesOnDisk,
      selected: m.id === selected,
    };
  });
}

/** What Settings shows for one bundled binary (v5 §4). */
export interface BinaryState {
  path: string | null;
  present: boolean;
  /** Its self-reported version, or null when it could not be asked. */
  version: string | null;
}

export interface MediaToolState {
  ffmpeg: BinaryState;
  whisper: BinaryState;
  ytdlp: BinaryState;
  models: WhisperModelState[];
}

/** Long enough for a cold binary to page in, short enough not to hang Settings. */
const VERSION_TIMEOUT_MS = 5_000;
/** yt-dlp unpacks ~38 MB of itself before it will answer anything, measured ~9.5s. */
const YTDLP_VERSION_TIMEOUT_MS = 20_000;

/**
 * Everything Settings needs to say whether transcription can run at all. The
 * version comes from asking the binary rather than from a constant, because a
 * constant would keep claiming 8.1 after someone re-staged a different build.
 */
export async function mediaToolState(): Promise<MediaToolState> {
  const ffmpeg = resolveFfmpegBin();
  const whisper = resolveWhisperBin();
  const ytdlp = resolveYtDlpBin();
  const [ffmpegVersion, whisperVersion, ytdlpVersion] = await Promise.all([
    ffmpeg ? probeVersion(ffmpeg, ["-version"], /^ffmpeg version (\S+)/m) : null,
    whisper
      ? probeVersion(whisper, ["--version"], /whisper\.cpp version:? (\S+)/i)
      : null,
    ytdlp
      ? probeVersion(ytdlp, ["--version"], /^(\S+)/m, YTDLP_VERSION_TIMEOUT_MS)
      : null,
  ]);
  return {
    ffmpeg: { path: ffmpeg, present: ffmpeg !== null, version: ffmpegVersion },
    whisper: { path: whisper, present: whisper !== null, version: whisperVersion },
    ytdlp: { path: ytdlp, present: ytdlp !== null, version: ytdlpVersion },
    models: whisperModelStates(),
  };
}

/** Ask a binary its version. Null on any failure — this is display, not work. */
async function probeVersion(
  bin: string,
  args: readonly string[],
  pattern: RegExp,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const out = await run(bin, args, { timeoutMs });
    const text = `${out.stdout}\n${out.stderr}`;
    return pattern.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap on retained output per stream, so a chatty child cannot grow memory. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 1_000_000;

/**
 * Spawn a child and collect its output. ARGV ARRAY ONLY, `shell` never set:
 * every path that reaches here — the media file, its directory, the model —
 * came from someone else's message, and a path interpolated into a command
 * string is a command they chose.
 *
 * Rejects on spawn failure, resolves with the exit code otherwise; a non-zero
 * exit is data (ffmpeg reports the duration of a file it then refuses to
 * convert), so it is the caller who decides whether it was a failure.
 */
export function run(
  bin: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    let child;
    try {
      child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err as Error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = (why: string): void => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(why)));
    };
    const onAbort = (): void => kill("aborted");
    const timer = opts.timeoutMs
      ? setTimeout(() => kill(`${bin} timed out after ${opts.timeoutMs}ms`), opts.timeoutMs)
      : null;
    timer?.unref?.();

    if (opts.signal?.aborted) {
      kill("aborted");
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < maxChars) stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      if (stderr.length < maxChars) stderr += c;
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() => resolvePromise({ code, stdout, stderr })),
    );
  });
}
