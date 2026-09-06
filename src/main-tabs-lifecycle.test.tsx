// ===========================================================================
// Main-tab staging — V6 P1 S6d (FIX-C5).
//
// Two claims, one per half of the fix.
//
//   1. A SECOND VISIT COSTS NOTHING. `{tab === "spaces" && <Spaces />}` threw
//      the screen away on every departure, so every arrival paid a cold read.
//      Against the user's worker that was 8.0 s for /api/spaces/list (25 bytes
//      of body, five rows in the table) because the reader queues behind the
//      importer's synchronous writes. A main tab is now mounted once and kept
//      mounted, so flipping away and back issues NO request — and the screen's
//      own state survives with it. Freshness is preserved by re-mounting a
//      pane whose last visit is older than STALE_MS.
//
//   2. UNKNOWN IS NEVER RENDERED AS EMPTY. While the first read is in flight a
//      screen knows nothing, and must say so. "no people known yet" over a
//      roster of 844, or five circles reading 0, is a verdict the screen has
//      not earned — the exact lie the user reported.
//
// The worker half of the same fix is worker/src/server/main-tabs-perf.test.ts.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { App } from "./App";
import { resetLoadCache } from "./components/LoadState";
import { stubWorker, type WorkerStub } from "./test-utils";

/** Must match App.tsx's STALE_MS. */
const STALE_MS = 30_000;

let stub: WorkerStub;

/** Every read the six main tabs make on arrival, so nothing 404s by accident. */
function seedRoutes(s: WorkerStub): void {
  s.routes.set("/api/artifacts", { artifacts: [] });
  s.routes.set("/api/freshness", { sources: [], overall: null });
  s.routes.set("/api/ops/halt", { halted: false });
  s.routes.set("/api/spaces/list", { areas: [], dormant: [], proposed_count: 0 });
  s.routes.set("/api/people", { people: [], open_questions: [] });
  s.routes.set("/api/people/aliases", { aliases: {} });
  s.routes.set("/api/people/who-i-am", {
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
    emptyNote: "nothing learned yet",
  });
  s.routes.set("/api/people/radar", { radar: [] });
  s.routes.set("/api/timeline", { rows: [], next_before: null });
  s.routes.set("/api/timeline/days", { days: [], sources: [] });
  s.routes.set("/api/calendar", { layers: [], items: [], counts: {} });
  s.routes.set("/api/settings/general", {
    hotkey_summon: "⌘⇧S",
    hotkey_bar: "⌘⇧B",
    launch_at_login: false,
  });
}

/** How many times the stub was asked for `path`. */
function hits(path: string): number {
  return stub.calls.filter((c) => c.path === path).length;
}

/** Click a main tab by its visible label. */
async function go(label: RegExp): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetLoadCache();
  stub = stubWorker();
  seedRoutes(stub);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("main tabs keep their place (FIX-C5)", () => {
  it("asks once for a tab's data, and not again when you flip away and back", async () => {
    render(<App />);
    await waitFor(() => expect(hits("/api/home")).toBe(1));

    await go(/Spaces/);
    await waitFor(() => expect(hits("/api/spaces/list")).toBe(1));

    await go(/Timeline/);
    await waitFor(() => expect(hits("/api/timeline")).toBe(1));

    // Back to Spaces. The pane was never unmounted, so there is nothing to
    // re-read: the flip is a `display` toggle, not a queue ticket.
    await go(/Spaces/);
    await go(/Timeline/);
    await go(/Spaces/);
    expect(hits("/api/spaces/list")).toBe(1);
    expect(hits("/api/timeline")).toBe(1);
  });

  it("keeps a visited pane in the DOM, hidden, rather than destroying it", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(hits("/api/home")).toBe(1));

    await go(/Spaces/);
    await waitFor(() => expect(container.querySelector('[data-pane="spaces"]')).not.toBeNull());

    await go(/Timeline/);
    const spaces = container.querySelector('[data-pane="spaces"]');
    const timeline = container.querySelector('[data-pane="timeline"]');
    // Still mounted…
    expect(spaces).not.toBeNull();
    // …and honestly hidden: out of the a11y tree and out of the tab order.
    expect(spaces?.hasAttribute("hidden")).toBe(true);
    expect(timeline?.hasAttribute("hidden")).toBe(false);
  });

  it("does not mount a tab that has never been opened", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(hits("/api/home")).toBe(1));
    expect(container.querySelector('[data-pane="people"]')).toBeNull();
    expect(hits("/api/people")).toBe(0);
  });

  it("re-reads a pane whose last visit has gone stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await waitFor(() => expect(hits("/api/home")).toBe(1));

    await go(/Spaces/);
    await waitFor(() => expect(hits("/api/spaces/list")).toBe(1));
    await go(/Timeline/);

    // Long enough away that the answer on screen is no longer trustworthy.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_MS + 1_000);
    });
    await go(/Spaces/);
    await waitFor(() => expect(hits("/api/spaces/list")).toBe(2));
  });

  // The Library polls — six intervals across its sub-tabs — so it is the one
  // main tab that must still unmount when it leaves, or it would keep asking a
  // worker that is already the bottleneck while nobody is looking at it.
  it("still unmounts the Library, because the Library polls", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(hits("/api/home")).toBe(1));

    await go(/Library/);
    await go(/Timeline/);
    expect(container.querySelector('[data-pane="library"]')).toBeNull();
  });
});

describe("a pending main tab never renders an empty verdict (FIX-C5)", () => {
  it("People stages the roster instead of printing five circles of zero", async () => {
    // A read that never answers is the pending case, held still.
    stub.routes.delete("/api/people");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        stub.calls.push({ path, method: "GET", body: undefined });
        if (path === "/api/people") return new Promise(() => {});
        if (!stub.routes.has(path)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => stub.routes.get(path) };
      }),
    );

    render(<App />);
    await go(/People/);

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /loading the people you know/i })).toBeTruthy(),
    );
    // The lie the user saw, in both of its forms.
    expect(screen.queryByText(/no people known yet/i)).toBeNull();
    expect(screen.queryByText(/drag someone here/i)).toBeNull();
  });

  it("Spaces stages the list instead of saying there are none", async () => {
    stub.routes.delete("/api/spaces/list");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        stub.calls.push({ path, method: "GET", body: undefined });
        if (path === "/api/spaces/list") return new Promise(() => {});
        if (!stub.routes.has(path)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => stub.routes.get(path) };
      }),
    );

    render(<App />);
    await go(/Spaces/);

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /loading your spaces/i })).toBeTruthy(),
    );
    expect(screen.queryByText(/no spaces yet/i)).toBeNull();
  });

  it("still prints the empty line once the answer really is nothing", async () => {
    render(<App />);
    await go(/Spaces/);
    await waitFor(() => expect(screen.getByText(/no spaces yet/i)).toBeTruthy());
  });
});
