import { describe, expect, it } from "vitest";

import {
  compareProbeCacheBehavior,
  summarizeProbeConcurrency,
  type SanitizedProbeMetric,
} from "./metrics.js";

function ladder(): SanitizedProbeMetric[] {
  return ([1, 4, 8, 16] as const).flatMap((concurrency, rung) =>
    Array.from({ length: concurrency }, (_, index) => ({
      concurrency,
      startedAtMs: rung * 10_000 + index * 10,
      completedAtMs: rung * 10_000 + 1_000 + index * 10,
      succeeded: !(concurrency === 8 && index === 7),
      rateLimited: concurrency === 8 && index === 7,
      inputTokens: 100,
      outputTokens: 2,
      cachedInputTokens: index,
      cacheWriteInputTokens: rung,
    })),
  );
}

describe("Phase 0b concurrency evidence", () => {
  it("summarizes exact rungs, overlap, throughput, cache deltas, and C8 ceiling inputs", () => {
    const evidence = summarizeProbeConcurrency(ladder());
    expect(evidence.rungs.map((rung) => [rung.concurrency, rung.attempts])).toEqual([
      [1, 1], [4, 4], [8, 8], [16, 16],
    ]);
    expect(evidence.rungs[0]).toMatchObject({
      completions: 1,
      failures: 0,
      peakOverlap: 1,
      elapsedMs: 1_000,
      firstCompletionMs: 1_000,
      completionsPerSecond: 1,
      projectedCallsPerHour: 3_600,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(evidence.rungs[1]).toMatchObject({
      peakOverlap: 4,
      cacheReadTokens: 6,
      cacheReadDeltaFromPreviousRung: 6,
      cacheWriteDeltaFromPreviousRung: 4,
    });
    expect(evidence.concurrency8CeilingInputs).toMatchObject({
      peakOverlap: 8,
      failures: 1,
      rateLimits: 1,
    });
    expect(evidence.concurrency8CeilingInputs.completionsPerSecond).toBeCloseTo(7 / 1.07);
    expect(JSON.stringify(evidence)).not.toContain("prompt");
  });

  it("rejects wrong counts, unsupported rungs, invalid times, and unsafe counters", () => {
    expect(() => summarizeProbeConcurrency(ladder().slice(1))).toThrow(/exactly 1\+4\+8\+16/);
    const wrongRung = ladder();
    wrongRung[0] = { ...wrongRung[0]!, concurrency: 2 as 1 };
    expect(() => summarizeProbeConcurrency(wrongRung)).toThrow(/unsupported concurrency/);
    const badTime = ladder();
    badTime[0] = { ...badTime[0]!, completedAtMs: badTime[0]!.startedAtMs };
    expect(() => summarizeProbeConcurrency(badTime)).toThrow(/completion must follow/);
    const nan = ladder();
    nan[0] = { ...nan[0]!, inputTokens: Number.NaN };
    expect(() => summarizeProbeConcurrency(nan)).toThrow(/finite non-negative bounded/);
    const negative = ladder();
    negative[0] = { ...negative[0]!, cachedInputTokens: -1 };
    expect(() => summarizeProbeConcurrency(negative)).toThrow(/finite non-negative bounded/);
  });

  it("preserves absent cache counters instead of reporting observed zero", () => {
    const samples = ladder().map(({ cachedInputTokens: _read, cacheWriteInputTokens: _write, ...sample }) => sample);
    const evidence = summarizeProbeConcurrency(samples);
    expect(evidence.rungs.every((rung) =>
      rung.cacheReadTokens === undefined && rung.cacheWriteTokens === undefined,
    )).toBe(true);
  });
});

describe("Phase 0b cache behavior evidence", () => {
  it("compares none, implicit, and explicit counters without content", () => {
    expect(compareProbeCacheBehavior([
      { mode: "explicit", inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 10 },
      { mode: "none", inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      { mode: "implicit", inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 20 },
    ])).toEqual({
      modes: [
        { mode: "none", inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheReadPercent: 0, cacheWritePercent: 0 },
        { mode: "implicit", inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 20, cacheReadPercent: 40, cacheWritePercent: 20 },
        { mode: "explicit", inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 10, cacheReadPercent: 70, cacheWritePercent: 10 },
      ],
      implicitReadDeltaFromNone: 40,
      implicitWriteDeltaFromNone: 20,
      explicitReadDeltaFromNone: 70,
      explicitWriteDeltaFromNone: 10,
    });
  });

  it("rejects missing/duplicate modes and impossible counters", () => {
    expect(() => compareProbeCacheBehavior([])).toThrow(/requires/);
    expect(() => compareProbeCacheBehavior([
      { mode: "none", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      { mode: "none", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      { mode: "explicit", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    ])).toThrow(/unique/);
    expect(() => compareProbeCacheBehavior([
      { mode: "none", inputTokens: 1, cachedInputTokens: 2, cacheWriteInputTokens: 0 },
      { mode: "implicit", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      { mode: "explicit", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    ])).toThrow(/cannot exceed/);
    expect(() => compareProbeCacheBehavior([
      { mode: "none", inputTokens: 1, cachedInputTokens: undefined as unknown as number, cacheWriteInputTokens: 0 },
      { mode: "implicit", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      { mode: "explicit", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    ])).toThrow(/must be present/);
  });
});
