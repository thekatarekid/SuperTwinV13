// ===========================================================================
// Timeline screen (build P4.1, spec §14.3.1): the event log rendered — day
// scrubber, filters, grouped rows, filing chips → space modal, row → modal.
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetLoadCache } from "./components/LoadState";
import { Timeline } from "./screens/Timeline";
import { homeFixture, stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
  // FIX-C4: the screen keeps its answer in the module-level pane cache so a
  // tab flip repaints instantly. Between tests that cache is someone else's
  // fixture, so it is dropped like any other global.
  resetLoadCache();
});

const rows = [
  {
    id: "ev_burst",
    ts: "2026-08-28T13:41:00.000Z",
    end_ts: "2026-08-28T13:20:00.000Z",
    source: "wa",
    kind: "wa.message",
    actor: "Rohan",
    chat: "Goa gang",
    text: "pool villa looks great",
    count: 12,
    event_ids: ["ev_burst"],
    space_id: "sp_goa",
    space_label: "Goa trip with Rohan",
  },
  {
    id: "ev_unsorted",
    ts: "2026-08-27T09:15:00.000Z",
    end_ts: "2026-08-27T09:15:00.000Z",
    source: "wa",
    kind: "wa.message",
    actor: "Ma",
    chat: null,
    text: "ticket book kar diya?",
    count: 1,
    event_ids: ["ev_unsorted"],
    space_id: null,
    space_label: null,
  },
];

function stubTimeline(nextBefore: string | null = null): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/timeline", { rows, next_before: nextBefore });
  stub.routes.set("/api/timeline/days", {
    days: [
      { day: "2026-08-28", count: 13 },
      { day: "2026-08-27", count: 1 },
    ],
    sources: ["browser", "wa"],
  });
  return stub;
}

describe("Timeline", () => {
  it("renders grouped rows under day headings with source + burst count", async () => {
    stubTimeline();
    render(<Timeline spaces={homeFixture.spaces} onOpenSpace={() => {}} />);
    await waitFor(() => expect(screen.getByText(/pool villa looks great/)).toBeTruthy());
    // The 12-message burst is one line.
    expect(screen.getByText(/×12/)).toBeTruthy();
    expect(screen.getAllByText("⬡ WhatsApp").length).toBeGreaterThan(0);
    // Two day sections.
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  it("shows the day scrubber and the source/person/space filters", async () => {
    stubTimeline();
    render(<Timeline spaces={homeFixture.spaces} onOpenSpace={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("day scrubber")).toBeTruthy());
    expect(screen.getByLabelText("day scrubber").querySelectorAll("button")).toHaveLength(2);
    const source = screen.getByLabelText("source filter") as HTMLSelectElement;
    expect(source.textContent).toContain("wa");
    expect(screen.getByLabelText("person filter")).toBeTruthy();
    const space = screen.getByLabelText("space filter") as HTMLSelectElement;
    expect(space.textContent).toContain("Goa trip with Rohan");
  });

  it("filing chip opens the space; unfiled rows show the unsorted flag", async () => {
    stubTimeline();
    const onOpenSpace = vi.fn();
    render(<Timeline spaces={homeFixture.spaces} onOpenSpace={onOpenSpace} />);
    await waitFor(() => expect(screen.getByLabelText("filed under Goa trip with Rohan")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("filed under Goa trip with Rohan"));
    expect(onOpenSpace).toHaveBeenCalledWith("sp_goa");
    expect(screen.getByText("→ unsorted ⚑")).toBeTruthy();
  });

  it("row click opens the event modal; Esc-equivalent close works", async () => {
    stubTimeline();
    render(<Timeline spaces={homeFixture.spaces} onOpenSpace={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("event ev_burst")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("event ev_burst"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("pool villa looks great");
    expect(dialog.textContent).toContain("12 events");
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pages with 'show more' when the worker hands back a cursor", async () => {
    const stub = stubTimeline("2026-08-27T09:15:00.000Z");
    render(<Timeline spaces={homeFixture.spaces} onOpenSpace={() => {}} />);
    await waitFor(() => expect(screen.getByText("show more")).toBeTruthy());
    const before = stub.calls.filter((c) => c.path === "/api/timeline").length;
    fireEvent.click(screen.getByText("show more"));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.path === "/api/timeline").length).toBeGreaterThan(before),
    );
  });
});
