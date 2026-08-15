// The embedding-model download manager (V1 Part 8, task 5.4).
//
// One download per model, several models known at once, and every byte checked
// against a pinned digest before it is allowed to become a file the runtime
// will load.
//
// Three properties, in the order they matter:
//
//   1. VERIFIED. Each file lands in `<name>.part` and is renamed only after its
//      sha256 matches the catalogue. A mismatch deletes the partial and reports
//      the mismatch — it never renames, never retries into place, never
//      "accepts with a warning". This is the one rejection in the system, and
//      it is a supply-chain gate on a binary artifact: a truncated or swapped
//      ONNX graph does not fail loudly, it produces vectors in a space where
//      nothing looks wrong. It is not a gate on anything a model concluded.
//   2. RESUMABLE. A `.part` that survived a quit or a dropped connection is
//      re-hashed and continued with a Range request. If the server answers 200
//      instead of 206 — a mirror that does not do ranges — the file restarts
//      from zero rather than being spliced, because a spliced file would fail
//      the digest and cost the whole download twice.
//      An explicit CANCEL is different from an interruption: it deletes the
//      partial, because it is the user saying no rather than the network
//      saying wait.
//   3. RECLAIMABLE. Delete removes exactly the catalogue's own paths under the
//      download directory. Never a path that arrived in a request, and never
//      anything inside the .app — removing a file from a signed bundle breaks
//      the bundle.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import {
  embeddingModelBytes,
  embeddingModelFilePath,
  embeddingModelFileStates,
  embeddingModelFileUrl,
  embeddingModelPresent,
} from "./embedder.js";
import type { EmbeddingModelSpec } from "./model-registry.js";

/** One model's fetch in flight, or the failure the last attempt ended in. */
export interface EmbeddingDownload {
  /** Which model. The card shows several rows; progress belongs to one of them. */
  modelId: string;
  status: "downloading" | "error";
  receivedBytes: number;
  totalBytes: number;
  /** Which file of how many, so a seven-file fetch reads as one operation. */
  file: string;
  error: string | null;
}

interface DownloadEntry extends EmbeddingDownload {
  controller: AbortController | null;
  /** True once cancel() was called: tells the file loop to bin the partial. */
  cancelled: boolean;
}

const downloads = new Map<string, DownloadEntry>();

/**
 * The previous attempt for a model, still tearing down.
 *
 * A cancel aborts the fetch and returns straight away, but the `rm` that bins
 * the partial is async and OUTLIVES the call that asked for it. Without an
 * ordering here, "cancel, then download again" lets the old attempt's `rm`
 * delete the `.part` the new attempt just created: on POSIX the unlink
 * succeeds against the open fd, the writer keeps filling an unlinked inode,
 * and the final `rename` fails with ENOENT — the model lands half-installed
 * with no error the user can act on. The same window sits between
 * {@link cancelEmbeddingDownload} and {@link deleteEmbeddingModelFiles}, where
 * a `rename` landing late resurrects a file the user asked to reclaim.
 *
 * So a restart, and a delete, wait for their own predecessor's teardown.
 * Entries drop out once settled, so this never grows.
 */
const teardown = new Map<string, Promise<void>>();

/** Wait for a model's previous attempt to finish touching the disk. */
async function awaitTeardown(modelId: string): Promise<void> {
  const prior = teardown.get(modelId);
  if (prior) await prior.catch(() => undefined);
}

/**
 * Drop THIS run's progress entry, never a newer attempt's.
 *
 * A finishing run used to `downloads.delete(spec.id)` blind. After a
 * cancel-then-restart the id belongs to the NEW attempt, so the old run's
 * teardown deleted the live entry — `embeddingDownloadFor()` then answered
 * "nothing in flight" while a download was very much in flight, and anything
 * waiting on that (the Settings card, the tests) concluded it had finished.
 */
function clearEntry(modelId: string, entry: DownloadEntry): void {
  if (downloads.get(modelId) === entry) downloads.delete(modelId);
}

function publicDownload(entry: DownloadEntry): EmbeddingDownload {
  return {
    modelId: entry.modelId,
    status: entry.status,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    file: entry.file,
    error: entry.error,
  };
}

/** What is happening to this model right now, or null. */
export function embeddingDownloadFor(modelId: string): EmbeddingDownload | null {
  const entry = downloads.get(modelId);
  return entry ? publicDownload(entry) : null;
}

/** Every model with something to report. */
export function embeddingDownloads(): EmbeddingDownload[] {
  return [...downloads.values()].map(publicDownload);
}

/**
 * The single-download view the original Settings card was written against:
 * a fetch in flight if there is one, otherwise the last failure.
 */
export function currentEmbeddingDownload(): EmbeddingDownload | null {
  const all = [...downloads.values()];
  return (
    all.map(publicDownload).find((d) => d.status === "downloading") ??
    all.map(publicDownload)[0] ??
    null
  );
}

/**
 * Start fetching one model. Returns the state to report. A second call while
 * one is in flight is a no-op that reports the same progress — a double-click
 * is not an error.
 */
export function startEmbeddingDownload(
  spec: EmbeddingModelSpec,
  opts: { onComplete?(spec: EmbeddingModelSpec): void | Promise<void> } = {},
): EmbeddingDownload | null {
  if (embeddingModelPresent(spec)) return null;
  const running = downloads.get(spec.id);
  if (running?.status === "downloading") return publicDownload(running);

  const entry: DownloadEntry = {
    modelId: spec.id,
    status: "downloading",
    receivedBytes: 0,
    totalBytes: embeddingModelBytes(spec),
    file: spec.files[0]?.path ?? "",
    error: null,
    controller: new AbortController(),
    cancelled: false,
  };
  downloads.set(spec.id, entry);
  // Not awaited: hundreds of megabytes are polled off the GET, not held open
  // on the POST that asked for them. It is REGISTERED, though, so the next
  // start or delete for this model can wait for it to let go of the disk.
  const prior = teardown.get(spec.id);
  // eslint-disable-next-line prefer-const -- referenced inside its own finally
  let run: Promise<void>;
  run = runDownload(spec, entry, opts.onComplete, prior).finally(() => {
    if (teardown.get(spec.id) === run) teardown.delete(spec.id);
  });
  teardown.set(spec.id, run);
  return publicDownload(entry);
}

/**
 * Abort one model's download, or every one of them. Returns how many were
 * actually stopped — 0 is an answer, not a failure.
 */
export function cancelEmbeddingDownload(modelId?: string): number {
  const entries = modelId
    ? ([downloads.get(modelId)].filter(Boolean) as DownloadEntry[])
    : [...downloads.values()];
  let n = 0;
  for (const entry of entries) {
    if (entry.controller) {
      entry.cancelled = true;
      entry.controller.abort();
      n++;
    }
    downloads.delete(entry.modelId);
  }
  return n;
}

/** Called when the server closes. */
export function abortEmbeddingDownloads(): void {
  cancelEmbeddingDownload();
}

/**
 * Remove one model's files from the DOWNLOAD directory. Returns how many were
 * there. Never touches the bundled copy: the paths are built from the
 * catalogue under the writable root and from nothing else.
 */
export async function deleteEmbeddingModelFiles(spec: EmbeddingModelSpec): Promise<number> {
  cancelEmbeddingDownload(spec.id);
  // The attempt just cancelled may still be renaming a verified file into
  // place. Reclaiming the space while that lands leaves the file behind.
  await awaitTeardown(spec.id);
  let deleted = 0;
  for (const file of spec.files) {
    const target = embeddingModelFilePath(file.path, spec);
    for (const path of [target, `${target}.part`]) {
      try {
        const st = await stat(path);
        if (st.isFile()) {
          await rm(path, { force: true });
          if (path === target) deleted++;
        }
      } catch {
        // never downloaded, or already gone
      }
    }
  }
  return deleted;
}

/**
 * Test hook: forget every recorded download without touching the disk.
 *
 * `teardown` is deliberately NOT cleared. The aborted runs are still unwinding,
 * and the next start has to wait for them for exactly the reason the map
 * exists — dropping the handles here would hand the race back.
 */
export function resetEmbeddingDownloadsForTests(): void {
  for (const entry of downloads.values()) {
    entry.cancelled = true;
    entry.controller?.abort();
  }
  downloads.clear();
}

// ---------------------------------------------------------------------------

async function runDownload(
  spec: EmbeddingModelSpec,
  entry: DownloadEntry,
  onComplete?: (spec: EmbeddingModelSpec) => void | Promise<void>,
  prior?: Promise<void>,
): Promise<void> {
  const controller = entry.controller!;
  try {
    // Whatever the last attempt is still doing to these paths, let it finish
    // before this one creates a `.part` the old one would bin. A cancel can
    // also arrive during the wait, which the catch below already handles.
    if (prior) await prior.catch(() => undefined);
    if (entry.cancelled || controller.signal.aborted) {
      clearEntry(spec.id, entry);
      return;
    }
    for (const file of embeddingModelFileStates(spec)) {
      if (file.present) {
        entry.receivedBytes += file.bytes;
        continue;
      }
      entry.file = file.path;
      await fetchOne(spec, entry, file, controller);
    }
    clearEntry(spec.id, entry);
    // The files are here; the caller decides what that means (load it, wake
    // the indexer). Failure in the hook is the hook's business, not a reason
    // to report the download as failed.
    if (onComplete) {
      try {
        await onComplete(spec);
      } catch {
        // The bytes landed and were verified. Whatever the hook wanted to do
        // with them is a separate failure, reported by whatever it touched.
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      // A cancel is the user's answer, not a failure to report back to them.
      clearEntry(spec.id, entry);
      return;
    }
    entry.status = "error";
    entry.error = err instanceof Error ? err.message : String(err);
  } finally {
    entry.controller = null;
  }
}

async function fetchOne(
  spec: EmbeddingModelSpec,
  entry: DownloadEntry,
  file: { path: string; bytes: number; sha256: string },
  controller: AbortController,
): Promise<void> {
  const dest = embeddingModelFilePath(file.path, spec);
  const part = `${dest}.part`;
  const fileBase = entry.receivedBytes;

  await mkdir(dirname(dest), { recursive: true });

  // What survived a previous attempt, if anything, and its hash so far.
  let digest = createHash("sha256");
  let have = await partialBytes(part);
  if (have > file.bytes) {
    // Longer than the file is meant to be: not a prefix of anything.
    await rm(part, { force: true });
    have = 0;
  }
  if (have > 0) {
    for await (const chunk of createReadStream(part)) digest.update(chunk as Buffer);
    entry.receivedBytes += have;
  }
  if (have === file.bytes) {
    // Complete but never renamed — a quit between the last byte and the
    // rename. Verify and finish rather than fetching it again.
    await commit(digest.digest("hex"), file, part, dest, entry, fileBase);
    return;
  }

  const res = await fetch(embeddingModelFileUrl(file.path, spec), {
    signal: controller.signal,
    redirect: "follow",
    headers: have > 0 ? { Range: `bytes=${have}-` } : undefined,
  });
  if (!res.ok || !res.body) {
    throw new Error(
      `the download server answered ${res.status} ${res.statusText} for ${file.path}`,
    );
  }

  // A mirror that ignores Range answers 200 with the WHOLE file. Splicing that
  // onto what is already there produces a longer file with a wrong digest, so
  // the partial is discarded and this attempt starts from zero.
  let appending = have > 0;
  if (appending && res.status !== 206) {
    await truncate(part, 0).catch(() => rm(part, { force: true }));
    entry.receivedBytes -= have;
    digest = createHash("sha256");
    have = 0;
    appending = false;
  }

  let written = have;
  const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    digest.update(chunk);
    written += chunk.length;
    entry.receivedBytes += chunk.length;
  });

  try {
    await pipeline(body, createWriteStream(part, { flags: appending ? "a" : "w" }), {
      signal: controller.signal,
    });
    if (written < file.bytes) {
      // Short of the pinned length: an interrupted transfer, not a wrong file.
      // The partial stays on disk so the next attempt continues from here.
      throw new Error(
        `${file.path} stopped at ${written} of ${file.bytes} bytes`,
      );
    }
    // Length is not checked separately — a file of the wrong length cannot
    // have the pinned digest, and the digest is the message worth reporting.
    await commit(digest.digest("hex"), file, part, dest, entry, fileBase);
  } catch (err) {
    // Whatever arrived for this file did not count yet.
    entry.receivedBytes = fileBase;
    // A cancel and a bad digest both bin the partial; a dropped connection
    // keeps it, because that is what makes the next attempt cheap.
    if (entry.cancelled || controller.signal.aborted || isDigestFailure(err)) {
      await rm(part, { force: true }).catch(() => {
        // already gone; nothing to undo
      });
    }
    throw err;
  }
}

/**
 * The digest gate. A file becomes a file the runtime can see only here, and
 * only when its bytes are the pinned bytes.
 */
async function commit(
  got: string,
  file: { path: string; bytes: number; sha256: string },
  part: string,
  dest: string,
  entry: DownloadEntry,
  fileBase: number,
): Promise<void> {
  if (got !== file.sha256) {
    await rm(part, { force: true }).catch(() => {
      // already gone
    });
    entry.receivedBytes = fileBase;
    throw new Error(
      `${file.path} does not match the pinned checksum — got ${got.slice(0, 12)}…`,
    );
  }
  await rename(part, dest);
  entry.receivedBytes = fileBase + file.bytes;
}

function isDigestFailure(err: unknown): boolean {
  return err instanceof Error && err.message.includes("pinned checksum");
}

async function partialBytes(path: string): Promise<number> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}
