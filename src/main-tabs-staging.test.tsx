// ===========================================================================
// The MAIN tabs — unknown is not empty (FIX-C4).
//
// THE REPORT. The user's install had imported thousands of events and every
// main tab said it had nothing: Home — "nothing needs you right now" / "no
// spaces yet" / "nothing to review" / "nothing learned yet"; Timeline —
// "nothing captured yet" over an event log with thousands of rows; Calendar —
// "nothing dated in this window" with all four layer counts on 0; People —
// "Who I am" and the follow-up radar "stuck on loading".
//
// THE MEASUREMENT. The worker was answering all of it. /api/timeline returned
// 200 with rows, /api/people 181 KB, /api/calendar items, /api/home 8 open
// tasks and 5 proposals waiting. It was just SLOW: better-sqlite3 is
// synchronous, a WhatsApp import held the database, and one tab's worth of
// concurrent reads took 15.01 s wall. For all fifteen of those seconds the
// screens painted a verdict they had not earned.
//
// This is the same defect the Library's four sub-tabs were cured of in
// 13.12.x · L2 (components/LoadState.tsx documents it, measured on this very
// user's worker). The fix was applied to one half of the app; these tests hold
// the other half to the same contract:
//
//   1. NO VERDICT WHILE UNKNOWN. While the first read is in flight the screen
//      paints a skeleton — never the empty line, never a count of 0.
//   2. THE VERDICT STILL ARRIVES. Once the worker has actually said "nothing",
//      the empty line is exactly what shows.
//   3. A RE-VISIT IS INSTANT. Coming back to a main tab repaints the last
//      answer in the same frame instead of asking a busy worker again.
//
// Every read here is deferred by hand: the defect only exists while a request
// is in flight, and a stub that answers in a microtask cannot see it.
// ===========================================================================

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLoadCache } from "./components/LoadState";
import { Calendar } from "./screens/Calendar";
import { Home } from "./screens/Home";
import { Timeline } from "./screens/Timeline";
import { Radar } from "./screens/people/Radar";
import { WhoIAm } from "./screens/people/WhoIAm";
import type { CalendarViewResponse, HomeData } from "./lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resetLoadCache();
});

// ---- a fetch stub that can be made to hang -------------------------------

interface Waiter {
  path: string;
  send: (body: unknown) => void;
}

interface Deferred {
  calls: string[];
  routes: Map<string, unknown>;
  held: Set<string>;
  waiters: Waiter[];
}

function stubDeferred(held: string[] = [], routes: Record<string, unknown> = {}): Deferred {
  const d: Deferred = { calls: [], routes: new Map(), held: new Set(held), waiters: [] };
  for (const [path, body] of Object.entries(routes)) d.routes.set(path, body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      d.calls.push(path);
      if (d.held.has(path) && (init?.method ?? "GET") === "GET") {
        const body = await new Promise<unknown>((res) => d.waiters.push({ path, send: res }));
        return { ok: true, status: 200, json: async () => body };
      }
      if (!d.routes.has(path)) {
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      }
      return { ok: true, status: 200, json: async () => d.routes.get(path) };
    }),
  );
  return d;
}

/** Release the first still-waiting request for `path`. */
async function send(d: Deferred, path: string, body: unknown): Promise<void> {
  const w = d.waiters.find((x) => x.path === path);
  if (!w) throw new Error(`no held request for ${path}`);
  d.waiters = d.waiters.filter((x) => x !== w);
  await act(async () => {
    w.send(body);
    await Promise.resolve();
  });
}

/** Let resolved promises flush without releasing a held read. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ---- fixtures -------------------------------------------------------------

const EMPTY_HOME: HomeData = { today: [], spaces: [], review: [], recent_understanding: [] };

const TIMELINE_ROW = {
  id: "e1",
  ts: "2026-09-01T10:00:00.000Z",
  end_ts: "2026-09-01T10:00:00.000Z",
  source: "wa",
  kind: "message",
  actor: "Rohan",
  chat: "Goa gang",
  text: "pool villa or bust",
  count: 1,
  event_ids: ["e1"],
  space_id: null,
  space_label: null,
};

const CALENDAR: CalendarViewResponse = {
  from: "2026-09-01",
  to: "2026-10-01",
  tz: "Asia/Kolkata",
  layers: ["my_events", "my_tasks", "twin_tasks", "people"],
  counts: { my_events: 1, my_tasks: 0, twin_tasks: 0, people: 0 },
  items: [
    {
      layer: "my_events",
      kind: "event",
      refId: "cev_dinner",
      title: "Dinner with Rohan",
      at: "2026-09-01T14:30:00.000Z",
      day: "2026-09-01",
      allDay: false,
      status: "confirmed",
      relative: "today",
      rendered: "2026-09-01 20:00 IST",
      sourceTz: null,
      spaceId: null,
      spaceLabel: null,
      personEntityId: null,
      personName: null,
      phrase: null,
      detail: {},
    },
  ],
};

const EMPTY_CARD = {
  selfId: "ent_self",
  filledBy: "processing",
  basics: [],
  life: [],
  narrative: [],
  traits: [],
  voice: [],
  people: {},
  counts: { claims: 0, people: 0 },
  empty: true,
  emptyNote: "Nothing yet — this card fills from processing over the first hour.",
};

/** The four sentences Home said while it was still asking. */
const HOME_VERDICTS = [
  "nothing needs you right now",
  "no spaces yet",
  "nothing to review",
  "nothing learned yet",
];

const HOME_SECTIONS = ["Today", "Spaces", "Review queue", "Recent understanding"];

const noop = (): void => {};
const homeProps = {
  prepared: [],
  onOpenArtifact: noop,
  onOpenTask: noop,
  onOpenSpace: noop,
  onOpenProposal: noop,
  onOpenClaim: noop,
  onDragMove: noop,
};

// ---------------------------------------------------------------------------

describe("Home — four verdicts it had not earned", () => {
  it("paints skeletons, not empty states, while /api/home has not answered", () => {
    // No `unknown` prop on purpose: the default reading of (no data, no error)
    // is the only honest one, so a caller that forgets it still cannot lie.
    render(<Home {...homeProps} data={null} error={null} loading />);

    for (const verdict of HOME_VERDICTS) expect(screen.queryByText(verdict)).toBeNull();
    for (const label of HOME_SECTIONS) {
      expect(screen.getByLabelText(label).getAttribute("aria-busy")).toBe("true");
    }
  });

  it("says 'nothing' once the worker has actually said nothing", () => {
    render(<Home {...homeProps} data={EMPTY_HOME} error={null} loading={false} />);

    for (const verdict of HOME_VERDICTS) expect(screen.getByText(verdict)).toBeTruthy();
    for (const label of HOME_SECTIONS) {
      expect(screen.getByLabelText(label).getAttribute("aria-busy")).toBe("false");
    }
  });

  it("a failed read is still the error state, not four empty sections", () => {
    render(<Home {...homeProps} data={null} error="worker unreachable" loading={false} />);

    expect(screen.getByText("worker unreachable")).toBeTruthy();
    for (const verdict of HOME_VERDICTS) expect(screen.queryByText(verdict)).toBeNull();
  });
});

describe("Timeline — 'nothing captured yet' over a log with thousands of rows", () => {
  it("never claims an empty log while the read is in flight", async () => {
    const d = stubDeferred(["/api/timeline"], { "/api/timeline/days": { days: [], sources: [] } });
    render(<Timeline spaces={[]} onOpenSpace={noop} />);

    for (let i = 0; i < 3; i += 1) {
      expect(screen.queryByText("nothing captured yet")).toBeNull();
      expect(screen.getByLabelText("loading your timeline")).toBeTruthy();
      // A wait with no indicator is what "frozen" meant. There is one.
      expect(screen.getAllByRole("progressbar").length).toBeGreaterThan(0);
      await settle();
    }

    await send(d, "/api/timeline", { rows: [TIMELINE_ROW], next_before: null });
    await waitFor(() => expect(screen.getByText("pool villa or bust")).toBeTruthy());
    expect(screen.queryByLabelText("loading your timeline")).toBeNull();
    expect(screen.queryByText("nothing captured yet")).toBeNull();
  });

  it("still says 'nothing captured yet' when the answer is nothing", async () => {
    const d = stubDeferred(["/api/timeline"], { "/api/timeline/days": { days: [], sources: [] } });
    render(<Timeline spaces={[]} onOpenSpace={noop} />);
    await settle();

    await send(d, "/api/timeline", { rows: [], next_before: null });
    await waitFor(() => expect(screen.getByText("nothing captured yet")).toBeTruthy());
  });

  it("a re-visit repaints the last timeline in the same frame", async () => {
    stubDeferred([], {
      "/api/timeline": { rows: [TIMELINE_ROW], next_before: null },
      "/api/timeline/days": { days: [], sources: [] },
    });
    const first = render(<Timeline spaces={[]} onOpenSpace={noop} />);
    await screen.findByText("pool villa or bust");
    first.unmount();

    render(<Timeline spaces={[]} onOpenSpace={noop} />);
    // No await: the answer is already known, so it is there on the first frame
    // and there is no pending phase to sit through.
    expect(screen.getByText("pool villa or bust")).toBeTruthy();
    expect(screen.queryByLabelText("loading your timeline")).toBeNull();
    await settle();
  });
});

describe("Calendar — an empty window, and four zeroes, asserted before asking", () => {
  it("paints the skeleton and no counts while the derivation is in flight", async () => {
    const d = stubDeferred(["/api/calendar"]);
    render(<Calendar />);

    for (let i = 0; i < 3; i += 1) {
      expect(screen.queryByText("nothing dated in this window")).toBeNull();
      expect(screen.getByLabelText("loading the calendar")).toBeTruthy();
      // A count of 0 is a claim about the layer, and there is no count yet.
      const chip = screen.getByLabelText("◼ my events layer");
      expect(chip.textContent).toContain("–");
      expect(chip.textContent).not.toContain("0");
      await settle();
    }

    await send(d, "/api/calendar", CALENDAR);
    await waitFor(() => expect(screen.getByText("Dinner with Rohan")).toBeTruthy());
    expect(screen.getByLabelText("◼ my events layer").textContent).toContain("1");
  });

  it("still says the window is empty once the worker says so", async () => {
    const d = stubDeferred(["/api/calendar"]);
    render(<Calendar />);
    await settle();

    await send(d, "/api/calendar", { ...CALENDAR, items: [], counts: { my_events: 0, my_tasks: 0, twin_tasks: 0, people: 0 } });
    await waitFor(() => expect(screen.getByText("nothing dated in this window")).toBeTruthy());
  });
});

describe("People — the two panels the user reported as stuck on loading", () => {
  it("Who I am paints the skeleton, not a bare word, while it asks", async () => {
    const d = stubDeferred(["/api/people/who-i-am"]);
    render(<WhoIAm />);

    await settle();
    expect(screen.getByLabelText("loading your identity card")).toBeTruthy();
    expect(screen.queryByText("loading…")).toBeNull();
    expect(screen.getAllByRole("progressbar").length).toBeGreaterThan(0);

    await send(d, "/api/people/who-i-am", EMPTY_CARD);
    await waitFor(() => expect(screen.getByText(/fills from processing/)).toBeTruthy());
    expect(screen.queryByLabelText("loading your identity card")).toBeNull();
  });

  it("the radar paints the skeleton and never 'nothing owed either way' first", async () => {
    const d = stubDeferred(["/api/people/radar"]);
    render(<Radar />);

    await settle();
    expect(screen.getByLabelText("loading the follow-up radar")).toBeTruthy();
    expect(screen.queryByText("nothing owed either way")).toBeNull();
    expect(screen.queryByText("loading…")).toBeNull();

    await send(d, "/api/people/radar", { radar: [] });
    await waitFor(() => expect(screen.getByText("nothing owed either way")).toBeTruthy());
  });
});
