// ===========================================================================
// The nudge card — V6 P1 S4.3 (Product_V6_Phase1 §18.3, Product_V6 §14.4.1).
// Component tests against a stubbed worker; the Tauri IPC is a no-op outside
// the webview by design (lib/tauri.ts), so these run headless.
//
// What is asserted here is the CARD: its anatomy, its 60-second auto-close,
// the unread counter that makes closing free, and the fact that it goes up
// once. WHERE anything goes is the router's, in the worker (surfaces/
// router.ts + the NUD cases), and this window never second-guesses it.
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Nudge } from "./Nudge";
import type { NudgeCardView, NudgeView } from "../lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const card = (over: Partial<NudgeCardView> = {}): NudgeCardView => ({
  id: "art_villas",
  kind: "help_now",
  title: "Goa trip",
  line: "villa comparison",
  peek: "Villa Sol ₹5.4k · pool · 6 beds",
  intent: "Saw you comparing Anjuna villas",
  spaceId: "sp_goa_dec",
  mergedWith: [],
  autoCloseAtMs: 0,
  ...over,
});

const view = (over: Partial<NudgeView> = {}): NudgeView => ({
  presence: "mac_active",
  card: card(),
  unread: 0,
  cardDurationMs: 60_000,
  routed: [],
  ...over,
});

function stubFetch(routes: Record<string, unknown>) {
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? "GET" });
      if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => routes[path] };
    }),
  );
  return calls;
}

describe("the card's anatomy", () => {
  it("renders space chip → intent → what I did → peek → Open / Not now / ✕", async () => {
    stubFetch({ "/api/surfaces/nudge": view(), "/api/surfaces/nudge/art_villas/shown": { unread: 1 } });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByTestId("nudge")).toBeTruthy());
    const el = screen.getByTestId("nudge");
    expect(el.textContent).toContain("Goa trip");
    expect(el.textContent).toContain("Saw you comparing Anjuna villas");
    expect(el.textContent).toContain("villa comparison");
    expect(el.textContent).toContain("Villa Sol ₹5.4k");
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("Not now")).toBeTruthy();
    expect(screen.getByLabelText("close")).toBeTruthy();
  });

  it("shows a merged card as one glance, with how many updates it carries", async () => {
    stubFetch({
      "/api/surfaces/nudge": view({
        card: card({ line: "villa comparison · Karan replied · fare dropped", mergedWith: ["art_karan", "art_fare"] }),
      }),
      "/api/surfaces/nudge/art_villas/shown": { unread: 1 },
    });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByTestId("nudge")).toBeTruthy());
    const el = screen.getByTestId("nudge");
    expect(el.textContent).toContain("villa comparison · Karan replied · fare dropped");
    expect(el.textContent).toContain("3 updates");
  });

  it("renders nothing at all when the router has no card (away, blocked, below the floor)", async () => {
    stubFetch({ "/api/surfaces/nudge": view({ card: null, presence: "away", unread: 2 }) });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByTestId("nudge-empty")).toBeTruthy());
    expect(screen.queryByTestId("nudge")).toBeNull();
    // The counter still shows: cards shown but not opened.
    expect(screen.getByTestId("nudge-empty").getAttribute("data-unread")).toBe("2");
  });
});

describe("the card counts as unread the moment it goes up", () => {
  it("tells the worker it was shown", async () => {
    const calls = stubFetch({ "/api/surfaces/nudge": view(), "/api/surfaces/nudge/art_villas/shown": { unread: 1 } });
    render(<Nudge />);
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/surfaces/nudge/art_villas/shown" && c.method === "POST")).toBe(true),
    );
  });
});

describe("auto-close costs a glance and loses nothing", () => {
  it("closes itself after the card duration and keeps the artifact", async () => {
    vi.useFakeTimers();
    const calls = stubFetch({
      "/api/surfaces/nudge": view(),
      "/api/surfaces/nudge/art_villas/shown": { unread: 1 },
      "/api/surfaces/nudge/art_villas/auto-close": { unread: 1 },
    });
    render(<Nudge />);
    await vi.waitFor(() => expect(screen.getByTestId("nudge")).toBeTruthy());
    await vi.advanceTimersByTimeAsync(59_000);
    expect(screen.queryByTestId("nudge")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(screen.queryByTestId("nudge")).toBeNull());
    expect(calls.some((c) => c.path === "/api/surfaces/nudge/art_villas/auto-close")).toBe(true);
  });

  it("the ✕ is the same close — kept, not deleted", async () => {
    const calls = stubFetch({
      "/api/surfaces/nudge": view(),
      "/api/surfaces/nudge/art_villas/shown": { unread: 1 },
      "/api/surfaces/nudge/art_villas/auto-close": { unread: 1 },
    });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByTestId("nudge")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("close"));
    await waitFor(() => expect(screen.queryByTestId("nudge")).toBeNull());
    expect(calls.some((c) => c.path === "/api/surfaces/nudge/art_villas/auto-close")).toBe(true);
  });

  it("goes up once — a re-poll of the same card never re-pops", async () => {
    vi.useFakeTimers();
    stubFetch({
      "/api/surfaces/nudge": view(),
      "/api/surfaces/nudge/art_villas/shown": { unread: 1 },
      "/api/surfaces/nudge/art_villas/auto-close": { unread: 1 },
    });
    render(<Nudge />);
    await vi.waitFor(() => expect(screen.getByTestId("nudge")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("close"));
    await vi.waitFor(() => expect(screen.queryByTestId("nudge")).toBeNull());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(screen.queryByTestId("nudge")).toBeNull();
  });
});

describe("Open and Not now", () => {
  it("Open clears the dot and raises the app", async () => {
    const calls = stubFetch({
      "/api/surfaces/nudge": view(),
      "/api/surfaces/nudge/art_villas/shown": { unread: 1 },
      "/api/surfaces/nudge/art_villas/opened": { unread: 0 },
    });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByText("Open")).toBeTruthy());
    fireEvent.click(screen.getByText("Open"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/surfaces/nudge/art_villas/opened")).toBe(true));
    expect(screen.queryByTestId("nudge")).toBeNull();
  });

  it("'Not now' ranks the kind down and parks the work", async () => {
    const calls = stubFetch({
      "/api/surfaces/nudge": view(),
      "/api/surfaces/nudge/art_villas/shown": { unread: 1 },
      "/api/surfaces/nudge/art_villas/not-now": { unread: 0, dismissals: 1 },
    });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
    fireEvent.click(screen.getByText("Not now"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/surfaces/nudge/art_villas/not-now")).toBe(true));
    expect(screen.queryByTestId("nudge")).toBeNull();
    // "Not now" is not a close: it never counts as unread.
    expect(calls.some((c) => c.path === "/api/surfaces/nudge/art_villas/auto-close")).toBe(false);
  });
});
