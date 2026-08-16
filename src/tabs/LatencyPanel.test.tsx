// The latency panel (build item 4.2) — the minimal ops read over
// GET /api/latency until item 4.4's fuller surface.
//
// What matters here: the panel renders the WORKER's numbers (budgets ride
// along in the payload, nothing hardcoded client-side), a breach reads as a
// breach, and an offline worker degrades to a dash — never to a fake pass.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LatencyPanel } from "./LatencyPanel";
import type { LatencyInfo } from "../lib/worker-client";

afterEach(cleanup);

const INFO: LatencyInfo = {
  calls: [
    {
      model: "opus",
      callType: "P-CL1",
      calls: 12,
      callsWithTtft: 12,
      worstTtftMs: 4_400,
      worstTotalMs: 16_000,
      minTokensPerSecond: 40,
      lastAt: "2026-08-15T12:00:00.000Z",
    },
  ],
  milestones: [
    { name: "first_claim", value: 17_500, budget: 30_000, unit: "ms", met: true, at: "2026-08-15T12:00:00.000Z" },
    { name: "silent_gap", value: 96_000, budget: 90_000, unit: "ms", met: false, at: "2026-08-15T12:00:00.000Z" },
    { name: "steady_calls", value: 9, budget: 12, unit: "calls", met: true, at: "2026-08-15T12:00:00.000Z" },
  ],
  ttftCoverage: 1,
  budgets: {
    firstClaimMs: 30_000,
    spacesTasksMs: 120_000,
    silentGapMs: 90_000,
    steadyCallsPerDay: 12,
    visibilitySlackMs: 15_000,
  },
  steady: { callsLast24h: 9, budget: 12, met: true },
};

describe("LatencyPanel", () => {
  it("renders milestones graded by the mark's own budget — a breach says BREACH", async () => {
    render(<LatencyPanel getLatencyFn={vi.fn().mockResolvedValue(INFO)} />);
    await waitFor(() => expect(screen.getByTestId("latency-milestones")).toBeTruthy());

    expect(screen.getByTestId("milestone-first_claim").textContent).toBe("within budget");
    expect(screen.getByTestId("milestone-silent_gap").textContent).toBe("BREACH");
    expect(screen.getByTestId("milestone-steady_calls").textContent).toBe("within budget");
    // Values render beside the budget they were graded against.
    expect(screen.getByText(/17\.5 s against 30\.0 s/)).toBeTruthy();
    expect(screen.getByText(/9 calls against 12 calls/)).toBeTruthy();
  });

  it("renders the per-(model, call type) worst-case table and the daily ledger", async () => {
    render(<LatencyPanel getLatencyFn={vi.fn().mockResolvedValue(INFO)} />);
    await waitFor(() => expect(screen.getByTestId("latency-calls")).toBeTruthy());

    const table = screen.getByTestId("latency-calls");
    expect(table.textContent).toContain("P-CL1");
    expect(table.textContent).toContain("opus");
    expect(table.textContent).toContain("4.4 s"); // worst TTFT, not a mean
    expect(table.textContent).toContain("16.0 s");
    expect(table.textContent).toContain("40");
    expect(screen.getByTestId("latency-steady").textContent).toContain("9 of 12 budgeted");
  });

  it("says OVER BUDGET when the ledger blew the quiet-day number", async () => {
    const over: LatencyInfo = { ...INFO, steady: { callsLast24h: 40, budget: 12, met: false } };
    render(<LatencyPanel getLatencyFn={vi.fn().mockResolvedValue(over)} />);
    await waitFor(() =>
      expect(screen.getByTestId("latency-steady").textContent).toContain("OVER BUDGET"),
    );
  });

  it("shows the budgets when nothing has been measured — never a fabricated pass", async () => {
    const empty: LatencyInfo = { ...INFO, calls: [], milestones: [] };
    render(<LatencyPanel getLatencyFn={vi.fn().mockResolvedValue(empty)} />);
    await waitFor(() => expect(screen.getByTestId("latency-no-milestones")).toBeTruthy());
    expect(screen.getByTestId("latency-no-milestones").textContent).toContain("30.0 s");
    expect(screen.getByText("No calls recorded yet.")).toBeTruthy();
  });

  it("degrades to an offline note when the worker is unreachable", async () => {
    render(<LatencyPanel getLatencyFn={vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))} />);
    await waitFor(() =>
      expect(screen.getByText("Worker offline — no latency data.")).toBeTruthy(),
    );
  });
});
