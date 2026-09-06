// ===========================================================================
// Sufficiency per class + the coverage caveat (V6 P1 S5.5; Product_V6_Phase1
// §19 rule 4; BAR-04..06). The model never decides whether it knew enough —
// code does, per class — so this suite is the statement of that bar:
//
//   lookup/relational/multihop  a judged result with a verbatim quote, or partial
//   aggregate                   a structured value; an enumeration that hit the
//                               cap says "N so far, list may be incomplete"
//   absence                     a COMPLETE scan, or it is not a "no"
//   temporal                    a complete window with something in it
//   general                     always (there was no retrieval to be short of)
//
// Zero model calls: the judge's output and the retrieval are values.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TZ = "Asia/Kolkata";
const tmpRoot = mkdtempSync(join(tmpdir(), "st-bar-sufficiency-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { noteCaptured } = await import("../coverage/index.js");
const { routeHeuristic } = await import("../prompts/route.v1.js");
const { checkSufficiency, caveatFor, caveatSources } = await import("./sufficiency.js");
import type { RoutePlan } from "../prompts/route.v1.js";
import type { BarRetrieval } from "./retrieval.js";
import type { JudgeOutput } from "../prompts/judge.v1.js";
import type { StructuredResult } from "../retrieval/structured.js";
import type { TimeWindowResult } from "../retrieval/time-window.js";

const NOW = new Date("2026-09-05T04:30:00.000Z");

function retrieval(over: Partial<BarRetrieval> = {}): BarRetrieval {
  return {
    plan: routeHeuristic("anything", NOW),
    methods_ran: [],
    candidates: [],
    structured: null,
    time_window: null,
    graph: null,
    counts: { lexical: 0, vector: 0, structured: 0, graph: 0, time_window: 0 },
    stream_keys: [],
    reranker: null,
    took_ms: 1,
    ...over,
  };
}

function judged(n: number): JudgeOutput {
  return {
    results: Array.from({ length: n }, (_, i) => ({ id: `e_${i}`, quote: `q${i}`, why: "w" })),
    answer: n > 0 ? "an answer built from the quotes" : null,
    dropped: [],
  };
}

function structured(over: Partial<StructuredResult>): StructuredResult {
  return {
    method: "structured",
    op: "sum",
    field: "amount",
    filters: {},
    value: 1020,
    byCurrency: [{ currency: "INR", value: 1020, rows: 3 }],
    range: null,
    rows: [],
    rowCount: 3,
    complete: true,
    rowsTruncated: false,
    excluded: { untyped: 0, undated: 0 },
    sql: "…",
    ...over,
  };
}

function window(count: number, shown: number): TimeWindowResult {
  return {
    method: "time_window",
    window: { fromIso: "2026-07-01T00:00:00.000Z", toIso: NOW.toISOString() },
    events: Array.from({ length: shown }, (_, i) => ({ id: `e_${i}` })) as TimeWindowResult["events"],
    count,
    complete: count <= shown,
    scored: false,
  };
}

function plan(cls: RoutePlan["class"], over: Partial<RoutePlan> = {}): RoutePlan {
  return { ...routeHeuristic("anything about the villa", NOW), class: cls, ...over };
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec(`DELETE FROM coverage; DELETE FROM consents;`);
});

// ---------------------------------------------------------------------------

describe("lookup / relational / multihop", () => {
  it("one judged result with a quote is enough", () => {
    const s = checkSufficiency(plan("lookup"), retrieval({ candidates: [] }), judged(1), NOW);
    expect(s.sufficient).toBe(true);
    expect(s.partial).toBe(false);
    expect(s.gaps).toEqual([]);
    expect(s.method).toBe("lexical ∪ vector");
  });

  it("candidates read but nothing answered is partial, and says so", () => {
    const s = checkSufficiency(
      plan("lookup"),
      retrieval({ candidates: Array(7).fill(null).map((_, i) => ({ id: `e${i}` })) as BarRetrieval["candidates"] }),
      judged(0),
      NOW,
    );
    expect(s.sufficient).toBe(false);
    expect(s.partial).toBe(true);
    expect(s.gaps[0]).toContain("7 candidate(s) read");
  });

  it("a multihop with no seed in the graph names that as the gap", () => {
    const s = checkSufficiency(
      plan("multihop", { seeds: ["rohan"] }),
      retrieval({ graph: { seeds: 0, hits: 0, expanded: 0 } }),
      judged(0),
      NOW,
    );
    expect(s.method).toBe("graph → vector");
    expect(s.gaps.some((g) => g.includes("rohan"))).toBe(true);
  });
});

describe("aggregate (BAR-04, BAR-06)", () => {
  it("a structured value is sufficient and the method is reported as structured", () => {
    const s = checkSufficiency(plan("aggregate"), retrieval({ structured: structured({}) }), null, NOW);
    expect(s.sufficient).toBe(true);
    expect(s.method).toBe("structured");
    expect(s.scanned).toBe(3);
  });

  it("rows dropped for a missing amount or date are named, and the answer is partial", () => {
    const s = checkSufficiency(
      plan("aggregate"),
      retrieval({ structured: structured({ excluded: { untyped: 2, undated: 1 } }) }),
      null,
      NOW,
    );
    expect(s.partial).toBe(true);
    expect(s.gaps.join(" ")).toContain("2 matching row(s) had no amount");
    expect(s.gaps.join(" ")).toContain("1 matching row(s) had no date");
  });

  it("BAR-06 — an enumeration that hit the cap says how many it has and what is missing", () => {
    const s = checkSufficiency(
      plan("aggregate"),
      retrieval({
        structured: structured({
          op: "list",
          value: null,
          rows: Array(12).fill({ claimKey: "c" }) as StructuredResult["rows"],
          rowCount: 15,
          complete: false,
        }),
      }),
      null,
      NOW,
    );
    expect(s.partial).toBe(true);
    expect(s.gaps[0]).toContain("12 so far, list may be incomplete");
    expect(s.gaps[0]).toContain("3 more row(s)");
  });

  it("no typed rows is not an answer — it is a named gap", () => {
    const s = checkSufficiency(plan("aggregate"), retrieval({ structured: null }), null, NOW);
    expect(s.sufficient).toBe(false);
    expect(s.gaps[0]).toContain("no typed rows");
  });
});

describe("absence (BAR-05) — a truncated scan is never a confident no", () => {
  it("a complete scan over the named thread is sufficient", () => {
    const s = checkSufficiency(plan("absence"), retrieval({ time_window: window(40, 40) }), judged(0), NOW);
    expect(s.sufficient).toBe(true);
    expect(s.partial).toBe(false);
    expect(s.scanned).toBe(40);
    expect(s.method).toBe("time_window");
  });

  it("a cut scan is insufficient and says the rest was never read", () => {
    const s = checkSufficiency(plan("absence"), retrieval({ time_window: window(900, 500) }), judged(0), NOW);
    expect(s.sufficient).toBe(false);
    expect(s.partial).toBe(true);
    expect(s.gaps[0]).toContain('not a confident "no"');
  });

  it("no range resolved at all is insufficient", () => {
    const s = checkSufficiency(plan("absence"), retrieval({ time_window: null }), judged(0), NOW);
    expect(s.sufficient).toBe(false);
    expect(s.gaps[0]).toContain("no range resolved");
  });
});

describe("temporal and general", () => {
  it("a complete window with rows is sufficient; an empty one is partial", () => {
    expect(checkSufficiency(plan("temporal"), retrieval({ time_window: window(6, 6) }), judged(1), NOW).sufficient).toBe(true);
    const empty = checkSufficiency(plan("temporal"), retrieval({ time_window: window(0, 0) }), judged(0), NOW);
    expect(empty.sufficient).toBe(false);
    expect(empty.gaps).toContain("nothing captured in that window");
  });

  it("general never has a retrieval to be short of", () => {
    const s = checkSufficiency(plan("general"), retrieval(), null, NOW);
    expect(s).toMatchObject({ sufficient: true, partial: false, caveat: null, method: "general knowledge" });
  });
});

describe("the coverage caveat", () => {
  it('"I only have WhatsApp back to Jul 2026" when the asked range reaches past the floor', () => {
    noteCaptured("wa", ["2026-07-04T10:00:00.000Z", "2026-08-02T10:00:00.000Z"]);
    const p = plan("absence", { filters: { stream: "wa:goa-gang" }, time: { from: "2026-01-01T00:00:00Z", to: NOW.toISOString() } });
    const c = caveatFor(p, retrieval(), NOW);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("floor");
    expect(c!.text).toBe("I only have WhatsApp back to Jul 2026");
  });

  it("no caveat when the asked range is inside what was captured", () => {
    noteCaptured("wa", ["2026-07-04T10:00:00.000Z"]);
    const p = plan("absence", { filters: { source: "wa" }, time: { from: "2026-08-01T00:00:00Z", to: NOW.toISOString() } });
    expect(caveatFor(p, retrieval(), NOW)).toBeNull();
  });

  it("the caveat is about the source the question named", () => {
    expect(caveatSources(plan("absence", { filters: { source: "browser" } }), retrieval())).toEqual(["browser"]);
    expect(caveatSources(plan("absence", { filters: { stream: "wa:goa-gang" } }), retrieval())).toEqual(["wa"]);
    expect(caveatSources(plan("lookup"), retrieval({ stream_keys: ["wa:goa-gang", "browser:x"] }))).toEqual(["wa", "browser"]);
  });

  it("an absence answer carries the caveat even when the scan was complete", () => {
    noteCaptured("wa", ["2026-07-04T10:00:00.000Z"]);
    const p = plan("absence", { filters: { stream: "wa:goa-gang" }, time: { from: "2026-01-01T00:00:00Z", to: NOW.toISOString() } });
    const s = checkSufficiency(p, retrieval({ time_window: window(40, 40) }), judged(0), NOW);
    expect(s.sufficient).toBe(true);
    expect(s.caveat?.text).toContain("back to Jul 2026");
  });
});
