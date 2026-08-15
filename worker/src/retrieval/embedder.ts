// The embedding backend — tier 3 of docs/v6-spec.md §1.
//
// Both halves ship inside the app: the runtime (@huggingface/transformers, ONNX
// on CPU) beside the worker bundle, and the WEIGHTS as a Tauri resource (v7 §7)
// — 129 MB on a 765 MB installer, for a tier whose canonical case is cold ↔
// health and which is worth nothing on a machine with no network. The download
// route stays because it is what a build that was never staged falls back to,
// and `embedderStatus()` still says which half is missing rather than waiting,
// retrying or reaching the network inside a chat turn.
//
// `allowRemoteModels` is false on every path here. Weights are either bundled
// or arrive through the download route (server/semantic-routes.ts), which checks
// each file against a pinned digest — so the runtime can never make a surprise
// request mid-turn, and a half-written file can never load as a model.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";

import { resourceCandidates } from "../media/tools.js";
import { getSemanticRetrievalPreference } from "../store/store.js";
import {
  activeEmbeddingModel,
  EMBEDDING_MODEL,
  embeddingModelSpecBytes,
  type EmbeddingModelFile,
  type EmbeddingModelSpec,
} from "./model-registry.js";

// The catalogue moved to model-registry.ts when the picker landed (task 5.4).
// Re-exported here because every caller and every test already imports these
// from `./embedder.js`, and the split is an internal one.
export {
  EMBEDDING_MODEL,
  activeEmbeddingModel,
  type EmbeddingModelFile,
  type EmbeddingModelSpec,
};

/**
 * What the whole model costs to fetch. Defaults to the ACTIVE model, which is
 * the bundled one until the user picks another.
 */
export function embeddingModelBytes(spec: EmbeddingModelSpec = activeEmbeddingModel()): number {
  return embeddingModelSpecBytes(spec);
}

/** Text in, unit vectors out. The only thing tier 3 needs from a model. */
export interface Embedder {
  model: string;
  dim: number;
  embed(texts: readonly string[], role: "query" | "passage"): Promise<Float32Array[]>;
}

export type EmbedderAvailability =
  | "ready"
  | "disabled"
  | "no-runtime"
  | "no-model"
  | "failed"
  | "unknown";

export interface EmbedderStatus {
  availability: EmbedderAvailability;
  model: string;
  dim: number;
  /** Human-readable, and honest about which half is missing. */
  reason: string;
}

/**
 * The package that runs the ONNX weights. Overridable so a test can point at a
 * stub, and so an install that vendors a different runtime can say so.
 */
const DEFAULT_RUNTIME = "@huggingface/transformers";

let registered: Embedder | null = null;
let loading: Promise<Embedder | null> | null = null;
let availability: EmbedderAvailability = "unknown";
let reason = `not loaded yet — ${EMBEDDING_MODEL.id} is loaded on first use`;

/** The id the current `availability`/`loading` verdict was reached about. */
let verdictFor: string = EMBEDDING_MODEL.id;

function idleReason(spec: EmbeddingModelSpec): string {
  return `not loaded yet — ${spec.id} is loaded on first use`;
}

/** An explicit directory is the whole answer — it outranks even the bundle. */
function overrideDir(): string | null {
  const v = process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
  return v && v.trim().length > 0 ? resolve(v.trim()) : null;
}

/**
 * Where a DOWNLOADED copy is cached: <home>/models/embeddings (mirrors
 * whisper). Outside the .app, so an app update never re-downloads it — and the
 * only one of the two directories anything here writes to or deletes from.
 */
export function embeddingModelDir(): string {
  const override = overrideDir();
  if (override) return override;
  const home =
    process.env.SUPERTWIN_HOME && process.env.SUPERTWIN_HOME.trim().length > 0
      ? process.env.SUPERTWIN_HOME
      : join(homedir(), "SuperTwinV11");
  return resolve(join(home, "models", "embeddings"));
}

/** One file under `dir`, laid out the way the runtime looks a cache up. */
function fileUnder(dir: string, relative: string, spec: EmbeddingModelSpec): string {
  return join(dir, ...spec.id.split("/"), ...relative.split("/"));
}

/** Every file present at its pinned length. A short file is absent, not broken. */
function completeUnder(dir: string, spec: EmbeddingModelSpec): boolean {
  return spec.files.every((f) => bytesOnDisk(fileUnder(dir, f.path, spec)) === f.bytes);
}

/**
 * The copy that ships inside the .app (v7 §7), or null on a build that was
 * never staged. It sits at <resources>/models/embeddings/<id>/<file>, which is
 * exactly the path the runtime resolves a cached model to, so pointing
 * `env.cacheDir` at it is the whole of loading it.
 *
 * resourceCandidates() anchors on the worker bundle's own directory rather than
 * cwd — esbuild rewrites `import.meta` to `{}` in the CJS bundle, and a
 * cwd-relative path is how this class of resource resolved in the repo and
 * nowhere else inside the .app, twice.
 */
export function bundledEmbeddingModelDir(
  spec: EmbeddingModelSpec = activeEmbeddingModel(),
): string | null {
  if (overrideDir()) return null;
  // Only one entry in the catalogue ships inside the .app. An upgrade the user
  // downloaded lives under <home>/models/embeddings and nowhere else, so asking
  // <resources> about it can only ever produce a false positive.
  if (!spec.bundled) return null;
  return (
    resourceCandidates("models", "embeddings").find((dir) => completeUnder(dir, spec)) ??
    null
  );
}

/** True when the weights ship inside the app: nothing to fetch, nothing to delete. */
export function embeddingModelBundled(
  spec: EmbeddingModelSpec = activeEmbeddingModel(),
): boolean {
  return bundledEmbeddingModelDir(spec) !== null;
}

/** Where the weights are read from: the bundled copy first, the download second. */
export function embeddingModelSourceDir(
  spec: EmbeddingModelSpec = activeEmbeddingModel(),
): string {
  return bundledEmbeddingModelDir(spec) ?? embeddingModelDir();
}

/**
 * Where one of the model's files belongs once DOWNLOADED — the write path, so
 * never the bundled copy: deleting or overwriting a file inside the .app breaks
 * its signature. The argument is only ever a path out of EMBEDDING_MODEL.files,
 * never one that arrived in a request.
 */
export function embeddingModelFilePath(
  relative: string,
  spec: EmbeddingModelSpec = activeEmbeddingModel(),
): string {
  return fileUnder(embeddingModelDir(), relative, spec);
}

/**
 * Where it is fetched from: the pinned revision, never a branch.
 *
 * SUPERTWIN_EMBEDDING_MODEL_BASE_URL replaces the host for EVERY model — it is
 * a flat mirror serving one model's tree, which is what the download tests
 * point at. It does not disable the digest check; nothing does.
 */
export function embeddingModelFileUrl(
  relative: string,
  spec: EmbeddingModelSpec = activeEmbeddingModel(),
): string {
  const override = process.env.SUPERTWIN_EMBEDDING_MODEL_BASE_URL;
  const base =
    override && override.trim().length > 0
      ? override.trim().replace(/\/+$/, "")
      : `${spec.source}/resolve/${spec.revision}`;
  return `${base}/${relative}`;
}

/** One file's state on disk. A wrong length is absent, not present-but-broken. */
export interface EmbeddingFileState extends EmbeddingModelFile {
  present: boolean;
  bytesOnDisk: number | null;
}

function bytesOnDisk(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    // never staged or downloaded, or removed underneath us — it counts as absent
    return null;
  }
}

/** Reported against the copy that would load, so a bundled build reads as ready. */
export function embeddingModelFileStates(
  spec: EmbeddingModelSpec = activeEmbeddingModel(),
): EmbeddingFileState[] {
  const dir = embeddingModelSourceDir(spec);
  return spec.files.map((f) => {
    const size = bytesOnDisk(fileUnder(dir, f.path, spec));
    return { ...f, present: size === f.bytes, bytesOnDisk: size };
  });
}

/** True only when every file is on disk at its pinned length. */
export function embeddingModelPresent(
  spec: EmbeddingModelSpec = activeEmbeddingModel(),
): boolean {
  return embeddingModelFileStates(spec).every((f) => f.present);
}

function runtimeSpecifier(): string {
  const override = process.env.SUPERTWIN_EMBEDDING_RUNTIME;
  return override && override.trim().length > 0 ? override.trim() : DEFAULT_RUNTIME;
}

/** Whether the runtime is installed at all, without loading a model. */
export async function embeddingRuntimeInstalled(): Promise<boolean> {
  try {
    await import(runtimeSpecifier());
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the tier is on. The stored setting is the switch; the env var only
 * overrides it, which is what lets a test — and a support call — force it off
 * without a database.
 *
 * With no stored choice the answer is whether the WEIGHTS ARE THERE. Defaulting
 * to off made sense while the model was a 129 MB download nobody had made; now
 * that it ships inside the app, off-by-default means SEMANTIC_WEIGHT multiplies
 * zero on every row of every query until somebody finds a switch they have no
 * reason to look for — which is exactly the state the live database was found
 * in, 0 vectors against 595 embeddable. A default that depends on the files on
 * disk cannot ship inert and cannot promise something it has not got.
 */
export function semanticEnabled(): boolean {
  const env = (process.env.SUPERTWIN_SEMANTIC_RETRIEVAL ?? "").trim();
  if (env === "0") return false;
  if (env === "1") return true;
  try {
    return getSemanticRetrievalPreference() ?? embeddingModelPresent();
  } catch {
    // No database yet (early boot, a unit test): off is the safe reading.
    return false;
  }
}

/**
 * Register an embedder directly, bypassing the runtime load. Passing null
 * forgets it (and any cached failure), which is what a test teardown wants.
 */
export function setEmbedder(embedder: Embedder | null): void {
  registered = embedder;
  loading = null;
  verdictFor = embedder?.model ?? activeEmbeddingModelIdSafe();
  if (embedder) {
    availability = "ready";
    reason = `using registered embedder ${embedder.model} (${embedder.dim}d)`;
  } else {
    availability = "unknown";
    reason = idleReason(activeEmbeddingModel());
  }
}

/** The active id without ever throwing — used in the reset paths above. */
function activeEmbeddingModelIdSafe(): string {
  return activeEmbeddingModel().id;
}

/**
 * The embedder, or null. Never throws and never reaches the network: the
 * weights are on disk already or this returns null. A failure is remembered,
 * so a chat turn pays for a missing runtime exactly once.
 */
export function getEmbedder(): Promise<Embedder | null> {
  if (registered) return Promise.resolve(registered);
  if (!semanticEnabled()) {
    availability = "disabled";
    reason = "semantic search is switched off in Settings";
    return Promise.resolve(null);
  }
  // A swap moved the pointer. Every remembered verdict was about a DIFFERENT
  // model's files, so none of it is an answer about this one.
  const active = activeEmbeddingModel();
  if (verdictFor !== active.id) {
    verdictFor = active.id;
    availability = "unknown";
    loading = null;
    reason = idleReason(active);
  }
  if (availability === "no-runtime" || availability === "failed") {
    return Promise.resolve(null);
  }
  // The weights arrive out of band, so "not here yet" is re-checked rather
  // than remembered — that is how a finished download becomes usable without
  // a restart.
  if (availability === "no-model") {
    if (!embeddingModelPresent()) return Promise.resolve(null);
    availability = "unknown";
  }
  if (!loading) loading = load();
  return loading;
}

async function load(): Promise<Embedder | null> {
  const spec = activeEmbeddingModel();
  verdictFor = spec.id;
  if (!embeddingModelPresent(spec)) {
    availability = "no-model";
    reason =
      `semantic search is off: ${spec.id} is not downloaded yet ` +
      `(${Math.round(embeddingModelBytes(spec) / 1024 / 1024)} MB)`;
    loading = null;
    return null;
  }

  const specifier = runtimeSpecifier();
  let mod: TransformersModule;
  try {
    // A RUNTIME specifier on purpose: esbuild must not pull 35 MB of native
    // onnxruntime into the worker bundle, and an install without the package
    // has to degrade rather than fail to link.
    mod = (await import(specifier)) as TransformersModule;
  } catch (err) {
    availability = "no-runtime";
    reason = `semantic search is off: ${specifier} is not installed (${(err as Error).message})`;
    loading = null;
    return null;
  }

  try {
    const embedder = await buildEmbedder(mod, spec);
    availability = "ready";
    reason = `${spec.id} (${spec.dim}d) loaded from ${embeddingModelSourceDir(spec)}`;
    return embedder;
  } catch (err) {
    availability = "failed";
    reason = `semantic search is off: ${spec.id} could not be loaded (${(err as Error).message})`;
    loading = null;
    return null;
  }
}

/** Point the runtime at one model's directory and build its pipeline. */
async function buildEmbedder(
  mod: TransformersModule,
  spec: EmbeddingModelSpec,
): Promise<Embedder> {
  const dir = embeddingModelSourceDir(spec);
  mod.env.cacheDir = dir;
  mod.env.allowLocalModels = true;
  // Never true. Weights are bundled or downloaded, and both are verified.
  mod.env.allowRemoteModels = false;
  const pipe = await mod.pipeline("feature-extraction", spec.id, { dtype: spec.dtype });
  return wrap(pipe, spec);
}

/**
 * An embedder for ONE named model, independent of whichever one is active.
 *
 * This is what makes both halves of task 5.4 possible without ever putting the
 * live index at risk: the benchmark runs the CANDIDATE beside the active model
 * on the same messages, and a swap builds the whole new index while the old
 * model is still the one answering questions. Nothing here touches the
 * singleton, the cached verdict, or `event_embeddings`.
 *
 * Throws rather than returning null, because every caller asked for THIS model
 * by name and "it did not load" is the answer they need, in words.
 */
export async function loadEmbedderFor(spec: EmbeddingModelSpec): Promise<Embedder> {
  if (!embeddingModelPresent(spec)) {
    throw new Error(`${spec.id} is not downloaded yet`);
  }
  const specifier = runtimeSpecifier();
  let mod: TransformersModule;
  try {
    mod = (await import(specifier)) as TransformersModule;
  } catch (err) {
    throw new Error(`${specifier} is not installed (${(err as Error).message})`);
  }
  return buildEmbedder(mod, spec);
}

/**
 * Load the model now and report what happened. Called when the user switches
 * the tier on and when a download finishes, so Settings learns whether it
 * works from a real load rather than from four files existing.
 */
export async function ensureEmbeddingModel(): Promise<EmbedderStatus> {
  // A remembered verdict was about a different set of files on disk.
  if (availability !== "ready") {
    availability = "unknown";
    loading = null;
  }
  await getEmbedder();
  return embedderStatus();
}

export function embedderStatus(): EmbedderStatus {
  const spec = activeEmbeddingModel();
  return {
    availability,
    model: registered?.model ?? spec.id,
    dim: registered?.dim ?? spec.dim,
    reason,
  };
}

/**
 * Drop whatever is loaded and any remembered verdict, so the next call decides
 * again from what is on disk. What the switch, a finished download and a delete
 * all need — and what a test teardown needs.
 */
export function forgetEmbedder(): void {
  registered = null;
  loading = null;
  availability = "unknown";
  verdictFor = activeEmbeddingModelIdSafe();
  reason = idleReason(activeEmbeddingModel());
}

// ---- Runtime adapter ------------------------------------------------------
//
// Structural types for the one function and one object this uses. Typed here
// rather than imported so the package stays out of the bundler's graph, which
// is the whole point of loading it by specifier.

interface FeatureTensor {
  data: Float32Array | number[];
  dims: number[];
}

type FeaturePipeline = (
  input: readonly string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureTensor>;

interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
    options: { dtype: string },
  ): Promise<FeaturePipeline>;
  env: {
    cacheDir: string;
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
  };
}

function wrap(pipe: FeaturePipeline, spec: EmbeddingModelSpec): Embedder {
  return {
    model: spec.id,
    dim: spec.dim,
    async embed(texts, role) {
      if (texts.length === 0) return [];
      const prefix = role === "query" ? spec.queryPrefix : spec.passagePrefix;
      const out = await pipe(
        texts.map((t) => `${prefix}${t}`),
        { pooling: "mean", normalize: true },
      );
      return splitTensor(out, texts.length, spec.dim);
    },
  };
}

/**
 * [n, dim] arrives as one flat buffer. A shape that disagrees with the model's
 * declared dimension is a wrong answer in a space where nothing looks wrong, so
 * it throws rather than reshaping around it.
 */
export function splitTensor(
  tensor: FeatureTensor,
  count: number,
  dim: number,
): Float32Array[] {
  const data =
    tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
  if (data.length !== count * dim) {
    throw new Error(
      `embedder returned ${data.length} floats for ${count} texts, expected ${count * dim}`,
    );
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) out.push(data.slice(i * dim, (i + 1) * dim));
  return out;
}
