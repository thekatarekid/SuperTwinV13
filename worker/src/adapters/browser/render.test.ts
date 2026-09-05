// ===========================================================================
// Render-time visit collapse (V6 P1 S1.4; T6-3/T6-4; SRC-10). Pure.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { collapseVisitRuns, isVisitRun, renderVisitRun, visitRunHead, visitRunSpan } from "./render.js";

const T0 = Date.parse("2026-08-28T13:58:00.000Z");

function visit(i: number, url: string, offsetMs: number, extra: Record<string, unknown> = {}) {
  return {
    id: `ev${i}`,
    ts: new Date(T0 + offsetMs).toISOString(),
    kind: "browser.visit",
    actor: "self",
    text: `Goibibo ${url}`,
    payloadJson: JSON.stringify({ url, title: "Goibibo", transition: "typed", visit_count: 12, dwell_ms: 7, browser: "chrome", ...extra }),
  };
}

const alias = (events: { id: string }[]) => (e: { id: string }) => `e${events.findIndex((x) => x.id === e.id) + 1}`;

describe("collapseVisitRuns", () => {
  it("SRC-10: six visits to one URL within 30 s → one run of six; nothing dropped", () => {
    const events = [
      ...[0, 1, 2, 3, 4, 5].map((i) => visit(i + 1, "https://www.goibibo.com/flights/", i * 5_000, i > 0 ? { transition: "reload" } : {})),
      visit(7, "https://www.goibibo.com/hotels/", 70_000, { transition: "link", visit_count: 1 }),
    ];
    const runs = collapseVisitRuns(events);
    expect(runs.map((r) => r.length)).toEqual([6, 1]);
    expect(runs.flat()).toEqual(events); // every row still there, in order
    const line = renderVisitRun(runs[0]!, alias(events));
    expect(line).toContain("e1–e6");
    expect(line).toContain("×6");
    expect(line).toContain("08-28 13:58"); // first…
    expect(line).toContain("typed/reload");
    expect(line).toContain("12 visits all-time");
    expect(line).not.toMatch(/dwell/);
    expect(line).toContain("Goibibo https://www.goibibo.com/flights/");
    // The lone seventh visit renders as a single-visit head, no ×N.
    const single = renderVisitRun(runs[1]!, alias(events));
    expect(single.startsWith("e7 08-28 13:59 self [browser.visit · link · 1 visit all-time · chrome]")).toBe(true);
  });

  it("a visit 31 s after the run's first starts a new run; a different URL always does", () => {
    const events = [
      visit(1, "https://a.example/", 0),
      visit(2, "https://a.example/", 30_000),
      visit(3, "https://a.example/", 31_000),
      visit(4, "https://b.example/", 32_000),
      visit(5, "https://a.example/", 33_000),
    ];
    expect(collapseVisitRuns(events).map((r) => r.map((e) => e.id))).toEqual([["ev1", "ev2"], ["ev3"], ["ev4"], ["ev5"]]);
  });

  it("non-visit events never fold, even when adjacent and identical", () => {
    const msg = (i: number) => ({ id: `m${i}`, ts: new Date(T0 + i).toISOString(), kind: "wa.message", text: "hi", payloadJson: "{}" });
    const runs = collapseVisitRuns([msg(1), msg(2), visit(3, "https://a.example/", 5), visit(4, "https://a.example/", 6)]);
    expect(runs.map((r) => r.length)).toEqual([1, 1, 2]);
    expect(isVisitRun(runs[0]!)).toBe(false);
    expect(isVisitRun(runs[2]!)).toBe(true);
  });

  it("span shows first–last minutes; head carries transition and visit_count, never dwell", () => {
    const events = [visit(1, "https://a.example/", 0), visit(2, "https://a.example/", 25_000 + 60_000 * 0)];
    expect(visitRunSpan(events)).toBe("08-28 13:58");
    const late = [visit(1, "https://a.example/", 50_000), visit(2, "https://a.example/", 70_000)];
    expect(visitRunSpan(late)).toBe("08-28 13:58–13:59");
    expect(visitRunHead(late)).toBe("[browser.visit ×2 · typed · 12 visits all-time · chrome]");
    expect(visitRunHead([{ id: "x", ts: null, kind: "browser.visit", payload: { url: "https://x/" } }])).toBe("[browser.visit]");
  });

  it("accepts a parsed payload as well as payloadJson, and tolerates garbage", () => {
    const a = { id: "1", ts: new Date(T0).toISOString(), kind: "browser.visit", payload: { url: "https://x/" } };
    const b = { id: "2", ts: new Date(T0 + 1000).toISOString(), kind: "browser.visit", payloadJson: '{"url":"https://x/"}' };
    const c = { id: "3", ts: new Date(T0 + 2000).toISOString(), kind: "browser.visit", payloadJson: "{not json" };
    expect(collapseVisitRuns([a, b, c]).map((r) => r.length)).toEqual([2, 1]);
  });
});
