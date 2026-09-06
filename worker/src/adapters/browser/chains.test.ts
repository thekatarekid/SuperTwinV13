import { describe, expect, it } from "vitest";

import { assignChains, browserStreamKey, CHAIN_GAP_MS } from "./chains.js";
import type { RawVisit } from "./history-db.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const DAY = "2026-08-28";
const MIN = 60_000;
const HOUR = 60 * MIN;

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

describe("assignChains — stream key = browser:<browser>:<profile>:<domain>:<day> (S3.4)", () => {
  it("keys every visit by its own domain and UTC day, profile normalised", () => {
    const [a, b] = assignChains(
      [
        visit({ visitId: 1, url: "https://www.goibibo.com/flights", tsMs: NOW }),
        visit({ visitId: 2, url: "https://airbnb.com/s/goa", tsMs: NOW + MIN, browser: "safari" }),
      ],
      { profile: "Profile 1" },
    );
    expect(a!.streamKey).toBe("browser:chrome:profile-1:goibibo.com:2026-08-28");
    expect(b!.streamKey).toBe("browser:safari:profile-1:airbnb.com:2026-08-28");
    expect(browserStreamKey("chrome", undefined, "x.example", DAY)).toBe("browser:chrome:default:x.example:2026-08-28");
  });

  it("same domain on the same day is ONE stream, referrer or not; another domain is another stream", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + MIN, referrerVisitId: 1 }),
      visit({ visitId: 3, url: "https://a.example/3", tsMs: NOW + 5 * HOUR }), // unrelated root, same domain-day
      visit({ visitId: 4, url: "https://b.example/", tsMs: NOW + 2 * MIN, referrerVisitId: 2 }), // linked, other domain
    ]);
    const byId = new Map(chained.map((v) => [v.visitId, v]));
    expect(byId.get(2)!.streamKey).toBe(byId.get(1)!.streamKey);
    expect(byId.get(3)!.streamKey).toBe(byId.get(1)!.streamKey);
    expect(byId.get(4)!.streamKey).not.toBe(byId.get(1)!.streamKey);
    // The referrer chain is still tracked underneath the stream.
    expect(byId.get(2)!.referrerUrl).toBe("https://a.example/");
    expect(byId.get(4)!.chainId).toBe(byId.get(1)!.chainId);
    expect(byId.get(3)!.chainId).not.toBe(byId.get(1)!.chainId);
  });

  it("a visit after UTC midnight starts the next day's stream", () => {
    const late = Date.parse("2026-08-28T23:50:00Z");
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: late }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: late + 15 * MIN, referrerVisitId: 1 }),
    ]);
    expect(chained[0]!.streamKey).toBe("browser:chrome:default:a.example:2026-08-28");
    expect(chained[1]!.streamKey).toBe("browser:chrome:default:a.example:2026-08-29");
  });

  it("a URL without a host lands in the 'unknown' domain slot", () => {
    const [v] = assignChains([visit({ visitId: 1, url: "about:blank", tsMs: NOW })]);
    expect(v!.streamKey).toBe("browser:chrome:default:unknown:2026-08-28");
  });

  it("a 30-min gap to the referrer splits the chain (dwell inference), not the stream", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + CHAIN_GAP_MS + MIN, referrerVisitId: 1 }),
    ]);
    expect(chained[0]!.chainId).not.toBe(chained[1]!.chainId);
    expect(chained[1]!.referrerUrl).toBe("https://a.example/"); // the link is still a fact
    expect(chained[0]!.streamKey).toBe(chained[1]!.streamKey);
  });

  it("stream keys are deterministic across re-reads (idempotent polls)", () => {
    const input = [
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW }),
      visit({ visitId: 2, url: "https://a.example/2", tsMs: NOW + MIN, referrerVisitId: 1 }),
    ];
    const a = assignChains(input, { profile: "Default" });
    const b = assignChains([...input].reverse(), { profile: "Default" });
    expect(a.map((v) => v.streamKey).sort()).toEqual(b.map((v) => v.streamKey).sort());
  });

  it("same visit ids from different browsers never merge (chain or stream)", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW, browser: "chrome" }),
      visit({ visitId: 2, url: "https://a.example/x", tsMs: NOW + MIN, referrerVisitId: 1, browser: "safari" }),
    ]);
    expect(chained[0]!.streamKey).not.toBe(chained[1]!.streamKey);
    expect(chained[0]!.chainId).not.toBe(chained[1]!.chainId);
    expect(chained[1]!.referrerUrl).toBeNull();
  });

  it("infers dwell from the gap to the next visit in the same chain (Safari), across domains", () => {
    const chained = assignChains([
      visit({ visitId: 1, url: "https://a.example/", tsMs: NOW, browser: "safari" }),
      visit({ visitId: 2, url: "https://b.example/2", tsMs: NOW + 3 * MIN, referrerVisitId: 1, browser: "safari" }),
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
