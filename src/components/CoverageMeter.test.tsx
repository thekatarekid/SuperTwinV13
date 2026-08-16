// The coverage meter (arch §14.0).
//
// Its three rules are its three tests: monotonic, loud when paused, absent in
// a quiet steady state.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CoverageMeter, type CoverageRow } from "./CoverageMeter";

afterEach(cleanup);

const rows = (over: Partial<Record<string, [number, number]>> = {}): CoverageRow[] =>
  (
    [
      ["live", [10, 10]],
      ["h24", [40, 40]],
      ["d7", [200, 200]],
      ["d30", [800, 568]],
      ["d90", [900, 0]],
    ] as const
  ).map(([horizon, pair]) => {
    const [total, done] = over[horizon] ?? pair;
    return { horizon, totalUnits: total, doneUnits: done } as CoverageRow;
  });

describe("the coverage meter", () => {
  it("renders each horizon: done, partial with a percentage, queued", () => {
    render(<CoverageMeter rows={rows()} mode="bootstrap" remainingMinutes={14} />);
    expect(screen.getByText(/live ✓/)).toBeTruthy();
    expect(screen.getByText(/30d ▓▓▓░ 71%/)).toBeTruthy();
    expect(screen.getByText(/90d ░ queued/)).toBeTruthy();
    expect(screen.getByText(/818 of 1,950 events/)).toBeTruthy();
    expect(screen.getByText(/~14 min remaining/)).toBeTruthy();
    expect(screen.getByText(/newest first/)).toBeTruthy();
  });

  it("NEVER goes backwards when a stale poll arrives (§14.0 rule 1)", () => {
    const { rerender } = render(<CoverageMeter rows={rows()} mode="bootstrap" />);
    expect(screen.getByText(/30d ▓▓▓░ 71%/)).toBeTruthy();

    rerender(<CoverageMeter rows={rows({ d30: [800, 100] })} mode="bootstrap" />);
    expect(screen.getByText(/30d ▓▓▓░ 71%/)).toBeTruthy();
    expect(screen.queryByText(/30d .* 13%/)).toBeNull();
  });

  it("still moves forwards", () => {
    const { rerender } = render(<CoverageMeter rows={rows()} mode="bootstrap" />);
    rerender(<CoverageMeter rows={rows({ d30: [800, 800] })} mode="bootstrap" />);
    expect(screen.getByText(/30d ✓/)).toBeTruthy();
  });

  it("says it is paused and counts down (§14.0 rule 2)", () => {
    render(
      <CoverageMeter rows={rows()} mode="bootstrap" pausedLabel="paused — rate limit, resumes in 04:12" />,
    );
    expect(screen.getByRole("status").textContent).toBe("paused — rate limit, resumes in 04:12");
  });

  it("disappears in steady state once nothing is outstanding (§14.0 rule 3)", () => {
    const done: CoverageRow[] = [{ horizon: "live", totalUnits: 10, doneUnits: 10 }];
    const { container } = render(<CoverageMeter rows={done} mode="steady" />);
    expect(container.firstChild).toBeNull();
  });

  it("stays visible in steady state while a backlog exists", () => {
    render(<CoverageMeter rows={rows()} mode="steady" />);
    expect(screen.getByLabelText("Understanding your history")).toBeTruthy();
  });

  it("omits the remaining estimate until a rate has been measured", () => {
    render(<CoverageMeter rows={rows()} mode="bootstrap" remainingMinutes={null} />);
    expect(screen.queryByText(/min remaining/)).toBeNull();
  });
});
