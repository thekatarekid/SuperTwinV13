// ===========================================================================
// Accessibility onboarding banner (P2.1, spec §4.2.2) — defect regression.
//
// Shipped 13.4.1 bug: "Open System Settings" did nothing in the packaged app.
// `openExternal` went through the shell plugin, whose default JS open-scope
// regex (^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+) rejects the
// `x-apple.systempreferences:` deep link; the rejection was swallowed and the
// helper fell through to `window.open`, a no-op for OS schemes in WKWebView.
//
// These tests pin the fixed contract:
//   * the click reaches the app's `open_external` command with the deep link,
//   * a rejected invoke renders a VISIBLE fallback (URL + manual path),
//   * the banner clears itself once the poll stops reporting need_permission,
//   * the × dismisses it.
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessibilityOnboarding } from "./components/AccessibilityOnboarding";

const invoke = vi.fn();
const shellOpen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: (...a: unknown[]) => shellOpen(...a) }));

const SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

function needPermission(): Record<string, unknown> {
  return {
    running: true,
    state: "need_permission",
    permission: false,
    settingsUrl: SETTINGS_URL,
  };
}

function capturing(): Record<string, unknown> {
  return {
    running: true,
    state: "capturing",
    permission: true,
    settingsUrl: SETTINGS_URL,
  };
}

/** Serve /api/screen/status from a mutable holder so a poll can flip state. */
function stubScreenStatus(initial: Record<string, unknown>): {
  current: Record<string, unknown>;
} {
  const holder = { current: initial };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => holder.current,
    })),
  );
  return holder;
}

beforeEach(() => {
  invoke.mockReset();
  shellOpen.mockReset();
  // Pretend we are inside the Tauri webview so openExternal takes the IPC path.
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("accessibility onboarding banner", () => {
  it("ASKS macOS, then routes the click to the app opener with the deep link", async () => {
    stubScreenStatus(needPermission());
    const commands: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      if (cmd === "request_accessibility") return { trusted: false, prompted: true };
      return undefined;
    });
    render(<AccessibilityOnboarding />);

    const button = await screen.findByText("Open System Settings");
    fireEvent.click(button);

    await waitFor(() => expect(commands).toContain("open_external"));
    // S6d/L4: the ask comes FIRST. Nothing in 13.11.5 ever called
    // AXIsProcessTrustedWithOptions, so macOS never listed SuperTwin in the
    // Accessibility pane and this button opened a pane with no row to switch
    // on — the whole reason screen capture could not be granted.
    expect(commands).toEqual(["request_accessibility", "open_external"]);
    expect(invoke).toHaveBeenCalledWith("open_external", { url: SETTINGS_URL });
    // The plugin path is only a fallback — a successful command must not use it.
    expect(shellOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a visible copyable fallback when the invoke rejects", async () => {
    stubScreenStatus(needPermission());
    // Both routes fail — exactly what 13.4.1 did, minus the silence.
    invoke.mockRejectedValue(new Error("shell.open not allowed on the configured scope"));
    shellOpen.mockRejectedValue(new Error("scope not allowed"));
    render(<AccessibilityOnboarding />);

    fireEvent.click(await screen.findByText("Open System Settings"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't open System Settings");
    expect(alert.textContent).toContain(
      "System Settings › Privacy & Security › Accessibility",
    );
    // The URL itself is on screen and copyable.
    expect(screen.getByTestId("accessibility-settings-url").textContent).toBe(
      SETTINGS_URL,
    );
    // …and the underlying reason is shown, not swallowed.
    expect(alert.textContent).toContain("scope not allowed");

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SETTINGS_URL));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("falls back to the shell plugin when the app command is missing", async () => {
    stubScreenStatus(needPermission());
    invoke.mockRejectedValue(new Error("command open_external not found"));
    shellOpen.mockResolvedValue(undefined);
    render(<AccessibilityOnboarding />);

    fireEvent.click(await screen.findByText("Open System Settings"));

    await waitFor(() => expect(shellOpen).toHaveBeenCalledWith(SETTINGS_URL));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears itself once the poll reports the permission is granted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const holder = stubScreenStatus(needPermission());
    render(<AccessibilityOnboarding />);

    expect(await screen.findByText("Open System Settings")).toBeTruthy();
    holder.current = capturing();
    await vi.advanceTimersByTimeAsync(5_100);

    await waitFor(() => expect(screen.queryByText("Open System Settings")).toBeNull());
  });

  it("dismisses on ×", async () => {
    stubScreenStatus(needPermission());
    render(<AccessibilityOnboarding />);

    fireEvent.click(await screen.findByLabelText("dismiss"));
    await waitFor(() => expect(screen.queryByText("Open System Settings")).toBeNull());
  });

  it("stays quiet when the sidecar is not running", async () => {
    stubScreenStatus({ running: false, state: "not_started", settingsUrl: SETTINGS_URL });
    const { container } = render(<AccessibilityOnboarding />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
