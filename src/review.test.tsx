// ===========================================================================
// P1.7 review queue — the acceptance path in the UI (spec §14.2/§14.6):
// review queue → proposal modal (evidence) → why? (decision) → trace →
// Approve → POST /api/proposals/:id/approve → queue refreshes.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { homeFixture, stubWorker } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review queue → approve, end to end", () => {
  it("walks proposal → evidence → why? → trace → approve", async () => {
    const stub = stubWorker();
    render(<App />);
    await waitFor(() => expect(screen.getByText("New space: “Hampi trek in October”")).toBeTruthy());

    // Open the proposal modal from the review queue.
    fireEvent.click(screen.getByText("New space: “Hampi trek in October”"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("october long weekend hampi?"); // evidence
    expect(dialog.textContent).toContain("Merge into…");

    // "why?" → decision record with justification + confidence.
    fireEvent.click(within(dialog).getByText("why?"));
    const why = await within(dialog).findByLabelText("why");
    expect(why.textContent).toContain("2 chat mentions + 3 browser visits");
    expect(why.textContent).toContain("conf 0.82");

    // trace → the packed context and raw output of the proposing run.
    fireEvent.click(within(why).getByText("trace →"));
    const trace = await within(dialog).findByLabelText("trace");
    expect(trace.textContent).toContain("4 events about hampi");
    expect(trace.textContent).toContain("decide.v1");

    // Approve fires the worker call, closes the modal, and refetches Home
    // (the stub's second /api/home returns an empty queue).
    stub.routes.set("/api/home", { ...homeFixture, review: [] });
    fireEvent.click(within(dialog).getByText("Approve"));
    await waitFor(() => {
      expect(
        stub.calls.some((c) => c.path === "/api/proposals/sp_prop/approve" && c.method === "POST"),
      ).toBe(true);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getByLabelText("Review queue").textContent).toContain("nothing to review"),
    );
  });
});
