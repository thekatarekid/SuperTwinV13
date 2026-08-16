// ===========================================================================
// Newest-page-first history (build item 1.1, arch §2.2 note 1).
//
// The property under test is one sentence: whatever order the source delivers
// pages in, the cohorts that come out are descending. A `desc` source passes
// through; an `asc` one is buffered and flipped; a full buffer spills as
// descending cohorts rather than growing.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { DescendingCohortBuffer, descendingCohorts, sortDescByTs } from "./backfill-order.js";

interface Ev {
  ts: string;
  id: string;
}

const ev = (id: string, ts: string): Ev => ({ id, ts });

/** Pages of an ASCENDING history: page 1 is 2019, the last page is this week. */
function ascendingPages(): Ev[][] {
  return [
    [ev("a1", "2019-01-01T00:00:00.000Z"), ev("a2", "2019-01-02T00:00:00.000Z")],
    [ev("b1", "2023-06-01T00:00:00.000Z"), ev("b2", "2023-06-02T00:00:00.000Z")],
    [ev("c1", "2026-08-01T00:00:00.000Z"), ev("c2", "2026-08-02T00:00:00.000Z")],
  ];
}

function ids(cohorts: Ev[][]): string[] {
  return cohorts.flat().map((e) => e.id);
}

function isDescending(events: readonly Ev[]): boolean {
  for (let i = 1; i < events.length; i += 1) {
    if (Date.parse(events[i]!.ts) > Date.parse(events[i - 1]!.ts)) return false;
  }
  return true;
}

describe("sortDescByTs", () => {
  it("puts the newest first and is stable on ties", () => {
    const same = "2026-08-01T00:00:00.000Z";
    const out = sortDescByTs([ev("x", same), ev("y", same), ev("older", "2019-01-01T00:00:00.000Z")]);
    expect(out.map((e) => e.id)).toEqual(["x", "y", "older"]);
  });

  it("treats an unparseable timestamp as the oldest thing there is", () => {
    const out = sortDescByTs([ev("junk", "not a date"), ev("real", "2020-01-01T00:00:00.000Z")]);
    expect(out.map((e) => e.id)).toEqual(["real", "junk"]);
  });
});

describe("DescendingCohortBuffer", () => {
  it("passes a desc source straight through, one cohort per page", () => {
    const buf = new DescendingCohortBuffer<Ev>("desc", { pageHintEvents: 10 });
    const first = buf.push([ev("c2", "2026-08-02T00:00:00.000Z"), ev("c1", "2026-08-01T00:00:00.000Z")]);
    expect(ids(first)).toEqual(["c2", "c1"]);
    expect(buf.buffered).toBe(0);
    expect(buf.flush()).toEqual([]);
  });

  it("re-sorts a desc page that lied about its order", () => {
    const buf = new DescendingCohortBuffer<Ev>("desc", { pageHintEvents: 10 });
    const out = buf.push([ev("old", "2019-01-01T00:00:00.000Z"), ev("new", "2026-08-01T00:00:00.000Z")]);
    expect(ids(out)).toEqual(["new", "old"]);
  });

  it("buffers an ascending source and emits descending cohorts at flush", () => {
    const buf = new DescendingCohortBuffer<Ev>("asc", { pageHintEvents: 10 });
    for (const page of ascendingPages()) expect(buf.push(page)).toEqual([]);
    expect(buf.buffered).toBe(6);

    const out = buf.flush();
    expect(ids(out)).toEqual(["c2", "c1", "b2", "b1", "a2", "a1"]);
    expect(isDescending(out.flat())).toBe(true);
    expect(buf.buffered).toBe(0);
  });

  it("slices the descending run into cohorts of the page hint", () => {
    const buf = new DescendingCohortBuffer<Ev>("asc", { pageHintEvents: 2 });
    for (const page of ascendingPages()) buf.push(page);
    const out = buf.flush();
    expect(out.map((c) => c.map((e) => e.id))).toEqual([
      ["c2", "c1"],
      ["b2", "b1"],
      ["a2", "a1"],
    ]);
  });

  it("spills as descending cohorts instead of growing without limit", () => {
    const buf = new DescendingCohortBuffer<Ev>("asc", {
      pageHintEvents: 2,
      maxBufferedEvents: 4,
    });
    const pages = ascendingPages();
    expect(buf.push(pages[0]!)).toEqual([]);
    // The second page tips it over the threshold: what is held spills, newest
    // of what has arrived first.
    const spilled = buf.push(pages[1]!);
    expect(ids(spilled)).toEqual(["b2", "b1", "a2", "a1"]);
    expect(buf.buffered).toBe(0);
    // The run that spilled is strictly descending; a later page may carry newer
    // events, which is the documented trade for a bounded buffer.
    expect(isDescending(spilled.flat())).toBe(true);

    const rest = [...buf.push(pages[2]!), ...buf.flush()];
    expect(ids(rest)).toEqual(["c2", "c1"]);
  });

  it("sorts an unordered source too", () => {
    const buf = new DescendingCohortBuffer<Ev>("unordered", { pageHintEvents: 10 });
    buf.push([ev("mid", "2023-01-01T00:00:00.000Z"), ev("new", "2026-01-01T00:00:00.000Z")]);
    buf.push([ev("old", "2019-01-01T00:00:00.000Z")]);
    expect(ids(buf.flush())).toEqual(["new", "mid", "old"]);
  });

  it("ignores empty pages and flushes empty when nothing arrived", () => {
    const buf = new DescendingCohortBuffer<Ev>("asc", { pageHintEvents: 10 });
    expect(buf.push([])).toEqual([]);
    expect(buf.flush()).toEqual([]);
  });

  it("pushEvent feeds one event at a time (a stream with no page framing)", () => {
    const buf = new DescendingCohortBuffer<Ev>("asc", { pageHintEvents: 10 });
    for (const e of ascendingPages().flat()) buf.pushEvent(e);
    expect(ids(buf.flush())).toEqual(["c2", "c1", "b2", "b1", "a2", "a1"]);
  });
});

describe("descendingCohorts (batch form)", () => {
  it("turns ascending pages into one descending run", () => {
    const out = descendingCohorts(ascendingPages(), "asc", { pageHintEvents: 100 });
    expect(ids(out)).toEqual(["c2", "c1", "b2", "b1", "a2", "a1"]);
  });

  it("keeps a desc source's page boundaries", () => {
    const desc = ascendingPages().reverse().map((p) => [...p].reverse());
    const out = descendingCohorts(desc, "desc", { pageHintEvents: 100 });
    expect(out).toHaveLength(3);
    expect(ids(out)).toEqual(["c2", "c1", "b2", "b1", "a2", "a1"]);
  });
});
