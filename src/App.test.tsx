// Smoke test for the P0.3 placeholder shell: it renders, shows the app name,
// and polls the worker's /api/health through workerUrl(). The real V13 UI
// suites arrive with the P1/P4 rebuild.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { workerUrl } from "./lib/config";

describe("placeholder shell", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({ status: "ok", version: "13.0.0" }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the app name and reports worker health from /api/health", async () => {
    render(<App />);
    expect(screen.getByText("SuperTwinV13")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("worker ok · v13.0.0")).toBeTruthy();
    });
    expect(fetch).toHaveBeenCalledWith(workerUrl("/api/health"));
  });

  it("points at the worker's 8013 default base URL", () => {
    expect(workerUrl("/api/health")).toBe("http://localhost:8013/api/health");
  });
});
