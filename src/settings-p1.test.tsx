// ===========================================================================
// The P1 §25 setting groups and the run-level Runs pane (V6 P1 S5.6).
//
// Three panes that had no UI at all — AI Connector, Retrieval, Calendar — plus
// what S5.6 adds to two that did: the golden gate on Intelligence (a change is
// a PROPOSAL, and the pane says which of running / applied / blocked is true),
// the §25 Assist fields (freshness, burst, card duration, merge window, intent
// floor, blocked kinds, behavioral rules), and the run index / run diff /
// quarantine on Runs.
//
// Every worker call is stubbed: no network, no worker, no model.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./screens/Settings";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Everything the shell asks for on mount, plus the S5.6 routes. */
function stubP1(over: Record<string, unknown> = {}): WorkerStub {
  const stub = stubWorker();
  const routes: Record<string, unknown> = {
    "/api/health": { version: "13.4.0", builtThroughPhase: "P4" },
    "/api/settings/general": {
      hotkey_summon: "double-right-cmd",
      hotkey_bar: "cmd-shift-s",
      launch_at_login: false,
      notifications_enabled: true,
      brief_times: ["08:30"],
      appearance: "system",
      graduation_mode: "propose",
    },
    "/api/settings/connector": {
      doors: [
        { door: "cli", label: "Claude Code CLI (your subscription)", status: "live", detail: "claude 2.1.0", connected: true },
        { door: "oauth", label: "Sign in to a provider", status: "p3", detail: "arrives in P3", connected: false },
        { door: "openrouter", label: "OpenRouter key", status: "p3", detail: "arrives in P3", connected: false },
        { door: "local", label: "Local models", status: "local-only", detail: "always on device", connected: true },
      ],
      fallback_order: ["cli", "local"],
      ceilings: { usd_per_call: 0.05, usd_per_hour: 3, usd_per_day: 15, calls_per_hour: 400, calls_per_day: 3000 },
      stop_all: false,
    },
    "/api/settings/retrieval": {
      agentic: true,
      t2: { hidden: true, hop_budget: 3, time_budget_s: 20 },
      scan_row_limit: 5000,
      graph: { hops: 2, fanout: 25, default_hops: 2, default_fanout: 25 },
      hubs: [{ entity_id: "ent_self", reason: "self", degree: 900, added_by: "code" }],
    },
    "/api/settings/calendar": {
      circles: {
        partner: { mode: "plan", leadDays: 14 },
        friends: { mode: "wish", leadDays: 0 },
      },
    },
    "/api/settings/assist": {
      enabled: true,
      thresholds: { default: 5 },
      cooldown_min: 30,
      quiet_hours: { start: "22:00", end: "07:00" },
      suppressed_contexts: [],
      freshness: "balanced",
      freshness_window: { idle_s: 300, max_s: 540 },
      freshness_presets: {
        live: { idle_s: 120, max_s: 180 },
        balanced: { idle_s: 300, max_s: 540 },
        relaxed: { idle_s: 420, max_s: 600 },
      },
      burst: { k: 4, window_s: 180 },
      card_duration_s: 60,
      merge_window_s: 120,
      intent_floor: 0.6,
      blocked_kinds: ["nudge:price_drop"],
      behavioral_rules: [
        { id: "rule_1", text: "never nudge me about deliveries", source: "chip", created_at: "2026-09-01" },
      ],
    },
    "/api/settings/intelligence": {
      default_model: "haiku",
      options: ["haiku", "sonnet"],
      models: [
        { id: "haiku", label: "Haiku 4.5", family: "haiku", alias: true, resolves_to: null, input_per_mtok: 1, output_per_mtok: 5, thinking_levels: [], default_thinking: null, effort: false, context_window: 200000 },
        { id: "sonnet", label: "Sonnet 4.5", family: "sonnet", alias: true, resolves_to: null, input_per_mtok: 3, output_per_mtok: 15, thinking_levels: ["off", "high"], default_thinking: "off", effort: false, context_window: 200000 },
      ],
      eval_gated: true,
      golden: {
        runner_installed: false,
        runner_note: null,
        state: { status: "idle", started_at: null, finished_at: null, categories: null, step: null, candidate: null, applied: false, regressed: [], summary: null, error: null, reason: null },
      },
      steps: [
        { key: "decide", label: "Decide", group: "Understanding", recommended: "sonnet", selected: "haiku", enabled: true, cost_7d_usd: 0, calls_7d: 0, thinking: "off", thinking_levels: [], eval_categories: ["DEC", "TSK"], pending: null },
      ],
    },
    "/api/embedding-models": { models: [], default: null, error: null, swap: null },
    "/api/traces": { traces: [], costs: [] },
    "/api/ops/quarantine": { items: [] },
    "/api/runs": {
      total: 2,
      costs: [{ pass: "decide", runs: 2, cost_usd: 0.008 }],
      runs: [
        { id: "run_a", kind: "llm", role: null, pass: "decide", origin: "live", model: "haiku", status: "ok", started_at: "2026-09-01T10:00:00.000Z", ended_at: null, cost_usd: 0.004, input_tokens: 100, cache_read: 0, output_tokens: 50, error_code: null, traces: 1, decisions: 2, reversed: 0, quarantine: null },
        { id: "run_b", kind: "llm", role: null, pass: "decide", origin: "live", model: "sonnet", status: "ok", started_at: "2026-09-02T10:00:00.000Z", ended_at: null, cost_usd: 0.004, input_tokens: 100, cache_read: 0, output_tokens: 50, error_code: null, traces: 1, decisions: 2, reversed: 0, quarantine: null },
      ],
    },
    "/api/runs/diff": {
      a: { id: "run_a", pass: "decide", model: "haiku", cost_usd: 0.004, traces: 1, decisions: 2, reversed: 0, quarantine: null, kind: "llm", role: null, origin: "live", status: "ok", started_at: null, ended_at: null, input_tokens: 0, cache_read: 0, output_tokens: 0, error_code: null },
      b: { id: "run_b", pass: "decide", model: "sonnet", cost_usd: 0.004, traces: 1, decisions: 2, reversed: 0, quarantine: null, kind: "llm", role: null, origin: "live", status: "ok", started_at: null, ended_at: null, input_tokens: 0, cache_read: 0, output_tokens: 0, error_code: null },
      fields: [
        { field: "pass", a: "decide", b: "decide", same: true },
        { field: "model", a: "haiku", b: "sonnet", same: false },
      ],
      prompt_versions: { a: ["decide.v9"], b: ["decide.v9"] },
      decisions: {
        only_a: [],
        only_b: [{ target_kind: "space", target_id: "sp_new", a_action: null, b_action: "create" }],
        changed: [{ target_kind: "task", target_id: "t_moved", a_action: "close", b_action: "monitor" }],
        same: 1,
      },
    },
    "/api/runs/run_a/quarantine": { run_id: "run_a", quarantine: { quarantined: true, at: "2026-09-06", reason: null } },
    ...over,
  };
  for (const [path, body] of Object.entries(routes)) stub.routes.set(path, body);
  return stub;
}

const openTab = (label: string): void => {
  fireEvent.click(screen.getByRole("button", { name: label }));
};

// ---------------------------------------------------------------------------

describe("Settings › AI Connector", () => {
  it("names every door with the phase it arrives in — a closed door says why", async () => {
    stubP1();
    render(<Settings />);
    openTab("AI Connector");
    await screen.findByRole("heading", { name: "AI Connector" });
    expect(screen.getAllByText(/Claude Code CLI/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/arrives in P3/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/on device/)).toBeTruthy();
  });

  it("shows the ceilings the worker enforces, read-only", async () => {
    stubP1();
    render(<Settings />);
    openTab("AI Connector");
    await screen.findByRole("heading", { name: "Spend ceilings" });
    expect(screen.getByText(/\$3 · 400 calls/)).toBeTruthy();
    expect(screen.getByText(/\$15 · 3000 calls/)).toBeTruthy();
    // No input for a ceiling: raising one from a settings pane is not on offer.
    expect(screen.queryByLabelText(/per hour/i)).toBeNull();
  });

  it("reordering the fallback posts the whole order", async () => {
    const stub = stubP1();
    render(<Settings />);
    openTab("AI Connector");
    fireEvent.click(await screen.findByLabelText("move local up"));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/connector" && c.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ fallback_order: ["local", "cli"] });
    });
  });

  it("says plainly when all model activity is stopped", async () => {
    stubP1({
      "/api/settings/connector": {
        doors: [],
        fallback_order: [],
        ceilings: { usd_per_call: 0.05, usd_per_hour: 3, usd_per_day: 15, calls_per_hour: 400, calls_per_day: 3000 },
        stop_all: true,
      },
    });
    render(<Settings />);
    openTab("AI Connector");
    expect(await screen.findByText(/All model activity is STOPPED/)).toBeTruthy();
  });
});

describe("Settings › Retrieval", () => {
  it("shows the three budgets that decide what a search costs, and no T2 control", async () => {
    stubP1();
    render(<Settings />);
    openTab("Retrieval");
    await screen.findByRole("heading", { name: "Retrieval" });
    expect((screen.getByLabelText("Graph hop limit") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Graph fan-out cap") as HTMLInputElement).value).toBe("25");
    expect((screen.getByLabelText("Exhaustive-scan row limit") as HTMLInputElement).value).toBe("5000");
    // The T2 budgets are stored and served but not rendered — a control for a
    // tier that does not run would be a promise the build cannot keep.
    expect(screen.queryByLabelText(/hop budget/i)).toBeNull();
    expect(screen.getByText(/T2 agentic retrieval .* arrives with P2/)).toBeTruthy();
  });

  it("a hub can be excluded and removed", async () => {
    const stub = stubP1();
    render(<Settings />);
    openTab("Retrieval");
    fireEvent.click(await screen.findByLabelText("remove hub ent_self"));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/retrieval" && c.method === "POST");
      expect(posts[0]!.body).toEqual({ remove_hub: "ent_self" });
    });
  });
});

describe("Settings › Calendar", () => {
  it("renders the per-circle plan/wish choice with its lead time", async () => {
    stubP1();
    render(<Settings />);
    openTab("Calendar");
    await screen.findByRole("heading", { name: "Lead time by circle" });
    expect((screen.getByLabelText("partner mode") as HTMLSelectElement).value).toBe("plan");
    expect((screen.getByLabelText("partner lead days") as HTMLInputElement).value).toBe("14");
    // A wish circle has no lead time to set — the field is disabled, not hidden.
    expect((screen.getByLabelText("friends lead days") as HTMLInputElement).disabled).toBe(true);
  });

  it("changing a circle posts just that circle", async () => {
    const stub = stubP1();
    render(<Settings />);
    openTab("Calendar");
    fireEvent.change(await screen.findByLabelText("friends mode"), { target: { value: "plan" } });
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/calendar" && c.method === "POST");
      expect(posts[0]!.body).toEqual({ circles: { friends: { mode: "plan" } } });
    });
  });

  it("says the derived calendar is what P1 ships", async () => {
    stubP1();
    render(<Settings />);
    openTab("Calendar");
    expect(await screen.findByText(/calendar is DERIVED/)).toBeTruthy();
  });
});

describe("Settings › Assist — the §25 fields", () => {
  it("freshness prints the seconds each preset means, and the one in force", async () => {
    stubP1();
    render(<Settings />);
    openTab("Assist");
    await screen.findByRole("heading", { name: "Freshness — the cold window" });
    const group = screen.getByRole("radiogroup", { name: "Freshness" });
    expect(within(group).getByText("120 / 180 s")).toBeTruthy();
    expect(within(group).getByText("300 / 540 s")).toBeTruthy();
    expect(within(group).getByText("420 / 600 s")).toBeTruthy();
    expect(screen.getByText(/in force: idle 300 s · max 540 s/)).toBeTruthy();
  });

  it("picking a preset posts it — the running dispatcher reads it next tick", async () => {
    const stub = stubP1();
    render(<Settings />);
    openTab("Assist");
    const group = await screen.findByRole("radiogroup", { name: "Freshness" });
    fireEvent.click(within(group).getAllByRole("radio")[0]!);
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(posts[0]!.body).toEqual({ freshness: "live" });
    });
  });

  it("burst, card duration, merge window and the intent floor are all editable", async () => {
    stubP1();
    render(<Settings />);
    openTab("Assist");
    expect((await screen.findByLabelText("Burst threshold (events K)") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Burst window (W, seconds)") as HTMLInputElement).value).toBe("180");
    expect((screen.getByLabelText("Nudge card duration (seconds)") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Merge window (seconds)") as HTMLInputElement).value).toBe("120");
    expect((screen.getByLabelText("Intent-confidence floor (0–1)") as HTMLInputElement).value).toBe("0.6");
  });

  it("a blocked kind is reversible in one click, and a rule can be taken back", async () => {
    const stub = stubP1();
    render(<Settings />);
    openTab("Assist");
    fireEvent.click(await screen.findByLabelText("unblock nudge:price_drop"));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(posts[0]!.body).toEqual({ blocked_kinds: [] });
    });
    fireEvent.click(screen.getByLabelText("remove rule never nudge me about deliveries"));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(posts[1]!.body).toEqual({ remove_rule: "rule_1" });
    });
  });

  it("adding a behavioral rule posts the text", async () => {
    const stub = stubP1();
    render(<Settings />);
    openTab("Assist");
    fireEvent.change(await screen.findByLabelText("new behavioral rule"), {
      target: { value: "  don't book anything on sundays  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "add rule" }));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/settings/assist" && c.method === "POST");
      expect(posts[0]!.body).toEqual({ add_rule: "don't book anything on sundays" });
    });
  });
});

describe("Settings › Intelligence — the golden gate (SET-02)", () => {
  it("a build with no eval harness says so and disables the run button, rather than failing on click", async () => {
    stubP1();
    render(<Settings />);
    openTab("Intelligence");
    const btn = (await screen.findByRole("button", { name: "Run golden set" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/not installed in this build/)).toBeTruthy();
    // The categories a change to this step would re-run are named up front.
    expect(screen.getByText(/gates: DEC, TSK/)).toBeTruthy();
  });

  it("a BLOCKED gate says the change was not applied and names what regressed", async () => {
    stubP1({
      "/api/settings/intelligence": {
        default_model: "haiku",
        options: ["haiku", "sonnet"],
        models: [],
        eval_gated: true,
        golden: {
          runner_installed: true,
          runner_note: "eval harness at /repo",
          state: {
            status: "blocked",
            started_at: "2026-09-06T09:00:00Z",
            finished_at: "2026-09-06T09:40:00Z",
            categories: ["DEC", "TSK"],
            step: "decide",
            candidate: { model: "sonnet" },
            applied: false,
            regressed: ["DEC"],
            summary: "COMPARE: red",
            error: null,
            reason: "Decide: model sonnet",
          },
        },
        steps: [],
      },
    });
    render(<Settings />);
    openTab("Intelligence");
    expect(await screen.findByText(/blocked: DEC below baseline/)).toBeTruthy();
    expect(screen.getByText(/was NOT applied/)).toBeTruthy();
  });

  it("a RUNNING gate says the change is not in force yet, and the button cannot start a second run", async () => {
    stubP1({
      "/api/settings/intelligence": {
        default_model: "haiku",
        options: ["haiku"],
        models: [],
        eval_gated: true,
        golden: {
          runner_installed: true,
          runner_note: "eval harness at /repo",
          state: {
            status: "running",
            started_at: "2026-09-06T09:00:00Z",
            finished_at: null,
            categories: ["DEC"],
            step: "decide",
            candidate: { model: "sonnet" },
            applied: false,
            regressed: [],
            summary: null,
            error: null,
            reason: "Decide: model sonnet",
          },
        },
        steps: [],
      },
    });
    render(<Settings />);
    openTab("Intelligence");
    expect(await screen.findByText(/the change is NOT in force yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "running…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the manual run posts only when a runner is installed", async () => {
    const stub = stubP1({
      "/api/settings/intelligence": {
        default_model: "haiku",
        options: ["haiku"],
        models: [],
        eval_gated: true,
        golden: {
          runner_installed: true,
          runner_note: "eval harness at /repo",
          state: { status: "idle", started_at: null, finished_at: null, categories: null, step: null, candidate: null, applied: false, regressed: [], summary: null, error: null, reason: null },
        },
        steps: [],
      },
      "/api/settings/golden/run": { started: true, state: { status: "running", regressed: [] } },
    });
    render(<Settings />);
    openTab("Intelligence");
    fireEvent.click(await screen.findByRole("button", { name: "Run golden set" }));
    await waitFor(() => {
      expect(stub.calls.filter((c) => c.path === "/api/settings/golden/run" && c.method === "POST")).toHaveLength(1);
    });
  });
});

describe("Settings › Runs — the run level (§25)", () => {
  it("lists runs with their call / decision counts", async () => {
    stubP1();
    render(<Settings />);
    openTab("Runs & Traces");
    await screen.findByRole("heading", { name: "Runs" });
    expect(screen.getByText(/2 run\(s\)/)).toBeTruthy();
    expect(screen.getAllByText(/1 call\(s\) · 2 decision\(s\)/)).toHaveLength(2);
  });

  it("diffing two runs names the header field that changed and what they decided differently", async () => {
    stubP1();
    render(<Settings />);
    openTab("Runs & Traces");
    fireEvent.click(await screen.findByLabelText("select run run_a"));
    fireEvent.click(screen.getByLabelText("select run run_b"));
    fireEvent.click(screen.getByRole("button", { name: "diff runs" }));
    await screen.findByText(/run diff: run_a vs run_b/);
    expect(screen.getByText("haiku → sonnet")).toBeTruthy();
    expect(screen.getByText("close → monitor")).toBeTruthy();
    expect(screen.getByText(/only B · create/)).toBeTruthy();
    // A field both runs share is not printed as a difference.
    expect(screen.queryByText("decide → decide")).toBeNull();
  });

  it("quarantine is offered per run and is not the undo button", async () => {
    const stub = stubP1();
    render(<Settings />);
    openTab("Runs & Traces");
    fireEvent.click(await screen.findByLabelText("quarantine run run_a"));
    await waitFor(() => {
      const posts = stub.calls.filter((c) => c.path === "/api/runs/run_a/quarantine" && c.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toMatchObject({ quarantined: true });
    });
    // Undo is a separate, destructive control that reads before it writes.
    expect(screen.getAllByLabelText(/^undo run run_/).length).toBeGreaterThan(0);
  });

  it("a quarantined run stays in the list, flagged, and offers release", async () => {
    stubP1({
      "/api/runs": {
        total: 1,
        costs: [],
        runs: [
          { id: "run_a", kind: "llm", role: null, pass: "decide", origin: "live", model: "haiku", status: "ok", started_at: "2026-09-01T10:00:00.000Z", ended_at: null, cost_usd: 0.004, input_tokens: 0, cache_read: 0, output_tokens: 0, error_code: null, traces: 1, decisions: 2, reversed: 0, quarantine: { quarantined: true, at: "2026-09-06", reason: "bad trial" } },
        ],
      },
    });
    render(<Settings />);
    openTab("Runs & Traces");
    await screen.findByRole("heading", { name: "Runs" });
    expect(screen.getByText(/· quarantined/)).toBeTruthy();
    expect(screen.getByLabelText("release run run_a")).toBeTruthy();
  });
});
