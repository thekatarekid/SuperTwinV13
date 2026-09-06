// ===========================================================================
// Library — staging and transitions (13.12.x · L2).
//
// The user's report, in three sentences: "switching a sub-tab first shows the
// DEFAULT/empty state, then after several seconds — sometimes a minute — of a
// frozen screen with no indicator, it flips to the real state"; "every one of
// the four sub-tab switches feels stuck because nothing appears for a long
// time". Measured against their own running worker, the reads behind those
// panes took 3.0 s (WhatsApp status), 4.0 s (storage), 5.4 s (screen) and
// 9.6 s (browser) while a WhatsApp import held the database.
//
// The staging contract these tests hold the shell to:
//
//   1. NO VERDICT WHILE UNKNOWN. While a pane's first read is in flight it
//      paints a skeleton. Never the empty state, never a default, never a
//      "not connected" card — none of which it has grounds to claim yet.
//   2. A RE-VISIT IS INSTANT. Flipping away and back repaints the last answer
//      in the same frame, from the pane cache, with no pending phase at all.
//   3. A STALE REPLY LOSES. The slow first request cannot overwrite the answer
//      a newer request already delivered — on screen or in the cache.
//
// Every read here is deferred by hand, because the defect only exists while a
// request is in flight: a stub that answers in a microtask cannot see it.
// ===========================================================================

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { peekLoadCache, resetLoadCache, useLoad } from "./components/LoadState";
import { Library, type LibraryView } from "./screens/Library";

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
  /** Requests to these paths hang until `send()` releases them. */
  held: Set<string>;
  waiters: Waiter[];
}

function stubDeferred(held: string[] = []): Deferred {
  const d: Deferred = { calls: [], routes: routeTable(), held: new Set(held), waiters: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
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

/** Release the nth still-waiting request for `path` with `body`. */
async function send(d: Deferred, path: string, body: unknown, nth = 0): Promise<void> {
  const matches = d.waiters.filter((w) => w.path === path);
  const w = matches[nth];
  if (!w) throw new Error(`no held request #${nth} for ${path} (have ${matches.length})`);
  d.waiters = d.waiters.filter((x) => x !== w);
  await act(async () => {
    w.send(body);
    await Promise.resolve();
  });
}

/** Let every already-resolved promise flush without releasing a held read. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const CHATS = {
  source_id: "whatsapp",
  event_count: 2,
  streams: [
    {
      id: "whatsapp:st:goa@g.us",
      label: "Goa gang",
      external_key: "goa@g.us",
      stream_kind: "group",
      tier: "T1",
      category: "cat1",
      capture_paused: 0,
      knows_from: "2024-01-05T00:00:00.000Z",
      last_ts: "2026-08-28T11:58:00.000Z",
      today_count: 2,
      event_count: 420,
      last_text: "pool villa or bust",
      last_kind: "whatsapp.message",
      last_from_me: 0,
    },
  ],
};

function routeTable(): Map<string, unknown> {
  const r = new Map<string, unknown>();
  r.set("/api/sources/whatsapp/status", {
    state: "online",
    paired: true,
    paused: false,
    pushName: "Aditya",
    importDone: true,
    importRange: "1y",
  });
  r.set("/api/library/chats", CHATS);
  r.set("/api/screen/status", {
    running: true,
    state: "capturing",
    permission: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security",
  });
  r.set("/api/library/screen", {
    day: "2026-08-28",
    event_count: 4,
    hours: new Array(24).fill(0).map((_, h) => (h === 14 ? 4 : 0)),
    sessions: [],
    apps: [
      {
        bundle_id: "com.figma.Desktop",
        app: "Figma",
        minutes: 44,
        event_count: 4,
        session_count: 1,
        docs: [{ doc: "v13 mocks", minutes: 4, event_count: 4, sessions: [] }],
      },
    ],
    paused: false,
  });
  r.set("/api/sources/browser/status", {
    source: "browser",
    connected: true,
    running: true,
    consent: {
      id: "cns_b1",
      state: "connected",
      granted_at: "2026-08-20T10:00:00.000Z",
      index_all: true,
      index_from: null,
      understand_from: null,
      profiles: [],
    },
    event_count: 3,
  });
  r.set("/api/library/browser", {
    event_count: 3,
    domains_today: [{ domain: "airbnb.com", visits: 3 }],
    chains: [],
    bookmarks: [],
  });
  r.set("/api/sources/browser/import", {
    source: "browser",
    connected: true,
    running: true,
    progress: {
      known: true,
      reading: false,
      first_pass_done: true,
      profiles: [
        { history_path: "/tmp/History", browser_name: "Chrome", profile: "Default", label: null, state: "done", visits_read: 3, error: null },
      ],
      visits_read: 3,
      events_written: 3,
      expected_visits: 3,
      started_at: "2026-08-28T10:00:00.000Z",
      finished_at: "2026-08-28T10:01:00.000Z",
    },
  });
  r.set("/api/library/storage", {
    disk: { free_bytes: 487_000_000_000, total_bytes: 994_000_000_000 },
    used: { events_derived_bytes: 1_600_000_000, media_bytes: 0 },
    budgets: {
      events_bytes_per_year: 8_000_000_000,
      media_bytes: 4_000_000_000,
      media_retention_days: 90,
    },
    copy: { lead: "Keeping more history costs disk. Understanding more history costs money." },
    sources: [],
  });
  return r;
}

/** The gating read of each pane: the one that decides what the pane claims. */
const GATE: Record<LibraryView, string> = {
  whatsapp: "/api/sources/whatsapp/status",
  screen: "/api/library/screen",
  browser: "/api/sources/browser/status",
  storage: "/api/library/storage",
};

/** What the skeleton names itself while that pane has no answer. */
const SKELETON: Record<LibraryView, string> = {
  whatsapp: "loading WhatsApp",
  screen: "loading Screen",
  browser: "loading Browser",
  storage: "loading the storage overview",
};

/**
 * The verdicts a pane must NOT reach for while it is still asking. Each of
 * these was on the user's screen for seconds before the truth replaced it.
 */
const LIES: Record<LibraryView, RegExp[]> = {
  whatsapp: [/no chats have arrived yet/, /Link a device/, /pick a conversation to read it/],
  screen: [
    /Nothing read off your screen yet/,
    /The screen watcher isn't running/,
    /nothing captured on this day/,
  ],
  browser: [
    /connected — reading your history/,
    /no visit chains captured yet/,
    /Connect your browsing/,
  ],
  storage: [/No source is connected yet/],
};

const VIEWS: LibraryView[] = ["whatsapp", "screen", "browser", "storage"];

describe("a sub-tab paints a skeleton, never a verdict, while it is still asking", () => {
  for (const view of VIEWS) {
    it(`${view} — the empty state is not rendered while the first read is pending`, async () => {
      const d = stubDeferred([GATE[view]]);
      render(<Library initial={view} />);

      // The very first frame, and every frame until the answer lands.
      for (let i = 0; i < 3; i++) {
        expect(screen.getByLabelText(SKELETON[view])).toBeTruthy();
        for (const lie of LIES[view]) expect(screen.queryByText(lie)).toBeNull();
        // A wait with no indicator is what "frozen" meant: there is one.
        expect(screen.getAllByRole("progressbar").length).toBeGreaterThan(0);
        await settle();
      }

      // The read lands, and only then does the pane state anything.
      await send(d, GATE[view], d.routes.get(GATE[view]));
      await waitFor(() => expect(screen.queryByLabelText(SKELETON[view])).toBeNull());
    });
  }

  it("whatsapp — an unpaired account never flashes the inbox first", async () => {
    const d = stubDeferred(["/api/sources/whatsapp/status"]);
    render(<Library initial="whatsapp" />);
    expect(screen.queryByLabelText("WhatsApp")).toBeNull();
    await settle();
    expect(screen.queryByLabelText("WhatsApp")).toBeNull();

    await send(d, "/api/sources/whatsapp/status", {
      state: "need_pairing",
      paired: false,
      paused: false,
    });
    await waitFor(() => expect(screen.getByLabelText("connect Connect WhatsApp")).toBeTruthy());
    // The inbox shell never went up in between.
    expect(screen.queryByLabelText("conversations")).toBeNull();
  });

  it("browser — a source that is NOT connected never claims it is, mid-read", async () => {
    const d = stubDeferred(["/api/sources/browser/status"]);
    render(<Library initial="browser" />);
    await settle();
    expect(screen.queryByText(/connected — reading your history/)).toBeNull();

    await send(d, "/api/sources/browser/status", {
      source: "browser",
      connected: false,
      running: false,
      consent: null,
      event_count: 0,
    });
    await waitFor(() =>
      expect(screen.getByLabelText("connect Connect your browsing")).toBeTruthy(),
    );
  });
});

describe("a re-visited sub-tab repaints from cache, in the same frame", () => {
  it("WhatsApp → Screen → WhatsApp shows the chats with no pending phase", async () => {
    stubDeferred();
    render(<Library initial="whatsapp" />);
    await screen.findByText("Goa gang");

    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("Screen"));
    await waitFor(() => expect(screen.queryByText("Goa gang")).toBeNull());

    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("WhatsApp"));
    // No await: the answer is already known, so it is on screen immediately.
    expect(screen.getByText("Goa gang")).toBeTruthy();
    expect(screen.queryByLabelText("loading WhatsApp")).toBeNull();
    await settle(); // let the background revalidation land before teardown
  });

  it("a re-visit inside the freshness window does not re-ask the worker", async () => {
    const d = stubDeferred();
    render(<Library initial="storage" />);
    await screen.findByLabelText("disk use");
    const asked = d.calls.filter((p) => p === "/api/library/storage").length;
    expect(asked).toBe(1);

    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("Screen"));
    await screen.findByLabelText("Screen");
    fireEvent.click(screen.getByLabelText("library storage").querySelector("button")!);

    expect(screen.getByLabelText("disk use")).toBeTruthy();
    await settle();
    expect(d.calls.filter((p) => p === "/api/library/storage").length).toBe(asked);
  });

  it("a pane that was left mid-read still fills its cache, so the return is instant", async () => {
    const d = stubDeferred(["/api/library/chats"]);
    render(<Library initial="whatsapp" />);
    await settle();

    // Leave while the chat read is still in flight, then let it answer.
    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("Screen"));
    await screen.findByLabelText("Screen");
    await send(d, "/api/library/chats", CHATS);

    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("WhatsApp"));
    expect(screen.getByText("Goa gang")).toBeTruthy();
    await settle();
  });
});

describe("a stale reply cannot overwrite a newer answer", () => {
  it("the slow first chat read loses to the fast second one", async () => {
    const d = stubDeferred(["/api/library/chats"]);
    render(<Library initial="whatsapp" />);
    await settle();

    // Away and back: request #1 is still in flight, request #2 is issued.
    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("Screen"));
    await screen.findByLabelText("Screen");
    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("WhatsApp"));
    await settle();
    expect(d.calls.filter((p) => p === "/api/library/chats").length).toBe(2);

    const fresh = {
      ...CHATS,
      streams: [{ ...CHATS.streams[0], id: "whatsapp:st:new@g.us", label: "NEW arrivals" }],
    };
    const stale = {
      ...CHATS,
      streams: [{ ...CHATS.streams[0], id: "whatsapp:st:old@g.us", label: "OLD answer" }],
    };

    // The newer request answers first, then the older one finally replies.
    await send(d, "/api/library/chats", fresh, 1);
    await waitFor(() => expect(screen.getByText("NEW arrivals")).toBeTruthy());
    await send(d, "/api/library/chats", stale, 0);
    await settle();

    expect(screen.getByText("NEW arrivals")).toBeTruthy();
    expect(screen.queryByText("OLD answer")).toBeNull();
    // And the cache the next visit paints from holds the newer answer too.
    const cached = peekLoadCache<Array<{ label: string }>>("library.whatsapp.chats");
    expect(cached?.[0]?.label).toBe("NEW arrivals");
  });

  it("leaving a pane mid-read and coming back does not stack a second query", async () => {
    // The other half of "ignore the stale request": on a worker measured at
    // 4-10 s per aggregate, four sub-tab flips must not leave four of them
    // queued. A re-mount joins the read already on the wire.
    const d = stubDeferred(["/api/library/storage"]);
    render(<Library initial="storage" />);
    await settle();

    fireEvent.click(within(screen.getByLabelText("library sources")).getByText("Screen"));
    await screen.findByLabelText("Screen");
    fireEvent.click(screen.getByLabelText("library storage").querySelector("button")!);
    await settle();

    expect(d.calls.filter((p) => p === "/api/library/storage").length).toBe(1);
    await send(d, "/api/library/storage", d.routes.get("/api/library/storage"));
    await waitFor(() => expect(screen.getByLabelText("disk use")).toBeTruthy());
  });

  it("useLoad drops an older reply even when it lands last", async () => {
    // Straight at the primitive: two reads for one key, overlapping, the older
    // answering second. Neither the render nor the cache may take it.
    const gates: Array<(v: string) => void> = [];
    function Probe(props: { which: number }): JSX.Element {
      const gate = useLoad(
        () => new Promise<string>((res) => gates.push(res)),
        [props.which],
        { cacheKey: "probe" },
      );
      return <p>{gate.data ?? "…"}</p>;
    }

    const view = render(<Probe which={1} />);
    await settle();
    view.rerender(<Probe which={2} />);
    await settle();
    expect(gates.length).toBe(2);

    await act(async () => {
      gates[1]!("second answer");
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("second answer")).toBeTruthy());

    await act(async () => {
      gates[0]!("first answer, far too late");
      await Promise.resolve();
    });
    await settle();

    expect(screen.getByText("second answer")).toBeTruthy();
    expect(screen.queryByText("first answer, far too late")).toBeNull();
    expect(peekLoadCache<string>("probe")).toBe("second answer");
  });
});
