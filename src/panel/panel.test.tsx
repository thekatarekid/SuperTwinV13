// ===========================================================================
// P2.3 — menu-bar panel + nudge surfaces (spec §14.7). Component tests with a
// stubbed worker fetch; the Tauri IPC is a no-op outside the webview by
// design (lib/tauri.ts), so these run headless.
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Panel, trayStateFor } from "./Panel";
import { Nudge, peekOf } from "./Nudge";
import { GroundedBar } from "../components/GroundedBar";
import { Home } from "../screens/Home";
import { homeFixture } from "../test-utils";
import type { ArtifactRow, CaptureState, PanelData } from "../lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const artifact = (over: Partial<ArtifactRow> = {}): ArtifactRow => ({
  id: "art_1",
  kind: "comparison",
  title: "Villa comparison — 3 fit budget",
  summary: "compared 6 across 3 sites",
  bodyJson: JSON.stringify({
    sections: [{ tool: "draft", input: "", content: "Villa Sol ₹5.4k ★4.8 · pool · 6 beds" }],
  }),
  intent: "Saw you comparing Anjuna villas",
  reasoning: "5 cross-source events",
  spaceId: "sp_goa",
  taskId: null,
  topicKey: "space:sp_goa",
  producer: "assist",
  status: "new",
  nudgedAt: "2026-08-28T14:41:00Z",
  seenAt: null,
  dismissedAt: null,
  expiresAt: null,
  createdAt: "2026-08-28T14:41:00Z",
  ...over,
});

const panelData = (over: Partial<PanelData> = {}): PanelData => ({
  needs_you: {
    approvals: [{ id: "t1", title: "flights ₹18,340", space_id: null, risk_class: "approve-final" }],
    questions: [{ id: "t2", title: "cab from home or office?", space_id: null }],
  },
  prepared: [
    artifact(),
    artifact({ id: "art_2", status: "seen", producer: "executor", title: "Web check-in done" }),
  ],
  older: [artifact({ id: "art_3", status: "dismissed", title: "Draft reply to Sameer" })],
  nudge: artifact(),
  today: [{ id: "t3", title: "pool payment due", due: "2026-08-28T18:00:00Z" }],
  capture_paused_until: null,
  ...over,
});

const captureState = (over: Partial<CaptureState> = {}): CaptureState => ({
  capturing: true,
  recording: ["browser", "whatsapp"],
  admitted: ["browser", "whatsapp"],
  paused: false,
  private_until: null,
  quick_pause_until: null,
  private_moment_minutes: 15,
  sources: [
    { source: "whatsapp", consent: "connected", running: true, capturing: true },
    { source: "browser", consent: "connected", running: true, capturing: true },
    { source: "screen", consent: null, running: false, capturing: false },
  ],
  ...over,
});

function stubFetch(routes: Record<string, unknown>) {
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? "GET" });
      if (!(path in routes)) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => routes[path] };
    }),
  );
  return calls;
}

describe("Panel (spec §14.7 anatomy)", () => {
  const routes = () => ({
    "/api/assist/panel": panelData(),
    "/api/health": { ok: true, version: "13.2.0", builtThroughPhase: "P2" },
    "/api/artifacts/art_1/seen": { artifact: artifact({ status: "seen" }) },
    "/api/artifacts/art_3/reopen": { artifact: artifact({ id: "art_3", status: "seen" }) },
    "/api/assist/pause": { capture_paused_until: "2026-08-28T15:00:00Z" },
    "/api/capture/state": captureState(),
    "/api/capture/private-moment": { ok: true, private_until: "2026-08-28T15:15:00Z", state: captureState({ paused: true }) },
    "/api/capture/stop": { ok: true, paused: ["browser", "whatsapp"], state: captureState({ capturing: false, recording: [] }) },
    "/api/capture/forget/preview": {
      preview: { minutes: 10, events_deleted: 14, episodes_deleted: 1, spaces_touched: 1, tasks_deleted: 0, claims_deleted: 0 },
    },
    "/api/capture/forget": { report: { minutes: 10, events_deleted: 14, episodes_deleted: 1 } },
  });

  it("renders the fixed order: needs-you, prepared (◆/◇ + ● dot), today, footer", async () => {
    stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByText(/flights ₹18,340/)).toBeTruthy());
    expect(screen.getByLabelText("Needs you").textContent).toContain("cab from home or office?");
    const prepared = screen.getByLabelText("Prepared");
    expect(prepared.textContent).toContain("Villa comparison");
    expect(prepared.textContent).toContain("◆");
    expect(prepared.textContent).toContain("◇");
    // The newest unseen artifact carries the ● new-dot.
    expect(screen.getByTestId("new-dot")).toBeTruthy();
    expect(screen.getByLabelText("Today").textContent).toContain("pool payment due");
    await waitFor(() =>
      expect(screen.getByText("v13.2.0 · built through P2")).toBeTruthy(),
    );
    expect(screen.getByLabelText("mini ask")).toBeTruthy();
  });

  it("keeps dismissed artifacts in the collapsed 'older' drawer — nothing vanishes", async () => {
    stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByText(/older \(dismissed, kept\)/)).toBeTruthy());
    expect(screen.queryByText("Draft reply to Sameer")).toBeNull();
    fireEvent.click(screen.getByText(/older \(dismissed, kept\)/));
    expect(screen.getByText("Draft reply to Sameer")).toBeTruthy();
  });

  it("opening a new artifact marks it seen (clears the dot everywhere)", async () => {
    const calls = stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByText(/Villa comparison/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Villa comparison/));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/artifacts/art_1/seen" && c.method === "POST")).toBe(
        true,
      ),
    );
  });

  it("the ⏸ quick-pause menu posts the chosen window", async () => {
    const calls = stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByLabelText("capture pause")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("capture pause"));
    fireEvent.click(screen.getByText("30 min"));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/assist/pause" && c.method === "POST")).toBe(true),
    );
  });

  it("trayStateFor: ⏸ paused > ● needs-you (counted) > ⏺ recording > ◉ idle", () => {
    expect(trayStateFor(panelData({ capture_paused_until: "x" }))).toEqual({
      state: "paused",
      needsYou: 0,
    });
    expect(trayStateFor(panelData())).toEqual({ state: "needs_you", needsYou: 3 });
    const quiet = panelData({ needs_you: { approvals: [], questions: [] }, nudge: null });
    expect(trayStateFor(quiet)).toEqual({ state: "idle", needsYou: 0 });
    // The glyph is the funnel's answer (T4-9): recording only when a source is
    // admitted and running; paused when a private moment or every-source pause holds.
    expect(trayStateFor(quiet, captureState())).toEqual({ state: "recording", needsYou: 0 });
    expect(trayStateFor(quiet, captureState({ capturing: false, recording: [] }))).toEqual({ state: "idle", needsYou: 0 });
    expect(
      trayStateFor(quiet, captureState({ paused: true, private_until: "2026-08-28T15:15:00Z", capturing: false, recording: [] })),
    ).toEqual({ state: "paused", needsYou: 0 });
    expect(
      trayStateFor(
        quiet,
        captureState({
          capturing: false,
          recording: [],
          admitted: [],
          sources: [
            { source: "whatsapp", consent: "paused", running: false, capturing: false },
            { source: "browser", consent: "paused", running: false, capturing: false },
            { source: "screen", consent: null, running: false, capturing: false },
          ],
        }),
      ),
    ).toEqual({ state: "paused", needsYou: 0 });
    // Needs-you still wins over recording.
    expect(trayStateFor(panelData(), captureState())).toEqual({ state: "needs_you", needsYou: 3 });
  });

  it("shows the real capture line and the ⏺ glyph while something is captured", async () => {
    stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByTestId("capture-line").textContent).toContain("capturing browser, whatsapp"));
    expect(screen.getByLabelText("capture pause").textContent).toContain("⏺");
  });

  it("private moment posts /api/capture/private-moment (15 min, not a setting)", async () => {
    const calls = stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByLabelText("capture pause")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("capture pause"));
    fireEvent.click(screen.getByText("private moment · 15 min"));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/capture/private-moment" && c.method === "POST")).toBe(true),
    );
  });

  it("stop capture posts /api/capture/stop — one click, the funnel closes", async () => {
    const calls = stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByLabelText("capture pause")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("capture pause"));
    fireEvent.click(screen.getByText("stop capture"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/capture/stop" && c.method === "POST")).toBe(true));
  });

  it("forget last 10 min: preview first (14 events, 1 episode), delete only on confirm", async () => {
    const calls = stubFetch(routes());
    render(<Panel />);
    await waitFor(() => expect(screen.getByLabelText("capture pause")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("capture pause"));
    fireEvent.click(screen.getByText(/forget last 10 min/));
    await waitFor(() => expect(screen.getByTestId("forget-preview")).toBeTruthy());
    expect(screen.getByTestId("forget-preview").textContent).toContain("14 events");
    expect(screen.getByTestId("forget-preview").textContent).toContain("1 episodes");
    // The preview alone deletes nothing.
    expect(calls.some((c) => c.path === "/api/capture/forget")).toBe(false);
    fireEvent.click(screen.getByText("forget"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/capture/forget" && c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("forget-preview")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("forgot 14 events");
  });
});

describe("Nudge (spec §14.7 nudge anatomy)", () => {
  it("renders intent → what I did → artifact peek → Open / Not now / ✕", async () => {
    stubFetch({ "/api/assist/nudge": { artifact: artifact() } });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByTestId("nudge")).toBeTruthy());
    const card = screen.getByTestId("nudge");
    expect(card.textContent).toContain("Saw you comparing Anjuna villas");
    expect(card.textContent).toContain("compared 6 across 3 sites");
    expect(card.textContent).toContain("Villa Sol ₹5.4k");
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("Not now")).toBeTruthy();
    expect(screen.getByLabelText("dismiss")).toBeTruthy();
  });

  it("'Not now' records a graded negative and parks the artifact as seen", async () => {
    const calls = stubFetch({
      "/api/assist/nudge": { artifact: artifact() },
      "/api/artifacts/art_1/signal": { weight: -0.2 },
      "/api/artifacts/art_1/seen": { artifact: artifact({ status: "seen" }) },
    });
    render(<Nudge />);
    await waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
    fireEvent.click(screen.getByText("Not now"));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/api/artifacts/art_1/signal")).toBe(true);
      expect(calls.some((c) => c.path === "/api/artifacts/art_1/seen")).toBe(true);
    });
    // The card minimized.
    expect(screen.queryByTestId("nudge")).toBeNull();
  });

  it("shows one artifact only once — a re-poll of the same id never re-pops", async () => {
    vi.useFakeTimers();
    stubFetch({ "/api/assist/nudge": { artifact: artifact() } });
    render(<Nudge />);
    await vi.waitFor(() => expect(screen.getByTestId("nudge")).toBeTruthy());
    // Auto-minimize fires…
    fireEvent.click(screen.getByText("Not now"));
    await vi.waitFor(() => expect(screen.queryByTestId("nudge")).toBeNull());
    // …and the next poll of the SAME artifact does not re-show it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.queryByTestId("nudge")).toBeNull();
  });

  it("peekOf pulls the first draft line out of the body", () => {
    expect(peekOf(artifact())).toContain("Villa Sol");
    expect(peekOf(artifact({ bodyJson: null }))).toBeNull();
  });
});

describe("in-app nudge surfaces (spec §14.7.8)", () => {
  it("Home shows the 'Prepared for you' shelf with the ● pulse on the unseen one", () => {
    const onOpen = vi.fn();
    render(
      <Home
        data={homeFixture}
        error={null}
        prepared={[artifact(), artifact({ id: "art_2", status: "seen", title: "Older brief" })]}
        onOpenArtifact={onOpen}
        onOpenTask={() => {}}
        onOpenSpace={() => {}}
        onOpenProposal={() => {}}
        onOpenClaim={() => {}}
        onDragMove={() => {}}
      />,
    );
    const shelf = screen.getByLabelText("Prepared for you");
    expect(shelf.textContent).toContain("Villa comparison");
    expect(screen.getAllByTestId("shelf-dot").length).toBe(1); // only the unseen one pulses
    fireEvent.click(screen.getByText("Villa comparison — 3 fit budget"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "art_1" }));
  });

  it("grounded bar: idle chip appears when focused-empty, Enter opens, typing dismisses silently", () => {
    const onOpen = vi.fn();
    const onTyped = vi.fn();
    render(
      <GroundedBar
        lock={null}
        onUnlock={() => {}}
        onTellTwin={async () => ""}
        nudge={artifact()}
        onOpenNudge={onOpen}
        onNudgeTyped={onTyped}
      />,
    );
    const input = screen.getByLabelText("ask");
    expect(screen.queryByTestId("bar-nudge-chip")).toBeNull(); // not focused yet
    fireEvent.focus(input);
    expect(screen.getByTestId("bar-nudge-chip")).toBeTruthy();
    // Enter on the empty bar opens the nudge.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Typing anything dismisses the chip silently (zero-cost negative).
    fireEvent.change(input, { target: { value: "h" } });
    expect(onTyped).toHaveBeenCalledWith(expect.objectContaining({ id: "art_1" }));
    expect(screen.queryByTestId("bar-nudge-chip")).toBeNull();
  });
});
