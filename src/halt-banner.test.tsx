// ===========================================================================
// The halt banner (V6 P1 S6d · C3) — the trip must be visible where the user
// already is.
//
// THE DEFECT THIS PINS. On the user's 13.11.5 install the budget latch had
// been set for hours: understanding was hard-stopped and every call refused
// before spawn. The whole product said so in exactly one place — Settings ›
// General, behind an 11-second read the user reported as "stuck on loading" —
// while Home said "nothing needs you right now". So: a latched budget (or the
// kill switch) shows up on the tab the user is actually on, names the reason,
// and carries the control that ends it.
//
// Zero network, zero worker, zero model calls: `fetch` is stubbed.
// ===========================================================================

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { formatWhen, HaltBanner } from "./components/HaltBanner";
import type { SpendStatus } from "./lib/api";
import { homeFixture } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TRIPPED_AT = "2026-09-06T15:12:59.534Z";

function spend(over: Partial<SpendStatus> = {}): SpendStatus {
  return {
    trippedAt: null,
    trippedReason: null,
    modelActivityPausedAt: null,
    hour: { calls: 0, usd: 0 },
    day: { calls: 0, usd: 0 },
    ceilings: { usdPerCall: 0.5, usdPerHour: 3, usdPerDay: 15, callsPerHour: 400, callsPerDay: 3000 },
    ...over,
  };
}

/** The user's own steady state: latched, and the hour window still hot. */
const LATCHED = spend({
  trippedAt: TRIPPED_AT,
  trippedReason: "$3.05 spent in the last hour (ceiling $3)",
  hour: { calls: 144, usd: 3.05 },
  day: { calls: 144, usd: 3.11 },
});

interface Stub {
  calls: { path: string; method: string }[];
  routes: Map<string, unknown>;
}

/** Everything the shell asks for on mount, with a settable /api/ops/spend. */
function stubShell(spendBody: SpendStatus | "fail"): Stub {
  const stub: Stub = { calls: [], routes: new Map() };
  stub.routes.set("/api/home", homeFixture);
  stub.routes.set("/api/artifacts", { artifacts: [] });
  // What the other tabs ask for, so switching tab exercises the banner rather
  // than a screen's own empty-read handling.
  stub.routes.set("/api/timeline", { rows: [], next_before: null });
  stub.routes.set("/api/timeline/days", { days: [], sources: [] });
  stub.routes.set("/api/spaces/list", { areas: [], dormant: [] });
  if (spendBody !== "fail") stub.routes.set("/api/ops/spend", spendBody);
  stub.routes.set("/api/ops/budget/reset", spend());
  stub.routes.set("/api/ops/model-activity", spend());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      stub.calls.push({ path, method: init?.method ?? "GET" });
      if (path === "/api/ops/spend" && spendBody === "fail") throw new TypeError("Failed to fetch");
      if (!stub.routes.has(path)) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      return { ok: true, status: 200, json: async () => stub.routes.get(path) };
    }),
  );
  return stub;
}

describe("C3 — a halted pipeline announces itself", () => {
  it("the budget latch is on Home, with the reason and the way out", async () => {
    stubShell(LATCHED);
    render(<App />);
    const banner = await screen.findByLabelText("pipeline halted");
    expect(banner.textContent).toContain("Understanding is paused");
    // The reason the worker latched, verbatim — not a generic "paused".
    expect(banner.textContent).toContain("$3.05 spent in the last hour (ceiling $3)");
    // What still works, so the user does not read this as "the app is dead".
    expect(banner.textContent).toContain("The bar still answers");
    expect(screen.getByRole("button", { name: "Resume background work" })).toBeTruthy();
  });

  it("it is on EVERY tab, not just Home — the halt does not depend on where you are", async () => {
    stubShell(LATCHED);
    render(<App />);
    await screen.findByLabelText("pipeline halted");
    for (const tab of ["◷ Timeline", "◈ Spaces", "▤ Library", "⚙ Settings"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(screen.getByLabelText("pipeline halted").textContent).toContain("Understanding is paused");
    }
  });

  it("Resume clears the latch through the worker and the banner goes away", async () => {
    const stub = stubShell(LATCHED);
    render(<App />);
    await screen.findByLabelText("pipeline halted");
    fireEvent.click(screen.getByRole("button", { name: "Resume background work" }));
    await waitFor(() => expect(screen.queryByLabelText("pipeline halted")).toBeNull());
    const reset = stub.calls.filter((c) => c.path === "/api/ops/budget/reset");
    expect(reset).toHaveLength(1);
    expect(reset[0]!.method).toBe("POST");
  });

  it("a resume that fails says so and keeps the banner up", async () => {
    const stub = stubShell(LATCHED);
    stub.routes.delete("/api/ops/budget/reset"); // 404 from the worker
    render(<App />);
    await screen.findByLabelText("pipeline halted");
    fireEvent.click(screen.getByRole("button", { name: "Resume background work" }));
    await waitFor(() => expect(screen.getByLabelText("pipeline halted").textContent).toContain("failed"));
    expect(screen.getByLabelText("pipeline halted").textContent).toContain("Understanding is paused");
  });

  it("a hot hour window is admitted, so a resume that re-trips is not a surprise", async () => {
    stubShell(LATCHED);
    render(<App />);
    const banner = await screen.findByLabelText("pipeline halted");
    expect(banner.textContent).toContain("$3.05 of the $3.00 ceiling");
    // ...and a latch whose window has since rolled off says no such thing.
    cleanup();
    vi.unstubAllGlobals();
    stubShell(spend({ trippedAt: TRIPPED_AT, trippedReason: "402 calls in the last hour (ceiling 400)" }));
    render(<App />);
    const cold = await screen.findByLabelText("pipeline halted");
    expect(cold.textContent).not.toContain("so work may stop again");
  });

  it("the kill switch outranks the latch: it stops the bar too, and says that", async () => {
    stubShell(
      spend({
        modelActivityPausedAt: "2026-09-06T09:00:00.000Z",
        trippedAt: TRIPPED_AT,
        trippedReason: "$3.05 spent in the last hour (ceiling $3)",
      }),
    );
    render(<App />);
    const banner = await screen.findByLabelText("pipeline halted");
    expect(banner.textContent).toContain("Model activity is off");
    expect(banner.textContent).toContain("not the bar");
    expect(screen.getByRole("button", { name: "Turn model activity back on" })).toBeTruthy();
  });

  it("a healthy install shows nothing at all — no banner, no false alarm", async () => {
    stubShell(spend());
    render(<App />);
    await screen.findByText("Book villa"); // Home has rendered
    expect(screen.queryByLabelText("pipeline halted")).toBeNull();
  });

  it("unknown is not a halt, and a failed read never erases one we know about", async () => {
    // The read has not answered: nothing is claimed either way.
    stubShell("fail");
    render(<App />);
    await screen.findByText("Book villa");
    expect(screen.queryByLabelText("pipeline halted")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    // A halt we already have stands until a NEWER answer replaces it: a poll
    // that could not reach the worker is not evidence the trip ended.
    let answered = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/ops/spend") {
          if (answered) throw new TypeError("Failed to fetch");
          answered = true;
          return { ok: true, status: 200, json: async () => LATCHED };
        }
        if (path === "/api/home") return { ok: true, status: 200, json: async () => homeFixture };
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      }),
    );
    const { rerender } = render(<HaltBanner />);
    await screen.findByLabelText("pipeline halted");
    rerender(<HaltBanner />);
    expect(screen.getByLabelText("pipeline halted").textContent).toContain("Understanding is paused");
  });

  it("the time is the reader's, not the worker's UTC string", () => {
    // The user who hit this lives at UTC+5:30. 15:12Z is 20:42 to them, and a
    // banner that says 15:12 is telling them it happened before it did.
    expect(formatWhen(TRIPPED_AT, { timeZone: "Asia/Kolkata" })).toMatch(/8:42|20:42/);
    expect(formatWhen(TRIPPED_AT, { timeZone: "UTC" })).toMatch(/3:12|15:12/);
    expect(formatWhen("not-a-time")).toBe("not-a-time");
  });
});
