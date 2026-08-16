import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App } from "./App";

afterEach(cleanup);

describe("App shell", () => {
  it("renders every tab in the rail", () => {
    render(<App />);
    for (const label of [
      "Inbox",
      "Chat",
      "Entities",
      "Sessions",
      "Episodes",
      "Threads",
      "Claims",
      "Spaces",
      "Tasks",
      "People",
      "Settings",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  // "Spaces" is back as of item 3.10 — as a filtered view over arcs, not as
  // the V1 tab this assertion originally retired. Agent and Digest stay gone.
  it("does not render the removed Agent / Digest tabs", () => {
    render(<App />);
    for (const label of ["Agent", "Digest"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("shows the Chat tab by default", () => {
    render(<App />);
    // The functional Chat tab is the default surface; assert on its stable
    // static chrome (the "New chat" action) rather than any streamed content.
    expect(screen.getByRole("button", { name: /New chat/i })).toBeTruthy();
  });

  it("switches panels when a tab is clicked", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current"),
    ).toBe("page");
    // The Settings surface is mounted — assert its first section heading.
    expect(screen.getByRole("heading", { name: "Worker" })).toBeTruthy();
  });
});
