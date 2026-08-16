// ===========================================================================
// The P-TI1 transport's own two invariants (arch §5.9.4, §12.11).
//
// The call itself is the prompt runner's business and is tested there; what is
// this file's is that the legend renders at all (a `legendFor` collision throws
// only at call time, which would be the worst possible moment to find out) and
// that no batch ever exceeds §12.11's ten channels or the caller's ceiling.
// ===========================================================================

import { describe, expect, it, vi } from "vitest";

import { P_TI1, type Ti1Channel, type Ti1Verdict } from "../prompts/p-ti1.js";
import { resolveTi1Batches, ti1Legend } from "./ti1-runner.js";

function channels(n: number): Ti1Channel[] {
  return Array.from({ length: n }, (_, i) => ({
    streamId: `s${i}`,
    name: `channel ${i}`,
    sample: ["Your order has shipped", "FLAT 50% OFF"],
    totalMessages: 40,
  }));
}

describe("ti1Legend", () => {
  it("renders the J.channel block and is byte-identical on every call (§5.9.4)", () => {
    const first = ti1Legend();
    expect(first).toContain("WIRE FORMAT — STW-2");
    expect(first).toContain("channel_class");
    expect(ti1Legend()).toBe(first);
  });
});

describe("resolveTi1Batches", () => {
  it("never puts more than §12.11's ten channels in a call", async () => {
    const seen: number[] = [];
    const report = await resolveTi1Batches(channels(25), async (batch) => {
      seen.push(batch.length);
      return [];
    }, 10);

    expect(seen).toEqual([P_TI1.maxChannelsPerCall, P_TI1.maxChannelsPerCall, 5]);
    expect(report.calls).toBe(3);
    expect(report.skipped).toBe(0);
  });

  it("stops at the ceiling and reports the channels it did not ask about", async () => {
    const invoke = vi.fn(async (batch: readonly Ti1Channel[]): Promise<Ti1Verdict[]> =>
      batch.map((c) => ({
        alias: "c1",
        streamId: c.streamId,
        cls: "tx" as const,
        label: "transactional",
        confidence: 0.9,
        reason: "this person's own orders",
        raw: "J|c1|tx|0.9|this person's own orders",
      })),
    );

    const report = await resolveTi1Batches(channels(25), invoke, 2);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(report.calls).toBe(2);
    expect(report.verdicts).toHaveLength(20);
    expect(report.skipped).toBe(5);
  });

  it("buys nothing when there is nothing ambiguous", async () => {
    const invoke = vi.fn<(b: readonly Ti1Channel[]) => Promise<Ti1Verdict[]>>(async () => []);
    const report = await resolveTi1Batches([], invoke, 4);
    expect(invoke).not.toHaveBeenCalled();
    expect(report).toMatchObject({ channels: 0, calls: 0, skipped: 0 });
  });
});
