// ===========================================================================
// Library › WhatsApp — the confirm transition (V6 P1 S6d L3).
//
// The bug this pins: "Confirm and import" appeared to do nothing. The panel
// gated the transition on `status.importDone`, which flips only when the Go
// daemon emits `backfill_complete` — minutes away over a real history — so the
// user pressed a button, the card re-rendered itself, and the import ran
// invisibly underneath.
//
// What is asserted here is the whole contract of that click:
//   1. the import view is up BEFORE the confirm request answers,
//   2. it keeps filling as chats land,
//   3. one click is one confirm, no matter how many times it is pressed,
//   4. a confirm that FAILS rolls back and says so — the view never claims an
//      import that did not start,
//   5. a window the daemon already installed is never offered a second
//      Confirm under a caveat saying one was already confirmed.
//
// The fetch stub here is local and deliberately controllable (a route can be
// left PENDING), which the shared stubWorker cannot do — every assertion about
// "before the request answers" needs a request that has not answered.
// ===========================================================================

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhatsAppLibrary } from "./screens/library/WhatsAppLibrary";

const POLL = 20;

interface Recorded {
  path: string;
  method: string;
  body: unknown;
}

interface Stub {
  calls: Recorded[];
  routes: Map<string, unknown>;
  /** Paths whose response is withheld until `release` is called. */
  pending: Set<string>;
  /** Paths that answer with an HTTP failure. */
  failing: Map<string, number>;
  release(path: string): void;
  countOf(path: string): number;
}

let stub: Stub;

const STATUS = "/api/sources/whatsapp/status";
const COUNTS = "/api/sources/whatsapp/counts";
const CONFIRM = "/api/sources/whatsapp/confirm";
const CHATS = "/api/library/chats";

const entry = (chats: number, messages: number) => ({ chats, messages });
const countsBody = (rangeInstalled = false) => ({
  counts: {
    counts: {
      "24h": entry(3, 41), "3d": entry(5, 120), "7d": entry(12, 1597), "30d": entry(40, 6091),
      "90d": entry(80, 8131), "180d": entry(120, 15000), "1y": entry(180, 26000), "2y": entry(214, 38412),
      "3y": entry(214, 38412), "4y": entry(214, 38412), "5y": entry(214, 38412), all: entry(214, 38412),
    },
    chats: 214,
    messages: 38412,
    oldestTs: "2024-09-01T00:00:00.000Z",
    bufferedBatches: 4,
    batches: 4,
    syncTypes: ["FULL"],
    rangeInstalled,
    ...(rangeInstalled ? { range: "all" as const } : {}),
    pendingLive: 2,
  },
  windows: [
    { range: "30d", chats: 40, messages: 6091, days: 30, accuracy: "measured" },
    { range: "all", chats: 214, messages: 38412, days: 735, accuracy: "measured" },
  ],
  caveats: rangeInstalled
    ? ["A window (all) is already confirmed; history is flowing."]
    : ["2 messages arrived since pairing and are held until you confirm — nothing is read before then."],
});

const chatRow = (key: string) => ({
  id: `whatsapp:st:${key}`,
  label: key,
  external_key: key,
  stream_kind: "dm",
  tier: null,
  category: null,
  capture_paused: 0,
  knows_from: null,
  last_ts: "2026-08-28T11:58:00.000Z",
  today_count: 0,
  event_count: 3,
  last_text: "hi",
  last_kind: "whatsapp.message",
  last_from_me: 0,
});

function installStub(): Stub {
  const waiters = new Map<string, Array<() => void>>();
  const s: Stub = {
    calls: [],
    routes: new Map<string, unknown>(),
    pending: new Set<string>(),
    failing: new Map<string, number>(),
    release(path) {
      s.pending.delete(path);
      for (const w of waiters.get(path) ?? []) w();
      waiters.delete(path);
    },
    countOf: (path) => s.calls.filter((c) => c.path === path).length,
  };
  // Paired, nothing imported, no window installed: the chooser card's state.
  s.routes.set(STATUS, { state: "connected", paired: true, paused: false, importDone: false });
  s.routes.set(COUNTS, countsBody());
  s.routes.set(CONFIRM, { ok: true, decision_id: "dec_1", importing: true, range: "all" });
  s.routes.set(CHATS, { source_id: "whatsapp", event_count: 0, streams: [] });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      s.calls.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (s.pending.has(path)) {
        await new Promise<void>((resolve) => {
          const list = waiters.get(path) ?? [];
          list.push(resolve);
          waiters.set(path, list);
        });
      }
      const code = s.failing.get(path);
      if (code !== undefined) {
        return { ok: false, status: code, json: async () => ({ error: "nope" }) };
      }
      if (!s.routes.has(path)) {
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      }
      return { ok: true, status: 200, json: async () => s.routes.get(path) };
    }),
  );
  return s;
}

/** Wait for the chooser card, then press Confirm. */
async function confirmFromCard(): Promise<void> {
  const card = await screen.findByLabelText("connect Choose how far back");
  await waitFor(() => expect(card.textContent).toContain("38,412 messages"));
  fireEvent.click(within(card).getByText("Confirm and import"));
}

beforeEach(() => {
  stub = installStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Library › WhatsApp › confirm and import", () => {
  it("moves to the import view IMMEDIATELY — before the confirm request answers", async () => {
    // The confirm never answers for the whole test: whatever the user sees is
    // what an optimistic transition put there, not a resolved request.
    stub.pending.add(CONFIRM);
    render(<WhatsAppLibrary pollMs={POLL} />);
    await confirmFromCard();

    // The card is gone and the source's own panel is up, in-flight state and all.
    await waitFor(() => expect(screen.queryByLabelText("connect Choose how far back")).toBeNull());
    const panel = screen.getByLabelText("WhatsApp");
    expect(within(panel).getByLabelText("whatsapp import status").textContent).toContain(
      "confirming your window",
    );
    // The request really is still in flight — nothing resolved it.
    expect(stub.countOf(CONFIRM)).toBe(1);

    stub.release(CONFIRM);
    // Once it lands, the line stops talking about confirming and starts
    // talking about the import that is now running.
    await waitFor(() =>
      expect(screen.getByLabelText("whatsapp import status").textContent).toContain(
        "importing your history",
      ),
    );
  });

  it("the import view keeps updating as chats land", async () => {
    render(<WhatsAppLibrary pollMs={POLL} />);
    await confirmFromCard();
    const status = await screen.findByLabelText("whatsapp import status");
    await waitFor(() => expect(status.textContent).toContain("nothing has landed yet"));

    // History starts arriving; the panel must show it without a remount.
    stub.routes.set(CHATS, {
      source_id: "whatsapp",
      event_count: 6,
      streams: [chatRow("rohan@s.whatsapp.net"), chatRow("goa@g.us")],
    });
    await waitFor(
      () =>
        expect(screen.getByLabelText("whatsapp import status").textContent).toContain(
          "2 chats so far",
        ),
      { timeout: 2000 },
    );
    expect(within(screen.getByLabelText("conversations")).getAllByRole("listitem")).toHaveLength(2);

    // …and the daemon's own progress frames win over the chat count once they exist.
    stub.routes.set(STATUS, {
      state: "syncing",
      paired: true,
      paused: false,
      importDone: false,
      importRange: "all",
      progress: { phase: "backfill", chatsDone: 12, chatsTotal: 214, messages: 4001, done: false },
    });
    await waitFor(
      () =>
        expect(screen.getByLabelText("whatsapp import status").textContent).toContain(
          "importing… 12/214 chats · 4001 messages",
        ),
      { timeout: 2000 },
    );
  });

  it("is impossible to double-fire: many clicks are one confirm", async () => {
    stub.pending.add(CONFIRM);
    const card = await (async () => {
      render(<WhatsAppLibrary pollMs={POLL} />);
      const c = await screen.findByLabelText("connect Choose how far back");
      await waitFor(() => expect(c.textContent).toContain("38,412 messages"));
      return c;
    })();
    const button = within(card).getByText("Confirm and import");
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.queryByLabelText("connect Choose how far back")).toBeNull());
    expect(stub.countOf(CONFIRM)).toBe(1);
    stub.release(CONFIRM);
    await waitFor(() => expect(stub.countOf(CONFIRM)).toBe(1));
  });

  it("a confirm that FAILS rolls back to the card and says nothing was imported", async () => {
    stub.failing.set(CONFIRM, 500);
    render(<WhatsAppLibrary pollMs={POLL} />);
    await confirmFromCard();
    const card = await screen.findByLabelText("connect Choose how far back");
    await waitFor(() => expect(card.textContent).toContain("Nothing was imported"));
    expect(card.textContent).toContain("the worker answered 500");
    // The button is live again — a failed yes is retryable.
    const button = within(card).getByText("Confirm and import") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(stub.countOf(CONFIRM)).toBe(2));
  });

  it("a window the daemon already installed is never offered a second Confirm", async () => {
    stub.routes.set(COUNTS, countsBody(true));
    render(<WhatsAppLibrary pollMs={POLL} />);
    // It lands on the import view, not on a chooser contradicting its own caveat.
    await screen.findByLabelText("WhatsApp");
    await waitFor(() => expect(screen.queryByLabelText("connect Choose how far back")).toBeNull());
    expect(screen.queryByText("Confirm and import")).toBeNull();
    expect(screen.getByLabelText("whatsapp import status").textContent).toContain(
      "importing your history",
    );
    expect(stub.countOf(CONFIRM)).toBe(0);
  });

  it("a persisted import range skips the chooser too — and stops polling /counts", async () => {
    stub.routes.set(STATUS, {
      state: "syncing",
      paired: true,
      paused: false,
      importDone: false,
      importRange: "all",
    });
    render(<WhatsAppLibrary pollMs={POLL} />);
    await screen.findByLabelText("WhatsApp");
    expect(screen.queryByText("Confirm and import")).toBeNull();
    // /counts is the chooser's read; with no chooser it must not be polled at
    // all — the worker is busy draining history.
    await act(async () => {
      await new Promise((r) => setTimeout(r, POLL * 4));
    });
    expect(stub.countOf(COUNTS)).toBe(0);
  });
});
