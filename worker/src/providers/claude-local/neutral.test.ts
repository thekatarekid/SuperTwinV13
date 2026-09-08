import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  LegacyProviderResult,
  ProviderModel,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderStreamEvent,
} from "../types.js";
import { emptyUsage } from "../usage.js";
import { StreamJsonParser } from "./parser.js";
import { claudeLocalAuthState, createNeutralClaudeProvider } from "./neutral.js";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function boundContinuation(instructions: string, selectedModel = "claude-test"): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      providerId: "claude-local",
      model: selectedModel,
      instructions,
    }))
    .digest("hex");
  return `claude-local:v1:${SESSION_ID}:${digest}`;
}

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "claude-test",
    displayName: "Claude Test",
    isDefault: true,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues: ["off", "low", "high"],
    defaultReasoning: "off",
    supportsTools: true,
    supportsHostTools: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: false,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    billingLabel: null,
    ...overrides,
  };
}

function catalogue(models: ProviderModel[] = [model()]): ProviderModelCatalogue {
  return {
    providerId: "claude-local",
    mode: "discovered",
    source: "test",
    discoveredAt: "2026-09-08T00:00:00.000Z",
    revision: "claude-test-revision",
    error: null,
    models,
  };
}

function request(events: ProviderStreamEvent[], overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: "run-neutral",
    model: "claude-test",
    instructions: "",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "exact prompt" }],
    }],
    maxOutputTokens: 8_192,
    maxAgentTurns: 1,
    onEvent: (event) => events.push(event),
    ...overrides,
  };
}

function legacyResult(overrides: Partial<LegacyProviderResult> = {}): LegacyProviderResult {
  return {
    sessionId: SESSION_ID,
    usage: emptyUsage(),
    freshFallback: false,
    status: "ok",
    ...overrides,
  };
}

function harness(sendImplementation?: (
  options: Parameters<ReturnType<typeof legacyTransport>["sendWithDirectInstructions"]>[0],
  instructions: string,
) => Promise<LegacyProviderResult>) {
  const transport = legacyTransport(sendImplementation);
  return {
    transport,
    provider: createNeutralClaudeProvider({
      legacy: transport,
      catalogue,
      supportsEffort: () => true,
    }),
  };
}

function legacyTransport(sendImplementation?: (
  options: Parameters<typeof defaultLegacySend>[0],
  instructions: string,
) => Promise<LegacyProviderResult>) {
  return {
    sendWithDirectInstructions: vi.fn(sendImplementation ?? defaultLegacySend),
    cancel: vi.fn(() => true),
    killAll: vi.fn(),
  };
}

async function defaultLegacySend(
  _options: Omit<import("../types.js").LegacySendOptions, "systemPromptFile">,
  _instructions: string,
): Promise<LegacyProviderResult> {
  return legacyResult();
}

describe("neutral Claude facade", () => {
  it("passes direct instructions exactly through a fake CLI, including blank and poison fallback", async () => {
    const stage = mkdtempSync(join(tmpdir(), "st-neutral-direct-"));
    const fakeCli = join(stage, "fake-claude.cjs");
    const callsFile = join(stage, "calls.ndjson");
    const prior = new Map([
      ["CLAUDE_BIN", process.env.CLAUDE_BIN],
      ["ST_NEUTRAL_CALLS", process.env.ST_NEUTRAL_CALLS],
      ["SUPERTWIN_TRACE_ENFORCE", process.env.SUPERTWIN_TRACE_ENFORCE],
    ]);
    writeFileSync(fakeCli, [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(2);",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.appendFileSync(process.env.ST_NEUTRAL_CALLS, JSON.stringify({ argv, stdin }) + '\\n');",
      "  const resumeAt = argv.indexOf('--resume');",
      "  if (resumeAt >= 0) {",
      "    const sid = argv[resumeAt + 1];",
      "    process.stdout.write(JSON.stringify({ type:'result', subtype:'error_during_execution', is_error:true, num_turns:0, session_id:sid, total_cost_usd:0, usage:{input_tokens:0,output_tokens:0}, errors:['No conversation found with session ID: ' + sid] }) + '\\n');",
      "  } else {",
      `    const sid = ${JSON.stringify(SESSION_ID)};`,
      "    process.stdout.write(JSON.stringify({ type:'system', subtype:'init', session_id:sid }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type:'result', subtype:'success', is_error:false, num_turns:1, stop_reason:'end_turn', session_id:sid, total_cost_usd:0, usage:{input_tokens:1,output_tokens:1} }) + '\\n');",
      "  }",
      "});",
      "",
    ].join("\n"), "utf8");
    chmodSync(fakeCli, 0o755);
    process.env.CLAUDE_BIN = fakeCli;
    process.env.ST_NEUTRAL_CALLS = callsFile;
    process.env.SUPERTWIN_TRACE_ENFORCE = "0";
    try {
      const { claudeLocalProvider } = await import("./index.js");
      const common = { message: "payload", onEvent: () => {} };
      await claudeLocalProvider.sendWithDirectInstructions(
        { ...common, runId: "direct-nonempty" },
        "EXACT DIRECT INSTRUCTIONS",
      );
      await claudeLocalProvider.sendWithDirectInstructions(
        { ...common, runId: "direct-blank" },
        "",
      );
      const poison = await claudeLocalProvider.sendWithDirectInstructions(
        { ...common, runId: "direct-poison", sessionId: SESSION_ID },
        "EXACT FALLBACK INSTRUCTIONS",
      );
      expect(poison.freshFallback).toBe(true);

      const calls = readFileSync(callsFile, "utf8").trim().split("\n").map((line) =>
        JSON.parse(line) as { argv: string[]; stdin: string });
      expect(calls).toHaveLength(4);
      const argValue = (args: string[], flag: string): string | undefined => {
        const at = args.indexOf(flag);
        return at < 0 ? undefined : args[at + 1];
      };
      expect(argValue(calls[0]!.argv, "--append-system-prompt"))
        .toBe("EXACT DIRECT INSTRUCTIONS");
      expect(calls[0]!.argv.filter((arg) => arg === "EXACT DIRECT INSTRUCTIONS")).toHaveLength(1);
      expect(calls[0]!.stdin).toBe("payload");
      expect(calls[1]!.argv).not.toContain("--append-system-prompt");
      expect(argValue(calls[2]!.argv, "--resume")).toBe(SESSION_ID);
      expect(calls[2]!.argv).not.toContain("--append-system-prompt");
      expect(argValue(calls[3]!.argv, "--append-system-prompt"))
        .toBe("EXACT FALLBACK INSTRUCTIONS");

      const blockedEvents: ProviderStreamEvent[] = [];
      const blocked = createNeutralClaudeProvider({
        legacy: claudeLocalProvider,
        catalogue,
        authState: () => ({ status: "signed_out", error: null }),
      });
      await expect(blocked.send(request(blockedEvents))).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      expect(readFileSync(callsFile, "utf8").trim().split("\n")).toHaveLength(4);
    } finally {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(stage, { recursive: true, force: true });
    }
  }, 20_000);

  it("maps every supported field exactly and modernizes continuation/tool/done events", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness(async (options) => {
      options.onEvent({ type: "session", sessionId: SESSION_ID });
      options.onEvent({ type: "tool_use", callId: "toolu-1", name: "Read", input: { path: "/tmp/x" } });
      options.onEvent({ type: "done", sessionId: SESSION_ID, usage: emptyUsage() });
      return legacyResult();
    });
    const abort = new AbortController();
    const result = await provider.send(request(events, {
      instructions: "exact instructions",
      hostTools: ["Read", "Grep"],
      text: { format: { type: "text" } },
      cache: { mode: "implicit" },
      continuation: { token: boundContinuation("exact instructions") },
      persistContinuation: true,
      skipHostSettings: true,
      cwd: "/tmp",
      reasoning: { budget: "high", effort: "high" },
      maxBudgetUsd: 0.25,
      timeoutMs: 9_000,
      signal: abort.signal,
    }));

    expect(transport.sendWithDirectInstructions).toHaveBeenCalledOnce();
    const [mapped, instructions] = transport.sendWithDirectInstructions.mock.calls[0]!;
    expect(instructions).toBe("exact instructions");
    expect(mapped).toMatchObject({
      runId: "run-neutral",
      message: "exact prompt",
      sessionId: SESSION_ID,
      allowedTools: ["Read", "Grep"],
      maxTurns: 1,
      persistSession: true,
      skipUserSettings: true,
      cwd: "/tmp",
      thinkingBudget: "high",
      effort: "high",
      maxBudgetUsd: 0.25,
      timeoutMs: 9_000,
      model: "claude-test",
      signal: abort.signal,
    });
    expect(mapped).not.toHaveProperty("systemPromptFile");
    expect(events).toEqual([
      { type: "continuation", token: boundContinuation("exact instructions") },
      { type: "tool_use", callId: "toolu-1", name: "Read", input: { path: "/tmp/x" } },
      { type: "done", continuation: boundContinuation("exact instructions"), usage: emptyUsage() },
    ]);
    expect(result).toMatchObject({
      continuation: boundContinuation("exact instructions"),
      status: "ok",
    });
  });

  it("preserves exact blank instructions instead of introducing a prompt fallback", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    await provider.send(request(events));
    expect(transport.sendWithDirectInstructions.mock.calls[0]?.[1]).toBe("");
  });

  it.each([
    ["image input", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }] }],
    ["function output", { input: [{ type: "function_call_output", call_id: "call", output: "ok" }] }],
    ["function tools", { tools: [{ type: "function", name: "x", description: "x", parameters: {}, strict: true }] }],
    ["required tool choice", { toolChoice: "required" }],
    ["host tools disabled", { toolChoice: "none", hostTools: ["Read"] }],
    ["parallel tools", { parallelToolCalls: true }],
    ["host parallel constraint", { parallelToolCalls: false, hostTools: ["Read"] }],
    ["JSON schema", { text: { format: { type: "json_schema", name: "x", strict: true, schema: {} } } }],
    ["verbosity", { text: { format: { type: "text" }, verbosity: "low" } }],
    ["disabled cache", { cache: { mode: "none" } }],
    ["explicit cache", { cache: { mode: "explicit", key: "x", ttl: "30m" } }],
  ] as const)("fails closed for unsupported %s before legacy send", async (_label, overrides) => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    const result = await provider.send(request(events, overrides as Partial<ProviderRequest>));
    expect(result).toMatchObject({ status: "error", errorCode: "CAPABILITY_UNSUPPORTED" });
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("never turns an invalid continuation into a fresh Claude session", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    const result = await provider.send(request(events, {
      continuation: { token: "not-a-session" },
    }));
    expect(result.errorCode).toBe("BAD_REQUEST");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("fails closed when resumed instructions differ from the bound session", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    const result = await provider.send(request(events, {
      instructions: "changed instructions",
      continuation: { token: boundContinuation("original instructions") },
    }));
    expect(result.errorCode).toBe("BAD_REQUEST");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("fails closed when a resume tries to replace the session's selected model", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    const result = await provider.send(request(events, {
      model: "claude-other",
      continuation: { token: boundContinuation("", "claude-test") },
    }));
    expect(result.errorCode).toBe("BAD_REQUEST");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("passes the raw UUID only after a continuation's instruction digest matches", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    await provider.send(request(events, {
      instructions: "original instructions",
      continuation: { token: boundContinuation("original instructions") },
    }));
    expect(transport.sendWithDirectInstructions.mock.calls[0]?.[0].sessionId).toBe(SESSION_ID);
  });

  it.each([
    ["comma-smuggled host tool", { hostTools: ["Read,Bash"] }],
    ["duplicate host tool", { hostTools: ["Read", "Read"] }],
    ["zero budget", { maxBudgetUsd: 0 }],
    ["negative budget", { maxBudgetUsd: -1 }],
    ["NaN budget", { maxBudgetUsd: Number.NaN }],
    ["zero timeout", { timeoutMs: 0 }],
    ["NaN timeout", { timeoutMs: Number.NaN }],
  ])("rejects invalid %s before the legacy transport", async (_label, overrides) => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    expect((await provider.send(request(events, overrides))).errorCode).toBe("BAD_REQUEST");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("maps host-tool auto choice but refuses every explicit parallelism setting", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    expect((await provider.send(request(events, {
      hostTools: ["Read"],
      toolChoice: "auto",
    }))).status).toBe("ok");
    expect(transport.sendWithDirectInstructions.mock.calls[0]?.[0].allowedTools).toEqual(["Read"]);
    expect((await provider.send(request(events, { parallelToolCalls: false }))).errorCode)
      .toBe("CAPABILITY_UNSUPPORTED");
  });

  it("accepts only the model's backend maximum because the CLI has no tighter output cap", async () => {
    const events: ProviderStreamEvent[] = [];
    const transport = legacyTransport();
    const provider = createNeutralClaudeProvider({ legacy: transport, catalogue });
    expect((await provider.send(request(events, { maxOutputTokens: 1_024 }))).errorCode)
      .toBe("CAPABILITY_UNSUPPORTED");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
    expect((await provider.send(request(events))).status).toBe("ok");
    expect(transport.sendWithDirectInstructions).toHaveBeenCalledOnce();
  });

  it("rejects output bounds above the catalogue ceiling as BAD_REQUEST", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    expect((await provider.send(request(events, { maxOutputTokens: 8_193 }))).errorCode)
      .toBe("BAD_REQUEST");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("fails closed when the catalogue lacks a model output ceiling", async () => {
    const events: ProviderStreamEvent[] = [];
    const transport = legacyTransport();
    const provider = createNeutralClaudeProvider({
      legacy: transport,
      catalogue: () => catalogue([model({ maxOutputTokens: null })]),
    });
    expect((await provider.send(request(events))).errorCode).toBe("CAPABILITY_UNSUPPORTED");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("enforces Claude's exact plain-completion turn and isolation contract", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    expect((await provider.send(request(events, {
      plainCompletion: true,
      maxAgentTurns: 1,
    }))).errorCode).toBe("BAD_REQUEST");
    expect((await provider.send(request(events, {
      plainCompletion: true,
      maxAgentTurns: 2,
      hostTools: ["Read"],
    }))).errorCode).toBe("BAD_REQUEST");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("refuses non-persisted resume because the Claude CLI cannot honor it", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    expect((await provider.send(request(events, {
      continuation: { token: boundContinuation("") },
      persistContinuation: false,
    }))).errorCode).toBe("CAPABILITY_UNSUPPORTED");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("derives the effort flag from the selected Claude model capability", async () => {
    const events: ProviderStreamEvent[] = [];
    const transport = legacyTransport();
    const effortProvider = createNeutralClaudeProvider({
      legacy: transport,
      catalogue,
      supportsEffort: () => true,
    });
    await effortProvider.send(request(events, {
      reasoning: { budget: "high" },
    }));
    expect(transport.sendWithDirectInstructions.mock.calls[0]?.[0]).toMatchObject({
      thinkingBudget: "high",
      effort: "high",
    });

    const tokenTransport = legacyTransport();
    const tokenProvider = createNeutralClaudeProvider({
      legacy: tokenTransport,
      catalogue,
      supportsEffort: () => false,
    });
    expect((await tokenProvider.send(request(events, {
      reasoning: { budget: "high", effort: "high" },
    }))).errorCode).toBe("CAPABILITY_UNSUPPORTED");
    expect(tokenTransport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("fails closed on a catalogue for another provider", async () => {
    const events: ProviderStreamEvent[] = [];
    const transport = legacyTransport();
    const provider = createNeutralClaudeProvider({
      legacy: transport,
      catalogue: () => ({ ...catalogue(), providerId: "chatgpt-oauth" }),
    });
    expect((await provider.send(request(events))).errorCode).toBe("MODEL_UNAVAILABLE");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("turns an uncorrelated legacy tool event into BACKEND_UNSUPPORTED", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider } = harness(async (options) => {
      options.onEvent({ type: "tool_use", name: "Read", input: {} });
      return legacyResult();
    });
    const result = await provider.send(request(events));
    expect(result.errorCode).toBe("BACKEND_UNSUPPORTED");
    expect(events).toEqual([expect.objectContaining({
      type: "error",
      code: "BACKEND_UNSUPPORTED",
    })]);
  });

  it("cancels immediately when a backend tool event has no call id", async () => {
    const events: ProviderStreamEvent[] = [];
    const transport = legacyTransport(async (options) => {
      options.onEvent({ type: "tool_use", name: "Read", input: {} });
      return legacyResult();
    });
    const provider = createNeutralClaudeProvider({ legacy: transport, catalogue });
    await provider.send(request(events));
    expect(transport.cancel).toHaveBeenCalledWith("run-neutral");
  });

  it.each([
    ["unrequested", [
      { type: "tool_use", callId: "toolu-1", name: "Bash", input: {} },
    ]],
    ["duplicate", [
      { type: "tool_use", callId: "toolu-1", name: "Read", input: {} },
      { type: "tool_use", callId: "toolu-1", name: "Read", input: {} },
    ]],
  ] as const)("cancels a backend %s tool call", async (_label, toolEvents) => {
    const events: ProviderStreamEvent[] = [];
    const transport = legacyTransport(async (options) => {
      for (const event of toolEvents) options.onEvent(event);
      return legacyResult();
    });
    const provider = createNeutralClaudeProvider({ legacy: transport, catalogue });
    const result = await provider.send(request(events, { hostTools: ["Read"] }));
    expect(result.errorCode).toBe("BACKEND_UNSUPPORTED");
    expect(transport.cancel).toHaveBeenCalledWith("run-neutral");
  });

  it("publishes only capabilities the neutral mapper can actually honor", () => {
    const { provider } = harness();
    expect(provider.capabilities).toMatchObject({
      functionTools: false,
      hostTools: true,
      continuation: true,
      requiresAuthentication: true,
    });
    expect(provider.catalogue().models[0]).toMatchObject({
      inputModalities: ["text"],
      supportsTools: false,
      supportsParallelToolCalls: false,
    });
  });

  it("classifies empty input as bad request but valid unmappable input as unsupported", async () => {
    const events: ProviderStreamEvent[] = [];
    const { provider, transport } = harness();
    expect((await provider.send(request(events, { input: [] }))).errorCode).toBe("BAD_REQUEST");
    expect((await provider.send(request(events, {
      input: [{
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "prior" }],
      }],
    }))).errorCode).toBe("CAPABILITY_UNSUPPORTED");
    expect(transport.sendWithDirectInstructions).not.toHaveBeenCalled();
  });

  it("reports local Claude auth state without exposing command output", () => {
    const ready = claudeLocalAuthState(vi.fn(() => ({
      pid: 1,
      output: [null, '{"loggedIn":true,"account":"private@example.com"}', ""],
      stdout: '{"loggedIn":true,"account":"private@example.com"}',
      stderr: "",
      status: 0,
      signal: null,
    })) as unknown as typeof import("node:child_process").spawnSync);
    expect(ready).toEqual({ status: "ready", error: null });

    const signedOut = claudeLocalAuthState(vi.fn(() => ({
      pid: 1,
      output: [null, '{"loggedIn":false}', "secret diagnostic"],
      stdout: '{"loggedIn":false}',
      stderr: "secret diagnostic",
      status: 1,
      signal: null,
    })) as unknown as typeof import("node:child_process").spawnSync);
    expect(signedOut).toEqual({ status: "signed_out", error: null });

    const missing = Object.assign(new Error("spawn ENOENT /private/path"), { code: "ENOENT" });
    const unavailable = claudeLocalAuthState(vi.fn(() => ({
      pid: 0,
      output: [null, null, null],
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
      error: missing,
    })) as unknown as typeof import("node:child_process").spawnSync);
    expect(unavailable).toEqual({ status: "unavailable", error: "Claude CLI is unavailable" });
    expect(JSON.stringify(unavailable)).not.toContain("private/path");
  });

  it.each([
    ["missing CLI", "SPAWN_FAILED", "child error: spawn ENOENT", "PROVIDER_UNAVAILABLE"],
    ["signed out", "CLI_ERROR", "Not logged in. Please run claude login", "AUTH_REQUIRED"],
    ["expired", "CLI_ERROR", "OAuth token expired", "AUTH_EXPIRED"],
  ] as const)("maps %s transport failures to a neutral typed error", async (
    _label,
    legacyCode,
    message,
    expectedCode,
  ) => {
    const events: ProviderStreamEvent[] = [];
    const transport = legacyTransport(async (options) => {
      options.onEvent({ type: "error", code: legacyCode, message });
      return legacyResult({ status: "error", errorCode: legacyCode });
    });
    const provider = createNeutralClaudeProvider({ legacy: transport, catalogue });
    const result = await provider.send(request(events));
    expect(result.errorCode).toBe(expectedCode);
    expect(events.at(-1)).toMatchObject({ type: "error", code: expectedCode });
  });

  it("keeps the transformed catalogue revision stable and input-sensitive", () => {
    const first = createNeutralClaudeProvider({ legacy: legacyTransport(), catalogue });
    const second = createNeutralClaudeProvider({
      legacy: legacyTransport(),
      catalogue: () => ({
        ...catalogue([model({ displayName: "Changed" })]),
        revision: "changed-source-revision",
      }),
    });
    expect(first.catalogue().revision).toBe(first.catalogue().revision);
    expect(second.catalogue().revision).not.toBe(first.catalogue().revision);
  });

  it("preserves the Claude wire tool id as the neutral callId", () => {
    const parser = new StreamJsonParser();
    const output = parser.push(
      '{"type":"assistant","message":{"id":"msg_wire","content":[{"type":"tool_use","id":"toolu_wire","name":"Read","input":{"file_path":"/tmp/x"}}]}}\n',
    );
    expect(output.events).toContainEqual({
      type: "tool_use",
      callId: "toolu_wire",
      name: "Read",
      input: { file_path: "/tmp/x" },
    });
  });

  it("ignores incomplete starts and deduplicates repeated full tool blocks", () => {
    const parser = new StreamJsonParser();
    const start = parser.push(
      '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_wire","name":"Read","input":{}}}}\n',
    );
    expect(start.events).toEqual([]);
    const full = '{"type":"assistant","message":{"id":"msg_wire","content":[{"type":"tool_use","id":"toolu_wire","name":"Read","input":{"file_path":"/tmp/x"}}]}}\n';
    expect(parser.push(full).events).toHaveLength(1);
    expect(parser.push(full).events).toEqual([]);
  });
});
