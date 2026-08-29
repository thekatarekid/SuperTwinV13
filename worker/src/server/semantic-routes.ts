// Semantic retrieval as Settings sees it (docs/v6-spec.md §1, tier 3).
//
// Routes:
//   GET  /api/retrieval/semantic                  -> switch + runtime + model + index
//   POST /api/retrieval/semantic/enable { on }    -> flip the switch
//   POST /api/retrieval/semantic/download         -> fetch the encoder
//   POST /api/retrieval/semantic/cancel           -> abort an in-flight download
//   POST /api/retrieval/semantic/delete           -> remove it from disk
//
// Deliberately the same shape as the whisper model routes next door: one
// download at a time, written to `.part` and renamed only once the whole file
// has landed, cancel is an answer rather than a failure, and progress is polled
// off the GET rather than held open on the POST.
//
// The one thing this does that whisper's does not is verify a digest. The
// encoder's bytes were measured when the revision was pinned (embedder.ts), and
// a truncated ONNX graph does not fail loudly — it produces vectors in a space
// where nothing looks wrong.

import type { IncomingMessage, ServerResponse } from "node:http";

import { countEventEmbeddings } from "../db/embeddings.js";
import {
  activeEmbeddingModel,
  embeddingModelBundled,
  embeddingModelBytes,
  embeddingModelFileStates,
  embeddingModelPresent,
  embeddingModelSourceDir,
  embeddingRuntimeInstalled,
  ensureEmbeddingModel,
  forgetEmbedder,
  type EmbeddingFileState,
} from "../retrieval/embedder.js";
import {
  abortEmbeddingDownloads,
  cancelEmbeddingDownload,
  currentEmbeddingDownload,
  deleteEmbeddingModelFiles,
  embeddingDownloadFor,
  startEmbeddingDownload,
  type EmbeddingDownload,
} from "../retrieval/downloads.js";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  findEmbeddingModel,
  listEmbeddingModels,
  type EmbeddingModelSpec,
} from "../retrieval/model-registry.js";
import {
  adoptDefaultEmbeddingModel,
  markEmbeddingModelChosenByUser,
} from "../retrieval/default-model.js";
import {
  cancelEmbeddingSwap,
  embeddingSwapState,
  startEmbeddingSwap,
  type EmbeddingSwapState,
} from "../retrieval/model-swap.js";
import {
  benchmarkRunning,
  lastBenchmark,
  runAndRemember,
  type BenchmarkResult,
} from "../retrieval/benchmark.js";
import { semanticStatus, type SemanticStatus } from "../retrieval/semantic.js";
import { wakeSemanticIndexer } from "../retrieval/indexer.js";
import { setSemanticRetrievalEnabled } from "../db/settings.js";

export type { EmbeddingDownload };

/** Everything the Settings card needs in one read. */
export interface SemanticReport extends SemanticStatus {
  runtimeInstalled: boolean;
  modelBytes: number;
  /** Where the files being reported actually are: the .app when bundled. */
  modelDir: string;
  /**
   * v7 §7: the encoder ships inside the app. Settings must not offer to fetch
   * what is already here, nor to delete out of a signed bundle — and the
   * download/delete routes below cannot reach it either.
   */
  bundled: boolean;
  files: EmbeddingFileState[];
  present: boolean;
  download: EmbeddingDownload | null;
}

/** One catalogue entry, with what this machine has of it (task 5.4). */
export interface EmbeddingModelReport {
  id: string;
  /** The repo the weights were exported from, when that is not `id`. */
  upstream: string | null;
  label: string;
  note: string;
  dim: number;
  bytes: number;
  source: string;
  revision: string;
  /** Ships inside the .app: nothing to fetch, nothing that may be deleted. */
  bundled: boolean;
  /** The upgrade the card leads with. */
  recommended: boolean;
  /** The model the index is built on right now. */
  active: boolean;
  present: boolean;
  /** Vectors this model owns. Every model but the active one holds 0. */
  indexed: number;
  files: EmbeddingFileState[];
  download: EmbeddingDownload | null;
}

/** GET /api/retrieval/semantic/models — the picker, the downloads, the swap. */
export interface EmbeddingRegistryReport {
  active: string;
  /** What this build wants to be running — see retrieval/default-model.ts. */
  default: string;
  models: EmbeddingModelReport[];
  swap: EmbeddingSwapState | null;
  benchmark: BenchmarkResult | null;
  benchmarkRunning: string | null;
}

async function report(): Promise<SemanticReport> {
  return {
    ...semanticStatus(),
    runtimeInstalled: await embeddingRuntimeInstalled(),
    modelBytes: embeddingModelBytes(),
    modelDir: embeddingModelSourceDir(),
    bundled: embeddingModelBundled(),
    files: embeddingModelFileStates(),
    present: embeddingModelPresent(),
    download: currentEmbeddingDownload(),
  };
}

function modelReport(spec: EmbeddingModelSpec, activeId: string): EmbeddingModelReport {
  return {
    id: spec.id,
    upstream: spec.upstream ?? null,
    label: spec.label,
    note: spec.note,
    dim: spec.dim,
    bytes: embeddingModelBytes(spec),
    source: spec.source,
    revision: spec.revision,
    bundled: embeddingModelBundled(spec),
    recommended: spec.recommended,
    active: spec.id === activeId,
    present: embeddingModelPresent(spec),
    indexed: safeIndexed(spec),
    files: embeddingModelFileStates(spec),
    download: embeddingDownloadFor(spec.id),
  };
}

function safeIndexed(spec: EmbeddingModelSpec): number {
  try {
    return countEventEmbeddings({ model: spec.id, dim: spec.dim });
  } catch {
    // A database that predates 0018 has no vector table; that is "none".
    return 0;
  }
}

function registryReport(): EmbeddingRegistryReport {
  const activeId = activeEmbeddingModel().id;
  return {
    active: activeId,
    default: DEFAULT_EMBEDDING_MODEL_ID,
    models: listEmbeddingModels().map((spec) => modelReport(spec, activeId)),
    swap: embeddingSwapState(),
    benchmark: lastBenchmark(),
    benchmarkRunning: benchmarkRunning(),
  };
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

/** Load the model that just landed, and get the index moving. */
async function afterDownload(): Promise<void> {
  // A download is the moment the DEFAULT encoder can become reachable, so this
  // is where an install is moved onto it — instantly on an empty index, and
  // through the background swap when there is one to re-embed. It is a no-op
  // for every other model, and for an install whose user has picked one.
  adoptDefaultEmbeddingModel();
  // Find out whether the files actually load before Settings claims the tier
  // is on; four files existing is not the same as a working encoder.
  await ensureEmbeddingModel();
  wakeSemanticIndexer();
}

/** Abort a download in flight. Called when the server closes. */
export function abortEmbeddingDownload(): void {
  abortEmbeddingDownloads();
}

/** The model named in a request body, or null. Ids are catalogue keys only. */
function specFromBody(body: unknown): EmbeddingModelSpec | null {
  const id = (body as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? findEmbeddingModel(id) : null;
}

/** Handle a semantic-retrieval request. Returns true if it handled it. */
export async function handleSemanticRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/retrieval/semantic") {
    sendJson(res, 200, await report());
    return true;
  }

  // ---- POST /api/retrieval/semantic/enable { on }
  if (method === "POST" && path === "/api/retrieval/semantic/enable") {
    const on = (await readJsonBody(req)) as { on?: unknown } | undefined;
    if (typeof on?.on !== "boolean") {
      sendJson(res, 400, { error: "on must be true or false" });
      return true;
    }
    setSemanticRetrievalEnabled(on.on);
    // The last verdict was reached under the old switch, so it is not an answer
    // to the new one. Deciding again here — rather than on the next chat turn —
    // is what lets the card say "ready" or "not downloaded yet" instead of
    // "unknown" the moment the user flips it.
    forgetEmbedder();
    await ensureEmbeddingModel();
    if (on.on) wakeSemanticIndexer();
    sendJson(res, 200, await report());
    return true;
  }

  // ---- POST /api/retrieval/semantic/download  (the ACTIVE model)
  if (method === "POST" && path === "/api/retrieval/semantic/download") {
    const started = startEmbeddingDownload(activeEmbeddingModel(), {
      onComplete: afterDownload,
    });
    if (!started) {
      // Already here. 200 rather than an error keeps a double-click from
      // reading as a failure.
      await ensureEmbeddingModel();
      sendJson(res, 200, await report());
      return true;
    }
    sendJson(res, 202, await report());
    return true;
  }

  // ---- POST /api/retrieval/semantic/cancel
  if (method === "POST" && path === "/api/retrieval/semantic/cancel") {
    const cancelled = cancelEmbeddingDownload(activeEmbeddingModel().id) > 0;
    sendJson(res, 200, { cancelled, ...(await report()) });
    return true;
  }

  // ---- POST /api/retrieval/semantic/delete
  if (method === "POST" && path === "/api/retrieval/semantic/delete") {
    const deleted = await deleteEmbeddingModelFiles(activeEmbeddingModel());
    // Whatever was loaded is now backed by files that are not there.
    forgetEmbedder();
    await ensureEmbeddingModel();
    sendJson(res, 200, { deleted, ...(await report()) });
    return true;
  }

  // =========================================================================
  // The registry (task 5.4): several encoders, one active, one index.
  // =========================================================================

  // ---- GET /api/retrieval/semantic/models
  if (method === "GET" && path === "/api/retrieval/semantic/models") {
    sendJson(res, 200, registryReport());
    return true;
  }

  // ---- POST /api/retrieval/semantic/models/download { id }
  if (method === "POST" && path === "/api/retrieval/semantic/models/download") {
    const spec = specFromBody(await readJsonBody(req));
    if (!spec) {
      sendJson(res, 400, { error: "id must name a model in the catalogue" });
      return true;
    }
    if (spec.bundled && embeddingModelBundled(spec)) {
      // It is inside the .app. There is nothing to fetch, and reaching for the
      // network would be the one thing this build promises never to do.
      sendJson(res, 200, registryReport());
      return true;
    }
    const started = startEmbeddingDownload(spec, { onComplete: afterDownload });
    sendJson(res, started ? 202 : 200, registryReport());
    return true;
  }

  // ---- POST /api/retrieval/semantic/models/cancel { id }
  if (method === "POST" && path === "/api/retrieval/semantic/models/cancel") {
    const spec = specFromBody(await readJsonBody(req));
    if (!spec) {
      sendJson(res, 400, { error: "id must name a model in the catalogue" });
      return true;
    }
    const cancelled = cancelEmbeddingDownload(spec.id) > 0;
    sendJson(res, 200, { cancelled, ...registryReport() });
    return true;
  }

  // ---- POST /api/retrieval/semantic/models/delete { id }
  if (method === "POST" && path === "/api/retrieval/semantic/models/delete") {
    const spec = specFromBody(await readJsonBody(req));
    if (!spec) {
      sendJson(res, 400, { error: "id must name a model in the catalogue" });
      return true;
    }
    if (spec.bundled) {
      // Deleting a file out of a signed .app breaks the app, and the bundled
      // copy is the fallback everything else depends on.
      sendJson(res, 409, {
        error: "the bundled encoder ships inside the app and cannot be deleted",
        ...registryReport(),
      });
      return true;
    }
    if (spec.id === activeEmbeddingModel().id) {
      sendJson(res, 409, {
        error: "that is the model the index is built on — switch to another one first",
        ...registryReport(),
      });
      return true;
    }
    const deleted = await deleteEmbeddingModelFiles(spec);
    sendJson(res, 200, { deleted, ...registryReport() });
    return true;
  }

  // ---- POST /api/retrieval/semantic/models/activate { id }
  //
  // Starts the swap. It does NOT move the pointer — that happens inside the
  // flip transaction, once the new index exists. Until then every question is
  // still answered by the old one.
  if (method === "POST" && path === "/api/retrieval/semantic/models/activate") {
    const spec = specFromBody(await readJsonBody(req));
    if (!spec) {
      sendJson(res, 400, { error: "id must name a model in the catalogue" });
      return true;
    }
    if (spec.id === activeEmbeddingModel().id) {
      markEmbeddingModelChosenByUser();
      sendJson(res, 200, registryReport());
      return true;
    }
    try {
      startEmbeddingSwap(spec.id);
      // Recorded only once the swap actually started: a refused activation
      // (weights not here, another swap running) is not a choice, and marking
      // it as one would wedge the install off the default for good.
      markEmbeddingModelChosenByUser();
    } catch (err) {
      sendJson(res, 409, {
        error: err instanceof Error ? err.message : String(err),
        ...registryReport(),
      });
      return true;
    }
    sendJson(res, 202, registryReport());
    return true;
  }

  // ---- POST /api/retrieval/semantic/models/swap/cancel
  if (method === "POST" && path === "/api/retrieval/semantic/models/swap/cancel") {
    const cancelled = cancelEmbeddingSwap();
    sendJson(res, 200, { cancelled, ...registryReport() });
    return true;
  }

  // ---- POST /api/retrieval/semantic/benchmark { id, sample?, k? }
  if (method === "POST" && path === "/api/retrieval/semantic/benchmark") {
    const body = (await readJsonBody(req)) as
      | { id?: unknown; sample?: unknown; k?: unknown }
      | undefined;
    const spec = specFromBody(body);
    if (!spec) {
      sendJson(res, 400, { error: "id must name a model in the catalogue" });
      return true;
    }
    try {
      const result = await runAndRemember(spec.id, {
        sample: typeof body?.sample === "number" ? body.sample : undefined,
        k: typeof body?.k === "number" ? body.k : undefined,
      });
      sendJson(res, 200, { result, ...registryReport() });
    } catch (err) {
      sendJson(res, 409, {
        error: err instanceof Error ? err.message : String(err),
        ...registryReport(),
      });
    }
    return true;
  }

  return false;
}
