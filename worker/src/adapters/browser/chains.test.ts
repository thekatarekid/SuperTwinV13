import { describe, expect, it } from "vitest";

import { assignChains, CHAIN_GAP_MS } from "./chains.js";
import type { RawVisit } from "./history-db.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const MIN = 60_000;

function visit(over: Partial<RawVisit> & { visitId: number; url: string; tsMs: number }): RawVisit {
  return {
    title: "",
    transition: "link",
    typed: false,
    redirect: false,
    referrerVisitId: 0,
    visitCount: 1,
    dwellMs: 0,
    browser: "chrome",
    ...over,
  };
}

describe("assignChains", () => {
  it("referrer-linked visits share one chain; unrelated roots do not", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + MIN, referrerVisitId: 1 }),
      visit({ visitId: 3, url: "https://b.example/", tsMs: NOW + 2 * MIN }),
    ]);
    expect(chained[0]!.streamKey).toBe(chained[1]!.streamKey);
    expect(chained[2]!.streamKey).not.toBe(chained[0]!.streamKey);
    expect(chained[1]!.referrerUrl).toBe("https://a.example/");
  });

  it("a 30-min gap to the referrer splits the chain", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + CHAIN_GAP_MS + MIN, referrerVisitId: 1 }),
    ]);
    expect(chained[0]!.streamKey).not.toBe(chained[1]!.streamKey);
  });

  it("stream keys are deterministic across re-reads (idempotent polls)", () => {
    const input = [
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + MIN, referrerVisitId: 1 }),
    ];
    const a = assignChains(input);
    const b = assignChains([...input].reverse());
    expect(a.map((v) => v.streamKey).sort()).toEqual(b.map((v) => v.streamKey).sort());
  });

  it("same visit ids from different browsers never merge", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW, browser: "chrome" }),
      visit({ visitId: 2, url: "https://x.example/", tsMs: NOW + MIN, referrerVisitId: 1, browser: "safari" }),
    ]);
    expect(chained[0]!.streamKey).not.toBe(chained[1]!.streamKey);
  });

  it("infers dwell from the gap to the next visit in the same chain (Safari)", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW, browser: "safari" }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + 3 * MIN, referrerVisitId: 1, browser: "safari" }),
    ]);
    expect(chained[0]!.inferredDwellMs).toBe(3 * MIN);
    expect(chained[1]!.inferredDwellMs).toBe(0); // last of chain: unknown
  });

  it("keeps recorded dwell when the source has it", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW, dwellMs: 5000 }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + 10 * MIN, referrerVisitId: 1 }),
    ]);
    expect(chained[0]!.inferredDwellMs).toBe(5000);
  });
});
