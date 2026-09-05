// ===========================================================================
// Library › Storage + the confirm card (V6 P1 S1.8; backlog T4-10, T5-6,
// T5-7). The four numbers each carry their own accuracy label and the card
// text is the worker's, shown verbatim; the storage panel leads with free
// disk, draws two bars on one track per source with bytes per tier, says in
// words that searchable-only rows carry no episode, and gives the two disk
// budgets two separate controls. Worker stubbed — zero model calls.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Library } from "./screens/Library";
import { ConfirmCard, clampUnderstand, floorIso } from "./screens/library/ConfirmCard";
import { StoragePanel, formatBytes } from "./screens/library/StoragePanel";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

const CARD = {
  version: "confirm-card.v1",
  source: "whatsapp",
  indexAll: true,
  indexFrom: null,
  understandFrom: "2026-08-02T00:00:00.000Z",
  understandDays: 30,
  indexDays: null,
  events: { value: 1204, unit: "events", accuracy: "exact", display: "1,204", note: "4,409 kept searchable" },
  cost: {
    value: 0.312,
    unit: "usd",
    accuracy: "estimate ±40%",
    display: "about $0.31",
    note: "we'll stop and ask if it passes $15.00 in a day",
  },
  time: {
    value: 246,
    unit: "seconds",
    accuracy: "estimate ±30%",
    display: "about 4 min 6 s",
    note: "one call after another, newest day first",
  },
  disk: { value: 27_656_170, unit: "bytes", accuracy: "about", display: "about 28 MB", note: "keeping history costs disk; understanding it costs money" },
  stopAskUsd: 15,
  computedAt: "2026-09-01T12:00:00.000Z",
  text: [
    "WhatsApp · understand from 2 Aug 2026 (30 days) · keep everything searchable",
    "Events: 1,204 (exact) — 4,409 kept searchable",
    "Cost: about $0.31 (estimate ±40%) — we'll stop and ask if it passes $15.00 in a day",
    "Time: about 4 min 6 s (estimate ±30%) — one call after another, newest day first",
    "Disk: about 28 MB (about) — keeping history costs disk; understanding it costs money",
  ].join("\n"),
};

const STORAGE = {
  disk: { free_bytes: 487_000_000_000, total_bytes: 1_000_000_000_000 },
  used: { events_derived_bytes: 1_400_000_000, media_bytes: 200_000_000 },
  budgets: { events_bytes_per_year: 2_000_000_000, media_bytes: 30_000_000_000, media_retention_days: 90 },
  sources: [
    {
      source: "whatsapp",
      label: "WhatsApp",
      consent: {
        state: "connected",
        index_all: true,
        index_from: null,
        understand_from: "2026-08-02T00:00:00.000Z",
        decision_id: "dec_1",
      },
      searchable: { events: 4409, bytes: 3_260_000, from: "2024-01-05T00:00:00.000Z", to: "2026-08-28T11:58:00.000Z" },
      understood: { events: 1204, bytes: 890_000, from: "2026-08-02T00:00:00.000Z", to: "2026-08-28T11:58:00.000Z" },
      searchable_only: {
        events: 3205,
        bytes: 2_370_000,
        from: "2024-01-05T00:00:00.000Z",
        to: "2026-08-01T23:00:00.000Z",
        label: "searchable-only",
        note: "Searchable, not understood: this is outside the understand window, so it is kept and findable but carries no episode.",
      },
    },
    {
      source: "browser",
      label: "Browser",
      consent: { state: "connected", index_all: false, index_from: "2026-06-03T00:00:00.000Z", understand_from: "2026-06-03T00:00:00.000Z", decision_id: "dec_2" },
      searchable: { events: 300, bytes: 221_700, from: "2026-06-03T00:00:00.000Z", to: "2026-08-28T00:00:00.000Z" },
      understood: { events: 300, bytes: 221_700, from: "2026-06-03T00:00:00.000Z", to: "2026-08-28T00:00:00.000Z" },
      searchable_only: { events: 0, bytes: 0, from: null, to: null, label: "searchable-only", note: "…" },
    },
  ],
  copy: {
    lead: "Keeping more history costs disk. Understanding more history costs money.",
    searchable_only: "Searchable, not understood: this is outside the understand window, so it is kept and findable but carries no episode.",
  },
};

function stubStorage(): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/library/storage", STORAGE);
  stub.routes.set("/api/library/budgets", { budgets: { ...STORAGE.budgets, events_bytes_per_year: 4_000_000_000 } });
  stub.routes.set("/api/consent/card", { card: CARD });
  stub.routes.set("/api/consent/confirm", {
    consent: { id: "cns_1", source: "whatsapp", state: "connected", index_all: true, index_from: null, understand_from: CARD.understandFrom, decision_id: "dec_9" },
    card: CARD,
    decision_id: "dec_9",
    change: "granted",
    replayed: 0,
    started: "started",
  });
  return stub;
}

describe("ConfirmCard — four numbers, four accuracy labels (T4-10)", () => {
  it("renders the worker's numbers with their own labels and the card text verbatim", async () => {
    const stub = stubStorage();
    render(<ConfirmCard source="whatsapp" counts={{ index: 4409, understand: 1204, exact: true }} nowMs={() => NOW} />);

    await waitFor(() => expect(screen.getByRole("group", { name: "Events" })).toBeTruthy());
    const events = screen.getByRole("group", { name: "Events" });
    expect(within(events).getByText("1,204")).toBeTruthy();
    expect(within(events).getByText("exact")).toBeTruthy();
    expect(within(events).getByText("4,409 kept searchable")).toBeTruthy();

    const cost = screen.getByRole("group", { name: "Cost" });
    expect(within(cost).getByText("about $0.31")).toBeTruthy();
    expect(within(cost).getByText("estimate ±40%")).toBeTruthy();
    expect(within(cost).getByText(/stop and ask if it passes \$15\.00/)).toBeTruthy();

    const time = screen.getByRole("group", { name: "Time" });
    expect(within(time).getByText("about 4 min 6 s")).toBeTruthy();
    expect(within(time).getByText("estimate ±30%")).toBeTruthy();
    expect(within(time).getByText("one call after another, newest day first")).toBeTruthy();

    const disk = screen.getByRole("group", { name: "Disk" });
    expect(within(disk).getByText("about 28 MB")).toBeTruthy();
    expect(within(disk).getByText("about")).toBeTruthy();

    // The text the worker will store, shown as-is.
    expect(screen.getByLabelText("card text").textContent).toBe(CARD.text);

    // The preview asked the worker with the windows + the flow's counts; no write yet.
    const preview = stub.calls.find((c) => c.path === "/api/consent/card");
    expect(preview?.method).toBe("POST");
    expect(preview?.body).toMatchObject({
      source: "whatsapp",
      index_all: true,
      index_from: null,
      understand_from: "2026-08-02T00:00:00.000Z",
      counts: { index: 4409, understand: 1204, exact: true },
    });
    expect(stub.calls.some((c) => c.path === "/api/consent/confirm")).toBe(false);
  });

  it("changing a window re-asks the worker; Confirm posts the same body and reports back", async () => {
    const stub = stubStorage();
    const onConfirmed = vi.fn();
    render(<ConfirmCard source="whatsapp" nowMs={() => NOW} onConfirmed={onConfirmed} />);
    await waitFor(() => expect(screen.getByRole("group", { name: "Events" })).toBeTruthy());

    fireEvent.change(screen.getByLabelText("understand window"), { target: { value: "7d" } });
    await waitFor(() =>
      expect(
        stub.calls.filter((c) => c.path === "/api/consent/card").at(-1)?.body,
      ).toMatchObject({ understand_from: "2026-08-25T00:00:00.000Z" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    const confirm = stub.calls.find((c) => c.path === "/api/consent/confirm");
    expect(confirm?.body).toMatchObject({ source: "whatsapp", index_all: true, understand_from: "2026-08-25T00:00:00.000Z" });
    expect(onConfirmed.mock.calls[0][0]).toMatchObject({ decision_id: "dec_9", change: "granted" });
  });

  it("Understand never exceeds Index: a shorter Index clamps the Understand pick (CNS-03)", async () => {
    stubStorage();
    render(<ConfirmCard source="browser" initialUnderstand="1y" nowMs={() => NOW} />);
    await waitFor(() => expect(screen.getByRole("group", { name: "Events" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("index window"), { target: { value: "90d" } });
    expect((screen.getByLabelText("understand window") as HTMLSelectElement).value).toBe("90d");
    expect(clampUnderstand("1y", "90d")).toBe("90d");
    expect(clampUnderstand("7d", "90d")).toBe("7d");
    expect(clampUnderstand("none", "90d")).toBe("none");
    expect(clampUnderstand("5y", "all")).toBe("5y");
  });

  it("floorIso is the start of the UTC day `days` back", () => {
    expect(floorIso(30, NOW)).toBe("2026-08-02T00:00:00.000Z");
    expect(floorIso(null, NOW)).toBeNull();
  });
});

describe("Library › Storage — two bars, free disk first, two budgets (T5-6, T5-7)", () => {
  it("leads with use · free, draws searchable + understood per source with bytes, says searchable-only carries no episode", async () => {
    stubStorage();
    render(<StoragePanel />);
    await waitFor(() => expect(screen.getByLabelText("disk use")).toBeTruthy());
    expect(screen.getByLabelText("disk use").textContent).toBe("1.6 GB · 487.0 GB free");
    expect(screen.getByText("Keeping more history costs disk. Understanding more history costs money.")).toBeTruthy();

    const wa = screen.getByRole("group", { name: "WhatsApp storage" });
    const searchable = within(wa).getByRole("progressbar", { name: "WhatsApp searchable" });
    const understood = within(wa).getByRole("progressbar", { name: "WhatsApp understood" });
    expect(searchable.getAttribute("aria-valuenow")).toBe("4409");
    expect(understood.getAttribute("aria-valuenow")).toBe("1204");
    expect(understood.getAttribute("aria-valuemax")).toBe("4409");
    // Same track: both bars are children of the one track element.
    expect(searchable.parentElement).toBe(understood.parentElement);
    expect((understood as HTMLElement).style.width).toBe("27%");

    expect(within(wa).getByText(/searchable · 4,409 events · 3\.3 MB/)).toBeTruthy();
    expect(within(wa).getByText(/understood · 1,204 events · 890 KB/)).toBeTruthy();
    const note = within(wa).getByRole("note");
    expect(note.textContent).toContain("3,205 events are searchable only (2.4 MB)");
    expect(note.textContent).toContain("carries no episode");

    // A source with nothing outside its window says nothing about it.
    const browser = screen.getByRole("group", { name: "Browser storage" });
    expect(within(browser).queryByRole("note")).toBeNull();
  });

  it("the two budgets have two controls and save independently", async () => {
    const stub = stubStorage();
    render(<StoragePanel />);
    await waitFor(() => expect(screen.getByLabelText("disk budgets")).toBeTruthy());
    const events = screen.getByRole("group", { name: "Events and derived, per year" });
    const media = screen.getByRole("group", { name: "Media" });
    expect(events).not.toBe(media);
    expect((within(events).getByLabelText("Events and derived, per year (GB)") as HTMLInputElement).value).toBe("2");
    expect((within(media).getByLabelText("Media (GB)") as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText("media retention (days)") as HTMLInputElement).value).toBe("90");

    fireEvent.change(within(events).getByLabelText("Events and derived, per year (GB)"), { target: { value: "4" } });
    fireEvent.click(within(events).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/library/budgets")).toBe(true));
    const save = stub.calls.find((c) => c.path === "/api/library/budgets");
    expect(save?.method).toBe("POST");
    expect(save?.body).toEqual({ events_bytes_per_year: 4_000_000_000 });
    await waitFor(() =>
      expect((within(events).getByLabelText("Events and derived, per year (GB)") as HTMLInputElement).value).toBe("4"),
    );
    // The media handle did not move.
    expect((within(media).getByLabelText("Media (GB)") as HTMLInputElement).value).toBe("30");
  });

  it("Change windows opens the confirm card for that source without counts (the worker counts the log)", async () => {
    const stub = stubStorage();
    render(<StoragePanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "change WhatsApp windows" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "change WhatsApp windows" }));
    await waitFor(() => expect(screen.getByLabelText("confirm whatsapp")).toBeTruthy());
    const preview = stub.calls.find((c) => c.path === "/api/consent/card");
    expect(preview?.body).toMatchObject({ source: "whatsapp" });
    expect((preview?.body as { counts?: unknown }).counts).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("confirm whatsapp")).toBeNull());
  });

  it("is reachable from the Library beside the source pill, without being a source", async () => {
    stubStorage();
    render(<Library />);
    expect(screen.getByLabelText("library sources").textContent).toBe("WhatsAppScreenBrowser");
    const pill = screen.getByLabelText("library storage");
    fireEvent.click(within(pill).getByText("Storage"));
    await waitFor(() => expect(screen.getByLabelText("Storage")).toBeTruthy());
    expect(within(pill).getByText("Storage").getAttribute("aria-current")).toBe("page");
  });

  it("formatBytes", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3_260_000)).toBe("3.3 MB");
    expect(formatBytes(487_000_000_000)).toBe("487.0 GB");
  });
});
