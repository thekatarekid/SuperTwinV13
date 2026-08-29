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
  stub.routes.set("/api/browser/status", {
    available: true,
    running: true,
    killSwitch: false,
    profileDir: "/tmp/profile",
  });
  stub.routes.set("/api/browser/import-chrome", { ok: true });
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

  it("PAIRED BUT NEVER IMPORTED: shows the history range picker", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/sources/whatsapp/status", {
      state: "connected",
      paired: true,
      paused: false,
      importDone: false,
    });
    render(<Library />);
    const card = await screen.findByLabelText("connect Choose how far back");
    fireEvent.change(within(card).getByLabelText("import range"), { target: { value: "2y" } });
    fireEvent.click(within(card).getByText("Import history"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/sources/whatsapp/import");
      expect(call!.body).toEqual({ range: "2y" });
    });
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

  it("NOTHING CAPTURED: shows the browser-profile connect flow", async () => {
    const stub = stubLibrary();
    stub.routes.set("/api/library/browser", {
      event_count: 0,
      domains_today: [],
      chains: [],
      bookmarks: [],
    });
    render(<Library />);
    await openSubtab("Browser");
    const card = await screen.findByLabelText("connect Connect your browsing");
    fireEvent.click(within(card).getByText("Import from Chrome"));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.path === "/api/browser/import-chrome")).toBe(true),
    );
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

    fireEvent.keyDown(window, { key: "1", metaKey: true });
    await waitFor(() => expect(screen.getByLabelText("Today")).toBeTruthy());
    fireEvent.keyDown(window, { key: "4", metaKey: true });
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
