// ===========================================================================
// The bundled media toolchain, as Settings sees it (v5 §4).
//
// Routes:
//   GET  /api/media/tools                  -> binaries + versions + model states
//   POST /api/media/models/download { id } -> fetch one model into the models dir
//   POST /api/media/models/cancel   { id } -> abort an in-flight download
//   POST /api/media/models/delete   { id } -> remove one downloaded model
//
// Mounted AHEAD of the /api/media/:eventId catch-all, which would otherwise
// read "tools" as an event id.
//
// Every id is looked up in WHISPER_MODELS before a path is built from it: the
// id arrives in a request body, and joining an arbitrary string onto a
// directory is how a download button becomes a write to somewhere else.
// ===========================================================================

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import {
  WHISPER_MODELS,
  mediaToolState,
  resolveWhisperModel,
  whisperModelStates,
  whisperModelsDir,
  type WhisperModelState,
} from "../media/tools.js";
import { getMediaWhisperModel } from "../db/settings.js";

/**
 * Where a model id's file is fetched from. Pinned to the same whisper.cpp repo
 * revision the build script stages the bundled model from, rather than `main`:
 * a model that silently changes underneath a pinned app is a different model.
 * The override exists so tests can serve bytes from localhost.
 */
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const DEFAULT_MODEL_BASE_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}`;

function modelBaseUrl(): string {
  const override = process.env.SUPERTWIN_WHISPER_MODEL_BASE_URL;
  return override && override.trim().length > 0
    ? override.trim().replace(/\/+$/, "")
    : DEFAULT_MODEL_BASE_URL;
}

/** The file one model id lives in, both on disk and on the server. */
function modelFileName(id: string): string {
  return `ggml-${id}.bin`;
}

/** One download in flight, or the failure the last one ended in. */
export interface ModelDownload {
  id: string;
  status: "downloading" | "error";
  receivedBytes: number;
  /**
   * What the server said it would send, or null when it did not say. NOT the
   * catalogue size — a progress bar that divides by a number nobody measured
   * reads as complete while bytes are still arriving.
   */
  totalBytes: number | null;
  error: string | null;
}

interface DownloadEntry extends ModelDownload {
  controller: AbortController | null;
  /**
   * True from the moment the bytes are whole to the moment the file has its
   * real name. The entry stays in the map across that window so a second
   * request cannot start a duplicate fetch, but it stops being reported: the
   * rename makes the model present on disk BEFORE the continuation after it
   * runs, and a caller that sees `present: true` must never also see a
   * download still in flight for the same id. The inverse window it leaves —
   * not present yet, nothing downloading — is one a poller simply polls
   * through.
   */
  finalizing: boolean;
}

const downloads = new Map<string, DownloadEntry>();

/** What a caller sees: the entry without its abort handle. */
function publicDownload(entry: DownloadEntry): ModelDownload {
  return {
    id: entry.id,
    status: entry.status,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    error: entry.error,
  };
}

/** One model row as Settings shows it: catalogue + disk + any live download. */
export interface WhisperModelReport extends WhisperModelState {
  download: ModelDownload | null;
}

function modelReports(): WhisperModelReport[] {
  return whisperModelStates().map((m) => {
    const entry = downloads.get(m.id);
    return { ...m, download: entry && !entry.finalizing ? publicDownload(entry) : null };
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The requested model id, or null when it is not one this app offers. */
function knownModelId(body: unknown): string | null {
  const id = (body as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") return null;
  return WHISPER_MODELS.some((m) => m.id === id) ? id : null;
}

function invalidId(res: ServerResponse): true {
  sendJson(res, 400, {
    error: `id must be one of ${WHISPER_MODELS.map((m) => m.id).join("|")}`,
  });
  return true;
}

/**
 * Fetch one model into the downloads dir. Writes to `<name>.part` and renames
 * only once the whole body has landed, so an aborted run can never leave
 * something that reads as a staged model — and a truncated body (the server
 * promised more than it sent) is a failure, not a shorter model.
 *
 * There is no digest to check against: only the bundled model has a pinned
 * sha256 (in scripts/stage-media-tools.mjs), because it is the only one whose
 * bytes were ever measured here. This verifies the download completed, not who
 * wrote it — the pinned revision and HTTPS are what that rests on.
 */
async function runDownload(entry: DownloadEntry): Promise<void> {
  const dir = whisperModelsDir();
  const dest = join(dir, modelFileName(entry.id));
  const part = `${dest}.part`;
  const controller = entry.controller!;

  try {
    await mkdir(dir, { recursive: true });
    const res = await fetch(`${modelBaseUrl()}/${modelFileName(entry.id)}`, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      throw new Error(`the download server answered ${res.status} ${res.statusText}`);
    }
    const declared = Number(res.headers.get("content-length"));
    entry.totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;

    const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      entry.receivedBytes += chunk.length;
    });
    await pipeline(body, createWriteStream(part), { signal: controller.signal });

    if (entry.totalBytes !== null && entry.receivedBytes !== entry.totalBytes) {
      throw new Error(
        `the download stopped early — ${entry.receivedBytes} of ${entry.totalBytes} bytes`,
      );
    }
    // Stop reporting the download BEFORE the rename lands, not after. The OS
    // makes the file present under its real name the instant rename returns,
    // while the delete below only runs once this function is resumed — a GET
    // serviced in between would answer `present: true` next to a stale
    // `status: "downloading"`, which is the one pair of states that cannot
    // both be true.
    entry.finalizing = true;
    try {
      await rename(part, dest);
    } catch (err) {
      // Nothing was named, so this is still a live download that failed.
      entry.finalizing = false;
      throw err;
    }
    downloads.delete(entry.id);
  } catch (err) {
    await rm(part, { force: true }).catch(() => {
      // the partial is already gone, or the dir was never created
    });
    const aborted = controller.signal.aborted;
    if (aborted) {
      // A cancel is the user's answer, not a failure to report back to them.
      downloads.delete(entry.id);
      return;
    }
    entry.status = "error";
    entry.error = err instanceof Error ? err.message : String(err);
  } finally {
    entry.controller = null;
  }
}

/**
 * Abort every download in flight. Called when the server closes, so a 3 GB
 * fetch dies with the process instead of writing into a `.part` nobody owns.
 */
export function abortModelDownloads(): void {
  for (const entry of downloads.values()) entry.controller?.abort();
  downloads.clear();
}

/** Handle a media-toolchain request. Returns true if it handled it. */
export async function handleMediaToolsRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // ---- GET /api/media/tools
  if (method === "GET" && path === "/api/media/tools") {
    const state = await mediaToolState();
    sendJson(res, 200, {
      ffmpeg: state.ffmpeg,
      whisper: state.whisper,
      ytdlp: state.ytdlp,
      models: modelReports(),
      modelsDir: whisperModelsDir(),
    });
    return true;
  }

  // ---- POST /api/media/models/download { id }
  if (method === "POST" && path === "/api/media/models/download") {
    const id = knownModelId(await readJsonBody(req));
    if (!id) return invalidId(res);

    if (resolveWhisperModel(id)) {
      // Already here. Answering 200 rather than an error keeps a double-click
      // from reading as a failure.
      sendJson(res, 200, { id, download: null, models: modelReports() });
      return true;
    }
    const existing = downloads.get(id);
    if (existing?.finalizing) {
      // The bytes are whole and the file is being given its real name. Not a
      // download to report, and not one to start over.
      sendJson(res, 200, { id, download: null, models: modelReports() });
      return true;
    }
    if (existing?.status === "downloading") {
      sendJson(res, 200, { id, download: publicDownload(existing), models: modelReports() });
      return true;
    }
    const entry: DownloadEntry = {
      id,
      status: "downloading",
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      controller: new AbortController(),
      finalizing: false,
    };
    downloads.set(id, entry);
    // Not awaited: the file is up to 3 GB, and the caller polls GET
    // /api/media/tools for progress rather than holding a request open.
    void runDownload(entry);
    sendJson(res, 202, { id, download: publicDownload(entry), models: modelReports() });
    return true;
  }

  // ---- POST /api/media/models/cancel { id }
  if (method === "POST" && path === "/api/media/models/cancel") {
    const id = knownModelId(await readJsonBody(req));
    if (!id) return invalidId(res);
    const entry = downloads.get(id);
    entry?.controller?.abort();
    downloads.delete(id);
    sendJson(res, 200, { id, cancelled: entry != null, models: modelReports() });
    return true;
  }

  // ---- POST /api/media/models/delete { id }
  if (method === "POST" && path === "/api/media/models/delete") {
    const id = knownModelId(await readJsonBody(req));
    if (!id) return invalidId(res);

    const model = WHISPER_MODELS.find((m) => m.id === id)!;
    if (model.bundled) {
      sendJson(res, 400, {
        error: "the bundled model ships inside the app and cannot be deleted",
      });
      return true;
    }
    if (getMediaWhisperModel() === id) {
      // Deleting it would leave transcription pointing at nothing. Say so
      // rather than silently moving the selection somewhere the user did not
      // choose.
      sendJson(res, 400, {
        error: "this is the model transcription uses — select another one first",
      });
      return true;
    }
    // Only ever the catalogue's own filename inside the downloads dir: the
    // bundled copy lives in the .app and is not this route's to remove.
    const target = join(whisperModelsDir(), modelFileName(id));
    let deleted = false;
    try {
      const st = await stat(target);
      if (st.isFile()) {
        await rm(target, { force: true });
        deleted = true;
      }
    } catch {
      // never downloaded, or already gone — either way there is nothing to do
    }
    downloads.delete(id);
    sendJson(res, 200, { id, deleted, models: modelReports() });
    return true;
  }

  return false;
}
