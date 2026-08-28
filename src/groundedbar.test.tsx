// ===========================================================================
// Grounded bar — the six states (build P4.1, spec §14.8, USR-04/06). The
// worker is stubbed; intent routing happens server-side, so each test shapes
// the /api/bar response for its state: live search (②), cited answers (③,
// with the citation chips that make grounding tappable), acting (④ incl.
// ask-once options), history (⑥ reopenable threads). ⑤ context-locked stays
// covered by feedback.test.tsx via the corrections pipeline.
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GroundedBar } from "./components/GroundedBar";
import { stubWorker } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderBar(overrides?: Partial<Parameters<typeof GroundedBar>[0]>) {
  const props = {
    lock: null,
    onUnlock: () => {},
    onTellTwin: async () => "ok",
    ...overrides,
  };
  render(<GroundedBar {...props} />);
  return screen.getByLabelText("ask") as HTMLInputElement;
}

describe("grounded bar", () => {
  it("② shows live results while typing (worker search, no model)", async () => {
    const stub = stubWorker();
    stub.routes.set("/api/bar/search", {
      events: [{ id: "e1", ts: null, actor: "Rohan", chat: "Goa gang", snippet: "pool villa" }],
      spaces: [{ id: "sp_goa", label: "Goa trip" }],
    });
    const onOpenEvent = vi.fn();
    const input = renderBar({ onOpenEvent });
    fireEvent.change(input, { target: { value: "goa villa" } });
    await waitFor(() => expect(screen.getByLabelText("live results")).toBeTruthy());
    expect(screen.getByText(/pool villa/)).toBeTruthy();
    expect(screen.getByText(/Goa trip \(space\)/)).toBeTruthy();
    fireEvent.click(screen.getByText(/pool villa/));
    expect(onOpenEvent).toHaveBeenCalledWith("e1");
  });

  it("③ answer state: cited answer with tappable evidence chips → Timeline", async () => {
    const stub = stubWorker();
    stub.routes.set("/api/bar/search", { events: [], spaces: [] });
    stub.routes.set("/api/bar", {
      intent: "question",
      thread_id: "th1",
      answer: {
        answer: "₹6k/night max [1]",
        citations: [{ n: 1, kind: "event", id: "ev9", label: "rohan · max 6k a night yaar" }],
        grounded: true,
        refused_uncited: false,
      },
    });
    const onOpenEvent = vi.fn();
    const input = renderBar({ onOpenEvent });
    fireEvent.change(input, { target: { value: "how much per night?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByLabelText("bar thread")).toBeTruthy());
    expect(screen.getByText(/₹6k\/night max/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("citation 1"));
    expect(onOpenEvent).toHaveBeenCalledWith("ev9");
    // Esc walks back one state: thread → input.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("bar thread")).toBeNull();
  });

  it("③ renders an inline webview card when the answer carries a URL", async () => {
    const stub = stubWorker();
    stub.routes.set("/api/bar/search", { events: [], spaces: [] });
    stub.routes.set("/api/bar", {
      intent: "question",
      thread_id: "th1",
      answer: {
        answer: "the saved villas are at https://airbnb.com/wishlists/3 [1]",
        citations: [{ n: 1, kind: "event", id: "ev2", label: "browser · airbnb" }],
        grounded: true,
        refused_uncited: false,
      },
    });
    const input = renderBar();
    fireEvent.change(input, { target: { value: "where are the villas?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("webview-card")).toBeTruthy());
    expect(screen.getByTestId("webview-card").textContent).toContain("airbnb.com");
    expect(screen.getByTestId("webview-card").textContent).toContain("SuperTwin Browser");
  });

  it("④ acting: progress lines ride back and the created space/task link opens", async () => {
    const stub = stubWorker();
    stub.routes.set("/api/bar/search", { events: [], spaces: [] });
    stub.routes.set("/api/bar", {
      intent: "action",
      thread_id: "th1",
      action: {
        status: "done",
        summary: 'created space "Hampi trek Oct"',
        space_id: "sp_hampi",
        task_id: "t9",
        progress: ["creating space ✓", "sweeping 3 related item(s) ✓"],
      },
    });
    const onOpenSpace = vi.fn();
    const input = renderBar({ onOpenSpace });
    fireEvent.change(input, { target: { value: "plan a hampi trek" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/created space/)).toBeTruthy());
    expect(screen.getByText("creating space ✓")).toBeTruthy();
    fireEvent.click(screen.getByText("open space"));
    expect(onOpenSpace).toHaveBeenCalledWith("sp_hampi");
  });

  it("④ ask-once: one question, one-tap options, the answer posts the held parse", async () => {
    const stub = stubWorker();
    stub.routes.set("/api/bar/search", { events: [], spaces: [] });
    const pending = { verb: "create_task", title: "buy sunscreen", risky: false };
    stub.routes.set("/api/bar", {
      intent: "action",
      thread_id: "th1",
      action: {
        status: "needs_input",
        summary: "which space is this for?",
        question: 'File "buy sunscreen" under which?',
        options: [
          { id: "sp_dec", label: "Goa Dec" },
          { id: "sp_wed", label: "Goa wedding" },
        ],
        pending,
        progress: [],
      },
    });
    const input = renderBar();
    fireEvent.change(input, { target: { value: "add task: buy sunscreen" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/under which\?/)).toBeTruthy());
    fireEvent.click(screen.getByText("Goa Dec"));
    await waitFor(() =>
      expect(
        stub.calls.some(
          (c) =>
            c.path === "/api/bar" &&
            (c.body as { answer?: { space_id?: string } })?.answer?.space_id === "sp_dec",
        ),
      ).toBe(true),
    );
  });

  it("⑥ history: ↑ lists past threads; reopening loads its messages (USR-06)", async () => {
    const stub = stubWorker();
    stub.routes.set("/api/bar/threads", {
      threads: [
        { thread_id: "th_villa", title: "villa advance reminder", last_ts: "2026-08-28T10:00:00Z", message_count: 2 },
      ],
    });
    stub.routes.set("/api/bar/threads/th_villa", {
      thread_id: "th_villa",
      messages: [
        { event_id: "e1", thread_id: "th_villa", role: "user", text: "remind rohan about the villa advance", ts: "t", intent: "action", meta: null },
        { event_id: "e2", thread_id: "th_villa", role: "twin", text: "draft ready", ts: "t", intent: "action", meta: null },
      ],
    });
    const input = renderBar();
    fireEvent.click(screen.getByLabelText("history"));
    await waitFor(() => expect(screen.getByLabelText("bar history")).toBeTruthy());
    fireEvent.click(screen.getByText(/villa advance reminder/));
    await waitFor(() => expect(screen.getByLabelText("bar thread")).toBeTruthy());
    expect(screen.getByText(/remind rohan about the villa advance/)).toBeTruthy();
    expect(screen.getByText(/draft ready/)).toBeTruthy();
    // Continuing types into the same thread ("follow up…" placeholder).
    expect(input.placeholder).toBe("follow up…");
  });

  it("⑤ context-locked keeps the P1.7 contract: lock chip + tell-the-twin reply", async () => {
    stubWorker();
    const onTellTwin = vi.fn(async () => "moved to Karan ✓");
    const input = renderBar({
      lock: { kind: "task", id: "t1", label: "Book villa" },
      onTellTwin,
    });
    expect(screen.getByText(/task: Book villa/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "this is karan's task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/moved to Karan ✓/)).toBeTruthy());
    expect(onTellTwin).toHaveBeenCalled();
  });
});
