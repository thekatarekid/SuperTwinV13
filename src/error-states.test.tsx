// ===========================================================================
// W3 — a failed read is visible, honest and retryable. Never a spinner.
//
// THE DEFECT THIS PINS. 13.11.1 shipped a worker that threw inside `main()`
// before it ever listened. Home said "worker unreachable"; Settings sat on
// `loading…` forever, because every panel swallowed the rejection
// (`.catch(() => {})`) and rendered its pending state off `data === null`.
// A dead worker was indistinguishable from a slow one, on eleven panels.
//
// WHAT IS ASSERTED HERE, per surface:
//   1. a failed read RESOLVES — the spinner is gone,
//   2. the words are HONEST — "worker unreachable" only when nothing is
//      listening; a 404 names the status and the route instead,
//   3. there is a RETRY, and pressing it re-asks the worker,
//   4. a worker that comes back renders, without a reload.
//
// Zero network, zero worker, zero model calls: `fetch` is a stub throughout.
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { fetchHome, WorkerError, describeWorkerError } from "./lib/api";
import { Calendar } from "./screens/Calendar";
import { Library, type LibraryView } from "./screens/Library";
import { Panel } from "./panel/Panel";
import { People } from "./screens/People";
import { SETTINGS_SUBTABS, Settings } from "./screens/Settings";
import { Spaces } from "./screens/Spaces";
import { WhyPanel } from "./components/WhyPanel";
import { Timeline } from "./screens/Timeline";
import { stubWorker } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Nothing is listening on the worker port: `fetch` itself rejects. */
function stubUnreachable(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Rejects until `up` is flipped, then serves `routes` — a worker booting. */
function stubDownThenUp(routes: Record<string, unknown>): { up: () => void } {
  let live = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (!live) throw new TypeError("Failed to fetch");
      const path = new URL(String(input)).pathname;
      if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => routes[path] };
    }),
  );
  return {
    up: () => {
      live = true;
    },
  };
}

// ---------------------------------------------------------------------------

describe("W3 · lib/api names which failure it was", () => {
  it("a rejected fetch is 'worker unreachable' — the process, not the route", async () => {
    stubUnreachable();
    const err = await fetchHome().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerError);
    expect((err as WorkerError).kind).toBe("unreachable");
    expect((err as WorkerError).status).toBeNull();
    expect(describeWorkerError(err)).toBe("worker unreachable");
  });

  it("a non-2xx answer names the status and the path, and does NOT claim the worker is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const err = await fetchHome().catch((e: unknown) => e);
    expect((err as WorkerError).kind).toBe("http");
    expect((err as WorkerError).status).toBe(503);
    expect(describeWorkerError(err)).toBe("the worker answered 503 for /api/home");
    expect(describeWorkerError(err)).not.toContain("unreachable");
  });

  it("a body that will not parse says the answer wasn't readable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    );
    const err = await fetchHome().catch((e: unknown) => e);
    expect((err as WorkerError).kind).toBe("malformed");
    expect(describeWorkerError(err)).toBe("the worker's answer for /api/home wasn't readable");
  });
});

// ---------------------------------------------------------------------------

describe("W3 · every Settings panel resolves a dead worker into an error + Retry", () => {
  for (const tab of SETTINGS_SUBTABS) {
    it(`${tab.label} — says "worker unreachable", offers Retry, and does not spin`, async () => {
      stubUnreachable();
      render(<Settings />);
      fireEvent.click(screen.getByRole("button", { name: tab.label }));

      // 1. the failure is on screen, in words
      await waitFor(() => expect(screen.getAllByText("worker unreachable").length).toBeGreaterThan(0));
      // 2. there is exactly one retry affordance
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      // 3. the spinner the 13.11.1 build never left is gone
      expect(screen.queryByText("loading…")).toBeNull();
      // 4. the alert is announced, not just painted
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    });
  }

  it("Retry re-asks the worker", async () => {
    const fetchStub = stubUnreachable();
    render(<Settings />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  it("a worker that comes back renders the panel on Retry — no reload", async () => {
    // Every read fails until the panel has given up; then the general settings
    // row is served and the pane paints.
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!up) throw new TypeError("Failed to fetch");
        const path = new URL(String(input)).pathname;
        if (path !== "/api/settings/general") return { ok: false, status: 404, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            hotkey_summon: "double-right-cmd",
            hotkey_bar: "cmd-shift-s",
            launch_at_login: false,
            notifications_enabled: true,
            brief_times: ["08:30"],
            appearance: "system",
          }),
        };
      }),
    );
    render(<Settings />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Summon hotkey")).toBeTruthy());
    expect(screen.queryByText("worker unreachable")).toBeNull();
  });

  it("a route the worker refuses names the status, and never says 'unreachable'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    render(<Settings />);
    await waitFor(() => expect(screen.getByText("couldn't load General settings")).toBeTruthy());
    expect(screen.getByText("the worker answered 500 for /api/settings/general")).toBeTruthy();
    expect(screen.queryByText("worker unreachable")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("W3 · the other screens", () => {
  it("Home — the shell's own read fails visibly and Retry re-asks", async () => {
    const fetchStub = stubUnreachable();
    render(<App />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    expect(screen.queryByText("loading…")).toBeNull();
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  it("Home — a worker that comes back paints on Retry", async () => {
    // /api/home rejects once, then the stub's real routes take over.
    let up = false;
    const live = stubWorker();
    const real = globalThis.fetch as unknown as (...a: unknown[]) => Promise<unknown>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        if (!up) throw new TypeError("Failed to fetch");
        return real(...args);
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Book villa")).toBeTruthy());
    expect(live.calls.some((c) => c.path === "/api/home")).toBe(true);
  });

  it("Spaces — error state with a Retry that re-asks", async () => {
    const fetchStub = stubUnreachable();
    render(<Spaces />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  it("Timeline — error state with a Retry that re-asks", async () => {
    const fetchStub = stubUnreachable();
    render(<Timeline spaces={[]} onOpenSpace={() => {}} />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    expect(screen.queryByText("nothing captured yet")).toBeNull();
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  it("People — error state with a Retry that re-asks", async () => {
    const fetchStub = stubUnreachable();
    render(<People />);
    await waitFor(() => expect(screen.getAllByText("worker unreachable").length).toBeGreaterThan(0));
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  it("Calendar — error state with a Retry that re-asks", async () => {
    const fetchStub = stubUnreachable();
    render(<Calendar />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    expect(screen.queryByText("nothing dated in this window")).toBeNull();
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  // The Library's four panes each own their read; a dead worker used to leave
  // three of them on a ConnectCard whose only note was "worker unreachable"
  // and no way to ask again.
  for (const view of ["whatsapp", "screen", "browser", "storage"] as LibraryView[]) {
    it(`Library › ${view} — error state with a Retry that re-asks`, async () => {
      const fetchStub = stubUnreachable();
      render(<Library initial={view} />);
      await waitFor(() => expect(screen.getAllByText("worker unreachable").length).toBeGreaterThan(0));
      expect(screen.queryByText("reading the disk…")).toBeNull();
      const before = fetchStub.mock.calls.length;
      fireEvent.click(screen.getAllByRole("button", { name: /^Retry$/ })[0]!);
      await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
    });
  }

  it("the menu-bar panel — says so and offers Retry rather than waiting on its poll", async () => {
    const fetchStub = stubUnreachable();
    render(<Panel />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  it("the why? drill-down resolves a failed read into an error + Retry", async () => {
    const fetchStub = stubUnreachable();
    render(<WhyPanel kind="space" id="sp_goa" />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    expect(screen.queryByText("loading decisions…")).toBeNull();
    const before = fetchStub.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchStub.mock.calls.length).toBeGreaterThan(before));
  });

  it("a save the worker refuses says so instead of springing the field back in silence", async () => {
    let allow = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/settings/data" && allow) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              home: "/tmp/st",
              storage: { db_bytes: 0, traces_bytes: 0, media_bytes: 0, logs_bytes: 0 },
              events_per_source: [],
              retention: { traces_days: 30 },
            }),
          };
        }
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    const field = await screen.findByDisplayValue("30");
    allow = false;
    fireEvent.blur(field, { target: { value: "7" } });
    await waitFor(() => expect(screen.getByText(/retention not saved/)).toBeTruthy());
    expect(screen.getByText(/worker unreachable/)).toBeTruthy();
  });

  it("a Settings toggle whose save never lands says so instead of springing back in silence", async () => {
    let allow = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/settings/general" && (init?.method ?? "GET") === "GET" && allow) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              hotkey_summon: "double-right-cmd",
              hotkey_bar: "cmd-shift-s",
              launch_at_login: false,
              notifications_enabled: true,
              brief_times: ["08:30"],
              appearance: "system",
            }),
          };
        }
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<Settings />);
    const toggle = await screen.findByLabelText("Launch at login");
    allow = false;
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/that change was not saved/)).toBeTruthy());
    expect(screen.getByText(/worker unreachable/)).toBeTruthy();
    // Dismissable, and the panel is still the panel — not an error screen.
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    await waitFor(() => expect(screen.queryByText(/that change was not saved/)).toBeNull());
    expect(screen.getByText("Summon hotkey")).toBeTruthy();
  });

  it("a screen that recovers stops claiming the worker is down", async () => {
    const worker = stubDownThenUp({
      "/api/timeline": { rows: [], next_before: null },
      "/api/timeline/days": { days: [], sources: [] },
    });
    render(<Timeline spaces={[]} onOpenSpace={() => {}} />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    worker.up();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("worker unreachable")).toBeNull());
    expect(screen.getByText("nothing captured yet")).toBeTruthy();
  });
});
