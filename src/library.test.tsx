// ===========================================================================
// P2.4 Library + freshness chip (spec §5.4, §14.3.2): the header "Knows you"
// chip, the three per-source sections, the per-stream capture pause, and the
// honest-delete confirm flow for a screen session.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  stub.routes.set("/api/library/chats", {
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
        today_count: 12,
        event_count: 420,
      },
      {
        id: "whatsapp:st:pta@g.us",
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
      },
    ],
  });
  stub.routes.set("/api/library/browser", {
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
          { ts: "2026-08-28T13:58:00.000Z", url: "https://airbnb.com/s/anjuna", title: "anjuna villas", dwell_ms: 120000 },
          { ts: "2026-08-28T14:00:00.000Z", url: "https://airbnb.com/rooms/1", title: "Villa Sol", dwell_ms: 120000 },
        ],
        space_label: "Goa trip with Rohan",
      },
    ],
    bookmarks: [
      { ts: "2026-08-28T14:03:00.000Z", url: "https://airbnb.com/rooms/1", title: "Villa Sol", folder: "Goa" },
    ],
  });
  stub.routes.set("/api/library/screen", {
    day: "2026-08-28",
    hours: new Array(24).fill(0).map((_, h) => (h === 14 ? 4 : 0)),
    sessions: [
      {
        stream_key: "screen:app:Airbnb",
        app: "Airbnb",
        started_at: "2026-08-28T14:02:00.000Z",
        ended_at: "2026-08-28T14:06:00.000Z",
        minutes: 4,
        event_count: 4,
      },
    ],
    paused: false,
  });
  // The client percent-encodes the stream id in the path.
  stub.routes.set(`/api/library/streams/${encodeURIComponent("whatsapp:st:goa@g.us")}/pause`, {
    stream_id: "whatsapp:st:goa@g.us",
    paused: true,
    decision_id: "decP",
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

async function openLibrary(): Promise<void> {
  render(<App />);
  fireEvent.click(screen.getByText("▤ Library"));
  await waitFor(() => expect(screen.getByText("Goa gang")).toBeTruthy());
}

describe("freshness chip", () => {
  it("renders the cross-source Knows-you headline in the header", async () => {
    stubLibrary();
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("freshness").textContent).toBe("Knows you: 2024 → 2 min ago"),
    );
  });
});

describe("Library — Chats", () => {
  it("shows tier badge, category, knows-you range and live counts", async () => {
    stubLibrary();
    await openLibrary();
    const chats = screen.getByLabelText("Chats");
    expect(within(chats).getByText("T1")).toBeTruthy();
    expect(within(chats).getByText("Cat-1")).toBeTruthy();
    expect(within(chats).getByText("knows you: 2024 →")).toBeTruthy();
    expect(within(chats).getByText("12 msgs today")).toBeTruthy();
    // Cat-2 never-replied shows the promotion hint instead of a range.
    expect(within(chats).getByText("never replied (reply promotes)")).toBeTruthy();
  });

  it("⏸ posts the per-stream capture pause", async () => {
    const stub = stubLibrary();
    await openLibrary();
    fireEvent.click(screen.getByLabelText("pause Goa gang"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path.endsWith("/pause"));
      expect(call).toBeTruthy();
      expect(call!.method).toBe("POST");
      expect(call!.body).toEqual({ paused: true });
    });
  });
});

describe("Library — Browser", () => {
  it("shows today's domains, the chain with filing chip, and the shelf", async () => {
    stubLibrary();
    await openLibrary();
    const browser = screen.getByLabelText("Browser");
    expect(browser.textContent).toContain("airbnb.com ×7");
    expect(browser.textContent).toContain("anjuna villas → Villa Sol");
    expect(browser.textContent).toContain("→ Goa trip with Rohan");
    expect(browser.textContent).toContain("★ shelf");
  });
});

describe("Library — Screen", () => {
  it("shows the day strip and session cards with privacy controls", async () => {
    stubLibrary();
    await openLibrary();
    const sect = screen.getByLabelText("Screen");
    expect(within(sect).getByLabelText("day strip")).toBeTruthy();
    expect(sect.textContent).toContain("14:02 Airbnb 4m");
    expect(sect.textContent).toContain("honest delete");
  });

  it("delete walks the confirm dialog and posts the cascading delete", async () => {
    const stub = stubLibrary();
    await openLibrary();
    fireEvent.click(screen.getByLabelText("delete session Airbnb 14:02"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("cannot be undone");
    fireEvent.click(within(dialog).getByText("Delete for good"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/library/screen/delete");
      expect(call).toBeTruthy();
      expect(call!.body).toEqual({
        start_ts: "2026-08-28T14:02:00.000Z",
        end_ts: "2026-08-28T14:06:00.000Z",
        stream_key: "screen:app:Airbnb",
      });
    });
    // The result summary is honest about what went with the events.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("deleted 4 events · 1 episodes"),
    );
  });
});
