// ===========================================================================
// Freshness chip (spec §5.4 / §14.2) — what the header actually SAYS.
//
// The defect this pins: 13.4.1 threw the "Knows you: …" headline away and
// showed a bare "catching up — 236 min behind" that grew by a minute a minute
// (it was measuring an imported-history queue, plus leaked eval rows). And a
// perfectly caught-up twin showed no state at all.
//
// So: a settled system must SAY "up to date"; a lagging one keeps its identity
// line and states the lag; and a history import reads as a shrinking count,
// never as minutes "behind".
// ===========================================================================

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FreshnessChip } from "./components/FreshnessChip";
import type { FreshnessOverview, FreshnessStatus, SourceFreshness } from "./lib/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function source(over: Partial<SourceFreshness> = {}): SourceFreshness {
  return {
    source_id: "whatsapp",
    captured_from: "2024-01-05T00:00:00.000Z",
    captured_to: "2026-08-28T11:58:00.000Z",
    understood_from: "2024-01-05T00:00:00.000Z",
    understood_to: "2026-08-28T11:58:00.000Z",
    event_count: 10,
    understood_count: 10,
    pending_count: 0,
    pending_live_count: 0,
    pending_backfill_count: 0,
    lag_minutes: null,
    backfill_complete: true,
    understood_percent: 100,
    label: "Knows you: 2024 → 2 min ago",
    status: "up_to_date",
    status_label: "up to date",
    detail: "capturing live ✓ · understanding: caught up",
    ...over,
  };
}

function stubFreshness(over: Partial<FreshnessOverview> = {}): void {
  const body: FreshnessOverview = {
    sources: [source()],
    label: "Knows you: 2024 → 2 min ago",
    lag_minutes: null,
    status: "up_to_date",
    status_label: "up to date",
    pending_live_count: 0,
    pending_backfill_count: 0,
    ...over,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
  );
}

async function chip(): Promise<HTMLElement> {
  render(<FreshnessChip />);
  return await waitFor(() => screen.getByLabelText("freshness"));
}

describe("FreshnessChip", () => {
  it("THE SETTLED STATE: a caught-up twin says so", async () => {
    stubFreshness();
    const el = await chip();
    expect(el.textContent).toContain("Knows you: 2024 → 2 min ago");
    expect(el.textContent).toContain("up to date");
    expect(el.className).toContain("freshness-up_to_date");
    expect(el.className).not.toContain("lagging");
  });

  it("keeps the identity line while stating the lag", async () => {
    stubFreshness({
      lag_minutes: 14,
      status: "catching_up",
      status_label: "catching up — 14 min behind",
      pending_live_count: 3,
      sources: [
        source({
          lag_minutes: 14,
          status: "catching_up",
          status_label: "catching up — 14 min behind",
          pending_live_count: 3,
          pending_count: 3,
          detail: "capturing live ✓ · catching up — 14 min behind",
        }),
      ],
    });
    const el = await chip();
    // 13.4.1 dropped this half entirely.
    expect(el.textContent).toContain("Knows you: 2024 → 2 min ago");
    expect(el.textContent).toContain("catching up — 14 min behind");
    expect(el.className).toContain("lagging");
    expect(el.getAttribute("title")).toContain("catching up — 14 min behind");
  });

  it("REGRESSION: a history import is a shrinking count, not minutes behind", async () => {
    stubFreshness({
      status: "importing_history",
      status_label: "importing history — 2,569 events left",
      pending_backfill_count: 2569,
      sources: [
        source({
          status: "importing_history",
          status_label: "importing history — 2,569 events left",
          pending_backfill_count: 2569,
          pending_count: 2569,
          backfill_complete: false,
          understood_percent: 21,
        }),
      ],
    });
    const el = await chip();
    expect(el.textContent).toContain("importing history — 2,569 events left");
    expect(el.textContent).not.toMatch(/behind/);
    expect(el.className).not.toContain("lagging");
  });

  it("shows the state alone when nothing is understood yet", async () => {
    stubFreshness({
      label: null,
      status: "importing_history",
      status_label: "importing history — 40 events left",
      pending_backfill_count: 40,
      sources: [source({ label: null, understood_from: null, understood_to: null })],
    });
    const el = await chip();
    expect(el.textContent).toBe("importing history — 40 events left");
  });

  it("renders nothing at all when the log is empty", async () => {
    stubFreshness({ sources: [], label: null, status: "no_data" as FreshnessStatus, status_label: "nothing captured yet" });
    render(<FreshnessChip />);
    await waitFor(() => expect(screen.queryByLabelText("freshness")).toBeNull());
  });

  it("FIX-C5: a stopped pipeline reads as stopped, and reads loud", async () => {
    // The reporting user's live state: the $3/hour ceiling latched at
    // 15:12:59Z, every call refused before spawn ever since, 11,015 events
    // waiting — and this chip said "importing history", with a hover detail
    // that ended "understanding: caught up".
    stubFreshness({
      status: "paused",
      status_label: "understanding paused — spend ceiling reached",
      pending_backfill_count: 11_015,
      hold: {
        kind: "budget",
        label: "understanding paused — spend ceiling reached",
        detail: "$3.05 spent in the last hour (ceiling $3). Reset it in Settings › General.",
        since: "2026-09-06T15:12:59.534Z",
        until_ms: null,
      },
      sources: [
        source({
          status: "paused",
          status_label: "understanding paused — spend ceiling reached",
          pending_backfill_count: 6618,
          pending_count: 6618,
          backfill_complete: false,
          detail: "capturing live ✓ · understanding paused — spend ceiling reached",
        }),
        source({
          source_id: "browser",
          status: "paused",
          status_label: "understanding paused — spend ceiling reached",
          pending_backfill_count: 4367,
          pending_count: 4367,
          backfill_complete: false,
          detail: "capturing live ✓ · understanding paused — spend ceiling reached",
        }),
      ],
    });
    const el = await chip();
    expect(el.textContent).toContain("understanding paused — spend ceiling reached");
    expect(el.textContent).not.toContain("caught up");
    expect(el.textContent).not.toContain("up to date");
    // A hold is one fact about the whole pipeline, not a sum over sources.
    expect(el.textContent).not.toContain("across 2 sources");
    expect(el.className).toContain("freshness-paused");
    expect(el.className).toContain("lagging");
    expect(el.getAttribute("title")).not.toContain("caught up");
  });

  it("renders nothing when the worker is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("worker down");
      }),
    );
    render(<FreshnessChip />);
    await waitFor(() => expect(screen.queryByLabelText("freshness")).toBeNull());
  });
});
