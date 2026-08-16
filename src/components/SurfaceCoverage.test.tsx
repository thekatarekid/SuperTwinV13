// The coverage meter as every surface mounts it (§14.0, "on every surface").
//
// The meter's own three rules are tested in CoverageMeter.test.tsx. What is
// tested here is the wiring: it reads the worker, it repeats, and a failed read
// takes the chrome down rather than the surface.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { SurfaceCoverage } from "./SurfaceCoverage";
import type { CoverageSnapshot, SurfacesClient } from "../lib/surfaces-client";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const snapshot = (done: number): CoverageSnapshot => ({
  mode: "bootstrap",
  rows: [{ horizon: "d30", totalUnits: 800, doneUnits: done }],
  pausedLabel: null,
  remainingMinutes: 14,
});

const clientWith = (getCoverage: SurfacesClient["getCoverage"]) =>
  ({ getCoverage } as unknown as SurfacesClient);

describe("SurfaceCoverage", () => {
  it("renders the meter from the worker's snapshot", async () => {
    render(<SurfaceCoverage client={clientWith(vi.fn(async () => snapshot(568)))} pollMs={0} />);

    expect(await screen.findByLabelText("Understanding your history")).toBeTruthy();
    expect(screen.getByText(/30d ▓▓▓░ 71%/)).toBeTruthy();
    expect(screen.getByText(/~14 min remaining/)).toBeTruthy();
  });

  it("renders a paused lane loudly (§14.0 rule 2)", async () => {
    const paused = { ...snapshot(568), pausedLabel: "paused — rate limit, resumes in 04:12" };
    render(<SurfaceCoverage client={clientWith(vi.fn(async () => paused))} pollMs={0} />);

    expect((await screen.findByRole("status")).textContent).toBe(
      "paused — rate limit, resumes in 04:12",
    );
  });

  it("keeps polling, and the meter moves forwards", async () => {
    vi.useFakeTimers();
    const getCoverage = vi
      .fn<SurfacesClient["getCoverage"]>()
      .mockResolvedValueOnce(snapshot(568))
      .mockResolvedValue(snapshot(800));

    render(<SurfaceCoverage client={clientWith(getCoverage)} pollMs={1000} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/30d ▓▓▓░ 71%/)).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(screen.getByText(/30d ✓/)).toBeTruthy();
  });

  it("renders nothing when the worker cannot be read — chrome never takes a surface down", async () => {
    const { container } = render(
      <SurfaceCoverage
        client={clientWith(
          vi.fn(async () => {
            throw new Error("worker offline");
          }),
        )}
        pollMs={0}
      />,
    );

    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
