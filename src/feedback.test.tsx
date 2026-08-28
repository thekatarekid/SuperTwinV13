// ===========================================================================
// P1.7 feedback system — spec §14.4, evals FIX-01/05/06.
//
//   FIX-06: the ··· menu is exactly Edit · Remove · Tell the twin, and the
//           quick-chips are contextual per object type (never crossed).
//   FIX-05: dragging a task onto a space fires the correction pipeline
//           (POST /api/corrections with a structured move) + undo chip.
//   FIX-01: "Tell the twin" context-locks the bar and posts the utterance.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { chipsFor } from "./components/DotMenu";
import { stubWorker } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderHome(stub = stubWorker()) {
  render(<App />);
  await waitFor(() => expect(screen.getByText("Book villa")).toBeTruthy());
  return stub;
}

describe("FIX-06 · contextual chips are contextual", () => {
  it("caps every type at 3 chips and never crosses them", () => {
    expect(chipsFor("task").map((c) => c.label)).toEqual(["Not mine", "Already done"]);
    expect(chipsFor("claim").map((c) => c.label)).toEqual(["Not true", "Outdated"]);
    expect(chipsFor("proposal").map((c) => c.label)).toEqual(["Merge into…"]);
    for (const type of ["task", "claim", "proposal", "space", "episode"] as const) {
      expect(chipsFor(type).length).toBeLessThanOrEqual(3);
    }
  });

  it("the ··· menu is exactly Edit · Remove · Tell the twin with task chips on a task", async () => {
    await renderHome();
    fireEvent.click(screen.getByText("Book villa"));
    fireEvent.click(within(screen.getByRole("dialog")).getByLabelText("more"));
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((b) => b.textContent)).toEqual(["Edit", "Remove", "Tell the twin"]);
    expect(within(menu).getByText("Not mine")).toBeTruthy();
    expect(within(menu).getByText("Already done")).toBeTruthy();
    expect(within(menu).queryByText("Not true")).toBeNull(); // no claim chips on a task
  });

  it("a claim gets claim chips", async () => {
    await renderHome();
    fireEvent.click(screen.getByText("Trip budget ₹6k/night"));
    fireEvent.click(within(screen.getByRole("dialog")).getByLabelText("more"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Not true")).toBeTruthy();
    expect(within(menu).getByText("Outdated")).toBeTruthy();
    expect(within(menu).queryByText("Not mine")).toBeNull();
  });

  it("a chip posts its structured correction", async () => {
    const stub = await renderHome();
    fireEvent.click(screen.getByText("Book villa"));
    fireEvent.click(within(screen.getByRole("dialog")).getByLabelText("more"));
    fireEvent.click(screen.getByText("Already done"));
    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/corrections" && c.method === "POST");
      expect(call?.body).toMatchObject({
        target: { kind: "task", id: "t1" },
        structured: { type: "already_done" },
      });
    });
  });
});

describe("FIX-05 · drag = correction", () => {
  it("dropping a task on a space posts a structured move and shows the undo chip", async () => {
    const stub = await renderHome();
    const task = screen.getByText("Book villa").closest("button")!;
    const space = screen.getByText("Side project").closest("button")!;

    const payload = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => payload.set(k, v),
      getData: (k: string) => payload.get(k) ?? "",
    };
    fireEvent.dragStart(task, { dataTransfer });
    fireEvent.dragOver(space, { dataTransfer });
    fireEvent.drop(space, { dataTransfer });

    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/corrections" && c.method === "POST");
      expect(call?.body).toMatchObject({
        target: { kind: "task", id: "t1" },
        structured: { type: "move", to_space_id: "sp_side" },
      });
    });

    // No dialog — an undo chip confirms (spec §14.4.1), and undo round-trips.
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("moved to sp_side");
    fireEvent.click(within(toast).getByText("undo"));
    await waitFor(() => {
      expect(stub.calls.some((c) => c.path === "/api/corrections/cor1/undo")).toBe(true);
    });
  });
});

describe("FIX-01 · tell the twin (context-locked bar)", () => {
  it("locks the bar to the object and posts the utterance as a correction", async () => {
    const stub = await renderHome();
    fireEvent.click(screen.getByText("Book villa"));
    fireEvent.click(within(screen.getByRole("dialog")).getByLabelText("more"));
    fireEvent.click(screen.getByText("Tell the twin"));

    // Modal closed, bar locked to the task.
    expect(screen.queryByRole("dialog")).toBeNull();
    const bar = screen.getByLabelText("grounded bar");
    expect(bar.textContent).toContain("⊙ task: Book villa");

    const input = screen.getByLabelText("ask");
    fireEvent.change(input, { target: { value: "this is karan's task, not mine" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/corrections" && c.method === "POST");
      expect(call?.body).toMatchObject({
        target: { kind: "task", id: "t1" },
        utterance: "this is karan's task, not mine",
      });
    });
    // The twin reports what it did (never a silent parse-to-nothing).
    await waitFor(() => expect(bar.textContent).toContain("moved to sp_side ✓"));

    // Esc exits the lock before it would hide the window (spec §14.8.4).
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("grounded bar").textContent).not.toContain("unlock");
  });
});
