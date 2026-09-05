// ===========================================================================
// CAT-02 · Browser domain category (GoldenEvals V2) as a deterministic unit
// test, plus the categorizer's own contract.
//
// Setup: history contains goibibo.com (14 visits, typed, 6 min dwell), a
// tracker redirect chain (0.4s dwells), news.ycombinator.com (bookmarked).
// Expected: goibibo + HN → Cat 1; tracker chain → Cat 2 (kept — there is no
// drop policy since V6 P1 S0.5 / T6-6); ambiguous domains get ONE cached
// cheap call, never repeated.
// Wrong: `tracker-as-interest` ("user interested in adclick.doubleclick").
// ===========================================================================

import { describe, expect, it } from "vitest";

import { aggregateDomains, DomainCategorizer, REPEAT_VISITS_MIN } from "./category.js";
import { MemorySink } from "./sink.js";
import { BrowserWatcher } from "./watcher.js";
import type { RawVisit } from "./history-db.js";
import type { BrowserVisitPayload } from "./envelope.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const MIN = 60_000;

let nextId = 1;
function visit(url: string, tsMs: number, over: Partial<RawVisit> = {}): RawVisit {
  return {
    visitId: nextId++,
    url,
    title: "",
    tsMs,
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

/** The CAT-02 history: goibibo (typed, real dwell), tracker chain, HN. */
function cat02Visits(): RawVisit[] {
  nextId = 1;
  const visits: RawVisit[] = [];
  // goibibo.com — 14 visits, typed, 6 min dwell.
  for (let i = 0; i < 14; i++) {
    visits.push(
      visit("https://www.goibibo.com/flights/", NOW - (200 - i * 10) * MIN, {
        typed: true,
        transition: "typed",
        dwellMs: 6 * MIN,
        visitCount: 14,
      }),
    );
  }
  // Tracker redirect chain — 0.4s dwells.
  const t0 = NOW - 50 * MIN;
  const a = visit("https://adclick.doubleclick.net/r?x=1", t0, { redirect: true, transition: "redirect", dwellMs: 400 });
  const b = visit("https://www.googleadservices.com/pagead/aclk?y=2", t0 + 1000, {
    redirect: true,
    transition: "redirect",
    dwellMs: 400,
    referrerVisitId: a.visitId,
  });
  visits.push(a, b);
  // news.ycombinator.com — bookmarked (domain arrives via bookmarkedDomains).
  visits.push(visit("https://news.ycombinator.com/item?id=1", NOW - 20 * MIN, { dwellMs: 2000, visitCount: 1 }));
  return visits;
}

describe("CAT-02 · browser domain category", () => {
  const bookmarked = new Set(["news.ycombinator.com"]);

  it("goibibo (typed/repeat/dwell) and HN (bookmarked) → Cat 1", () => {
    const stats = aggregateDomains(cat02Visits(), bookmarked);
    const cat = new DomainCategorizer();
    expect(cat.categorize(stats.get("goibibo.com")!)).toBe("cat1");
    expect(cat.categorize(stats.get("news.ycombinator.com")!)).toBe("cat1");
  });

  it("tracker chain → Cat 2 by the redirect-hop rule — never an interest (wrong: tracker-as-interest)", () => {
    const stats = aggregateDomains(cat02Visits(), bookmarked);
    const cat = new DomainCategorizer();
    for (const domain of ["adclick.doubleclick.net", "googleadservices.com"]) {
      const s = stats.get(domain)!;
      expect(cat.categorize(s), domain).toBe("cat2"); // ad_immunity: cat1 here is the failure
    }
  });

  it("end-to-end: watcher emits goibibo+HN as cat1 and KEEPS the tracker hops as cat2", () => {
    const sink = new MemorySink();
    const w = new BrowserWatcher({ sink, profiles: [], now: () => NOW });
    const events = w.visitEvents(cat02Visits(), bookmarked);
    const byDomain = new Map<string, BrowserVisitPayload[]>();
    for (const e of events) {
      const p = e.payload as BrowserVisitPayload;
      if (!byDomain.has(p.domain)) byDomain.set(p.domain, []);
      byDomain.get(p.domain)!.push(p);
    }
    expect(byDomain.get("goibibo.com")!.every((p) => p.category === "cat1")).toBe(true);
    expect(byDomain.get("news.ycombinator.com")!.every((p) => p.category === "cat1")).toBe(true);
    // 100% of URLs are kept (T6-6): the hops land, ordered late as Cat 2.
    expect(byDomain.get("adclick.doubleclick.net")!.every((p) => p.category === "cat2")).toBe(true);
    expect(byDomain.get("googleadservices.com")!.every((p) => p.category === "cat2")).toBe(true);
    expect(events).toHaveLength(cat02Visits().length);
  });

  it("ambiguous domains get ONE cached cheap call, never repeated", () => {
    let calls = 0;
    const cat = new DomainCategorizer((domain) => {
      calls++;
      return domain === "obscure-blog.example" ? "cat1" : "cat2";
    });
    // Ambiguous: 1 visit, no typed, no bookmark, mid dwell, not a tracker.
    const stats = aggregateDomains([visit("https://obscure-blog.example/post", NOW, { dwellMs: 5000 })]);
    const s = stats.get("obscure-blog.example")!;
    expect(cat.heuristic(s)).toBeNull();
    for (let i = 0; i < 5; i++) expect(cat.categorize(s)).toBe("cat1");
    expect(calls).toBe(1);
  });

  it("no resolver wired → ambiguous stays ambiguous (kept, never dropped)", () => {
    const cat = new DomainCategorizer();
    const stats = aggregateDomains([visit("https://obscure-blog.example/post", NOW, { dwellMs: 5000 })]);
    expect(cat.categorize(stats.get("obscure-blog.example")!)).toBe("ambiguous");
  });
});

describe("heuristics edges", () => {
  it("repeat visits alone reach Cat 1 at the floor", () => {
    const cat = new DomainCategorizer();
    const visits = Array.from({ length: REPEAT_VISITS_MIN }, (_, i) =>
      visit("https://recipes.example/", NOW + i * MIN, { dwellMs: 2000 }),
    );
    const s = aggregateDomains(visits).get("recipes.example")!;
    expect(cat.categorize(s)).toBe("cat1");
  });
});
