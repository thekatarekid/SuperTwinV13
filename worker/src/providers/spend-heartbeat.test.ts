// ===========================================================================
// Spend heartbeat (S0.8, T0-13) — GoldenEvals SPD-06 as a deterministic
// vitest test. Fake clock, injected log, ZERO live model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SPEND_HEARTBEAT_MS,
  formatTokens,
  formatUptime,
  noteRefusal,
  noteSpend,
  refusalCode,
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

  it("a refused call is not an idle minute: BLOCKED, the count and the code", () => {
    // The user's own steady state: the latch is set, the lanes keep asking,
    // every ask is refused before spawn. Before C3 this minute read
    // "[spend] 60s: 0 calls, 0 tok, ~$0.00 | run 0h01m: 0 calls, …" — the same
    // line a worker whose dispatcher never started would write.
    const lines: string[] = [];
    startSpendHeartbeat({ log: (l) => lines.push(l) });
    for (let i = 0; i < 12; i += 1) noteRefusal({ code: "BUDGET_EXCEEDED" });
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[0]).toBe(
      "[spend] 60s: 0 calls, 0 tok, ~$0.00 | run 0h01m: 0 calls, 0 tok, ~$0.00" +
        " | BLOCKED: 12 refused this interval (BUDGET_EXCEEDED ×12), 12 since boot",
    );
    expect(lines[0]).toContain("BLOCKED");
  });

  it("the refusal count resets each interval; the run total does not", () => {
    const lines: string[] = [];
    startSpendHeartbeat({ log: (l) => lines.push(l) });
    for (let i = 0; i < 3; i += 1) noteRefusal({ code: "BUDGET_EXCEEDED" });
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[0]).toContain("BLOCKED: 3 refused this interval (BUDGET_EXCEEDED ×3), 3 since boot");
    // A quiet minute AFTER a refusal still says the pipeline is being turned
    // away — the run total is the standing fact, not a one-minute blip.
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[1]).toBe(
      "[spend] 60s: 0 calls, 0 tok, ~$0.00 | run 0h02m: 0 calls, 0 tok, ~$0.00 | 0 refused this interval, 3 since boot",
    );
    noteRefusal({ code: "MODEL_ACTIVITY_PAUSED" });
    noteRefusal({ code: "BUDGET_EXCEEDED" });
    noteRefusal({ code: "BUDGET_EXCEEDED" });
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    // Commonest code first, so the reason that dominates is the one you read.
    expect(lines[2]).toContain("BLOCKED: 3 refused this interval (BUDGET_EXCEEDED ×2, MODEL_ACTIVITY_PAUSED ×1), 6 since boot");
  });

  it("admitted and refused in the same minute: counted apart, and not BLOCKED", () => {
    const lines: string[] = [];
    startSpendHeartbeat({ log: (l) => lines.push(l) });
    noteSpend(usage()); // the bar is latch-exempt and still answers
    noteRefusal({ code: "BUDGET_EXCEEDED" });
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[0]).toBe(
      "[spend] 60s: 1 calls, 30.5K tok, ~$0.01 | run 0h01m: 1 calls, 30.5K tok, ~$0.01" +
        " | 1 refused this interval (BUDGET_EXCEEDED ×1), 1 since boot",
    );
    expect(lines[0]).not.toContain("BLOCKED");
  });

  it("a genuinely idle minute is unchanged — no clause, no false alarm", () => {
    const lines: string[] = [];
    startSpendHeartbeat({ log: (l) => lines.push(l) });
    vi.advanceTimersByTime(SPEND_HEARTBEAT_MS);
    expect(lines[0]).toBe("[spend] 60s: 0 calls, 0 tok, ~$0.00 | run 0h01m: 0 calls, 0 tok, ~$0.00");
  });

  it("names the code the gate threw, and never loses an unexpected throw", () => {
    expect(refusalCode({ code: "BUDGET_EXCEEDED" })).toBe("BUDGET_EXCEEDED");
    expect(refusalCode(Object.assign(new Error("x"), { name: "ModelActivityPausedError" }))).toBe(
      "ModelActivityPausedError",
    );
    expect(refusalCode("MEDIA_UNAVAILABLE")).toBe("MEDIA_UNAVAILABLE");
    expect(refusalCode(null)).toBe("REFUSED");
    expect(refusalCode({})).toBe("REFUSED");
  });

  it("formats like the backlog line: 1.9M tok, run 8h56m", () => {
    expect(formatTokens(1_900_000)).toBe("1.9M");
    expect(formatTokens(41_234)).toBe("41.2K");
    expect(formatTokens(812)).toBe("812");
    expect(formatUptime((8 * 60 + 56) * 60_000)).toBe("8h56m");
    expect(formatUptime(30 * 3600_000)).toBe("30h00m");
  });
});
