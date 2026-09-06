// ===========================================================================
// The halt banner ON LAUNCH (V6 P1 S6e · E2).
//
// The budget latch survives restart by design (SPD-02), so a latched home
// relaunches latched — and the relaunch is precisely when the worker may not
// be listening yet. C3 made the banner render on every tab; it still had one
// blind spot: if the FIRST /api/ops/spend read failed, `unknown` correctly
// rendered nothing and the next attempt was thirty seconds away. For half a
// minute after launch, a hard-stopped app looked healthy.
//
// So: until the first answer arrives the banner re-asks quickly, and only
// then settles into the poll. Zero network, zero worker, zero model calls.
// ===========================================================================

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HALT_FIRST_ANSWER_RETRY_MS, HALT_POLL_MS, HaltBanner } from "./components/HaltBanner";
import type { SpendStatus } from "./lib/api";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The two rows the user's own install still carries. */
const LATCHED: SpendStatus = {
  trippedAt: "2026-09-06T17:38:06.843Z",
  trippedReason: "$3.07 spent in the last hour (ceiling $3)",
  modelActivityPausedAt: null,
  hour: { calls: 144, usd: 3.07 },
  day: { calls: 302, usd: 6.2 },
  ceilings: { usdPerCall: 0.5, usdPerHour: 3, usdPerDay: 15, callsPerHour: 400, callsPerDay: 3000 },
};

describe("E2 — a latched home says so at launch, not thirty seconds later", () => {
  it("re-asks fast until the worker answers, then shows the halt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path !== "/api/ops/spend") return { ok: false, status: 404, json: async () => ({}) };
        attempts += 1;
        // The worker is still booting for the first two reads — the real shape
        // of a relaunch, not a hypothetical.
        if (attempts < 3) throw new TypeError("Failed to fetch");
        return { ok: true, status: 200, json: async () => LATCHED };
      }),
    );

    render(<HaltBanner />);
    // Nothing is claimed while the answer is unknown.
    await waitFor(() => expect(attempts).toBe(1));
    expect(screen.queryByLabelText("pipeline halted")).toBeNull();

    await vi.advanceTimersByTimeAsync(HALT_FIRST_ANSWER_RETRY_MS * 2 + 100);

    expect(attempts).toBeGreaterThanOrEqual(3);
    const banner = await screen.findByLabelText("pipeline halted");
    expect(banner.textContent).toContain("Understanding is paused");
    expect(banner.textContent).toContain("$3.07 spent in the last hour (ceiling $3)");
    expect((screen.getByRole("button", { name: "Resume background work" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("once it has an answer it settles into the poll, not the retry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path !== "/api/ops/spend") return { ok: false, status: 404, json: async () => ({}) };
        attempts += 1;
        return { ok: true, status: 200, json: async () => LATCHED };
      }),
    );

    render(<HaltBanner />);
    await screen.findByLabelText("pipeline halted");
    expect(attempts).toBe(1);

    // Well past the fast retry, nowhere near the poll: still one read.
    await vi.advanceTimersByTimeAsync(HALT_FIRST_ANSWER_RETRY_MS * 3);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(HALT_POLL_MS);
    expect(attempts).toBe(2);
  });

  it("the retry is an order of magnitude faster than the poll", () => {
    expect(HALT_FIRST_ANSWER_RETRY_MS).toBeLessThan(HALT_POLL_MS / 5);
  });
});
