// ===========================================================================
// Library › Screen — the three gates (V6 P1 S6d / L4) · defect regression.
//
// SHIPPED 13.11.5 BUG. Screen capture could not be switched on at all:
//
//   * nothing ever ASKED macOS for Accessibility (every path called the
//     prompt-free `AXIsProcessTrusted`), so SuperTwin was not in System
//     Settings › Privacy & Security › Accessibility — the user's screenshot of
//     that pane shows a long list of apps and no SuperTwin. "Open System
//     Settings" opened a pane with no row to switch on;
//   * the consent row and the explicit "Record from now on" — which is what
//     actually spawns the sidecar — had no interface anywhere.
//
// These tests pin the fixed contract: the button ASKS before it opens Settings,
// the ladder shows the rung the worker actually reports, the poll flips the
// panel without a restart, and a poll never asks.
// ===========================================================================

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ScreenGate,
  ScreenGateNotice,
  permissionReasonLine,
  screenGateStep,
} from "./screens/library/ScreenGate";
import type { ScreenStatus } from "./lib/api";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

function status(over: Partial<ScreenStatus> = {}): ScreenStatus {
  return {
    running: false,
    state: "not_started",
    consent: false,
    permission: false,
    recordFrom: null,
    settingsUrl: SETTINGS_URL,
    ...over,
  };
}

/** Record every fetch, and answer each path from a mutable holder. */
function stubFetch(routes: Record<string, () => unknown>): {
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      const path = new URL(url, "http://127.0.0.1:8013").pathname;
      const fn = routes[path];
      if (!fn) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => fn() };
    }),
  );
  return { calls };
}

beforeEach(() => {
  invoke.mockReset();
  // Inside Tauri by default: the host app is the identity that asks.
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("screenGateStep — the rung is read, never assumed", () => {
  it("walks consent → permission → record → capturing", () => {
    expect(screenGateStep(null)).toBe("consent");
    expect(screenGateStep(status())).toBe("consent");
    expect(screenGateStep(status({ consent: true }))).toBe("permission");
    // A field the worker did not send is unknown, not false: `consent` and
    // `recordFrom` only arrived with S6d, and a pane must not demand a step it
    // has no evidence is outstanding.
    expect(screenGateStep({ running: true, state: "need_permission", permission: false, settingsUrl: "x:" })).toBe(
      "permission",
    );
    expect(screenGateStep({ running: true, state: "capturing", permission: true, settingsUrl: "x:" })).toBe(
      "capturing",
    );
    expect(screenGateStep(status({ consent: true, permission: true }))).toBe("record");
    // Armed but the sidecar is not up: still not capturing, and the panel
    // must not claim it is.
    expect(
      screenGateStep(status({ consent: true, permission: true, recordFrom: "2026-09-06T10:00:00Z" })),
    ).toBe("record");
    expect(
      screenGateStep(
        status({ consent: true, permission: true, recordFrom: "2026-09-06T10:00:00Z", running: true }),
      ),
    ).toBe("capturing");
  });

  it("names a probe that failed for a reason of its own, and stays quiet otherwise", () => {
    expect(permissionReasonLine(status())).toBeNull();
    expect(permissionReasonLine(status({ permissionReason: "denied" }))).toBeNull();
    expect(permissionReasonLine(status({ permissionReason: "binary-missing" }))).toContain("reinstall");
    expect(permissionReasonLine(status({ permissionReason: "timeout" }))).toContain("didn't answer");
  });
});

describe("the Accessibility rung", () => {
  it("ASKS macOS before it opens System Settings — the fix for an empty Accessibility list", async () => {
    const order: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      if (cmd === "request_accessibility") return { trusted: false, prompted: true };
      return undefined;
    });
    stubFetch({ "/api/screen/permission": () => ({ granted: false, reason: "denied", settingsUrl: SETTINGS_URL }) });

    render(<ScreenGate status={status({ consent: true })} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Grant Accessibility" }));

    await waitFor(() => expect(order).toContain("open_external"));
    // The order IS the fix: opening the pane first is what showed the user a
    // list of other apps with no SuperTwin row in it.
    expect(order).toEqual(["request_accessibility", "open_external"]);
    expect(invoke).toHaveBeenCalledWith("open_external", { url: SETTINGS_URL });
  });

  it("falls back to the worker's ask when the shell predates the command — same TCC row either way", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "request_accessibility") throw new Error("unknown command");
      return undefined;
    });
    const { calls } = stubFetch({
      "/api/screen/request-permission": () => ({ granted: false, reason: "denied", prompted: true, settingsUrl: SETTINGS_URL }),
      "/api/screen/permission": () => ({ granted: false, reason: "denied", settingsUrl: SETTINGS_URL }),
    });

    render(<ScreenGate status={status({ consent: true })} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Grant Accessibility" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/screen/request-permission") && c.method === "POST")).toBe(true),
    );
  });

  it("polls the real trust state after asking, so the switch lands without a restart — and the poll never asks", async () => {
    vi.useFakeTimers();
    try {
      invoke.mockResolvedValue({ trusted: false, prompted: true });
      const granted = { value: false };
      const { calls } = stubFetch({
        "/api/screen/permission": () => ({
          granted: granted.value,
          reason: granted.value ? "granted" : "denied",
          settingsUrl: SETTINGS_URL,
        }),
      });
      const changed = vi.fn();

      render(<ScreenGate status={status({ consent: true })} onChanged={changed} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Grant Accessibility" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(invoke).toHaveBeenCalledWith("open_external", { url: SETTINGS_URL });
      changed.mockClear();

      // The user switches the row on in System Settings.
      granted.value = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(changed).toHaveBeenCalled();
      // A poll reads; it never puts a dialog up.
      expect(calls.every((c) => !c.url.includes("request-permission"))).toBe(true);
      expect(invoke).not.toHaveBeenCalledWith("request_accessibility", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll before the user has asked — an idle sub-tab probes nothing", async () => {
    vi.useFakeTimers();
    try {
      const { calls } = stubFetch({
        "/api/screen/permission": () => ({ granted: false, reason: "denied", settingsUrl: SETTINGS_URL }),
      });
      render(<ScreenGate status={status({ consent: true })} onChanged={() => {}} />);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the other two rungs", () => {
  it("gate 1 writes the consent row live-only: index everything, understand from now", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
        void url;
        return { ok: true, status: 200, json: async () => ({ consent: {}, card: {}, change: "granted" }) };
      }),
    );
    const before = Date.now();

    render(<ScreenGate status={status()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow screen capture" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const body = bodies[0] as Record<string, unknown>;
    expect(body.source).toBe("screen");
    expect(body.index_all).toBe(true);
    // Screen is live only (Product_V6_Phase1 §4): understanding starts now and
    // never reaches backwards.
    expect(Date.parse(String(body.understand_from))).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("gate 3 is its own deliberate press — a granted permission does not start recording by itself", async () => {
    const { calls } = stubFetch({ "/api/screen/record": () => ({ ok: true, recordFrom: "2026-09-06T10:00:00Z", running: true }) });

    render(<ScreenGate status={status({ consent: true, permission: true })} onChanged={() => {}} />);
    // Nothing has been recorded merely because the permission landed.
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Record from now on" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Record from now on" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/screen/record") && c.method === "POST")).toBe(true),
    );
  });

  it("renders nothing once capture is actually running", () => {
    const running = status({
      consent: true,
      permission: true,
      recordFrom: "2026-09-06T10:00:00Z",
      running: true,
      state: "capturing",
    });
    const { container } = render(<ScreenGate status={running} onChanged={() => {}} />);
    expect(container.firstChild).toBeNull();
    const notice = render(<ScreenGateNotice status={running} onChanged={() => {}} />);
    expect(notice.container.firstChild).toBeNull();
  });

  it("the one-line notice offers the SAME outstanding step, so old captures stay visible", () => {
    render(<ScreenGateNotice status={status({ consent: true })} onChanged={() => {}} />);
    expect(screen.getByText(/Capture is blocked/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Grant Accessibility" })).toBeTruthy();
  });
});
