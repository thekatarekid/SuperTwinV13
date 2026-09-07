export const PROBE_CONCURRENCY_RUNGS = [1, 4, 8, 16] as const;
export type ProbeConcurrencyRung = (typeof PROBE_CONCURRENCY_RUNGS)[number];
export type ProbeCacheMode = "none" | "implicit" | "explicit";

const MAX_SAFE_COUNTER = 1_000_000_000_000;

export interface SanitizedProbeMetric {
  concurrency: ProbeConcurrencyRung;
  startedAtMs: number;
  completedAtMs: number;
  succeeded: boolean;
  rateLimited: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  activeSockets?: number;
}

export interface ProbeRungMetrics {
  concurrency: ProbeConcurrencyRung;
  attempts: number;
  completions: number;
  failures: number;
  rateLimits: number;
  peakOverlap: number;
  elapsedMs: number;
  firstCompletionMs: number;
  completionsPerSecond: number;
  projectedCallsPerHour: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheReadDeltaFromPreviousRung?: number;
  cacheWriteDeltaFromPreviousRung?: number;
  peakRssBytes: number;
  peakHeapUsedBytes: number;
  peakActiveSockets: number;
}

export interface ProbeConcurrencyMetrics {
  rungs: ProbeRungMetrics[];
  concurrency8CeilingInputs: {
    peakOverlap: number;
    completionsPerSecond: number;
    projectedCallsPerHour: number;
    failures: number;
    rateLimits: number;
  };
}

export interface CacheBehaviorSample {
  mode: ProbeCacheMode;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}

export interface CacheModeMetrics extends CacheBehaviorSample {
  cacheReadPercent: number;
  cacheWritePercent: number;
}

export interface ProbeCacheComparison {
  modes: CacheModeMetrics[];
  implicitReadDeltaFromNone: number;
  implicitWriteDeltaFromNone: number;
  explicitReadDeltaFromNone: number;
  explicitWriteDeltaFromNone: number;
}

function boundedNumber(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a finite non-negative bounded number`);
  }
  return value;
}

function tokenCounter(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : boundedNumber(value, label, MAX_SAFE_COUNTER);
}

function requiredTokenCounter(value: unknown, label: string): number {
  const bounded = tokenCounter(value, label);
  if (bounded === undefined) throw new Error(`${label} must be present for cache measurement`);
  return bounded;
}

function validateSample(sample: SanitizedProbeMetric): void {
  if (!PROBE_CONCURRENCY_RUNGS.includes(sample.concurrency)) {
    throw new Error("Probe metric has an unsupported concurrency rung");
  }
  const start = boundedNumber(sample.startedAtMs, "startedAtMs");
  const end = boundedNumber(sample.completedAtMs, "completedAtMs");
  if (end <= start) throw new Error("Probe metric completion must follow its start");
  if (typeof sample.succeeded !== "boolean" || typeof sample.rateLimited !== "boolean") {
    throw new Error("Probe metric outcome flags must be boolean");
  }
  if (sample.succeeded && sample.rateLimited) {
    throw new Error("A rate-limited probe metric cannot be successful");
  }
  const input = tokenCounter(sample.inputTokens, "inputTokens");
  tokenCounter(sample.outputTokens, "outputTokens");
  const read = tokenCounter(sample.cachedInputTokens, "cachedInputTokens");
  const write = tokenCounter(sample.cacheWriteInputTokens, "cacheWriteInputTokens");
  boundedNumber(sample.rssBytes ?? 0, "rssBytes", MAX_SAFE_COUNTER);
  boundedNumber(sample.heapUsedBytes ?? 0, "heapUsedBytes", MAX_SAFE_COUNTER);
  boundedNumber(sample.activeSockets ?? 0, "activeSockets", MAX_SAFE_COUNTER);
  if (input !== undefined && (read !== undefined && read > input || write !== undefined && write > input)) {
    throw new Error("Cache token counters cannot exceed input tokens");
  }
}

function peakOverlap(samples: readonly SanitizedProbeMetric[]): number {
  const boundaries = samples.flatMap((sample) => [
    { at: sample.startedAtMs, delta: 1 },
    { at: sample.completedAtMs, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  for (const boundary of boundaries) {
    active += boundary.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function rungMetrics(
  concurrency: ProbeConcurrencyRung,
  samples: readonly SanitizedProbeMetric[],
): ProbeRungMetrics {
  const startedAt = Math.min(...samples.map((sample) => sample.startedAtMs));
  const completedAt = Math.max(...samples.map((sample) => sample.completedAtMs));
  const firstCompletedAt = Math.min(...samples.map((sample) => sample.completedAtMs));
  const elapsedMs = completedAt - startedAt;
  const completions = samples.filter((sample) => sample.succeeded).length;
  const completionsPerSecond = completions * 1_000 / elapsedMs;
  const reads = samples.map((sample) => tokenCounter(sample.cachedInputTokens, "cachedInputTokens"));
  const writes = samples.map((sample) => tokenCounter(sample.cacheWriteInputTokens, "cacheWriteInputTokens"));
  return {
    concurrency,
    attempts: samples.length,
    completions,
    failures: samples.length - completions,
    rateLimits: samples.filter((sample) => sample.rateLimited).length,
    peakOverlap: peakOverlap(samples),
    elapsedMs,
    firstCompletionMs: firstCompletedAt - startedAt,
    completionsPerSecond,
    projectedCallsPerHour: completionsPerSecond * 3_600,
    ...(reads.every((value) => value !== undefined)
      ? { cacheReadTokens: reads.reduce((total, value) => total + value!, 0) }
      : {}),
    ...(writes.every((value) => value !== undefined)
      ? { cacheWriteTokens: writes.reduce((total, value) => total + value!, 0) }
      : {}),
    peakRssBytes: Math.max(...samples.map((sample) => boundedNumber(sample.rssBytes ?? 0, "rssBytes", MAX_SAFE_COUNTER))),
    peakHeapUsedBytes: Math.max(...samples.map((sample) => boundedNumber(sample.heapUsedBytes ?? 0, "heapUsedBytes", MAX_SAFE_COUNTER))),
    peakActiveSockets: Math.max(...samples.map((sample) => boundedNumber(sample.activeSockets ?? 0, "activeSockets", MAX_SAFE_COUNTER))),
  };
}

export function summarizeProbeConcurrency(
  samples: readonly SanitizedProbeMetric[],
): ProbeConcurrencyMetrics {
  if (samples.length !== 29) throw new Error("Concurrency evidence must contain exactly 1+4+8+16 samples");
  for (const sample of samples) validateSample(sample);
  const rungs = PROBE_CONCURRENCY_RUNGS.map((concurrency) => {
    const matches = samples.filter((sample) => sample.concurrency === concurrency);
    if (matches.length !== concurrency) {
      throw new Error(`Concurrency ${concurrency} evidence must contain exactly ${concurrency} samples`);
    }
    return rungMetrics(concurrency, matches);
  });
  for (let index = 1; index < rungs.length; index += 1) {
    const current = rungs[index]!;
    const previous = rungs[index - 1]!;
    if (current.cacheReadTokens !== undefined && previous.cacheReadTokens !== undefined) {
      current.cacheReadDeltaFromPreviousRung = current.cacheReadTokens - previous.cacheReadTokens;
    }
    if (current.cacheWriteTokens !== undefined && previous.cacheWriteTokens !== undefined) {
      current.cacheWriteDeltaFromPreviousRung = current.cacheWriteTokens - previous.cacheWriteTokens;
    }
  }
  const concurrency8 = rungs.find((rung) => rung.concurrency === 8)!;
  return {
    rungs,
    concurrency8CeilingInputs: {
      peakOverlap: concurrency8.peakOverlap,
      completionsPerSecond: concurrency8.completionsPerSecond,
      projectedCallsPerHour: concurrency8.projectedCallsPerHour,
      failures: concurrency8.failures,
      rateLimits: concurrency8.rateLimits,
    },
  };
}

function cacheModeMetrics(sample: CacheBehaviorSample): CacheModeMetrics {
  const input = requiredTokenCounter(sample.inputTokens, "inputTokens");
  const read = requiredTokenCounter(sample.cachedInputTokens, "cachedInputTokens");
  const write = requiredTokenCounter(sample.cacheWriteInputTokens, "cacheWriteInputTokens");
  if (read > input || write > input) throw new Error("Cache token counters cannot exceed input tokens");
  return {
    mode: sample.mode,
    inputTokens: input,
    cachedInputTokens: read,
    cacheWriteInputTokens: write,
    cacheReadPercent: input === 0 ? 0 : read * 100 / input,
    cacheWritePercent: input === 0 ? 0 : write * 100 / input,
  };
}

export function compareProbeCacheBehavior(
  samples: readonly CacheBehaviorSample[],
): ProbeCacheComparison {
  if (samples.length !== 3) throw new Error("Cache comparison requires none, implicit, and explicit samples");
  const byMode = new Map<ProbeCacheMode, CacheModeMetrics>();
  for (const sample of samples) {
    if (!(["none", "implicit", "explicit"] as const).includes(sample.mode) || byMode.has(sample.mode)) {
      throw new Error("Cache comparison modes must be unique and supported");
    }
    byMode.set(sample.mode, cacheModeMetrics(sample));
  }
  const none = byMode.get("none");
  const implicit = byMode.get("implicit");
  const explicit = byMode.get("explicit");
  if (!none || !implicit || !explicit) {
    throw new Error("Cache comparison requires none, implicit, and explicit samples");
  }
  return {
    modes: [none, implicit, explicit],
    implicitReadDeltaFromNone: implicit.cachedInputTokens - none.cachedInputTokens,
    implicitWriteDeltaFromNone: implicit.cacheWriteInputTokens - none.cacheWriteInputTokens,
    explicitReadDeltaFromNone: explicit.cachedInputTokens - none.cachedInputTokens,
    explicitWriteDeltaFromNone: explicit.cacheWriteInputTokens - none.cacheWriteInputTokens,
  };
}
