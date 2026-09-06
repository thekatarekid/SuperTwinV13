// ===========================================================================
// Per-source status in the Library (V6 P1 S6d L6) — Product_V6 §7.2:
// "Library ──── per source: capture status · windows · pause · delete".
//
// THE DEFECT THESE PIN. Status lived in one chip in the app's top-right
// corner and it was a ROLL-UP. On the reporting user's machine it read
//
//     Knows you: 2010 → 32 min ago · importing history — 11,466 events left
//
// while the two connected sources were, at that same moment,
//
//     browser   Knows you: 2010 → 2h ago · 6,649 left  (71% understood)
//     whatsapp  Knows you: 2023 → 4h ago · 4,359 left  (89% understood)
//
// The left edge came from browser, the right edge from browser, the count from
// adding both — so a user standing in Library › WhatsApp read a number that was
// mostly browser, and no panel stated its own source's window, coverage or
// progress at all.
//
// So: each sub-tab states ITS OWN source's status inside its own panel, and no
// combined counter appears anywhere in the Library chrome.
// ===========================================================================

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { FreshnessChip } from "./components/FreshnessChip";
import { resetLoadCache } from "./components/LoadState";
import { Library } from "./screens/Library";
import { homeFixture } from "./test-utils";

afterEach(() => {
  cleanup();
  resetLoadCache();
  vi.unstubAllGlobals();
});

// ---- the reporting user's own shape, in numbers ---------------------------

const WHATSAPP_STATUS = {
  source_id: "whatsapp",
  connection: { state: "connected", capturing: true, granted_at: "2026-09-06T14:49:41.661Z" },
  windows: { index_all: true, index_from: null, understand_from: "2026-08-07T14:49:41.661Z" },
  window_label: "index everything · understand from 7 Aug 2026",
  coverage: {
    captured_from: "2022-08-27T00:00:00.000Z",
    captured_to: "2026-09-06T08:00:00.000Z",
    understood_from: "2023-04-11T00:00:00.000Z",
    understood_to: "2026-09-06T08:00:00.000Z",
    label: "Knows you: 2023 → 4h ago",
  },
  progress: {
    status: "importing_history",
    status_label: "importing history — 4,359 events left",
    detail: "capturing live ✓ · importing history: at 2023 (89%, 4,359 left)",
    event_count: 38472,
    understood_count: 34113,
    understood_percent: 89,
    pending_live_count: 0,
    pending_backfill_count: 4359,
    backfill_complete: false,
    lag_minutes: null,
  },
};

const BROWSER_STATUS = {
  source_id: "browser",
  connection: { state: "connected", capturing: true, granted_at: "2026-09-06T14:54:58.980Z" },
  windows: { index_all: true, index_from: null, understand_from: "2026-08-07T14:54:58.974Z" },
  window_label: "index everything · understand from 7 Aug 2026",
  coverage: {
    captured_from: "2010-05-02T00:00:00.000Z",
    captured_to: "2026-09-06T10:00:00.000Z",
    understood_from: "2010-05-02T00:00:00.000Z",
    understood_to: "2026-09-06T10:00:00.000Z",
    label: "Knows you: 2010 → 2h ago",
  },
  progress: {
    status: "importing_history",
    status_label: "importing history — 6,649 events left",
    detail: "capturing live ✓ · importing history: at 2010 (71%, 6,649 left)",
    event_count: 23207,
    understood_count: 16558,
    understood_percent: 71,
    pending_live_count: 0,
    pending_backfill_count: 6649,
    backfill_complete: false,
    lag_minutes: null,
  },
};

const SCREEN_STATUS = {
  source_id: "screen",
  connection: { state: "not_connected", capturing: false, granted_at: null },
  windows: null,
  window_label: "no window — not connected",
  coverage: {
    captured_from: null,
    captured_to: null,
    understood_from: null,
    understood_to: null,
    label: null,
  },
  progress: {
    status: "no_data",
    status_label: "nothing captured yet",
    detail: "nothing captured yet · understanding: caught up",
    event_count: 0,
    understood_count: 0,
    understood_percent: 0,
    pending_live_count: 0,
    pending_backfill_count: 0,
    backfill_complete: false,
    lag_minutes: null,
  },
};

/** The cross-source chip, exactly as the worker sums it from the two above. */
const COMBINED_FRESHNESS = {
  sources: [
    {
      source_id: "browser",
      ...BROWSER_STATUS.coverage,
      event_count: 23207,
      understood_count: 16558,
      pending_count: 6649,
      pending_live_count: 0,
      pending_backfill_count: 6649,
      lag_minutes: null,
      backfill_complete: false,
      understood_percent: 71,
      label: "Knows you: 2010 → 2h ago",
      status: "importing_history",
      status_label: "importing history — 6,649 events left",
      detail: BROWSER_STATUS.progress.detail,
    },
    {
      source_id: "whatsapp",
      ...WHATSAPP_STATUS.coverage,
      event_count: 38472,
      understood_count: 34113,
      pending_count: 4359,
      pending_live_count: 0,
      pending_backfill_count: 4359,
      lag_minutes: null,
      backfill_complete: false,
      understood_percent: 89,
      label: "Knows you: 2023 → 4h ago",
      status: "importing_history",
      status_label: "importing history — 4,359 events left",
      detail: WHATSAPP_STATUS.progress.detail,
    },
  ],
  // The union range and the SUM — neither is any one source's truth.
  label: "Knows you: 2010 → 2h ago",
  lag_minutes: null,
  status: "importing_history",
  status_label: "importing history — 11,008 events left",
  pending_live_count: 0,
  pending_backfill_count: 11008,
};

const STATUS_BY_SOURCE: Record<string, unknown> = {
  whatsapp: WHATSAPP_STATUS,
  browser: BROWSER_STATUS,
  screen: SCREEN_STATUS,
};

/**
 * A worker stub that answers per SOURCE, not just per path — the whole point
 * of the feature is that `?source=whatsapp` and `?source=browser` are
 * different answers.
 */
function stubSources(over: Record<string, unknown> = {}): void {
  const routes: Record<string, unknown> = {
    "/api/home": homeFixture,
    "/api/artifacts": { artifacts: [] },
    "/api/freshness": COMBINED_FRESHNESS,
    "/api/sources/whatsapp/status": {
      state: "syncing",
      paired: true,
      paused: false,
      pushName: "Aditya",
      importDone: true,
      importRange: "all",
    },
    "/api/library/chats": { source_id: "whatsapp", event_count: 38472, streams: [] },
    "/api/sources/browser/status": {
      source: "browser",
      connected: true,
      running: true,
      consent: BROWSER_STATUS.windows,
      event_count: 23207,
    },
    "/api/sources/browser/discover": {
      now: "2026-09-06T12:00:00.000Z",
      windows: [],
      profiles: [],
      totals: {},
      needs_full_disk_access: false,
      full_disk_access_settings_url: "",
      disclosure: { scratch_dir: "/tmp", text: "copied then read" },
      connected: true,
      consent: BROWSER_STATUS.windows,
    },
    "/api/library/browser": { domains_today: [], chains: [], bookmarks: [] },
    "/api/library/screen": { day: "2026-09-06", hours: [], sessions: [], apps: [], event_count: 0 },
    "/api/screen/status": { state: "need_permission", permission: false, running: false, settingsUrl: "x" },
    ...over,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/library/source-status") {
        const source = url.searchParams.get("source") ?? "";
        const body = STATUS_BY_SOURCE[source];
        if (!body) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
        return { ok: true, status: 200, json: async () => body };
      }
      if (!(url.pathname in routes)) {
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      }
      return { ok: true, status: 200, json: async () => routes[url.pathname] };
    }),
  );
}

async function openSubtab(label: string): Promise<void> {
  fireEvent.click(within(screen.getByLabelText("library sources")).getByText(label));
}

/**
 * The strip, once it has actually ANSWERED. The section exists from the first
 * frame (that is the point — it is a skeleton, not a hole), so waiting on the
 * element alone races the read.
 */
async function settledStrip(source: string, settledText: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(screen.getByLabelText(`${source} status`).textContent).toContain(settledText),
  );
  return screen.getByLabelText(`${source} status`);
}

// ---------------------------------------------------------------------------

describe("Library — each sub-tab states its OWN source's status", () => {
  it("WhatsApp's panel shows WhatsApp's window, coverage and backlog", async () => {
    stubSources();
    render(<Library />);

    const strip = await settledStrip("whatsapp", "index everything");
    // connection state
    expect(strip.textContent).toContain("syncing");
    // the window in force
    expect(strip.textContent).toContain("index everything · understand from 7 Aug 2026");
    // this source's own coverage range
    expect(strip.textContent).toContain("Knows you: 2023 → 4h ago");
    // this source's own import progress
    expect(strip.textContent).toContain("importing history — 4,359 events left");
    expect(strip.textContent).toContain("89%");

    // and NOT the other source's, nor the sum of the two.
    expect(strip.textContent).not.toContain("2010");
    expect(strip.textContent).not.toContain("6,649");
    expect(strip.textContent).not.toContain("11,008");
  });

  it("Browser's panel shows Browser's own numbers, not WhatsApp's", async () => {
    stubSources();
    render(<Library />);
    await openSubtab("Browser");

    const strip = await settledStrip("browser", "Knows you: 2010 → 2h ago");
    expect(strip.textContent).toContain("connected · watching");
    expect(strip.textContent).toContain("Knows you: 2010 → 2h ago");
    expect(strip.textContent).toContain("importing history — 6,649 events left");
    expect(strip.textContent).toContain("71%");

    expect(strip.textContent).not.toContain("4,359");
    expect(strip.textContent).not.toContain("11,008");
    // WhatsApp's strip is not on screen at all — one source at a time.
    expect(screen.queryByLabelText("whatsapp status")).toBeNull();
  });

  it("Screen's panel says live-only and never borrows a history window", async () => {
    stubSources({
      "/api/library/screen": {
        day: "2026-09-06",
        hours: new Array(24).fill(0),
        sessions: [
          {
            stream_key: "screen:Xcode",
            app: "Xcode",
            bundle_id: "com.apple.dt.Xcode",
            doc: "App.tsx",
            started_at: "2026-09-06T09:00:00.000Z",
            ended_at: "2026-09-06T09:40:00.000Z",
            minutes: 40,
            event_count: 12,
          },
        ],
        event_count: 12,
      },
      "/api/screen/status": { state: "running", permission: true, running: true, settingsUrl: "x" },
    });
    render(<Library />);
    await openSubtab("Screen");

    const strip = await settledStrip("screen", "nothing captured yet");
    expect(strip.textContent).toContain("live only · no history window");
    expect(strip.textContent).not.toContain("understand from");
    expect(strip.textContent).not.toContain("11,008");
  });

  it("asks the worker for THIS source only — one read per sub-tab, keyed by source", async () => {
    stubSources();
    render(<Library />);
    await settledStrip("whatsapp", "Knows you: 2023 → 4h ago");
    await openSubtab("Browser");
    await settledStrip("browser", "Knows you: 2010 → 2h ago");

    const paths = (fetch as unknown as { mock: { calls: [RequestInfo | URL][] } }).mock.calls
      .map((c) => new URL(String(c[0])))
      .filter((u) => u.pathname === "/api/library/source-status")
      .map((u) => u.searchParams.get("source"));
    expect(paths).toContain("whatsapp");
    expect(paths).toContain("browser");
    // The cross-source roll-up is never what a panel reads.
    const freshnessCalls = (fetch as unknown as { mock: { calls: [RequestInfo | URL][] } }).mock.calls
      .map((c) => new URL(String(c[0])).pathname)
      .filter((p) => p === "/api/freshness");
    expect(freshnessCalls).toHaveLength(0);
  });

  it("paints a skeleton, never an unearned verdict, while the read is in flight", async () => {
    let release!: (v: unknown) => void;
    const held = new Promise<unknown>((r) => {
      release = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/library/source-status") {
          await held;
          return { ok: true, status: 200, json: async () => WHATSAPP_STATUS };
        }
        if (url.pathname === "/api/sources/whatsapp/status") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ state: "online", paired: true, paused: false, importDone: true }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ streams: [] }) };
      }),
    );
    render(<Library />);
    const strip = await waitFor(() => screen.getByLabelText("whatsapp status"));
    // No range, no percentage, no verdict — it does not know any of them yet.
    expect(strip.textContent).toContain("checking");
    expect(strip.textContent).not.toContain("up to date");
    expect(strip.textContent).not.toContain("Knows you");
    expect(strip.querySelector('[role="progressbar"]')).toBeNull();

    // Let it land, and the same strip states WhatsApp's own numbers.
    release(undefined);
    await waitFor(() =>
      expect(screen.getByLabelText("whatsapp status").textContent).toContain(
        "importing history — 4,359 events left",
      ),
    );
  });
});

describe("Library chrome carries no combined counter", () => {
  it("THE DEFECT: the cross-source chip is gone from the Library", async () => {
    stubSources();
    render(<App />);

    // It is there on Home — the roll-up is honest as a global glance.
    await waitFor(() => expect(screen.getByLabelText("freshness")).toBeTruthy());

    fireEvent.click(within(screen.getByLabelText("primary")).getByText("▤ Library"));
    await waitFor(() => expect(screen.getByLabelText("library sources")).toBeTruthy());

    expect(screen.queryByLabelText("freshness")).toBeNull();
    // and the summed number appears nowhere on the Library screen.
    expect(document.body.textContent).not.toContain("11,008");
    expect(document.body.textContent).not.toContain("Knows you: 2010 → 2h ago · importing");
  });

  it("the per-source strip replaces it — the same screen states WhatsApp's own numbers", async () => {
    stubSources();
    render(<App />);
    fireEvent.click(within(screen.getByLabelText("primary")).getByText("▤ Library"));

    const strip = await settledStrip("whatsapp", "importing history — 4,359 events left");
    expect(strip.textContent).toContain("89%");
    expect(screen.queryByLabelText("freshness")).toBeNull();
  });
});

describe("what stays global says it is a roll-up", () => {
  it("names how many sources it is adding up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => COMBINED_FRESHNESS })),
    );
    render(<FreshnessChip />);
    const chip = await waitFor(() => screen.getByLabelText("freshness"));
    expect(chip.textContent).toContain("importing history — 11,008 events left");
    // Without this the number reads as one source's backlog. It is two.
    expect(chip.textContent).toContain("across 2 sources");
  });

  it("stays silent about the count when only one source is importing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ...COMBINED_FRESHNESS,
          sources: [COMBINED_FRESHNESS.sources[0]],
          status_label: "importing history — 6,649 events left",
          pending_backfill_count: 6649,
        }),
      })),
    );
    render(<FreshnessChip />);
    const chip = await waitFor(() => screen.getByLabelText("freshness"));
    expect(chip.textContent).toContain("importing history — 6,649 events left");
    expect(chip.textContent).not.toContain("across");
  });
});
