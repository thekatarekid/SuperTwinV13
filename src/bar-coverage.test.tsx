// ===========================================================================
// The grounded bar's S5.5 response fields — V6 P1 R2 (Product_V6_Phase1 §19.4,
// §19.5, §19.6, §21).
//
// S5.5 made the worker decide sufficiency in code, attach the coverage caveat,
// label a general answer and hand back the thread's lock with its quick chips.
// The overlay rendered none of it, which is worse than not computing it: a
// partial answer that does not say it is partial reads as a complete one.
//
// Each case shapes /api/bar the way the worker shapes it and asserts what the
// user is told. The worker is stubbed: no network, no model.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GroundedBar } from "./components/GroundedBar";
import { stubWorker, type WorkerStub } from "./test-utils";

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

function stubBar(response: Record<string, unknown>): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/bar/typeahead", { events: [], spaces: [] });
  stub.routes.set("/api/bar", response);
  return stub;
}

async function ask(input: HTMLInputElement, text: string): Promise<void> {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getByLabelText("bar thread")).toBeTruthy());
}

describe("the bar renders what the worker decided about the answer", () => {
  it("a partial answer says it is partial and names its gaps", async () => {
    stubBar({
      intent: "question",
      class: "aggregate",
      thread_id: "th1",
      lock: null,
      chips: [],
      answer: {
        answer: "₹18,400 so far [1]",
        citations: [{ n: 1, kind: "event", id: "ev1", label: "swiggy · ₹420" }],
        grounded: true,
        refused_uncited: false,
        class: "aggregate",
        method: "structured",
        value: 18400,
        partial: true,
        gaps: ["3 rows with no amount", "Feb 2024 not captured"],
        coverage_caveat: null,
        not_from_your_data: false,
        results: [],
        scanned: 41,
        methods_ran: ["structured"],
      },
    });
    await ask(renderBar(), "how much on food this year");
    const notes = screen.getByLabelText("answer notes");
    expect(within(notes).getByTestId("partial-answer")).toBeTruthy();
    expect(within(notes).getByLabelText("gaps").textContent).toContain("3 rows with no amount");
    expect(within(notes).getByLabelText("gaps").textContent).toContain("Feb 2024 not captured");
  });

  it("the coverage caveat is printed in the worker's own sentence", async () => {
    stubBar({
      intent: "question",
      class: "temporal",
      thread_id: "th1",
      answer: {
        answer: "nothing before that [1]",
        citations: [{ n: 1, kind: "event", id: "ev1", label: "rohan · goa?" }],
        grounded: true,
        refused_uncited: false,
        class: "temporal",
        method: "time window",
        value: null,
        partial: true,
        gaps: [],
        coverage_caveat: {
          source: "whatsapp",
          kind: "floor",
          text: "I only have WhatsApp back to Jan 2024.",
          floor: "2024-01-01",
        },
        not_from_your_data: false,
        results: [],
        scanned: 12,
        methods_ran: ["time"],
      },
    });
    await ask(renderBar(), "when did we first talk about goa");
    expect(screen.getByLabelText("coverage caveat").textContent).toBe("I only have WhatsApp back to Jan 2024.");
  });

  it("a general answer is labelled — the one ungrounded answer says so", async () => {
    stubBar({
      intent: "question",
      class: "general",
      thread_id: "th1",
      answer: {
        answer: "Not from your data: the Konkan monsoon runs June to September.",
        citations: [],
        grounded: false,
        refused_uncited: false,
        class: "general",
        method: "general knowledge",
        value: null,
        partial: false,
        gaps: [],
        coverage_caveat: null,
        not_from_your_data: true,
        results: [],
        scanned: 0,
        methods_ran: [],
      },
    });
    await ask(renderBar(), "when is the monsoon in goa");
    expect(screen.getByTestId("not-from-your-data")).toBeTruthy();
  });

  it("a sufficient, fully covered answer carries no notes at all", async () => {
    stubBar({
      intent: "question",
      class: "lookup",
      thread_id: "th1",
      answer: {
        answer: "₹6k a night [1]",
        citations: [{ n: 1, kind: "event", id: "ev1", label: "rohan · max 6k a night yaar" }],
        grounded: true,
        refused_uncited: false,
        class: "lookup",
        method: "lexical ∪ vector",
        value: null,
        partial: false,
        gaps: [],
        coverage_caveat: null,
        not_from_your_data: false,
        results: [],
        scanned: 8,
        methods_ran: ["lexical", "vector"],
      },
    });
    await ask(renderBar(), "villa budget");
    expect(screen.queryByLabelText("answer notes")).toBeNull();
  });
});

describe("the thread locks to what the bar made, and the chips ride with it", () => {
  it("shows the lock and its quick chips, and a chip is a correction", async () => {
    const onQuickChip = vi.fn();
    stubBar({
      intent: "action",
      class: "action",
      thread_id: "th1",
      lock: { kind: "task", id: "tk_1", label: "Buy sunscreen" },
      chips: [
        { label: "Not mine", structured: { type: "wrong_person", owner: "them" } },
        { label: "Already done", structured: { type: "already_done" } },
      ],
      action: { status: "done", summary: "made the task 'Buy sunscreen'", task_id: "tk_1", progress: [] },
    });
    await ask(renderBar({ onQuickChip }), "add task: buy sunscreen for goa");
    const lock = screen.getByLabelText("thread lock");
    expect(within(lock).getByText(/task: Buy sunscreen/)).toBeTruthy();
    expect(within(lock).getByText(/a follow-up here corrects this/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Already done on Buy sunscreen"));
    expect(onQuickChip).toHaveBeenCalledWith({ kind: "task", id: "tk_1" }, { type: "already_done" });
  });

  it("no lock, no chip row — an unlocked answer offers nothing to correct", async () => {
    stubBar({
      intent: "question",
      class: "lookup",
      thread_id: "th1",
      lock: null,
      chips: [],
      answer: {
        answer: "₹6k a night [1]",
        citations: [],
        grounded: true,
        refused_uncited: false,
      },
    });
    await ask(renderBar(), "villa budget");
    expect(screen.queryByLabelText("thread lock")).toBeNull();
    expect(screen.queryByLabelText("quick chips")).toBeNull();
  });
});
