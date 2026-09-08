import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import {
  setActiveProvider,
  setProviderModelSelection,
  setProviderReasoningSelection,
} from "../db/settings.js";
import {
  encodeStepOverrides,
  STEP_OVERRIDES_ENV,
} from "../settings/overrides.js";
import {
  ProviderSelectionError,
  resolveModelCall,
} from "./selection.js";
import type {
  NeutralProviderResult,
  ProviderAuthState,
  ProviderCapabilities,
  ProviderId,
  ProviderModel,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderV2,
} from "./types.js";
import { emptyUsage } from "./usage.js";

function model(
  id: string,
  options: Partial<ProviderModel> = {},
): ProviderModel {
  return {
    id,
    displayName: id,
    isDefault: false,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "off",
    supportsTools: true,
    supportsHostTools: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    supportsStrictTools: true,
    supportsVerbosity: true,
    supportsPromptCacheKey: true,
    supportsPromptCacheOptions: true,
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    billingLabel: null,
    ...options,
  };
}

function fixtureCatalogue(providerId: ProviderId): ProviderModelCatalogue {
  const models = providerId === "claude-local"
    ? [
        model("haiku", { isDefault: true }),
        model("claude-haiku-4-5-20251001"),
        model("claude-sonnet-5"),
        model("claude-explicit"),
      ]
    : [
        model("gpt-default", {
          isDefault: true,
          reasoningValues: ["none", "low", "medium", "high", "xhigh"],
          defaultReasoning: "none",
        }),
        model("gpt-exact", {
          reasoningValues: ["none", "low", "medium", "high", "xhigh"],
          defaultReasoning: "medium",
        }),
        model("gpt-family"),
        model("gpt-stem"),
        model("gpt-other"),
      ];
  return {
    providerId,
    mode: "discovered",
    source: `${providerId}-fixture`,
    discoveredAt: "2026-09-08T00:00:00.000Z",
    revision: `${providerId}-revision-1`,
    error: null,
    models,
  };
}

class FakeProvider implements ProviderV2 {
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities = {
    functionTools: true,
    hostTools: true,
    continuation: true,
    requiresAuthentication: false,
  };

  constructor(
    readonly id: ProviderId,
    private readonly models: ProviderModelCatalogue = fixtureCatalogue(id),
  ) {
    this.displayName = id;
  }

  authState(): ProviderAuthState {
    return { status: "ready", error: null };
  }

  catalogue(): ProviderModelCatalogue {
    return this.models;
  }

  async send(_request: ProviderRequest): Promise<NeutralProviderResult> {
    return {
      continuation: null,
      usage: emptyUsage(),
      freshFallback: false,
      status: "ok",
    };
  }

  cancel(): boolean {
    return false;
  }

  killAll(): void {}
}

let scratchHome: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "supertwin-selection-"));
  process.env.SUPERTWIN_HOME = scratchHome;
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env[STEP_OVERRIDES_ENV];
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env[STEP_OVERRIDES_ENV];
  rmSync(scratchHome, { recursive: true, force: true });
});

describe("provider/model selection snapshot", () => {
  it("preserves exact -> settingsKey -> stem model precedence", () => {
    const provider = new FakeProvider("chatgpt-oauth");
    setProviderModelSelection("chatgpt-oauth", "live", "gpt-stem");
    setProviderModelSelection("chatgpt-oauth", "orient.v6", "gpt-family");
    setProviderModelSelection("chatgpt-oauth", "live.v1", "gpt-exact");

    expect(resolveModelCall({
      source: "step",
      key: "live.v1",
      fallbackKeys: ["orient.v6"],
    }, { provider }).model).toBe("gpt-exact");
  });

  it("uses an explicit settingsKey before a version stem", () => {
    const provider = new FakeProvider("chatgpt-oauth");
    setProviderModelSelection("chatgpt-oauth", "live", "gpt-stem");
    setProviderModelSelection("chatgpt-oauth", "orient.v6", "gpt-family");

    expect(resolveModelCall({
      source: "step",
      key: "live.v1",
      fallbackKeys: ["orient.v6"],
    }, { provider }).model).toBe("gpt-family");
  });

  it("falls back from a versioned step to its stem for model and reasoning", () => {
    const provider = new FakeProvider("chatgpt-oauth");
    setProviderModelSelection("chatgpt-oauth", "orient", "gpt-stem");
    setProviderReasoningSelection("chatgpt-oauth", "orient", "high");

    expect(resolveModelCall({ source: "step", key: "orient.v7" }, {
      provider,
    })).toMatchObject({
      key: "orient.v7",
      model: "gpt-stem",
      reasoning: "high",
    });
  });

  it("keeps the distinct Claude role and step defaults for shared keys", () => {
    const provider = new FakeProvider("claude-local");

    expect(resolveModelCall({ source: "role", key: "extract" }, {
      provider,
    }).model).toBe("claude-sonnet-5");
    expect(resolveModelCall({ source: "step", key: "extract" }, {
      provider,
    }).model).toBe("haiku");
    expect(resolveModelCall({ source: "role", key: "classify" }, {
      provider,
    }).model).toBe("claude-haiku-4-5-20251001");
  });

  it("uses the selected provider's advertised default and default reasoning when unset", () => {
    const provider = new FakeProvider("chatgpt-oauth");
    const resolved = resolveModelCall({ source: "step", key: "decide" }, {
      provider,
    });

    expect(resolved).toMatchObject({
      providerId: "chatgpt-oauth",
      model: "gpt-default",
      reasoning: "off",
      catalogueRevision: "chatgpt-oauth-revision-1",
    });
  });

  it("never replaces an explicit unavailable or hidden saved model", () => {
    const catalogue = fixtureCatalogue("chatgpt-oauth");
    catalogue.models.push(model("gpt-hidden", { hidden: true }));
    const provider = new FakeProvider("chatgpt-oauth", catalogue);

    for (const selected of ["gpt-missing", "gpt-hidden"]) {
      setProviderModelSelection("chatgpt-oauth", "decide", selected);
      expect(() => resolveModelCall({ source: "step", key: "decide" }, {
        provider,
      })).toThrow(expect.objectContaining<Partial<ProviderSelectionError>>({
        code: "MODEL_UNAVAILABLE",
        model: selected,
      }));
    }
  });

  it("does not fall back to Claude when the active provider is unavailable", () => {
    setActiveProvider("chatgpt-oauth");
    const claude = new FakeProvider("claude-local");

    expect(() => resolveModelCall({ source: "step", key: "orient" }, {
      getProvider: (providerId) =>
        providerId === "claude-local" ? claude : undefined,
    })).toThrow(expect.objectContaining<Partial<ProviderSelectionError>>({
      code: "PROVIDER_UNAVAILABLE",
      providerId: "chatgpt-oauth",
    }));
  });

  it("honours one candidate override as a provider/model/reasoning unit", () => {
    setActiveProvider("claude-local");
    process.env[STEP_OVERRIDES_ENV] = encodeStepOverrides({
      decide: {
        provider: "chatgpt-oauth",
        model: "gpt-exact",
        thinking: "high",
      },
    });
    const providers = new Map<ProviderId, ProviderV2>([
      ["claude-local", new FakeProvider("claude-local")],
      ["chatgpt-oauth", new FakeProvider("chatgpt-oauth")],
    ]);

    expect(resolveModelCall({ source: "step", key: "decide.v9" }, {
      getProvider: (providerId) => providers.get(providerId),
    })).toMatchObject({
      providerId: "chatgpt-oauth",
      model: "gpt-exact",
      reasoning: "high",
    });
  });

  it("keeps an explicitly injected test provider isolated from another provider's override", () => {
    process.env[STEP_OVERRIDES_ENV] = encodeStepOverrides({
      decide: {
        provider: "chatgpt-oauth",
        model: "gpt-exact",
        thinking: "high",
      },
    });

    expect(resolveModelCall({ source: "step", key: "decide" }, {
      provider: new FakeProvider("claude-local"),
    })).toMatchObject({
      providerId: "claude-local",
      model: "haiku",
      reasoning: "off",
    });
  });

  it("clamps ChatGPT max through the catalogue capability mapping", () => {
    const provider = new FakeProvider("chatgpt-oauth");
    setProviderModelSelection("chatgpt-oauth", "decide", "gpt-exact");
    setProviderReasoningSelection("chatgpt-oauth", "decide", "max");

    expect(resolveModelCall({ source: "step", key: "decide" }, {
      provider,
    }).reasoning).toBe("xhigh");
  });

  it("returns a frozen snapshot that ignores later settings and registry changes", () => {
    setActiveProvider("chatgpt-oauth");
    setProviderModelSelection("chatgpt-oauth", "decide", "gpt-exact");
    setProviderReasoningSelection("chatgpt-oauth", "decide", "high");
    const first = new FakeProvider("chatgpt-oauth");
    let registered: ProviderV2 = first;
    const snapshot = resolveModelCall({ source: "step", key: "decide" }, {
      getProvider: () => registered,
    });

    setActiveProvider("claude-local");
    setProviderModelSelection("chatgpt-oauth", "decide", "gpt-other");
    registered = new FakeProvider("chatgpt-oauth", {
      ...fixtureCatalogue("chatgpt-oauth"),
      revision: "replacement-revision",
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.provider).toBe(first);
    expect(snapshot).toMatchObject({
      providerId: "chatgpt-oauth",
      model: "gpt-exact",
      reasoning: "high",
      catalogueRevision: "chatgpt-oauth-revision-1",
    });
  });
});
