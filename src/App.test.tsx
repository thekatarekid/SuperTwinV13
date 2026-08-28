// ===========================================================================
// P1.7 shell — nav, Home sections, modal open/Esc-dismiss. (spec §14.1/§14.2)
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { stubWorker } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shell", () => {
  it("renders the top-center pill nav with the four tabs", async () => {
    stubWorker();
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "primary" });
    expect(nav.textContent).toContain("Home");
    expect(nav.textContent).toContain("Timeline");
    expect(nav.textContent).toContain("Library");
    expect(nav.textContent).toContain("Settings");
    await waitFor(() => expect(screen.getByText("Book villa")).toBeTruthy());
  });

  it("renders the four Home sections from /api/home", async () => {
    stubWorker();
    render(<App />);
    await waitFor(() => expect(screen.getByText("Book villa")).toBeTruthy());
    expect(screen.getByLabelText("Today")).toBeTruthy();
    expect(screen.getByLabelText("Spaces")).toBeTruthy();
    expect(screen.getByLabelText("Review queue")).toBeTruthy();
    expect(screen.getByLabelText("Recent understanding")).toBeTruthy();
    expect(screen.getByText("Goa trip with Rohan")).toBeTruthy();
    expect(screen.getByText("New space: “Hampi trek in October”")).toBeTruthy();
    expect(screen.getByText("Trip budget ₹6k/night")).toBeTruthy();
  });

  it("switches tabs by click and ⌘-number", async () => {
    stubWorker();
    render(<App />);
    fireEvent.click(screen.getByText("▤ Library"));
    expect(screen.getByText(/Per-source capture/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(screen.getByText(/The event log rendered/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    await waitFor(() => expect(screen.getByLabelText("Today")).toBeTruthy());
  });

  it("opens a task modal with evidence and Esc dismisses it", async () => {
    stubWorker();
    render(<App />);
    await waitFor(() => expect(screen.getByText("Book villa")).toBeTruthy());
    fireEvent.click(screen.getByText("Book villa"));
    const dialog = screen.getByRole("dialog", { name: "Book villa" });
    expect(dialog.textContent).toContain("lets lock goa 18-21 dec");
    expect(dialog.textContent).toContain("approve-final");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the worker-unreachable state without crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
  });
});
