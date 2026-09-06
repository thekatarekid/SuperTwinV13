// ===========================================================================
// P1.7 shell — nav, Home sections, modal open/Esc-dismiss. (spec §14.1/§14.2)
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { stubWorker } from "./test-utils";

/**
 * The ⌘-number of a tab, read off the nav. Asserting the SHORTCUT works must
 * not also assert the tab ORDER — every lane that adds a tab would break it.
 */
function shortcutFor(label: string): string {
  const nav = screen.getByRole("navigation", { name: "primary" });
  const buttons = within(nav).getAllByRole("button");
  const i = buttons.findIndex((b) => (b.textContent ?? "").includes(label));
  if (i < 0) throw new Error(`no "${label}" tab in the nav`);
  return String(i + 1);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shell", () => {
  it("renders the top-center pill nav with the five tabs", async () => {
    stubWorker();
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "primary" });
    expect(nav.textContent).toContain("Home");
    expect(nav.textContent).toContain("Timeline");
    expect(nav.textContent).toContain("Library");
    expect(nav.textContent).toContain("People");
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
    // The stub serves no /api/library/* routes, so the real Library screen
    // (P2.4) lands on its unreachable-worker state.
    await waitFor(() => expect(screen.getByText("worker unreachable")).toBeTruthy());
    // The Calendar tab (V6 P1 S5.3) and the Timeline, by their own shortcut.
    // Neither route is stubbed, so both land on their unreachable-worker state.
    fireEvent.keyDown(window, { key: shortcutFor("Calendar"), metaKey: true });
    expect(screen.getByLabelText("Calendar")).toBeTruthy();
    fireEvent.keyDown(window, { key: shortcutFor("Timeline"), metaKey: true });
    // The real Timeline screen (P4.1); the stub serves no /api/timeline.
    expect(screen.getByLabelText("Timeline")).toBeTruthy();
    fireEvent.keyDown(window, { key: shortcutFor("Home"), metaKey: true });
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
