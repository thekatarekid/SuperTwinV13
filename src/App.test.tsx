import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App } from "./App";

afterEach(cleanup);

describe("App shell", () => {
  it("renders all three tabs", () => {
    render(<App />);
    for (const label of ["Inbox", "Chat", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("does not render the removed Spaces / Agent / Digest tabs", () => {
    render(<App />);
    for (const label of ["Spaces", "Agent", "Digest"]) {
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
