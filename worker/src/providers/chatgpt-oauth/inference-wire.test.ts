import { expect, it } from "vitest";

import { buildChatGptInferenceWire, CHATGPT_RESPONSES_URL } from "./inference-wire.js";
import { CODEX_RESPONSES_URL } from "./probe/constants.js";
import { buildContractProbeMatrix } from "./probe/matrix.js";
import { buildChatGptRequest } from "./request.js";
import type { ProviderModel } from "../types.js";
import { buildProductionCanaryRequest } from "./index.js";

it("freezes one inference wire contract for production and the Phase 0b probe", () => {
  expect(CODEX_RESPONSES_URL).toBe(CHATGPT_RESPONSES_URL);
  const body = JSON.stringify({ model: "gpt-visible", instructions: "", input: [{ type: "message", role: "user",
    content: [{ type: "input_text", text: "Reply with OK." }] }], store: false, stream: true });
  const init = buildChatGptInferenceWire({ accessToken: "token", accountId: "account", userAgent: "SuperTwinV13/13.12.2",
    sessionId: "session", requestId: "request", bodyText: body });
  expect(init).toEqual({ method: "POST", redirect: "error", body, headers: {
    Authorization: "Bearer token", "ChatGPT-Account-ID": "account", "User-Agent": "SuperTwinV13/13.12.2",
    originator: "supertwinv13", Accept: "application/json", "Content-Type": "application/json",
    session_id: "session", "x-client-request-id": "request",
  } });
  expect(init).not.toHaveProperty("compress");
  expect((init.headers as Record<string, string>)).not.toHaveProperty("Accept-Encoding");
});

it("keeps matrix sequence one identical to the production compatibility canary", () => {
  const canary = buildContractProbeMatrix("gpt-visible")[0]!;
  const model: ProviderModel = { id: "gpt-visible", displayName: "Visible", isDefault: true, hidden: false,
    inputModalities: ["text"], reasoningValues: [], defaultReasoning: null, supportsTools: false,
    supportsHostTools: false, supportsParallelToolCalls: false, supportsStructuredOutput: false,
    supportsStrictTools: false, supportsVerbosity: false, supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false, contextWindow: null, maxOutputTokens: null,
    billingLabel: "ChatGPT subscription" };
  const production = buildChatGptRequest(buildProductionCanaryRequest(model, "canary", () => undefined), model);
  expect(production).toEqual(canary.body);
  expect((production.input[0] as { content: Array<{ text: string }> }).content[0]!.text).toBe("Reply with OK.");
  expect(JSON.stringify(canary.body)).not.toContain("deterministic cache measurement prefix");
});
