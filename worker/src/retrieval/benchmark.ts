// The on-corpus benchmark (V1 Part 8, task 5.4).
//
// "embeddinggemma is 2.1× better" is a claim about somebody else's corpus. This
// runs the candidate against the active model on THE USER'S OWN MESSAGES and
// reports two things it actually measured:
//
//   - OVERLAP@K. For each probe, the top-K neighbours the active model returns
//     and the top-K the candidate returns, intersected. High overlap means the
//     candidate would put the same messages in front of Claude — so the swap
//     buys nothing. Low overlap means it ranks differently.
//   - MS/EVENT. Wall-clock per message, both models, on this machine.
//
// What it deliberately does NOT do is claim which ranking is BETTER. There are
// no labels here — nobody has said which neighbour was the right one — so a
// benchmark that scored quality would be scoring its own guess. The card says
// how much would change and what it would cost, and leaves the judgement where
// it belongs.
//
// Everything below is arithmetic over measured numbers. No model is asked
// anything, and nothing a model produced is edited or discarded.

import {
  activeEmbeddingModel,
  findEmbeddingModel,
  type EmbeddingModelSpec,
} from "./model-registry.js";
import { loadEmbedderFor, type Embedder } from "./embedder.js";
import { cosine } from "./semantic.js";
import { readCorpus } from "./model-swap.js";

/** Messages sampled by default. Big enough for a stable overlap, small enough to wait for. */
export const DEFAULT_BENCHMARK_SAMPLE = 120;

/** Neighbours compared per probe. The shortlist assign and chat actually use. */
export const DEFAULT_BENCHMARK_K = 8;

/** Probes drawn from the sample. Each one costs two query embeddings. */
export const DEFAULT_BENCHMARK_PROBES = 20;

export interface BenchmarkResult {
  activeModel: string;
  candidateModel: string;
  /** Messages embedded by each model. */
  sampleSize: number;
  /** Probe messages whose neighbour lists were compared. */
  probes: number;
  k: number;
  /** 0..1 — how much of each top-K list the two models agree on. */
  overlapAtK: number;
  activeMsPerEvent: number;
  candidateMsPerEvent: number;
  /** candidate ÷ active. Above 1 means the candidate is slower. */
  speedRatio: number;
  /**
   * Composed from the numbers above by the rule stated in `recommendation`.
   * It is a summary of a measurement, not a verdict on anything a model said.
   */
  recommendation: string;
  ranAt: string;
}

export interface BenchmarkOptions {
  sample?: number;
  k?: number;
  probes?: number;
  /** Test seam: build an embedder without the ONNX runtime. */
  loadEmbedder?(spec: EmbeddingModelSpec): Promise<Embedder>;
}

/**
 * Run the candidate beside the active model on a sample of the user's events.
 *
 * Throws on a request that cannot be run — an unknown id, the active model, an
 * empty corpus, a model that will not load. It never half-answers.
 */
export async function runEmbeddingBenchmark(
  candidateId: string,
  opts: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const candidate = findEmbeddingModel(candidateId);
  if (!candidate) throw new Error(`unknown embedding model: ${candidateId}`);
  const active = activeEmbeddingModel();
  if (candidate.id === active.id) {
    throw new Error(`${candidate.id} is already the model in use`);
  }

  const sampleSize = clamp(opts.sample ?? DEFAULT_BENCHMARK_SAMPLE, 8, 1000);
  const k = clamp(opts.k ?? DEFAULT_BENCHMARK_K, 1, 50);

  const rows = readCorpus(sampleSize);
  if (rows.length < 2) {
    throw new Error("there are not enough messages here to benchmark against yet");
  }
  const texts = rows.map((r) => r.text);
  const probes = Math.min(clamp(opts.probes ?? DEFAULT_BENCHMARK_PROBES, 1, 200), rows.length);
  const effectiveK = Math.min(k, rows.length - 1);

  const load = opts.loadEmbedder ?? loadEmbedderFor;
  const [activeEmbedder, candidateEmbedder] = [await load(active), await load(candidate)];

  const a = await measure(activeEmbedder, texts, texts.slice(0, probes));
  const b = await measure(candidateEmbedder, texts, texts.slice(0, probes));

  let agreed = 0;
  for (let i = 0; i < probes; i++) {
    const left = topK(a.queries[i], a.passages, i, effectiveK);
    const right = topK(b.queries[i], b.passages, i, effectiveK);
    const rightSet = new Set(right);
    agreed += left.filter((idx) => rightSet.has(idx)).length / effectiveK;
  }
  const overlapAtK = probes > 0 ? agreed / probes : 0;

  const activeMsPerEvent = a.ms / texts.length;
  const candidateMsPerEvent = b.ms / texts.length;
  const speedRatio = activeMsPerEvent > 0 ? candidateMsPerEvent / activeMsPerEvent : 0;

  return {
    activeModel: active.id,
    candidateModel: candidate.id,
    sampleSize: texts.length,
    probes,
    k: effectiveK,
    overlapAtK,
    activeMsPerEvent,
    candidateMsPerEvent,
    speedRatio,
    recommendation: recommend({
      candidate,
      overlapAtK,
      speedRatio,
      sampleSize: texts.length,
    }),
    ranAt: new Date().toISOString(),
  };
}

interface Measured {
  passages: Float32Array[];
  queries: Float32Array[];
  ms: number;
}

/** One model's whole share of the work, timed as the user would feel it. */
async function measure(
  embedder: Embedder,
  texts: readonly string[],
  probeTexts: readonly string[],
): Promise<Measured> {
  const startedAt = Date.now();
  const passages = await embedder.embed(texts, "passage");
  const queries = await embedder.embed(probeTexts, "query");
  return { passages, queries, ms: Date.now() - startedAt };
}

/** Indices of the `k` nearest passages to `probe`, excluding the probe itself. */
function topK(
  probe: Float32Array,
  passages: readonly Float32Array[],
  self: number,
  k: number,
): number[] {
  const scored: { i: number; sim: number }[] = [];
  for (let i = 0; i < passages.length; i++) {
    if (i === self) continue;
    scored.push({ i, sim: cosine(probe, passages[i]) });
  }
  scored.sort((x, y) => y.sim - x.sim || x.i - y.i);
  return scored.slice(0, k).map((s) => s.i);
}

/**
 * The card's sentence. Built from the measurements and from a rule stated in
 * the sentence itself, so a reader can disagree with the rule rather than
 * having to trust it.
 */
function recommend(input: {
  candidate: EmbeddingModelSpec;
  overlapAtK: number;
  speedRatio: number;
  sampleSize: number;
}): string {
  const name = input.candidate.upstream ?? input.candidate.id;
  const agrees = `${Math.round(input.overlapAtK * 100)}%`;
  const speed =
    input.speedRatio >= 1.05
      ? `${input.speedRatio.toFixed(1)}× slower per message`
      : input.speedRatio <= 0.95
        ? `${(1 / input.speedRatio).toFixed(1)}× faster per message`
        : "about the same speed";
  const head = `${name} picks the same messages ${agrees} of the time on ${input.sampleSize} of your own, and is ${speed}.`;

  if (input.overlapAtK >= 0.9) {
    return `${head} It would change very little of what Claude sees — not worth the swap unless you want the extra dimensions for something else.`;
  }
  if (input.speedRatio > 3) {
    return `${head} It ranks your messages differently often enough to matter, but at that cost the index takes noticeably longer to build. Nothing here can say which ranking is better — only that they differ.`;
  }
  return `${head} It ranks your messages differently often enough to be worth trying. Nothing here can say which ranking is better, and the old index keeps answering until the new one is built — so a swap is reversible.`;
}

function clamp(raw: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ---- Last result ----------------------------------------------------------
//
// Kept in memory rather than a table: it describes a machine's speed at a
// moment, it is cheap to re-run, and a stale one read back after a reboot
// would be a measurement of a different machine state.

let last: BenchmarkResult | null = null;
let running: string | null = null;

export function lastBenchmark(): BenchmarkResult | null {
  return last;
}

/** Which candidate is being measured right now, if any. */
export function benchmarkRunning(): string | null {
  return running;
}

/** Run one and remember it. Refuses to run two at once — they would time each other. */
export async function runAndRemember(
  candidateId: string,
  opts?: BenchmarkOptions,
): Promise<BenchmarkResult> {
  if (running) throw new Error(`a benchmark of ${running} is already running`);
  running = candidateId;
  try {
    last = await runEmbeddingBenchmark(candidateId, opts);
    return last;
  } finally {
    running = null;
  }
}

export function resetBenchmarkForTests(): void {
  last = null;
  running = null;
}
