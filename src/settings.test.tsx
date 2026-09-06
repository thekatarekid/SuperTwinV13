// ===========================================================================
// Settings screen (spec §14.9) — the shell and the panels.
//
// Covers the three defects fixed after real use of the 13.4.1 build:
//   layout        the eight subtabs are ONE centred row above the panel, not a
//                 vertical list inside it; the row does not live in the
//                 scrolling panel and only the selected panel renders.
//   graduation    a fresh install PROPOSES (V6 P1 S5.1) and graduates to
//                 auto-create after two clean weeks; the copy says which one
//                 you are in and what the streak buys.
//   undo run      the link reads before it writes: a confirm names the blast
//                 radius, and nothing is POSTed until it is accepted.
//
// Plus the pre-existing round-trip coverage (General POST, Intelligence
// default-Haiku picker, opening a run to its exact record).
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./screens/Settings";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SUBTAB_LABELS = [
  "General",
  "Capture & Privacy",
  "Sources",
  "Intelligence",
  "Enrichment",
  "Assist",
  "Runs & Traces",
  "Data",
];

function stubSettings(): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/settings/general", {
    hotkey_summon: "double-right-cmd",
    hotkey_bar: "cmd-shift-s",
    launch_at_login: false,
    notifications_enabled: true,
    brief_times: ["08:30", "18:30"],
    appearance: "system",
    graduation_mode: "propose",
  });
  // The fresh-install shape the worker serves (V6 P1 S5.1): propose-only,
  // graduating to auto-create after two clean weeks on the gates.
  stub.routes.set("/api/settings/graduation", {
    mode: "propose",
    default_mode: "propose",
    reverted: false,
    required_days: 14,
    consecutive_green: 0,
    window_proposals: 0,
    min_proposals: 5,
    window: [],
  });
  stub.routes.set("/api/settings/t3", {
    last_run_at: null,
    last_report: null,
    eval_regression_due: null,
  });
  stub.routes.set("/api/health", { version: "13.4.0", builtThroughPhase: "P4" });
  stub.routes.set("/api/settings/capture", {
    sources: { whatsapp: { paused: false }, screen: { paused: true } },
    app_blocklist: ["1Password"],
    domain_blocklist: [],
    pagetext_rules: [],
    incognito: "always-off",
  });
  stub.routes.set("/api/settings/intelligence", {
    default_model: "haiku",
    options: ["haiku", "sonnet", "opus"],
    eval_gated: true,
    steps: [
      {
        key: "orient.v6",
        label: "Orient",
        group: "Understanding",
        recommended: "sonnet",
        selected: "haiku",
        enabled: true,
        cost_7d_usd: 0.42,
        calls_7d: 12,
      },
      {
        key: "critic.v4",
        label: "Critic",
        group: "Understanding",
        recommended: "haiku",
        selected: "haiku",
        enabled: true,
        cost_7d_usd: 0,
        calls_7d: 0,
      },
    ],
  });
  stub.routes.set("/api/retrieval/semantic/models", {
    active: "Xenova/multilingual-e5-small",
    models: [
      {
        id: "Xenova/multilingual-e5-small",
        label: "E5 small",
        dim: 384,
        bytes: 129_000_000,
        bundled: true,
        recommended: false,
        active: true,
        present: true,
        indexed: 100,
      },
      {
        id: "onnx-community/embeddinggemma-300m-ONNX",
        label: "EmbeddingGemma 300M",
        dim: 768,
        bytes: 300_000_000,
        bundled: false,
        recommended: true,
        active: false,
        present: false,
        indexed: 0,
      },
    ],
    swap: null,
  });
  stub.routes.set("/api/traces", {
    traces: [
      {
        id: "trc1",
        run_id: "run1",
        pass: "decide",
        caller: "test",
        model: "haiku",
        prompt_version: "decide.v8",
        repair_count: 0,
        input_tokens: 10,
        output_tokens: 5,
        cost_usd: 0.001,
        latency_ms: 800,
        status: "ok",
        day: "2026-08-28",
        created_at: "2026-08-28T10:00:00Z",
      },
    ],
    costs: [{ pass: "decide", calls: 1, cost_usd: 0.001 }],
  });
  stub.routes.set("/api/trace/trc1/full", {
    trace: {
      trace_id: "trc1",
      ts: "2026-08-28T10:00:00Z",
      run_id: "run1",
      pass: "decide",
      caller: "test",
      model: "haiku",
      prompt_version: "decide.v8",
      system_prompt: "THE EXACT SYSTEM PROMPT",
      packed_context: "THE EXACT PACKED CONTEXT",
      raw_output: '{"ok":true}',
      parsed_result: { ok: true },
      repair_count: 0,
      cost_usd: 0.001,
      latency_ms: 800,
      status: "ok",
    },
    compressed: false,
  });
  stub.routes.set("/api/ops/quarantine", { items: [] });
  stub.routes.set("/api/ops/runs/run1/undo", {
    runId: "run1",
    reversible: 1,
    skipped: 1,
    reversed: 1,
    items: [
      {
        decisionId: "dec_a",
        pass: "decide",
        targetKind: "episode",
        targetId: "ep_1",
        action: "attach",
        reason: "same trip thread",
        createdAt: "2026-08-28T10:00:00Z",
        reversible: true,
        skipReason: null,
      },
      {
        decisionId: "dec_b",
        pass: "user",
        targetKind: "space",
        targetId: "sp_1",
        action: "approve",
        reason: null,
        createdAt: "2026-08-28T10:01:00Z",
        reversible: false,
        skipReason: "your own edit — an undo never reverses a human's row",
      },
    ],
  });
  return stub;
}

// ---------------------------------------------------------------------------
// Layout: the subtab row (defect: a vertical list that scrolled and overlapped)
// ---------------------------------------------------------------------------

describe("Settings subtab row", () => {
  it("renders the eight full labels as one centred row above the panel", async () => {
    stubSettings();
    const { container } = render(<Settings />);
    await screen.findByRole("heading", { name: "General" });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    // One row, styled as the pill nav's smaller sibling — not a stacked list.
    expect(nav.className).toContain("pill-nav");
    const row = container.querySelector(".settings-subtabs");
    expect(row).toBeTruthy();
    expect(row!.contains(nav)).toBe(true);

    const labels = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(SUBTAB_LABELS);
  });

  it("keeps the row OUT of the scrolling panel, so it cannot scroll away", async () => {
    stubSettings();
    const { container } = render(<Settings />);
    await screen.findByRole("heading", { name: "General" });
    const row = container.querySelector(".settings-subtabs")!;
    const panel = container.querySelector(".settings-panel")!;
    // Siblings, not nested: the panel scrolls, the sticky row does not go
    // with it, and neither is laid on top of the other.
    expect(panel.contains(row)).toBe(false);
    expect(row.contains(panel)).toBe(false);
    expect(row.nextElementSibling).toBe(panel);
  });

  it("shows only the selected subtab's panel, and moves the active state", async () => {
    stubSettings();
    render(<Settings />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const general = within(nav).getByRole("button", { name: "General" });
    const runs = within(nav).getByRole("button", { name: "Runs & Traces" });

    expect(general.getAttribute("aria-current")).toBe("page");
    expect(runs.getAttribute("aria-current")).toBeNull();
    await screen.findByRole("heading", { name: "General" });
    expect(screen.queryByRole("heading", { name: /Runs & Traces/ })).toBeNull();

    fireEvent.click(runs);
    await screen.findByRole("heading", { name: /Runs & Traces/ });
    // The old panel is gone — one panel at a time, never two stacked.
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
    expect(runs.getAttribute("aria-current")).toBe("page");
    expect(general.getAttribute("aria-current")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

describe("Settings › General", () => {
  it("a fresh install reads as PROPOSE-ONLY with the graduation streak, auto-create offered", async () => {
    stubSettings();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Propose-only — new spaces wait/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Switch to auto-create/ })).toBeTruthy();
    // The streak is the gate: two clean weeks graduate the install.
    expect(screen.getByText(/0\/14 days/)).toBeTruthy();
    expect(screen.getByText(/graduates to auto-create/)).toBeTruthy();
    // Version footer (cross-phase gate: version + built-through phase visible).
    expect(screen.getByText("v13.4.0 · built through P4")).toBeTruthy();
  });

  it("auto-create reads as graduated and can be switched back to propose-only", async () => {
    const stub = stubSettings();
    stub.routes.set("/api/settings/graduation", {
      mode: "auto",
      default_mode: "propose",
      reverted: false,
      required_days: 14,
      consecutive_green: 14,
      window_proposals: 40,
      min_proposals: 5,
      window: [],
    });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Auto-create — the twin files/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Switch to propose-only/ }));
    await waitFor(() => {
      const posts = stub.calls.filter(
        (c) => c.path === "/api/settings/graduation" && c.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ mode: "propose" });
    });
  });

  it("general toggles round-trip through POST /api/settings/general", async () => {
    const stub = stubSettings();
    render(<Settings />);
    const toggle = await screen.findByLabelText("Launch at login");
    fireEvent.click(toggle);
    await waitFor(() => {
      const posts = stub.calls.filter(
        (c) => c.path === "/api/settings/general" && c.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ launch_at_login: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

describe("Settings › Intelligence", () => {
  it("default Haiku, recommendation shown, picker posts the step", async () => {
    const stub = stubSettings();
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Intelligence" }));
    const picker = (await screen.findByLabelText("Orient model")) as HTMLSelectElement;
    expect(picker.value).toBe("haiku"); // default Haiku everywhere
    expect(screen.getAllByText("rec: sonnet")).toHaveLength(1); // recommendation shown
    expect(screen.getByText(/EmbeddingGemma 300M/)).toBeTruthy();
    expect(screen.getByText(/golden set first/)).toBeTruthy();

    fireEvent.change(picker, { target: { value: "sonnet" } });
    await waitFor(() => {
      const posts = stub.calls.filter(
        (c) => c.path === "/api/settings/intelligence" && c.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ step: "orient.v6", model: "sonnet" });
    });
  });
});

// ---------------------------------------------------------------------------
// Runs & Traces
// ---------------------------------------------------------------------------

describe("Settings › Runs & Traces", () => {
  it("filters list traces and opens the exact record", async () => {
    stubSettings();
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Runs & Traces" }));
    const row = await screen.findByRole("button", { name: /decide · haiku/ });
    fireEvent.click(row);
    // The full record — the actual prompt and context, never a paraphrase.
    await waitFor(() => {
      expect(screen.getByText("THE EXACT SYSTEM PROMPT")).toBeTruthy();
      expect(screen.getByText("THE EXACT PACKED CONTEXT")).toBeTruthy();
    });
  });

  it("undo run READS before it writes: the confirm names the blast radius", async () => {
    const stub = stubSettings();
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Runs & Traces" }));

    const link = await screen.findByRole("button", { name: "undo run run1" });
    expect(link.textContent).toBe("undo run…"); // the ellipsis promises a step
    fireEvent.click(link);

    const dialog = await screen.findByRole("dialog", { name: "confirm undo run" });
    // Preview only — a GET, and nothing has been changed yet.
    expect(stub.calls.filter((c) => c.path === "/api/ops/runs/run1/undo")).toEqual([
      { path: "/api/ops/runs/run1/undo", method: "GET", body: undefined },
    ]);
    // What gets reverted, and what deliberately does not.
    expect(within(dialog).getByText(/reverses 1 change/)).toBeTruthy();
    expect(within(dialog).getByText(/episode attach · ep_1/)).toBeTruthy();
    expect(within(dialog).getByText(/never reverses a human's row/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Revert 1 change" }));
    await waitFor(() => {
      expect(
        stub.calls.filter((c) => c.path === "/api/ops/runs/run1/undo" && c.method === "POST"),
      ).toHaveLength(1);
    });
    // A receipt, and the dialog is gone.
    await screen.findByText(/run run1: 1 change reverted, 1 left alone/);
    expect(screen.queryByRole("dialog", { name: "confirm undo run" })).toBeNull();
  });

  it("cancelling the undo confirm changes nothing", async () => {
    const stub = stubSettings();
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Runs & Traces" }));
    fireEvent.click(await screen.findByRole("button", { name: "undo run run1" }));

    const dialog = await screen.findByRole("dialog", { name: "confirm undo run" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "confirm undo run" })).toBeNull(),
    );
    expect(
      stub.calls.filter((c) => c.path === "/api/ops/runs/run1/undo" && c.method === "POST"),
    ).toHaveLength(0);
  });

  it("a run with nothing reversible says so and disables the destructive button", async () => {
    const stub = stubSettings();
    stub.routes.set("/api/ops/runs/run1/undo", {
      runId: "run1",
      reversible: 0,
      skipped: 1,
      items: [
        {
          decisionId: "dec_z",
          pass: "decide",
          targetKind: "claim",
          targetId: "ck_1",
          action: "compress",
          reason: null,
          createdAt: "2026-08-28T10:00:00Z",
          reversible: false,
          skipReason: "no restore path for claim:compress",
        },
      ],
    });
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Runs & Traces" }));
    fireEvent.click(await screen.findByRole("button", { name: "undo run run1" }));

    const dialog = await screen.findByRole("dialog", { name: "confirm undo run" });
    expect(within(dialog).getByText(/Nothing in this run can be reverted/)).toBeTruthy();
    // And WHY: undo restores what a run moved, it never deletes what it made.
    expect(within(dialog).getByText(/never deletes something the run created/)).toBeTruthy();
    expect(within(dialog).getByText(/no restore path for claim:compress/)).toBeTruthy();
    const revert = within(dialog).getByRole("button", { name: /Revert 0 changes/ });
    expect((revert as HTMLButtonElement).disabled).toBe(true);
  });
});
