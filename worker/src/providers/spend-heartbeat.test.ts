// ===========================================================================
// Spend heartbeat (S0.8, T0-13) — GoldenEvals SPD-06 as a deterministic
// vitest test. Fake clock, injected log, ZERO live model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SPEND_HEARTBEAT_MS,
  formatTokens,
  formatUptime,
  noteSpend,
  resetSpendHeartbeatForTests,
  spendHeartbeatLine,
  startSpendHeartbeat,
  usageTokens,
} from "./spend-heartbeat.js";
import type { Usage } from "./types.js";

const usage = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 1_000,
  cacheCreationInputTokens: 11_000,
  cacheReadInputTokens: 18_000,
  outputTokens: 500,
  costUsd: 0.0055,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-06T10:00:00Z"));
  resetSpendHeartbeatForTests();
});

afterEach(() => {
  resetSpendHeartbeatForTests();
  vi.useRealTimers();
});

describe("SPD-06 — heartbeat", () => {
  it("a `[spend] 60s:` line lands within 60 s of the first call", () => {
    const lines: string[] = [];
    startSpendHeartbeat({ log: (l) => lines.push(l) });
    noteSpend(usage());
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS - 1);
    expect(lines).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[spend\] 60s: /);
    expect(lines[0]).toBe("[spend] 60s: 1 calls, 30.5K tok, ~$0.01 | run 0h01m: 1 calls, 30.5K tok, ~$0.01");
  });

  it("the interval resets each minute; the run totals accumulate", () => {
    const lines: string[] = [];
    startSpendHeartbeat({ log: (l) => lines.push(l) });
    for (let i = 0; i < 27; i += 1) noteSpend(usage({ costUsd: 0.0815 }));
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[0]).toBe("[spend] 60s: 27 calls, 823.5K tok, ~$2.20 | run 0h01m: 27 calls, 823.5K tok, ~$2.20");
    // A silent minute reads as zero, not as a stale repeat.
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[1]).toBe("[spend] 60s: 0 calls, 0 tok, ~$0.00 | run 0h02m: 27 calls, 823.5K tok, ~$2.20");
    noteSpend(usage({ costUsd: undefined }));
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[2]).toBe("[spend] 60s: 1 calls, 30.5K tok, ~$0.00 | run 0h03m: 28 calls, 854.0K tok, ~$2.20");
  });

  it("stop() ends the beat; start() is idempotent (one timer per process)", () => {
    const lines: string[] = [];
    const a = startSpendHeartbeat({ log: (l) => lines.push(l) });
    startSpendHeartbeat({ log: (l) => lines.push(l) });
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines).toHaveLength(1); // two starts, one line
    a.stop();
    vi.advanceTimersByTime(10 * SPEND_HEARTBEAT_MS);
    expect(lines).toHaveLength(1);
  });

  it("counts every token the call touched, and tolerates a missing usage", () => {
    expect(usageTokens(usage())).toBe(30_500);
    expect(usageTokens(undefined)).toBe(0);
    noteSpend(undefined);
    expect(spendHeartbeatLine(Date.now())).toBe("[spend] 60s: 1 calls, 0 tok, ~$0.00 | run 0h00m: 1 calls, 0 tok, ~$0.00");
  });

  it("formats like the backlog line: 1.9M tok, run 8h56m", () => {
    expect(formatTokens(1_900_000)).toBe("1.9M");
    expect(formatTokens(41_234)).toBe("41.2K");
    expect(formatTokens(812)).toBe("812");
    expect(formatUptime((8 * 60 + 56) * 60_000)).toBe("8h56m");
    expect(formatUptime(30 * 3600_000)).toBe("30h00m");
  });
});
