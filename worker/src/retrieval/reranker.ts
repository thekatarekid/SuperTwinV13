// ===========================================================================
// The cross-encoder reranker (V6 P1 S2.4; Build §5.2, Product_V6 §23 —
// "bge-reranker class, local").
//
// A bi-encoder scores a question and a passage that never met: two vectors,
// one cosine. A cross-encoder reads them TOGETHER — one forward pass over the
// pair — and that is why it is more precise and why it cannot be an index:
// it costs a model pass per candidate, so it runs on the fused top window
// (semantic.ts, RERANK_WINDOW), never on the corpus.
//
// Three sources of a reranker, in order:
//
//   1. setReranker(r) — a registered instance. The test seam, and how the
//      deterministic fallback is wired in a suite (LEXICAL_OVERLAP_RERANKER).
//   2. The registry model (RERANKER_MODEL, model-registry.ts) when its weights
//      are on disk at their pinned lengths and the runtime imports. Loaded once,
//      remembered; never reaches the network (allowRemoteModels = false).
//   3. null — and the fusion layer keeps the RRF order. Retrieval without a
//      reranker is retrieval, just less precise.
//
// SUPERTWIN_RERANKER=off turns it off; =lexical selects the deterministic one
// (what a CI box without the 278 MB download runs).
//
// Zero model calls in the `claude` sense anywhere here: this is a local ONNX
// classifier, and the fallback is arithmetic over tokens.
// ===========================================================================

import {
  embeddingModelPresent,
  embeddingModelSourceDir,
} from "./embedder.js";
import { RERANKER_MODEL, type RerankerModelSpec } from "./model-registry.js";

/** (question, passages) in, one relevance in 0..1 per passage out, same order. */
export interface Reranker {
  model: string;
  score(query: string, passages: readonly string[]): Promise<number[]>;
}

export type RerankerAvailability =
  | "ready"
  | "disabled"
  | "no-runtime"
  | "no-model"
  | "failed"
  | "unknown";

export interface RerankerStatus {
  availability: RerankerAvailability;
  model: string;
  reason: string;
}

/** Pairs per forward pass. The window is 50; two passes at most. */
export const RERANK_BATCH = 16;

/** Chars of a passage handed to the cross-encoder — it truncates at 512 tokens anyway. */
export const MAX_RERANK_PASSAGE_CHARS = 1200;

const DEFAULT_RUNTIME = "@huggingface/transformers";

let registered: Reranker | null = null;
let loading: Promise<Reranker | null> | null = null;
let availability: RerankerAvailability = "unknown";
let reason = "reranker not loaded yet";

// ---- The deterministic fallback -------------------------------------------

function overlapTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Token overlap as a relevance: the share of the question's distinct tokens
 * the passage contains, softened by a length prior so a passage that is the
 * question plus one word outranks one that is the question plus a page. It is
 * a fixture that behaves like a reranker — monotone in overlap, deterministic,
 * 0..1 — not a claim about language. Tests and CI use it; production only on
 * SUPERTWIN_RERANKER=lexical.
 */
export const LEXICAL_OVERLAP_RERANKER: Reranker = {
  model: "lexical-overlap-v1",
  async score(query, passages) {
    const q = new Set(overlapTokens(query));
    if (q.size === 0) return passages.map(() => 0);
    return passages.map((p) => {
      const tokens = overlapTokens(p);
      if (tokens.length === 0) return 0;
      const set = new Set(tokens);
      let hit = 0;
      for (const t of q) if (set.has(t)) hit++;
      const overlap = hit / q.size;
      const lengthPrior = 1 / (1 + Math.log1p(Math.max(0, tokens.length - hit)) / 8);
      return Math.min(1, overlap * lengthPrior);
    });
  },
};

// ---- Selection -------------------------------------------------------------

function mode(): "auto" | "off" | "lexical" {
  const raw = (process.env.SUPERTWIN_RERANKER ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "lexical") return "lexical";
  return "auto";
}

/** Register an instance (tests, or an operator seam). null clears it. */
export function setReranker(reranker: Reranker | null): void {
  registered = reranker;
  loading = null;
  availability = reranker ? "ready" : "unknown";
  reason = reranker ? `${reranker.model} registered` : "reranker not loaded yet";
}

/**
 * The reranker, or null. Never throws and never reaches the network; a failure
 * is remembered so a turn pays for a missing runtime exactly once. "Not
 * downloaded yet" is re-checked, so a finished download becomes usable without
 * a restart.
 */
export function getReranker(spec: RerankerModelSpec = RERANKER_MODEL): Promise<Reranker | null> {
  if (registered) return Promise.resolve(registered);
  const m = mode();
  if (m === "off") {
    availability = "disabled";
    reason = "reranker is switched off (SUPERTWIN_RERANKER=off)";
    return Promise.resolve(null);
  }
  if (m === "lexical") {
    availability = "ready";
    reason = `${LEXICAL_OVERLAP_RERANKER.model} selected (SUPERTWIN_RERANKER=lexical)`;
    return Promise.resolve(LEXICAL_OVERLAP_RERANKER);
  }
  if (availability === "no-runtime" || availability === "failed") return Promise.resolve(null);
  if (availability === "no-model") {
    if (!embeddingModelPresent(spec)) return Promise.resolve(null);
    availability = "unknown";
  }
  if (!loading) loading = load(spec);
  return loading;
}

async function load(spec: RerankerModelSpec): Promise<Reranker | null> {
  if (!embeddingModelPresent(spec)) {
    availability = "no-model";
    reason = `reranker is off: ${spec.id} is not downloaded yet`;
    loading = null;
    return null;
  }
  const specifier = runtimeSpecifier();
  let mod: RerankerRuntime;
  try {
    mod = (await import(specifier)) as RerankerRuntime;
  } catch (err) {
    availability = "no-runtime";
    reason = `reranker is off: ${specifier} is not installed (${(err as Error).message})`;
    loading = null;
    return null;
  }
  try {
    const reranker = await buildReranker(mod, spec);
    availability = "ready";
    reason = `${spec.id} loaded from ${embeddingModelSourceDir(spec)}`;
    return reranker;
  } catch (err) {
    availability = "failed";
    reason = `reranker is off: ${spec.id} could not be loaded (${(err as Error).message})`;
    loading = null;
    return null;
  }
}

export function rerankerStatus(): RerankerStatus {
  return { availability, model: registered?.model ?? RERANKER_MODEL.id, reason };
}

/** Drop what is loaded and every remembered verdict (a finished download, a test teardown). */
export function forgetReranker(): void {
  registered = null;
  loading = null;
  availability = "unknown";
  reason = "reranker not loaded yet";
}

function runtimeSpecifier(): string {
  const override = process.env.SUPERTWIN_EMBEDDING_RUNTIME;
  return override && override.trim().length > 0 ? override.trim() : DEFAULT_RUNTIME;
}

// ---- Runtime adapter -------------------------------------------------------
//
// Structural types for the two classes this uses, typed here so the package
// stays out of the bundler's graph (it is loaded by specifier, like the
// encoder). A sequence-classification head over (query, passage) pairs returns
// logits [n, 1]; sigmoid turns a logit into the 0..1 the fusion layer spends.

interface LogitTensor {
  data: Float32Array | number[];
  dims: number[];
}

interface RerankerTokenizer {
  (
    text: readonly string[],
    options: { text_pair: readonly string[]; padding: boolean; truncation: boolean },
  ): unknown;
}

interface RerankerModel {
  (inputs: unknown): Promise<{ logits: LogitTensor }>;
}

interface RerankerRuntime {
  AutoTokenizer: { from_pretrained(model: string): Promise<RerankerTokenizer> };
  AutoModelForSequenceClassification: {
    from_pretrained(model: string, options: { dtype: string }): Promise<RerankerModel>;
  };
  env: { cacheDir: string; allowLocalModels: boolean; allowRemoteModels: boolean };
}

async function buildReranker(mod: RerankerRuntime, spec: RerankerModelSpec): Promise<Reranker> {
  mod.env.cacheDir = embeddingModelSourceDir(spec);
  mod.env.allowLocalModels = true;
  // Never true. Weights arrive through the verified download route or not at all.
  mod.env.allowRemoteModels = false;
  const tokenizer = await mod.AutoTokenizer.from_pretrained(spec.id);
  const model = await mod.AutoModelForSequenceClassification.from_pretrained(spec.id, {
    dtype: spec.dtype,
  });
  return {
    model: spec.id,
    async score(query, passages) {
      const out: number[] = [];
      for (let i = 0; i < passages.length; i += RERANK_BATCH) {
        const batch = passages
          .slice(i, i + RERANK_BATCH)
          .map((p) => (p.length > MAX_RERANK_PASSAGE_CHARS ? p.slice(0, MAX_RERANK_PASSAGE_CHARS) : p));
        const inputs = tokenizer(
          batch.map(() => query),
          { text_pair: batch, padding: true, truncation: true },
        );
        const { logits } = await model(inputs);
        out.push(...splitLogits(logits, batch.length));
      }
      return out;
    },
  };
}

/** [n, 1] logits → n sigmoids. A shape that disagrees with n is a wrong answer, so it throws. */
export function splitLogits(tensor: LogitTensor, count: number): number[] {
  const data = tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
  if (data.length !== count) {
    throw new Error(`reranker returned ${data.length} logits for ${count} pairs`);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(1 / (1 + Math.exp(-data[i])));
  return out;
}
