import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "st-phase6-provider-"));
process.env.SUPERTWIN_HOME = scratch;
process.env.SUPERTWIN_DB_PATH = join(scratch, "st.db");
process.env.SUPERTWIN_CHAT_CWD = join(scratch, "chat");
process.env.SUPERTWIN_BRAIN_DIR = join(scratch, "brain");
process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "0";

const db = await import("../db/index.js");
const { closeDb } = await import("../db/connection.js");
const { appStateSet } = await import("../db/ingest.js");
const { setActiveProvider } = await import("../db/settings.js");
const { providerV2TestDouble } = await import("../providers/test-support.js");
const { emptyUsage } = await import("../providers/usage.js");
const { registerV2, resetProviderRegistryForTests } = await import("../providers/registry.js");
const { startServer } = await import("./index.js");
import type {
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderV2,
} from "../providers/types.js";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";

const model = (id: string, hidden = false) => ({
  id,
  displayName: id,
  isDefault: !hidden,
  hidden,
  inputModalities: ["text" as const],
  reasoningValues: ["off"],
  defaultReasoning: "off",
  supportsTools: false,
  supportsHostTools: false,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: false,
  supportsStrictTools: false,
  supportsVerbosity: false,
  supportsPromptCacheKey: false,
  supportsPromptCacheOptions: false,
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  billingLabel: null,
});

function provider(
  providerId: "claude-local" | "chatgpt-oauth",
  modelId: string,
  send: (request: ProviderRequest) => ReturnType<ProviderV2["send"]>,
): ProviderV2 {
  return providerV2TestDouble(send, {
    providerId,
    model: model(modelId),
    capabilities: { continuation: true },
  });
}

async function json(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function chat(body: unknown): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const frames: Array<Record<string, unknown>> = [];
  for (const line of (await response.text()).split("\n")) {
    if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
  }
  return frames;
}

beforeAll(async () => {
  mkdirSync(process.env.SUPERTWIN_CHAT_CWD!, { recursive: true });
  mkdirSync(process.env.SUPERTWIN_BRAIN_DIR!, { recursive: true });
  db.runMigrations();
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

beforeEach(() => {
  resetProviderRegistryForTests();
  setActiveProvider("claude-local");
  appStateSet("ai.chatgpt.enabled", "0");
});

afterAll(async () => {
  await server.close();
  resetProviderRegistryForTests();
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_CHAT_CWD;
  delete process.env.SUPERTWIN_BRAIN_DIR;
  delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
  rmSync(scratch, { recursive: true, force: true });
});

describe("Phase 6 provider server acceptance", () => {
  it("restores provider-specific choices and keeps hidden models out of both settings APIs", async () => {
    registerV2(provider("claude-local", "haiku", async () => { throw new Error("must not send"); }));
    const chatgpt = provider("chatgpt-oauth", "gpt-visible", async () => { throw new Error("must not send"); });
    const catalogue: ProviderModelCatalogue = {
      ...chatgpt.catalogue(),
      models: [model("gpt-visible"), model("gpt-hidden", true)],
    };
    registerV2({ ...chatgpt, catalogue: () => catalogue });
    appStateSet("ai.chatgpt.enabled", "1");

    expect((await json("/api/settings/provider", "POST", { provider: "chatgpt-oauth" })).status).toBe(200);
    expect((await json("/api/settings/intelligence", "POST", {
      step: "decide", model: "gpt-visible", thinking: "off",
    })).status).toBe(200);
    expect((await json("/api/settings/intelligence", "POST", {
      step: "decide", model: "gpt-hidden",
    })).status).toBe(400);
    expect((await json("/api/settings/models", "POST", {
      role: "chat", model: "gpt-hidden",
    })).status).toBe(400);

    expect((await json("/api/settings/provider", "POST", { provider: "claude-local" })).status).toBe(200);
    const legacyClaude = await json("/api/settings/models");
    expect(legacyClaude.status).toBe(200);
    expect(legacyClaude.body.models.some((entry: { id: string }) => entry.id === "haiku")).toBe(true);

    const restored = await json("/api/settings/provider", "POST", { provider: "chatgpt-oauth" });
    expect(restored.body.steps.find((step: { key: string }) => step.key === "decide"))
      .toMatchObject({ selected_model: "gpt-visible", available: true });
    const legacyChatGpt = await json("/api/settings/models");
    expect(legacyChatGpt.body.models.map((entry: { id: string }) => entry.id)).toEqual(["gpt-visible"]);
  });

  it.each([
    ["signed_out", "AUTH_REQUIRED", 0],
    ["expired", "AUTH_EXPIRED", 0],
    ["ready", "RATE_LIMITED", 1],
  ] as const)("returns selected ChatGPT %s failure without Claude or API-key fallback", async (
    authStatus,
    expectedCode,
    expectedTransportCalls,
  ) => {
    const claudeSend = vi.fn<ProviderV2["send"]>();
    const chatGptTransport = vi.fn();
    const chatGptSend = vi.fn<ProviderV2["send"]>(async () => {
      if (authStatus !== "ready") {
        throw Object.assign(new Error("private authentication detail"), { code: expectedCode });
      }
      chatGptTransport();
      return {
        continuation: null,
        usage: emptyUsage(),
        freshFallback: false,
        status: "error",
        errorCode: "RATE_LIMITED",
      };
    });
    registerV2(provider("claude-local", "haiku", claudeSend));
    const chatGpt = provider("chatgpt-oauth", "gpt-visible", chatGptSend);
    registerV2({
      ...chatGpt,
      authState: () => ({ status: authStatus, error: null }),
    });
    appStateSet("ai.chatgpt.enabled", "1");
    setActiveProvider("chatgpt-oauth");

    const frames = await chat({
      runId: "phase6-no-fallback",
      conversationId: randomUUID(),
      message: "hello",
      grounded: false,
    });
    expect(frames).toContainEqual({
      type: "error",
      code: expectedCode,
      message: `provider request failed (${expectedCode})`,
    });
    expect(chatGptSend).toHaveBeenCalledOnce();
    expect(chatGptTransport).toHaveBeenCalledTimes(expectedTransportCalls);
    expect(claudeSend).not.toHaveBeenCalled();
    expect(JSON.stringify(frames)).not.toContain("private authentication detail");
    expect(JSON.stringify(frames)).not.toMatch(/api[ _-]?key/i);
  });

});
