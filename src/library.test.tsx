// ===========================================================================
// Library subtabs + People in the nav (spec §14.3.2, §14.1.3).
//
// The Library is one source at a time, chosen from the subtab pill under the
// main nav: WhatsApp · Screen · Browser. Each subtab has two states that both
// have to be real — the source's own view of its data, and, when the source is
// not connected, the actual connect flow for it (pairing / Accessibility /
// browser profile), never a bare "nothing captured yet" line.
//
// People is its own nav destination now, not the tail of Library's scroll.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { Library } from "./screens/Library";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

const GOA = "whatsapp:st:goa@g.us";
const PTA = "whatsapp:st:pta@g.us";

/** A worker with all three sources connected and carrying data. */
function stubLibrary(): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/freshness", {
    sources: [
      {
        source_id: "whatsapp",
        captured_from: "2024-01-05T00:00:00.000Z",
        captured_to: "2026-08-28T11:58:00.000Z",
        understood_from: "2024-01-05T00:00:00.000Z",
        understood_to: "2026-08-28T11:58:00.000Z",
        event_count: 10,
        understood_count: 10,
        pending_count: 0,
        lag_minutes: null,
        backfill_complete: true,
        understood_percent: 100,
        label: "Knows you: 2024 → 2 min ago",
        detail: "capturing live ✓ · understanding: caught up",
      },
    ],
    label: "Knows you: 2024 → 2 min ago",
    lag_minutes: null,
  });

  // ---- WhatsApp: linked, imported, two chats -------------------------------
  stub.routes.set("/api/sources/whatsapp/status", {
    state: "online",
    paired: true,
    paused: false,
    pushName: "Aditya",
    importDone: true,
    importRange: "1y",
  });
  stub.routes.set("/api/library/chats", {
    source_id: "whatsapp",
    event_count: 460,
    streams: [
      {
        id: GOA,
        label: "Goa gang",
        external_key: "goa@g.us",
        stream_kind: "group",
        tier: "T1",
        category: "cat1",
        capture_paused: 0,
        knows_from: "2024-01-05T00:00:00.000Z",
        last_ts: "2026-08-28T11:58:00.000Z",
        today_count: 12,
        event_count: 420,
        last_text: "pool villa or bust",
        last_kind: "whatsapp.message",
        last_from_me: 0,
      },
      {
        id: PTA,
        label: "PTA updates",
        external_key: "pta@g.us",
        stream_kind: "group",
        tier: null,
        category: "cat2",
        capture_paused: 0,
        knows_from: null,
        last_ts: "2026-08-20T10:00:00.000Z",
        today_count: 0,
        event_count: 40,
        last_text: null,
        last_kind: "image",
        last_from_me: 0,
      },
    ],
  });
  stub.routes.set(`/api/inbox/chats/${encodeURIComponent(GOA)}/messages`, [
    {
      id: "e1",
      ts: "2026-08-28T11:57:00.000Z",
      kind: "whatsapp.message",
      text: "lets lock goa 18-21 dec",
      fromMe: false,
      actorName: "Rohan",
    },
    {
      id: "e2",
      ts: "2026-08-28T11:58:00.000Z",
      kind: "whatsapp.message",
      text: "pool villa or bust",
      fromMe: true,
      actorName: null,
    },
  ]);
  stub.routes.set(`/api/library/streams/${encodeURIComponent(GOA)}/pause`, {
    stream_id: GOA,
    paused: true,
    decision_id: "decP",
  });
  stub.routes.set("/api/sources/whatsapp/pair", { ok: true });
  stub.routes.set("/api/sources/whatsapp/import", { ok: true });
  stub.routes.set("/api/sources/whatsapp/extend", { ok: true });
  stub.routes.set("/api/sources/whatsapp/pause", { ok: true, paused: true });

  // ---- Browser -------------------------------------------------------------
  // V6 S1.4: the card is decided by the consent row (/api/sources/browser/*),
  // never by event_count.
  stub.routes.set("/api/sources/browser/status", {
    source: "browser",
    connected: true,
    running: true,
    consent: {
      id: "cns_b1",
      state: "connected",
      granted_at: "2026-08-20T10:00:00.000Z",
      index_all: true,
      index_from: null,
      understand_from: "2026-07-29T10:00:00.000Z",
      profiles: [],
    },
    event_count: 31,
  });
  stub.routes.set("/api/sources/browser/connect", { ok: true, consent: null, started: true, running: true });
  stub.routes.set("/api/library/browser", {
    event_count: 31,
    domains_today: [
      { domain: "airbnb.com", visits: 7 },
      { domain: "makemytrip.com", visits: 3 },
    ],
    chains: [
      {
        stream_key: "chain-1",
        started_at: "2026-08-28T13:58:00.000Z",
        ended_at: "2026-08-28T14:02:00.000Z",
        visits: [
          {
            ts: "2026-08-28T13:58:00.000Z",
            url: "https://airbnb.com/s/anjuna",
            title: "anjuna villas",
            dwell_ms: 120000,
          },
          {
            ts: "2026-08-28T14:00:00.000Z",
            url: "https://airbnb.com/rooms/1",
            title: "Villa Sol",
            dwell_ms: 120000,
          },
        ],
        space_label: "Goa trip with Rohan",
      },
    ],
    bookmarks: [
      {
        ts: "2026-08-28T14:03:00.000Z",
        url: "https://airbnb.com/rooms/1",
        title: "Villa Sol",
        folder: "Goa",
      },
    ],
  });

  // ---- Screen --------------------------------------------------------------
  stub.routes.set("/api/screen/status", {
    running: true,
    state: "capturing",
    permission: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security",
  });
  stub.routes.set("/api/library/screen", {
    day: "2026-08-28",
    event_count: 6,
    hours: new Array(24).fill(0).map((_, h) => (h === 14 ? 4 : 0)),
    sessions: [
      {
        stream_key: "com.figma.Desktop¦mocks",
        app: "Figma",
        bundle_id: "com.figma.Desktop",
        doc: "v13 mocks",
        started_at: "2026-08-28T14:02:00.000Z",
        ended_at: "2026-08-28T14:06:00.000Z",
        minutes: 4,
        event_count: 4,
      },
    ],
    apps: [
      {
        bundle_id: "com.figma.Desktop",
        app: "Figma",
        minutes: 44,
        event_count: 6,
        session_count: 2,
        docs: [
          {
            doc: "v13 mocks",
            minutes: 4,
            event_count: 4,
            sessions: [
              {
                stream_key: "com.figma.Desktop¦mocks",
                app: "Figma",
                bundle_id: "com.figma.Desktop",
                doc: "v13 mocks",
                started_at: "2026-08-28T14:02:00.000Z",
                ended_at: "2026-08-28T14:06:00.000Z",
                minutes: 4,
                event_count: 4,
              },
            ],
          },
        ],
      },
    ],
    paused: false,
  });
  stub.routes.set("/api/library/screen/delete", {
    report: {
      events_deleted: 4,
      episodes_deleted: 1,
      claim_versions_deleted: 0,
      claims_deleted: 0,
      tasks_deleted: 0,
      decision_id: "decD",
    },
  });
  return stub;
}

async function openSubtab(label: string): Promise<void> {
  fireEvent.click(within(screen.getByLabelText("library sources")).getByText(label));
}

describe("freshness chip", () => {
  it("renders the cross-source Knows-you headline in the header", async () => {
    stubLibrary();
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("freshness").textContent).toContain(
        "Knows you: 2024 → 2 min ago",
      ),
    );
  });
});

describe("Library subtabs (spec §14.3.2)", () => {
  it("shows three source subtabs under the nav, one source visible at a time", async () => {
    stubLibrary();
    render(<Library />);
    const subnav = screen.getByLabelText("library sources");
    expect(subnav.textContent).toBe("WhatsAppScreenBrowser");

    // WhatsApp is the landing subtab; the other two are NOT rendered.
    await waitFor(() => expect(screen.getByLabelText("WhatsApp")).toBeTruthy());
    expect(screen.queryByLabelText("Screen")).toBeNull();
    expect(screen.queryByLabelText("Browser")).toBeNull();

    await openSubtab("Screen");
    await waitFor(() => expect(screen.getByLabelText("Screen")).toBeTruthy());
    expect(screen.queryByLabelText("WhatsApp")).toBeNull();

    await openSubtab("Browser");
    await waitFor(() => expect(screen.getByLabelText("Browser")).toBeTruthy());
    expect(screen.queryByLabelText("Screen")).toBeNull();
  });

  it("marks the active subtab as the current page", async () => {
    stubLibrary();
    render(<Library />);
    const subnav = screen.getByLabelText("library sources");
    expect(within(subnav).getByText("WhatsApp").getAttribute("aria-current")).toBe("page");
    await openSubtab("Browser");
    expect(within(subnav).getByText("Browser").getAttribute("aria-current")).toBe("page");
    expect(within(subnav).getByText("WhatsApp").getAttribute("aria-current")).toBeNull();
  });
});

describe("Library › WhatsApp", () => {
  it("renders the chat inbox: previews, tier badges, and the message pane", async () => {
    stubLibrary();
    render(<Library />);
    const list = await screen.findByLabelText("conversations");
    await waitFor(() => expect(within(list).getByText("Goa gang")).toBeTruthy());
    expect(within(list).getByText("T1")).toBeTruthy();
    expect(within(list).getByText("Cat-1")).toBeTruthy();
    expect(within(list).getByText("pool villa or bust")).toBeTruthy();
    expect(within(list).getByText("knows you: 2024 →")).toBeTruthy();
    // A media-only last message previews as its kind, not as an empty line.
    expect(within(list).getByText("📷 Photo")).toBeTruthy();
    // Cat-2 never-replied keeps the promotion hint.
    expect(within(list).getByText("never replied (reply promotes)")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("open chat Goa gang"));
    const thread = screen.getByLabelText("messages");
    await waitFor(() => expect(within(thread).getByText("lets lock goa 18-21 dec")).toBeTruthy());
    expect(within(thread).getByText("pool villa or bust")).toBeTruthy();
    expect(within(thread).getByText(/Rohan/)).toBeTruthy();
  });

  it("⏸ posts the per-stream capture pause", async () => {
    const stub = stubLibrary();
    render(<Library />);
    await screen.findByLabelText("pause Goa gang");
    fireEvent.click(screen.getByLabelText("pause Goa gang"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path.endsWith("/pause") && c.method === "POST");
      expect(call).toBeTruthy();
      expect(call!.body).toEqual({ paused: true });
    });
  });

  it("the range control extends the imported history", async () => {
    const stub = stubLibrary();
    render(<Library />);
    const select = await screen.findByLabelText("extend history");
    fireEvent.change(select, { target: { value: "5y" } });
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/sources/whatsapp/extend");
      expect(call!.body).toEqual({ range: "5y" });
    });
  });

  it("NOT PAIRED: shows the real pairing flow, not an empty list", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/sources/whatsapp/status", {
      state: "need_pairing",
      paired: false,
      paused: false,
    });
    render(<Library />);
    const card = await screen.findByLabelText("connect Connect WhatsApp");
    expect(card.textContent).toContain("Linked devices");
    expect(screen.queryByLabelText("conversations")).toBeNull();

    fireEvent.click(within(card).getByText("Show a new code"));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.path === "/api/sources/whatsapp/pair")).toBe(true),
    );
  });

  it("PAIRED BUT NOT CONFIRMED: measured counts per window, then one confirm (S1.5)", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/sources/whatsapp/status", {
      state: "connected",
      paired: true,
      paused: false,
      importDone: false,
    });
    const entry = (chats: number, messages: number) => ({ chats, messages });
    const counts = {
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
      syncTypes: ["FULL", "INITIAL_BOOTSTRAP"],
      rangeInstalled: false,
      pendingLive: 2,
    };
    stub.routes.set("/api/sources/whatsapp/counts", {
      counts,
      windows: [
        { range: "7d", chats: 12, messages: 1597, days: 7, accuracy: "measured" },
        { range: "30d", chats: 40, messages: 6091, days: 30, accuracy: "measured" },
        { range: "2y", chats: 214, messages: 38412, days: 730, accuracy: "measured" },
        { range: "all", chats: 214, messages: 38412, days: 735, accuracy: "measured" },
      ],
      caveats: ["2 messages arrived since pairing and are held until you confirm — nothing is read before then."],
    });
    stub.routes.set("/api/sources/whatsapp/confirm", { ok: true, decision_id: "dec_1" });
    render(<Library />);
    const card = await screen.findByLabelText("connect Choose how far back");
    // The counts are MEASURED and shown on the windows, with the honest caveat.
    await waitFor(() => expect(card.textContent).toContain("38,412 messages in 214 chats"));
    expect(within(card).getByLabelText("counts caveats").textContent).toContain("held until you confirm");
    fireEvent.change(within(card).getByLabelText("import range"), { target: { value: "2y" } });
    fireEvent.change(within(card).getByLabelText("understand range"), { target: { value: "7d" } });
    fireEvent.click(within(card).getByText("Confirm and import"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/sources/whatsapp/confirm");
      expect(call).toBeTruthy();
      const body = call!.body as { index: string; understand: string; card_text: string };
      expect(body.index).toBe("2y");
      expect(body.understand).toBe("7d");
      // The card text travels verbatim: the numbers the user saw are in it.
      expect(body.card_text).toContain("38,412 messages in 214 chats");
      expect(body.card_text).toContain("1,597 messages");
      expect(body.card_text).toContain("held until you confirm");
    });
    // The old direct import is gone: nothing is imported without the confirm.
    expect(stub.calls.some((c) => c.path === "/api/sources/whatsapp/import")).toBe(false);
  });
});

describe("Library › Screen", () => {
  it("groups sessions by app, expands to the document and its sessions", async () => {
    stubLibrary();
    render(<Library />);
    await openSubtab("Screen");
    const sect = await screen.findByLabelText("Screen");
    expect(within(sect).getByLabelText("day strip")).toBeTruthy();
    const app = within(sect).getByLabelText("app Figma");
    expect(app.textContent).toContain("com.figma.Desktop");
    expect(app.textContent).toContain("2 sessions");
    // Sessions are behind the app, not a flat list of every four-minute row.
    expect(within(sect).queryByText("v13 mocks")).toBeNull();
    fireEvent.click(app);
    expect(within(sect).getByText(/v13 mocks/)).toBeTruthy();
    expect(within(sect).getByLabelText("delete session Figma 14:02")).toBeTruthy();
    expect(sect.textContent).toContain("honest delete");
  });

  it("delete walks the confirm dialog and posts the cascading delete", async () => {
    const stub = stubLibrary();
    render(<Library />);
    await openSubtab("Screen");
    fireEvent.click(await screen.findByLabelText("app Figma"));
    fireEvent.click(screen.getByLabelText("delete session Figma 14:02"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("cannot be undone");
    fireEvent.click(within(dialog).getByText("Delete for good"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/library/screen/delete");
      expect(call).toBeTruthy();
      expect(call!.body).toEqual({
        start_ts: "2026-08-28T14:02:00.000Z",
        end_ts: "2026-08-28T14:06:00.000Z",
        stream_key: "com.figma.Desktop¦mocks",
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("deleted 4 events · 1 episodes"),
    );
  });

  it("NO PERMISSION AND NOTHING CAPTURED: shows the Accessibility connect flow", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/screen/status", {
      running: true,
      state: "need_permission",
      permission: false,
      settingsUrl: "x-apple.systempreferences:com.apple.preference.security",
    });
    stub.routes.set("/api/library/screen", {
      day: "2026-08-28",
      event_count: 0,
      hours: new Array(24).fill(0),
      sessions: [],
      apps: [],
      paused: false,
    });
    render(<Library />);
    await openSubtab("Screen");
    const card = await screen.findByLabelText("connect Grant screen understanding");
    expect(card.textContent).toContain("Accessibility");
    expect(within(card).getByText("Open System Settings")).toBeTruthy();
    expect(screen.queryByLabelText("day strip")).toBeNull();
  });

  it("NO PERMISSION BUT DATA ON DISK: keeps the history, asks for the permission above it", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/screen/status", {
      running: true,
      state: "need_permission",
      permission: false,
      settingsUrl: "x-apple.systempreferences:com.apple.preference.security",
    });
    render(<Library />);
    await openSubtab("Screen");
    const sect = await screen.findByLabelText("Screen");
    // The already-captured history is the user's own — never hidden behind the
    // permission card.
    expect(within(sect).getByLabelText("app Figma")).toBeTruthy();
    expect(within(sect).getByRole("status").textContent).toContain("Capture is blocked");
    expect(screen.queryByLabelText("connect Grant screen understanding")).toBeNull();
  });
});

describe("Library › Browser", () => {
  it("renders visit chains as tab chains with dwell, filing chip and the shelf", async () => {
    stubLibrary();
    render(<Library />);
    await openSubtab("Browser");
    const sect = await screen.findByLabelText("Browser");
    expect(sect.textContent).toContain("airbnb.com ×7");
    const chain = within(sect).getByLabelText("tab chain chain-1");
    expect(chain.textContent).toContain("anjuna villas");
    expect(chain.textContent).toContain("Villa Sol");
    expect(chain.textContent).toContain("→ Goa trip with Rohan");
    // Per-hop dwell, not just a chain total.
    expect(within(chain).getAllByText("2m").length).toBe(2);
    // The bookmark that landed on a hop is marked on the hop itself.
    expect(within(chain).getByText("★ bookmarked")).toBeTruthy();
    expect(within(sect).getByLabelText("bookmark shelf").textContent).toContain("Villa Sol");
  });

  it("hops to one URL within 30 s fold into one ×N hop (T6-3); the chain still counts every visit", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/library/browser", {
      event_count: 7,
      domains_today: [],
      chains: [
        {
          stream_key: "chain-dup",
          started_at: "2026-08-28T13:58:00.000Z",
          ended_at: "2026-08-28T13:59:10.000Z",
          visits: [
            ...[0, 5, 10, 15, 20, 25].map((s) => ({
              ts: `2026-08-28T13:58:${String(s).padStart(2, "0")}.000Z`,
              url: "https://www.goibibo.com/flights/",
              title: "Flights",
              dwell_ms: 0,
            })),
            { ts: "2026-08-28T13:59:10.000Z", url: "https://www.goibibo.com/hotels/", title: "Hotels", dwell_ms: 0 },
          ],
          space_label: null,
        },
      ],
      bookmarks: [],
    });
    render(<Library />);
    await openSubtab("Browser");
    const chain = await screen.findByLabelText("tab chain chain-dup");
    expect(within(chain).getAllByRole("listitem")).toHaveLength(2);
    expect(within(chain).getByLabelText("6 visits within 30 seconds").textContent).toBe("×6 · 13:58–13:58");
    expect(chain.textContent).toContain("7 hops");
  });

  it("NOT CONNECTED: the connect card shows every profile with real counts, the plateau note, Safari's FDA message and the local paths; Connect grants consent", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/sources/browser/status", { source: "browser", connected: false, running: false, consent: null, event_count: 0 });
    const chromePath = "/Users/me/Library/Application Support/Google/Chrome/Default/History";
    const win = (v: number) => ({ visits: v, bookmarks: 0 });
    stub.routes.set("/api/sources/browser/discover", {
      now: "2026-08-28T12:00:00.000Z",
      windows: ["3d", "7d", "30d", "90d", "180d", "1y", "2y", "3y", "4y", "5y", "all"],
      profiles: [
        {
          browser: "chrome",
          browser_name: "Chrome",
          profile: "Default",
          label: "Aditya",
          history_path: chromePath,
          bookmarks_path: "/Users/me/Library/Application Support/Google/Chrome/Default/Bookmarks",
          readable: true,
          error: null,
          windows: { "30d": win(1200), "90d": win(3400), "1y": win(3400), all: win(3400) },
          total_visits: 3400,
          total_bookmarks: 12,
          oldest_visit_ts: "2026-05-30T00:00:00.000Z",
          newest_visit_ts: "2026-08-28T11:00:00.000Z",
          plateau_window: "90d",
          retention_note: "Chrome keeps 90 days of history — anything older is already gone, so longer windows can't grow.",
        },
        {
          browser: "safari",
          browser_name: "Safari",
          profile: "Safari",
          label: null,
          history_path: "/Users/me/Library/Safari/History.db",
          bookmarks_path: null,
          readable: false,
          error: { code: "full-disk-access", message: "macOS protects Safari's history file. Give SuperTwin Full Disk Access …", settings_url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" },
          windows: {},
          total_visits: 0,
          total_bookmarks: 0,
          oldest_visit_ts: null,
          newest_visit_ts: null,
          plateau_window: null,
          retention_note: null,
        },
      ],
      totals: { "30d": win(1200), "90d": win(3400), "1y": win(3400), all: win(3400) },
      needs_full_disk_access: true,
      full_disk_access_settings_url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      disclosure: { scratch_dir: "/tmp/supertwinv13-history", text: "SuperTwin reads 2 history files by copying each one to /tmp/supertwinv13-history …" },
      connected: false,
      consent: null,
    });
    render(<Library />);
    await openSubtab("Browser");
    const card = await screen.findByLabelText("connect Connect your browsing");
    const list = await within(card).findByLabelText("browser profiles found");
    const chrome = within(list).getByLabelText("browser profile Chrome · Aditya");
    expect(chrome.textContent).toContain("1,200 visits / 30 days");
    expect(chrome.textContent).toContain("3,400 visits / everything");
    expect(chrome.textContent).toContain("12 bookmarks");
    expect(chrome.textContent).toContain("Chrome keeps 90 days");
    const safari = within(list).getByLabelText("browser profile Safari");
    expect(safari.textContent).toContain("needs Full Disk Access");
    expect(within(list).getByLabelText("full disk access").textContent).toContain("Full Disk Access");
    expect(within(list).getByLabelText("totals per window").textContent).toContain("everything: 3,400 visits");
    expect(list.textContent).toContain(chromePath);
    expect(list.textContent).toContain("/tmp/supertwinv13-history");

    fireEvent.click(within(card).getByText("Connect"));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.path === "/api/sources/browser/connect" && c.method === "POST")).toBe(true),
    );
    // Nothing goes through the SuperTwin Browser's Chromium import any more.
    expect(stub.calls.some((c) => c.path === "/api/browser/import-chrome")).toBe(false);
  });

  it("CONNECTED WITH ZERO EVENTS: the data view, not the connect card (card no longer gated on event_count)", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/sources/browser/status", {
      source: "browser",
      connected: true,
      running: true,
      consent: { id: "cns_b2", state: "connected", granted_at: "2026-08-28T11:59:00.000Z", index_all: true, index_from: null, understand_from: null, profiles: [] },
      event_count: 0,
    });
    stub.routes.set("/api/library/browser", { event_count: 0, domains_today: [], chains: [], bookmarks: [] });
    render(<Library />);
    await openSubtab("Browser");
    const sect = await screen.findByLabelText("Browser");
    expect(sect.textContent).toContain("connected — reading your history");
    expect(sect.textContent).toContain("understand off");
    expect(screen.queryByLabelText("connect Connect your browsing")).toBeNull();
    expect(stub.calls.some((c) => c.path === "/api/sources/browser/discover")).toBe(false);
  });
});

describe("People in the nav (spec §14.1.3)", () => {
  it("is a top-level tab, reachable by click and by ⌘4", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/people", {
      people: [
        {
          id: "ent_priya",
          name: "Priya",
          subtype: null,
          circle: "friends",
          provisional: 0,
          user_pinned: 0,
          first_seen_at: null,
          last_seen_at: null,
          created_at: "2026-01-01",
        },
      ],
      open_questions: [],
    });
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "primary" });
    expect(nav.textContent).toContain("People");
    // Library no longer carries People at the bottom of its scroll.
    fireEvent.click(screen.getByText("▤ Library"));
    await waitFor(() => expect(screen.getByLabelText("library sources")).toBeTruthy());
    expect(screen.queryByLabelText("People")).toBeNull();

    fireEvent.click(screen.getByText("◍ People"));
    await waitFor(() => expect(screen.getByLabelText("person Priya")).toBeTruthy());

    // Read each shortcut off the nav: this asserts that ⌘-number switches
    // tabs, not what order the tabs happen to be in (lanes keep adding them).
    const shortcutFor = (label: string): string => {
      const buttons = within(screen.getByRole("navigation", { name: "primary" })).getAllByRole("button");
      const i = buttons.findIndex((b) => (b.textContent ?? "").includes(label));
      if (i < 0) throw new Error(`no "${label}" tab in the nav`);
      return String(i + 1);
    };
    fireEvent.keyDown(window, { key: shortcutFor("Home"), metaKey: true });
    await waitFor(() => expect(screen.getByLabelText("Today")).toBeTruthy());
    fireEvent.keyDown(window, { key: shortcutFor("People"), metaKey: true });
    await waitFor(() => expect(screen.getByLabelText("person Priya")).toBeTruthy());
  });

  it("drag-to-correct still works from the nav destination", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/people", {
      people: [
        {
          id: "ent_priya",
          name: "Priya",
          subtype: null,
          circle: "friends",
          provisional: 0,
          user_pinned: 0,
          first_seen_at: null,
          last_seen_at: null,
          created_at: "2026-01-01",
        },
      ],
      open_questions: [],
    });
    render(<App />);
    fireEvent.click(screen.getByText("◍ People"));
    await waitFor(() => expect(screen.getByLabelText("person Priya")).toBeTruthy());

    fireEvent.dragStart(screen.getByLabelText("person Priya"));
    const closeFriends = screen.getByLabelText("circle close friends");
    fireEvent.dragOver(closeFriends);
    expect(closeFriends.className).toContain("drop-target");
    fireEvent.drop(closeFriends);

    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/corrections" && c.method === "POST");
      expect(post!.body).toEqual({
        target: { kind: "person", id: "ent_priya" },
        structured: { type: "set_circle", circle: "close_friends" },
      });
    });
  });
});
