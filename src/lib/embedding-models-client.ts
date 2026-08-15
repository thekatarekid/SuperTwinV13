// Typed calls for the two Settings surfaces added in phase 5 (task 5.4 and the
// phase-2 lane-tier pin), kept out of worker-client.ts so this wave's tracks do
// not collide in one file. Same shape as everything there: leading-slash paths
// through workerUrl(), JSON in, JSON out, a thrown Error carrying the worker's
// own message on a non-2xx.

import { workerUrl } from "./config";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(workerUrl(path), { signal });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(workerUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok) throw new Error(parsed?.error ?? `${res.status} ${res.statusText}`);
  if (parsed === null) throw new Error("the worker sent something that was not JSON");
  return parsed;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // not JSON; fall through to the status line
  }
  return `${res.status} ${res.statusText}`;
}

// ---------------------------------------------------------------------------
// Embedding models (task 5.4)
// ---------------------------------------------------------------------------

export interface EmbeddingModelFileState {
  path: string;
  bytes: number;
  present: boolean;
  bytesOnDisk: number | null;
}

export interface EmbeddingModelDownload {
  modelId: string;
  status: "downloading" | "error";
  receivedBytes: number;
  totalBytes: number;
  file: string;
  error: string | null;
}

/** One encoder in the catalogue, with what this Mac has of it. */
export interface EmbeddingModelRow {
  id: string;
  /** The repo the weights were exported from, when that is not `id`. */
  upstream: string | null;
  label: string;
  note: string;
  dim: number;
  bytes: number;
  source: string;
  revision: string;
  /** Ships inside the app: nothing to fetch, nothing that may be deleted. */
  bundled: boolean;
  recommended: boolean;
  /** The model the index is built on right now. */
  active: boolean;
  present: boolean;
  /** Vectors this model owns. Everything but the active model holds 0. */
  indexed: number;
  files: EmbeddingModelFileState[];
  download: EmbeddingModelDownload | null;
}

/**
 * A swap in flight, or the last one's outcome. The pointer only moves when
 * `phase` reaches "done" — until then the old index is still answering.
 */
export interface EmbeddingSwapState {
  fromModel: string;
  toModel: string;
  phase: "embedding" | "flipping" | "done" | "error" | "cancelled";
  total: number;
  embedded: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** What the benchmark measured on this corpus. Never a claim about anyone else's. */
export interface EmbeddingBenchmark {
  activeModel: string;
  candidateModel: string;
  sampleSize: number;
  probes: number;
  k: number;
  /** 0..1 — how much of each top-K list the two models agree on. */
  overlapAtK: number;
  activeMsPerEvent: number;
  candidateMsPerEvent: number;
  /** candidate ÷ active. Above 1 means the candidate is slower. */
  speedRatio: number;
  recommendation: string;
  ranAt: string;
}

export interface EmbeddingRegistry {
  active: string;
  models: EmbeddingModelRow[];
  swap: EmbeddingSwapState | null;
  benchmark: EmbeddingBenchmark | null;
  benchmarkRunning: string | null;
}

export function getEmbeddingRegistry(signal?: AbortSignal): Promise<EmbeddingRegistry> {
  return getJson<EmbeddingRegistry>("/api/retrieval/semantic/models", signal);
}

export function downloadEmbeddingModelById(id: string): Promise<EmbeddingRegistry> {
  return postJson<EmbeddingRegistry>("/api/retrieval/semantic/models/download", { id });
}

export function cancelEmbeddingModelById(id: string): Promise<EmbeddingRegistry> {
  return postJson<EmbeddingRegistry>("/api/retrieval/semantic/models/cancel", { id });
}

export function deleteEmbeddingModelById(id: string): Promise<EmbeddingRegistry> {
  return postJson<EmbeddingRegistry>("/api/retrieval/semantic/models/delete", { id });
}

/** Start the background re-embed. The old index keeps serving until it lands. */
export function activateEmbeddingModel(id: string): Promise<EmbeddingRegistry> {
  return postJson<EmbeddingRegistry>("/api/retrieval/semantic/models/activate", { id });
}

export function cancelEmbeddingSwap(): Promise<EmbeddingRegistry> {
  return postJson<EmbeddingRegistry>("/api/retrieval/semantic/models/swap/cancel", {});
}

export function benchmarkEmbeddingModel(
  id: string,
  opts?: { sample?: number; k?: number },
): Promise<EmbeddingRegistry & { result: EmbeddingBenchmark }> {
  return postJson<EmbeddingRegistry & { result: EmbeddingBenchmark }>(
    "/api/retrieval/semantic/benchmark",
    { id, ...opts },
  );
}

/** Everything this module offers, so a test can inject a partial stand-in. */
export interface EmbeddingModelsClient {
  getEmbeddingRegistry: typeof getEmbeddingRegistry;
  downloadEmbeddingModelById: typeof downloadEmbeddingModelById;
  cancelEmbeddingModelById: typeof cancelEmbeddingModelById;
  deleteEmbeddingModelById: typeof deleteEmbeddingModelById;
  activateEmbeddingModel: typeof activateEmbeddingModel;
  cancelEmbeddingSwap: typeof cancelEmbeddingSwap;
  benchmarkEmbeddingModel: typeof benchmarkEmbeddingModel;
}
