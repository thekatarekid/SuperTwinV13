// ===========================================================================
// Library › Browser — the choice the connect card offers, and what the panel
// shows the instant Connect returns (V6 P1 S6d L5; user issue 5).
//
// The user's report: the card listed four browser profiles under bullets that
// looked selectable and were not — Connect took every browser and all history,
// with no window control — and after Connect the panel said "connected —
// reading your history" for minutes with nothing else on screen.
//
// So this suite asserts, in the DOM:
//   * every discovered profile is a real checkbox, ticked by default, and an
//     unreadable one (Safari without Full Disk Access) is disabled with the
//     button that opens the settings pane;
//   * unticking a profile changes every number the card shows — the counts are
//     the selection's, not the machine's;
//   * Connect posts EXACTLY the pick, the two windows, the measured counts and
//     the card's own words;
//   * Understand can never reach past Index (CNS-03);
//   * the panel flips to the connected/importing view on the same click, with
//     per-profile progress, and updates as the ledger moves.
// Zero model calls; the worker is the fetch stub.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserLibrary, browserCardText, clampUnderstandWindow, importHeadline } from "./screens/library/BrowserLibrary";
import { resetLoadCache } from "./components/LoadState";
import { stubWorker, type WorkerStub } from "./test-utils";
import type { BrowserImportProgress, BrowserProfileCounts } from "./lib/api";

const CHROME = "/Users/me/Library/Application Support/Google/Chrome/Default/History";
const BRAVE = "/Users/me/Library/Application Support/BraveSoftware/Brave-Browser/Default/History";
const SAFARI = "/Users/me/Library/Safari/History.db";

const win = (visits: number, bookmarks = 0) => ({ visits, bookmarks });

function chrome(): BrowserProfileCounts {
  return {
    browser: "chrome",
    browser_name: "Chrome",
    profile: "Default",
    label: "Aditya",
    history_path: CHROME,
    bookmarks_path: "/Users/me/Library/Application Support/Google/Chrome/Default/Bookmarks",
    readable: true,
    error: null,
    windows: { "7d": win(90), "30d": win(1200), "90d": win(3400), "180d": win(3400), "1y": win(3400), "2y": win(3400), "5y": win(3400), all: win(3400, 12) },
    total_visits: 3400,
    total_bookmarks: 12,
    oldest_visit_ts: "2026-05-30T00:00:00.000Z",
    newest_visit_ts: "2026-08-28T11:00:00.000Z",
    plateau_window: "90d",
    retention_note: "Chrome keeps 90 days of history — anything older is already gone, so longer windows can't grow.",
  };
}

function brave(): BrowserProfileCounts {
  return {
    ...chrome(),
    browser: "brave",
    browser_name: "Brave",
    label: "Person 1",
    history_path: BRAVE,
    bookmarks_path: null,
    windows: { "7d": win(40), "30d": win(500), "90d": win(6544), "180d": win(6544), "1y": win(6544), "2y": win(6544), "5y": win(6544), all: win(6544) },
    total_visits: 6544,
    total_bookmarks: 0,
    retention_note: null,
  };
}

function safari(): BrowserProfileCounts {
  return {
    browser: "safari",
    browser_name: "Safari",
    profile: "Safari",
    label: null,
    history_path: SAFARI,
    bookmarks_path: null,
    readable: false,
    error: {
      code: "full-disk-access",
      message: "macOS protects Safari's history file. Give SuperTwin Full Disk Access…",
      settings_url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    },
    windows: {},
    total_visits: 0,
    total_bookmarks: 0,
    oldest_visit_ts: null,
    newest_visit_ts: null,
    plateau_window: null,
    retention_note: null,
  };
}

function progress(over: Partial<BrowserImportProgress> = {}): BrowserImportProgress {
  return {
    known: true,
    reading: true,
    first_pass_done: false,
    profiles: [
      {
        history_path: CHROME,
        browser: "chrome",
        browser_name: "Chrome",
        profile: "Default",
        label: "Aditya",
        state: "reading",
        visits_read: 0,
        events_written: 0,
        expected_visits: 3400,
        started_at: "2026-08-28T12:00:00.000Z",
        finished_at: null,
        error: null,
      },
    ],
    visits_read: 0,
    events_written: 0,
    expected_visits: 3400,
    started_at: "2026-08-28T12:00:00.000Z",
    finished_at: null,
    ...over,
  };
}

/** A worker where the browser is discovered but not yet connected. */
function stubDisconnected(profiles = [chrome(), brave(), safari()]): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/library/source-status", {
    source_id: "browser",
    connection: { state: "not_connected", capturing: false, granted_at: null },
    windows: { index_all: false, index_from: null, understand_from: null },
    window_label: "",
    coverage: { captured_from: null, captured_to: null, understood_from: null, understood_to: null, label: "" },
    progress: {
      status: "idle",
      status_label: "",
      detail: "",
      event_count: 0,
      understood_count: 0,
      understood_percent: 0,
      pending_live_count: 0,
      pending_backfill_count: 0,
      backfill_complete: true,
      lag_minutes: null,
    },
  });
  stub.routes.set("/api/sources/browser/status", {
    source: "browser",
    connected: false,
    running: false,
    consent: null,
    event_count: 0,
  });
  stub.routes.set("/api/sources/browser/discover", {
    now: "2026-08-28T12:00:00.000Z",
    windows: ["3d", "7d", "30d", "90d", "180d", "1y", "2y", "3y", "4y", "5y", "all"],
    profiles,
    totals: { "30d": win(1700), "90d": win(9944), "1y": win(9944), all: win(9944, 12) },
    needs_full_disk_access: profiles.some((p) => p.error?.code === "full-disk-access"),
    full_disk_access_settings_url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    disclosure: { scratch_dir: "/tmp/supertwinv13-history", text: "SuperTwin reads 3 history files by copying each one…" },
    connected: false,
    consent: null,
  });
  stub.routes.set("/api/sources/browser/connect", {
    ok: true,
    started: true,
    running: true,
    consent: {
      id: "cns_b",
      state: "connected",
      granted_at: "2026-08-28T12:00:00.000Z",
      index_all: true,
      index_from: null,
      understand_from: "2026-07-29T00:00:00.000Z",
      profiles: [CHROME],
      counts: { [CHROME]: 3400 },
      card_text: "Index everything…",
    },
    progress: progress({ profiles: [{ ...progress().profiles[0]!, state: "pending" }], reading: false }),
  });
  stub.routes.set("/api/library/browser", { event_count: 0, domains_today: [], chains: [], bookmarks: [] });
  stub.routes.set("/api/sources/browser/import", { source: "browser", connected: true, running: true, progress: progress() });
  return stub;
}

beforeEach(() => {
  resetLoadCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function card(): Promise<HTMLElement> {
  return screen.findByLabelText("connect Connect your browsing");
}

describe("the browser connect card — per-profile selection (S6d L5)", () => {
  it("every discovered profile is a real checkbox, ticked by default; an unreadable one is disabled and offers the settings pane", async () => {
    stubDisconnected();
    render(<BrowserLibrary />);
    const c = await card();
    const list = await within(c).findByLabelText("browser profiles found");

    const chromeBox = within(list).getByLabelText("include Chrome · Aditya") as HTMLInputElement;
    const braveBox = within(list).getByLabelText("include Brave · Person 1") as HTMLInputElement;
    const safariBox = within(list).getByLabelText("include Safari") as HTMLInputElement;
    expect(chromeBox.type).toBe("checkbox");
    // Default is everything that can actually be read — nothing is opted in
    // behind the user's back, and nothing readable is opted out for them.
    expect(chromeBox.checked).toBe(true);
    expect(braveBox.checked).toBe(true);
    expect(safariBox.checked).toBe(false);
    expect(safariBox.disabled).toBe(true);
    expect(within(list).getByLabelText("open Full Disk Access for Safari")).toBeTruthy();
    // The counts the S1.4 card already showed are still there, per profile.
    expect(within(list).getByLabelText("browser profile Chrome · Aditya").textContent).toContain("1,200 visits / 30 days");
    expect(within(list).getByLabelText("browser profile Chrome · Aditya").textContent).toContain("Chrome keeps 90 days");
  });

  it("unticking a profile changes every number on the card — the counts are the SELECTION's", async () => {
    stubDisconnected();
    render(<BrowserLibrary />);
    const c = await card();
    await waitFor(() =>
      // 3,400 + 6,544 — both readable profiles, ticked by default.
      expect(within(c).getByLabelText("totals per window").textContent).toContain("everything: 9,944 visits"),
    );

    fireEvent.click(within(c).getByLabelText("include Brave · Person 1"));
    await waitFor(() => expect(within(c).getByLabelText("totals per window").textContent).toContain("everything: 3,400 visits"));
    expect(within(c).getByLabelText("card text").textContent).toContain("from 1 browser profile");
    expect(within(c).getByLabelText("card text").textContent).toContain("Brave · Person 1 — not included");
  });

  it("Connect stays off until the list to pick from is on screen — a failed discovery never falls back to \"all browsers\"", async () => {
    const stub = stubDisconnected();
    stub.routes.delete("/api/sources/browser/discover"); // 404 → discovery fails
    render(<BrowserLibrary />);
    const c = await card();
    await waitFor(() => expect(c.textContent).toContain("couldn't look for browsers"));
    expect((within(c).getByText("Connect") as HTMLButtonElement).disabled).toBe(true);
    expect(stub.calls.some((x) => x.path === "/api/sources/browser/connect")).toBe(false);
  });

  it("Connect is refused with nothing ticked, and says so", async () => {
    stubDisconnected();
    render(<BrowserLibrary />);
    const c = await card();
    await within(c).findByLabelText("browser profiles found");
    fireEvent.click(within(c).getByLabelText("include Chrome · Aditya"));
    fireEvent.click(within(c).getByLabelText("include Brave · Person 1"));
    await waitFor(() => expect((within(c).getByText("Connect") as HTMLButtonElement).disabled).toBe(true));
    expect(c.textContent).toContain("Tick at least one browser profile");
  });
});

describe("the browser connect card — the two windows (Product P1 §3.3)", () => {
  it("offers Index and Understand with measured counts, and clamps Understand to Index (CNS-03)", async () => {
    stubDisconnected();
    render(<BrowserLibrary />);
    const c = await card();
    const index = within(c).getByLabelText("index window") as HTMLSelectElement;
    const understand = within(c).getByLabelText("understand window") as HTMLSelectElement;
    expect(index.value).toBe("all");
    expect(understand.value).toBe("30d");
    // Every option is priced from the current selection.
    expect(within(index).getByText(/last 30 days · 1,700 visits/)).toBeTruthy();

    // A 7-day Index cannot leave a 30-day Understand standing.
    fireEvent.change(index, { target: { value: "7d" } });
    await waitFor(() => expect((within(c).getByLabelText("understand window") as HTMLSelectElement).value).toBe("7d"));
    expect(clampUnderstandWindow("1y", "30d")).toBe("30d");
    expect(clampUnderstandWindow("7d", "30d")).toBe("7d");
    expect(clampUnderstandWindow("1y", "all")).toBe("1y");
  });

  it("Connect posts exactly the pick, the windows, the measured counts and the card's own words", async () => {
    const stub = stubDisconnected();
    render(<BrowserLibrary />);
    const c = await card();
    fireEvent.click(within(c).getByLabelText("include Brave · Person 1")); // Chrome only
    fireEvent.change(within(c).getByLabelText("index window"), { target: { value: "90d" } });
    await waitFor(() => expect((within(c).getByLabelText("index window") as HTMLSelectElement).value).toBe("90d"));
    fireEvent.change(within(c).getByLabelText("understand window"), { target: { value: "30d" } });

    fireEvent.click(within(c).getByText("Connect"));
    await waitFor(() => expect(stub.calls.some((x) => x.path === "/api/sources/browser/connect")).toBe(true));
    const body = stub.calls.find((x) => x.path === "/api/sources/browser/connect")!.body as Record<string, unknown>;
    expect(body.profiles).toEqual([CHROME]);
    expect(body.index_all).toBe(false);
    expect(typeof body.index_from).toBe("string");
    expect(typeof body.understand_from).toBe("string");
    // The floors are ordered: understand can never reach past index.
    expect(Date.parse(body.understand_from as string)).toBeGreaterThan(Date.parse(body.index_from as string));
    expect(body.counts).toEqual({ [CHROME]: 3400 }); // Chrome's 90-day count
    expect(String(body.card_text)).toContain("Index last 90 days");
    expect(String(body.card_text)).toContain("Understand last 30 days");
  });

  it("understand can be switched off entirely — nothing goes to the model", async () => {
    const stub = stubDisconnected();
    render(<BrowserLibrary />);
    const c = await card();
    fireEvent.change(within(c).getByLabelText("understand window"), { target: { value: "none" } });
    await waitFor(() => expect(c.textContent).toContain("nothing goes to the model"));
    fireEvent.click(within(c).getByText("Connect"));
    await waitFor(() => expect(stub.calls.some((x) => x.path === "/api/sources/browser/connect")).toBe(true));
    const body = stub.calls.find((x) => x.path === "/api/sources/browser/connect")!.body as Record<string, unknown>;
    expect(body.understand_from).toBeNull();
  });
});

describe("after Connect: the importing view, not a blank (S6d L5)", () => {
  it("flips to the connected panel on the same click and shows the import profile by profile", async () => {
    stubDisconnected();
    render(<BrowserLibrary />);
    const c = await card();
    fireEvent.click(within(c).getByText("Connect"));

    // No second round-trip to /status — which is the unbounded COUNT that made
    // this take minutes — before the panel changes.
    const panel = await screen.findByLabelText("Browser");
    expect(screen.queryByLabelText("connect Connect your browsing")).toBeNull();
    const imp = await within(panel).findByLabelText("browser import progress");
    expect(imp.textContent).toContain("Chrome · Aditya");
    await waitFor(() => expect(imp.textContent).toContain("Reading your history"));
    expect(within(imp).getByLabelText("history import")).toBeTruthy();
    expect(panel.textContent).toContain("visits appear here as they land");
  });

  it("the live line moves as the ledger does, and settles into a finished import", async () => {
    const stub = stubDisconnected();
    stub.routes.set("/api/sources/browser/import", {
      source: "browser",
      connected: true,
      running: true,
      progress: progress({ visits_read: 1700, events_written: 1700, profiles: [{ ...progress().profiles[0]!, visits_read: 1700, events_written: 1700 }] }),
    });
    render(<BrowserLibrary pollMs={5} />);
    const c = await card();
    fireEvent.click(within(c).getByText("Connect"));
    const imp = await screen.findByLabelText("browser import progress");
    await waitFor(() => expect(imp.textContent).toContain("1,700 of about 3,400 visits"));
    expect(imp.textContent).toContain("50%");

    stub.routes.set("/api/sources/browser/import", {
      source: "browser",
      connected: true,
      running: true,
      progress: progress({
        reading: false,
        first_pass_done: true,
        visits_read: 3400,
        events_written: 3400,
        finished_at: "2026-08-28T12:04:00.000Z",
        profiles: [{ ...progress().profiles[0]!, state: "done", visits_read: 3400, events_written: 3400, finished_at: "2026-08-28T12:04:00.000Z" }],
      }),
    });
    await waitFor(() => expect(imp.textContent).toContain("History imported"), { timeout: 3000 });
    expect(imp.textContent).toContain("done");
  });

  it("a still-unknown status paints a skeleton, never the connected-and-empty default", async () => {
    const stub = stubDisconnected();
    // A status read that never lands: exactly the 7-second COUNT the user hit.
    stub.routes.delete("/api/sources/browser/status");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Promise(() => {})),
    );
    render(<BrowserLibrary />);
    const sk = await screen.findByRole("status");
    expect(sk.getAttribute("aria-busy")).toBe("true");
    expect(sk.getAttribute("aria-label")).toBe("loading Browser");
    expect(screen.queryByText(/connected — reading your history/)).toBeNull();
    expect(screen.queryByLabelText("connect Connect your browsing")).toBeNull();
  });
});

describe("the card text stored with the consent", () => {
  it("names the windows, the measured counts, every profile taken and every profile skipped", () => {
    const text = browserCardText([chrome()], [brave(), safari()], "90d", "30d");
    expect(text).toContain("Index last 90 days: 3,400 visits");
    expect(text).toContain("from 1 browser profile (measured)");
    expect(text).toContain("Understand last 30 days: 1,200 visits go to the model");
    expect(text).toContain("Chrome · Aditya — 3,400 visits in this window");
    expect(text).toContain("Brave · Person 1 — not included");
    expect(text).toContain("Safari — not included (needs Full Disk Access)");
    expect(browserCardText([chrome()], [], "all", null)).toContain("Understand: nothing goes to the model.");
  });

  it("the import headline never invents a number it does not have", () => {
    expect(importHeadline(progress({ known: false }))).toBe("starting the import…");
    expect(importHeadline(progress({ expected_visits: null, visits_read: 12 }))).toContain("12 visits so far");
    expect(importHeadline(progress({ visits_read: 40 }))).toContain("40 of about 3,400 visits");
    expect(importHeadline(progress({ reading: false, first_pass_done: true, visits_read: 3400 }))).toContain("History imported");
  });
});
