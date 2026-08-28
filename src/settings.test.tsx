// ===========================================================================
// P4.3 Settings screen (spec §14.9): the eight subtabs render, values come
// from the worker, and edits round-trip through the settings routes —
// Intelligence shows default-Haiku + per-step recommendation, General carries
// the graduation switch, Runs opens a trace to its exact record.
// ===========================================================================

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./screens/Settings";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  stub.routes.set("/api/settings/graduation", {
    mode: "propose",
    reverted: false,
    required_days: 14,
    consecutive_green: 9,
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
  return stub;
}

describe("Settings (spec §14.9)", () => {
  it("renders the eight subtabs and the General pane with the graduation switch", async () => {
    stubSettings();
    render(<Settings />);
    for (const t of [
      "General",
      "Capture & Privacy",
      "Sources",
      "Intelligence",
      "Enrichment",
      "Assist",
      "Runs",
      "Data",
    ]) {
      expect(screen.getByRole("button", { name: t })).toBeTruthy();
    }
    await waitFor(() => expect(screen.getByText(/gates green 9\/14/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Turn on auto-create/ })).toBeTruthy();
    // Version footer (cross-phase gate: version + built-through phase visible).
    expect(screen.getByText("v13.4.0 · built through P4")).toBeTruthy();
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

  it("intelligence: default Haiku, recommendation shown, picker posts the step", async () => {
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

  it("runs: filters list traces and opens the exact record", async () => {
    stubSettings();
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    const row = await screen.findByRole("button", { name: /decide · haiku/ });
    fireEvent.click(row);
    // The full record — the actual prompt and context, never a paraphrase.
    await waitFor(() => {
      expect(screen.getByText("THE EXACT SYSTEM PROMPT")).toBeTruthy();
      expect(screen.getByText("THE EXACT PACKED CONTEXT")).toBeTruthy();
    });
  });
});
