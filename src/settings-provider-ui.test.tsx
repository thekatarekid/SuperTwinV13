import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntelligencePanel } from "./screens/settings/IntelligencePanel";
import { openExternal } from "./lib/tauri";

vi.mock("./lib/tauri", () => ({ openExternal: vi.fn(async () => undefined) }));

const CONSENT =
  "SuperTwin will send selected WhatsApp messages, browser text, screen captures, and derived context to OpenAI using your personal ChatGPT/Codex subscription. This is consumer-service traffic, not API business data. OpenAI may retain or use content according to your account’s data controls. SuperTwin cannot guarantee no training, Temporary Chat treatment, or deletion. Confirm you have permission to share this data. You can sign out and stop future sends at any time.";

type ProviderId = "claude-local" | "chatgpt-oauth";

function intelligence(
  provider: ProviderId,
  options: { auth?: "ready" | "signed_out" | "unavailable" | "degraded"; mode?: "discovered" | "cached" | "fallback"; empty?: boolean; error?: string | null; stepCount?: number } = {},
) {
  const chatGpt = provider === "chatgpt-oauth";
  const model = chatGpt ? "gpt-5.6-sol" : "claude-sonnet-4-5";
  const alternate = chatGpt ? "gpt-5.6-terra" : "claude-haiku-4-5";
  const models = options.empty
    ? []
    : [model, alternate].map((id, index) => ({
        id,
        displayName: index === 0
          ? (chatGpt ? "GPT-5.6 Sol" : "Sonnet 4.5")
          : (chatGpt ? "GPT-5.6 Terra" : "Haiku 4.5"),
        isDefault: index === 0,
        hidden: false,
        inputModalities: ["text"],
        reasoningValues: chatGpt ? ["low", "medium", "high"] : ["off", "high"],
        defaultReasoning: chatGpt ? "medium" : "off",
        supportsTools: true,
        supportsHostTools: true,
        supportsParallelToolCalls: true,
        supportsStructuredOutput: true,
        supportsStrictTools: true,
        supportsVerbosity: chatGpt,
        supportsPromptCacheKey: chatGpt,
        supportsPromptCacheOptions: chatGpt,
        contextWindow: 200_000,
        maxOutputTokens: null,
        billingLabel: chatGpt ? "ChatGPT subscription" : "$3/MTok input · $15/MTok output",
      }));
  return {
    provider: {
      selected: provider,
      options: [
        { id: "claude-local", label: "Claude — Claude subscription", auth_state: "ready" },
        { id: "chatgpt-oauth", label: "ChatGPT — ChatGPT subscription", auth_state: options.auth ?? "ready" },
      ],
    },
    catalogue: {
      providerId: provider,
      mode: options.mode ?? "discovered",
      source: chatGpt ? "account catalogue" : "Claude CLI",
      discoveredAt: "2026-09-08T10:00:00.000Z",
      revision: `${provider}-r1`,
      error: options.error ?? null,
      models,
    },
    default_model: model,
    options: [model, alternate],
    models: [],
    eval_gated: true,
    steps: [
      ["Orient", "Understanding"], ["Critic", "Understanding"],
      ["Extract", "Understanding"], ["Decide", "Understanding"],
      ["Digest", "Understanding"], ["Consolidation judge", "Understanding"],
      ["Assist watcher", "Fast lane"], ["Executor", "Agents"],
      ["Grounded bar", "Agents"], ["Tiering", "Utility"], ["Brief", "Utility"],
    ].slice(0, options.stepCount ?? 2).map(([label, group]) => ({
      key: label.toLowerCase(),
      label,
      group,
      selected_model: model,
      recommended_model: model,
      reasoning: chatGpt ? "medium" : "off",
      reasoning_values: chatGpt ? ["low", "medium", "high"] : ["off", "high"],
      available: !options.empty && (options.auth ?? "ready") === "ready",
      recommended: model,
      selected: model,
      enabled: true,
      cost_7d_usd: 0,
      calls_7d: 0,
    })),
  };
}

function status(auth: "ready" | "signed_out" | "unavailable" | "degraded") {
  return {
    signed_in: auth === "ready",
    auth_state: auth,
    plan: auth === "ready" ? "Plus" : null,
    quota: { state: "unknown", reset_at: null },
    token_expires_at: null,
    canary: { status: "unknown", checked_at: null, error: null },
  };
}

function install(initial: ReturnType<typeof intelligence>, options: { cancelResult?: boolean; terminalStatusFailsOnce?: boolean; stepSave?: Promise<unknown> } = {}) {
  let current = initial;
  let loginPoll = 0;
  const calls: Array<{ path: string; query: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, query: url.search, method, body });
    let response: unknown;
    if (path === "/api/settings/intelligence" && method === "GET") response = current;
    else if (path === "/api/settings/intelligence" && method === "POST") {
      response = options.stepSave ? await options.stepSave : { step: body.step, ok: true, gate: null };
    }
    else if (path === "/api/settings/provider") {
      current = intelligence(body.provider, {
        auth: body.provider === "chatgpt-oauth" ? "signed_out" : "ready",
        stepCount: initial.steps.length,
      });
      response = current;
    } else if (path === "/api/retrieval/semantic/models") {
      response = { active: null, default: null, models: [], error: null, swap: null };
    } else if (path === "/api/providers/chatgpt-oauth/status") {
      response = status(current.provider.options[1].auth_state as Parameters<typeof status>[0]);
    } else if (path === "/api/providers/chatgpt-oauth/login/start") {
      response = { login_id: "login-1", auth_url: "https://auth.openai.com/oauth/authorize?safe=1", expires_at: "2026-09-08T12:00:00.000Z" };
    } else if (path === "/api/providers/chatgpt-oauth/login/status") {
      loginPoll += 1;
      if (options.terminalStatusFailsOnce && loginPoll === 2) throw new Error("status temporarily unavailable");
      if (loginPoll === 1) {
        response = { login_id: "login-1", status: "awaiting_browser", expires_at: "2026-09-08T12:00:00.000Z", error: null };
      } else {
        current = intelligence("chatgpt-oauth", { auth: "ready" });
        response = { login_id: "login-1", status: "signed_in", expires_at: null, error: null };
      }
    } else if (path === "/api/providers/chatgpt-oauth/login/cancel") response = { cancelled: options.cancelResult ?? true };
    else if (path === "/api/providers/chatgpt-oauth/logout") {
      current = intelligence("chatgpt-oauth", { auth: "signed_out" });
      response = { signed_out: true };
    } else response = { error: "not found" };
    return { ok: true, status: 200, json: async () => response };
  }));
  return { calls, get current() { return current; }, get loginPoll() { return loginPoll; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(openExternal).mockClear();
});

describe("Settings › Intelligence provider UI (V2 P3-C)", () => {
  it("switches every step picker between the two provider catalogues", async () => {
    const stub = install(intelligence("claude-local", { stepCount: 11 }));
    render(<IntelligencePanel />);
    const provider = await screen.findByLabelText("AI provider") as HTMLSelectElement;
    expect([...provider.options].map((option) => [option.value, option.textContent])).toEqual([
      ["claude-local", "Claude — Claude subscription"],
      ["chatgpt-oauth", "ChatGPT — ChatGPT subscription"],
    ]);
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).value).toBe("claude-sonnet-4-5");
    expect(screen.getAllByLabelText(/ model$/)).toHaveLength(11);

    fireEvent.change(provider, { target: { value: "chatgpt-oauth" } });
    await waitFor(() => expect((screen.getByLabelText("Orient model") as HTMLSelectElement).value).toBe("gpt-5.6-sol"));
    expect((screen.getByLabelText("Decide model") as HTMLSelectElement).value).toBe("gpt-5.6-sol");
    expect(screen.getAllByLabelText(/ model$/)).toHaveLength(11);
    expect((screen.getByLabelText("Orient thinking") as HTMLSelectElement).value).toBe("medium");
    expect((screen.getByLabelText("Decide thinking") as HTMLSelectElement).value).toBe("medium");
    for (const picker of screen.getAllByLabelText(/ model$/) as HTMLSelectElement[]) {
      expect([...picker.options].map((option) => option.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    }
    expect(screen.getAllByLabelText(/ thinking$/)).toHaveLength(11);
    for (const picker of screen.getAllByLabelText(/ thinking$/) as HTMLSelectElement[]) {
      expect([...picker.options].map((option) => option.value)).toEqual(["low", "medium", "high"]);
    }
    expect(stub.calls.find((call) => call.path === "/api/settings/provider")?.body).toEqual({ provider: "chatgpt-oauth" });

    fireEvent.change(screen.getByLabelText("AI provider"), { target: { value: "claude-local" } });
    await waitFor(() => expect((screen.getByLabelText("Decide model") as HTMLSelectElement).value).toBe("claude-sonnet-4-5"));
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).value).toBe("claude-sonnet-4-5");
    expect((screen.getByLabelText("Orient thinking") as HTMLSelectElement).value).toBe("off");
    expect((screen.getByLabelText("Decide thinking") as HTMLSelectElement).value).toBe("off");
    for (const picker of screen.getAllByLabelText(/ model$/) as HTMLSelectElement[]) {
      expect([...picker.options].map((option) => option.value)).toEqual(["claude-sonnet-4-5", "claude-haiku-4-5"]);
    }
    for (const picker of screen.getAllByLabelText(/ thinking$/) as HTMLSelectElement[]) {
      expect([...picker.options].map((option) => option.value)).toEqual(["off", "high"]);
    }
    expect(screen.getAllByLabelText(/ model$/)).toHaveLength(11);
  });

  it("shows exact consent, disables signed-out models, and completes browser PKCE automatically", async () => {
    const stub = install(intelligence("chatgpt-oauth", { auth: "signed_out" }));
    render(<IntelligencePanel />);
    expect(await screen.findByText(CONSENT)).toBeTruthy();
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/authorization code/i)).toBeNull();
    expect(screen.queryByText(/enter.*code/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?safe=1"));
    await waitFor(() => expect(screen.getByText("ChatGPT signed in")).toBeTruthy());
    expect(stub.loginPoll).toBe(2);
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByText("Plus · unknown")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign out of ChatGPT" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeTruthy());
    expect(stub.calls.some((call) => call.path === "/api/providers/chatgpt-oauth/logout")).toBe(true);
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).disabled).toBe(true);
  });

  it("uses subscription copy without dollar pricing for ChatGPT", async () => {
    install(intelligence("chatgpt-oauth"));
    render(<IntelligencePanel />);
    const picker = await screen.findByLabelText("Orient model") as HTMLSelectElement;
    expect(picker.options[0]?.textContent).toBe("GPT-5.6 Sol — ChatGPT subscription");
    expect(picker.options[0]?.textContent).not.toContain("$");
  });

  it("renders cached, empty, and unavailable states with retry controls", async () => {
    const stub = install(intelligence("chatgpt-oauth", { auth: "unavailable", mode: "cached", empty: true, error: "catalogue offline" }));
    render(<IntelligencePanel />);
    expect(await screen.findByText(/cached ChatGPT models.*catalogue offline/)).toBeTruthy();
    expect(screen.getByText("No models are available for this provider.")).toBeTruthy();
    expect(screen.getByText("ChatGPT is unavailable in this build.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /retry/i }).length).toBeGreaterThanOrEqual(2);
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(stub.calls.some((call) =>
      call.path === "/api/settings/intelligence" && call.query === "?refresh=models",
    )).toBe(true));
  });

  it("ignores a stale ChatGPT status completion after switching to Claude", async () => {
    let resolveStatus!: (value: unknown) => void;
    const delayedStatus = new Promise<unknown>((resolve) => { resolveStatus = resolve; });
    let current = intelligence("chatgpt-oauth", { auth: "signed_out" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      let response: unknown;
      if (path === "/api/settings/intelligence") response = current;
      else if (path === "/api/retrieval/semantic/models") response = { active: null, default: null, models: [], error: null, swap: null };
      else if (path === "/api/providers/chatgpt-oauth/status") return { ok: true, status: 200, json: async () => delayedStatus };
      else if (path === "/api/settings/provider") {
        current = intelligence(body.provider);
        response = current;
      }
      return { ok: true, status: 200, json: async () => response };
    }));

    render(<IntelligencePanel />);
    const provider = await screen.findByLabelText("AI provider");
    await screen.findByText("Checking ChatGPT sign-in…");
    fireEvent.change(provider, { target: { value: "claude-local" } });
    await waitFor(() => expect((screen.getByLabelText("AI provider") as HTMLSelectElement).value).toBe("claude-local"));
    resolveStatus(status("ready"));
    await Promise.resolve();
    expect(screen.queryByText("ChatGPT signed in")).toBeNull();
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).value).toBe("claude-sonnet-4-5");
  });

  it("ignores an auth completion after the panel unmounts", async () => {
    let resolveStatus!: (value: unknown) => void;
    const delayedStatus = new Promise<unknown>((resolve) => { resolveStatus = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const response = path === "/api/settings/intelligence"
        ? intelligence("chatgpt-oauth", { auth: "signed_out" })
        : { active: null, default: null, models: [], error: null, swap: null };
      if (path === "/api/providers/chatgpt-oauth/status") {
        return { ok: true, status: 200, json: async () => delayedStatus };
      }
      return { ok: true, status: 200, json: async () => response };
    }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<IntelligencePanel />);
    await screen.findByText("Checking ChatGPT sign-in…");
    view.unmount();
    resolveStatus(status("ready"));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("refreshes terminal truth when cancellation loses to a completed callback", async () => {
    const stub = install(intelligence("chatgpt-oauth", { auth: "signed_out" }), { cancelResult: false });
    render(<IntelligencePanel />);
    await screen.findByText(CONSENT);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await screen.findByText("Waiting for approval in your browser…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(screen.getByText("ChatGPT signed in")).toBeTruthy());
    expect(screen.queryByText("Sign-in cancelled.")).toBeNull();
    expect(stub.calls.filter((call) => call.path === "/api/providers/chatgpt-oauth/login/status").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps polling if cancel-false terminal recovery temporarily fails", async () => {
    const stub = install(intelligence("chatgpt-oauth", { auth: "signed_out" }), {
      cancelResult: false,
      terminalStatusFailsOnce: true,
    });
    render(<IntelligencePanel />);
    await screen.findByText(CONSENT);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await screen.findByText("Waiting for approval in your browser…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(screen.getByText("ChatGPT signed in")).toBeTruthy(), { timeout: 2_500 });
    expect(stub.loginPoll).toBeGreaterThanOrEqual(3);
  });

  it("lets only the latest overlapping status refresh update the same generation", async () => {
    const replies = [status("degraded")];
    const pending: Array<(value: unknown) => void> = [];
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/providers/chatgpt-oauth/status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          return { ok: true, status: 200, json: async () => replies.shift() };
        }
        return {
          ok: true,
          status: 200,
          json: async () => new Promise((resolve) => pending.push(resolve)),
        };
      }
      const response = path === "/api/settings/intelligence"
        ? intelligence("chatgpt-oauth", { auth: "degraded" })
        : { active: null, default: null, models: [], error: null, swap: null };
      return { ok: true, status: 200, json: async () => response };
    }));
    render(<IntelligencePanel />);
    const retry = await screen.findByRole("button", { name: "Retry ChatGPT status" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!(status("ready"));
    await waitFor(() => expect(screen.getByText("ChatGPT signed in")).toBeTruthy());
    pending[0]!(status("signed_out"));
    await Promise.resolve();
    expect(screen.getByText("ChatGPT signed in")).toBeTruthy();
  });

  it("runs correctly under React StrictMode's setup-cleanup-setup lifecycle", async () => {
    install(intelligence("chatgpt-oauth", { auth: "signed_out" }));
    render(<StrictMode><IntelligencePanel /></StrictMode>);
    expect(await screen.findByText(CONSENT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await waitFor(() => expect(screen.getByText("ChatGPT signed in")).toBeTruthy(), { timeout: 2_500 });
    expect((screen.getByLabelText("Orient model") as HTMLSelectElement).disabled).toBe(false);
  });

  it("serializes the complete provider-dependent control surface during a step mutation", async () => {
    let finishSave!: (value: unknown) => void;
    const stepSave = new Promise<unknown>((resolve) => { finishSave = resolve; });
    const data = intelligence("claude-local", { stepCount: 11 });
    Object.assign(data, {
      golden: {
        runner_installed: true,
        runner_note: "installed",
        state: { status: "idle", started_at: null, finished_at: null, categories: null, step: null, candidate: null, applied: false, regressed: [], summary: null, error: null, reason: null },
      },
    });
    install(data, { stepSave });
    render(<IntelligencePanel />);
    const model = await screen.findByLabelText("Orient model");
    fireEvent.change(model, { target: { value: "claude-sonnet-4-5" } });
    await screen.findByText("Updating intelligence settings…");
    expect((screen.getByLabelText("AI provider") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getAllByLabelText(/ model$/).every((control) => (control as HTMLSelectElement).disabled)).toBe(true);
    expect(screen.getAllByLabelText(/ thinking$/).every((control) => (control as HTMLSelectElement).disabled)).toBe(true);
    expect(screen.getAllByLabelText(/ enabled$/).every((control) => (control as HTMLInputElement).disabled)).toBe(true);
    expect((screen.getByRole("button", { name: "Run golden set" }) as HTMLButtonElement).disabled).toBe(true);
    finishSave({ step: "orient", ok: true, gate: null });
    await waitFor(() => expect((screen.getByLabelText("AI provider") as HTMLSelectElement).disabled).toBe(false));
  });
});
