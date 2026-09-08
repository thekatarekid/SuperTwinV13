import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  get,
  getV2,
  killAllRegisteredProviders,
  list,
  listV2,
  register,
  registerV2,
  resetProviderRegistryForTests,
} from "./registry.js";
import type { LegacyProvider, ProviderId, ProviderV2 } from "./types.js";
import { emptyUsage } from "./usage.js";

beforeEach(resetProviderRegistryForTests);

function legacy(): LegacyProvider {
  return {
    id: "claude-local",
    cancel: () => false,
    send: async () => ({
      sessionId: "legacy",
      usage: emptyUsage(),
      freshFallback: false,
      status: "ok",
    }),
  };
}

function neutral(id: ProviderId, killAll = vi.fn()): ProviderV2 {
  return {
    id,
    displayName: id,
    capabilities: {
      functionTools: false,
      hostTools: id === "claude-local",
      continuation: true,
      requiresAuthentication: id === "chatgpt-oauth",
    },
    authState: () => ({ status: "ready", error: null }),
    catalogue: () => ({
      providerId: id,
      mode: "fallback",
      source: "test",
      discoveredAt: "2026-09-08T00:00:00.000Z",
      revision: "test",
      error: null,
      models: [],
    }),
    send: async () => ({
      continuation: null,
      usage: emptyUsage(),
      freshFallback: false,
      status: "ok",
    }),
    cancel: () => false,
    killAll,
  };
}

describe("parallel provider registries", () => {
  it("returns undefined for an unregistered V2 provider", () => {
    expect(getV2("chatgpt-oauth")).toBeUndefined();
  });

  it("keeps the one-release legacy registry isolated from strict V2 lookups", () => {
    const old = legacy();
    const modern = neutral("claude-local");
    register(old);
    registerV2(modern);
    expect(get("claude-local")).toBe(old);
    expect(getV2("claude-local")).toBe(modern);
    expect(list()).toEqual([old]);
    expect(listV2()).toEqual([modern]);
  });

  it("fans killAll out to every V2 provider even when one throws", () => {
    const first = vi.fn(() => {
      throw new Error("first failed");
    });
    const second = vi.fn();
    registerV2(neutral("claude-local", first));
    registerV2(neutral("chatgpt-oauth", second));
    expect(() => killAllRegisteredProviders()).toThrow(AggregateError);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("replaces one provider id without duplicating shutdown work", () => {
    const oldKill = vi.fn();
    const newKill = vi.fn();
    registerV2(neutral("claude-local", oldKill));
    registerV2(neutral("claude-local", newKill));
    killAllRegisteredProviders();
    expect(oldKill).not.toHaveBeenCalled();
    expect(newKill).toHaveBeenCalledOnce();
    expect(listV2()).toHaveLength(1);
  });
});
