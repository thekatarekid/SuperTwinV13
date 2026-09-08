import type {
  NeutralProviderResult,
  ProviderId,
  ProviderCapabilities,
  ProviderModel,
  ProviderRequest,
  ProviderV2,
} from "./types.js";

export const TEST_PROVIDER_MODEL_ID = "claude-test-model";
export const TEST_PROVIDER_MAX_OUTPUT_TOKENS = 8_192;

/** Extract the single text message used by provider-neutral completion tests. */
export function providerRequestText(request: ProviderRequest): string {
  const item = request.input[0];
  const part = item?.type === "message" ? item.content[0] : undefined;
  if (
    request.input.length !== 1 ||
    item?.type !== "message" ||
    item.role !== "user" ||
    item.content.length !== 1 ||
    part?.type !== "input_text"
  ) {
    throw new Error("test expected exactly one user input_text item");
  }
  return part.text;
}

/** Complete offline ProviderV2 double; callers supply only send behavior. */
export function providerV2TestDouble(
  send: (request: ProviderRequest) => Promise<NeutralProviderResult>,
  options: {
    providerId?: ProviderId;
    model?: Partial<ProviderModel>;
    capabilities?: Partial<ProviderCapabilities>;
  } = {},
): ProviderV2 {
  const providerId = options.providerId ?? "claude-local";
  const model: ProviderModel = {
    id: TEST_PROVIDER_MODEL_ID,
    displayName: "Test Model",
    isDefault: true,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "off",
    supportsTools: false,
    supportsHostTools: false,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: 200_000,
    maxOutputTokens: TEST_PROVIDER_MAX_OUTPUT_TOKENS,
    billingLabel: null,
    ...options.model,
  };
  return {
    id: providerId,
    displayName: "Offline test provider",
    capabilities: {
      functionTools: false,
      hostTools: false,
      continuation: true,
      requiresAuthentication: false,
      ...options.capabilities,
    },
    authState: () => ({ status: "ready", error: null }),
    catalogue: () => ({
      providerId,
      mode: "discovered",
      source: "offline-test",
      discoveredAt: "2026-09-08T00:00:00.000Z",
      revision: "offline-test-revision",
      error: null,
      models: [model],
    }),
    send,
    cancel: () => false,
    killAll: () => {},
  };
}
