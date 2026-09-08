// Provider registry (Cabinet-style). Minimal by design — register concrete
// providers at worker startup, then resolve by id. The Claude adapter agent
// registers "claude-local" and it is the default.

import type { Provider, ProviderId, ProviderV2 } from "./types.js";

export interface ProviderFacades {
  /** One-release Claude-only compatibility surface. */
  legacy: Provider;
  /** Strict provider-neutral surface used by all migrated work. */
  v2: ProviderV2;
}

/** Default provider id used when a caller does not specify one. */
export const DEFAULT_PROVIDER_ID = "claude-local";

const providers = new Map<string, Provider>();
const providersV2 = new Map<ProviderId, ProviderV2>();

/** Register (or replace) a provider by its id. */
export function register(provider: Provider): void {
  providers.set(provider.id, provider);
}

/** Look up a provider by id, or undefined if not registered. */
export function get(id: string = DEFAULT_PROVIDER_ID): Provider | undefined {
  return providers.get(id);
}

/** List all registered providers. */
export function list(): Provider[] {
  return [...providers.values()];
}

/** Register a strict provider-neutral backend without changing legacy lookups. */
export function registerV2(provider: ProviderV2): void {
  providersV2.set(provider.id, provider);
}

/**
 * Register both views of one backend as one boot operation. A mismatched pair
 * is refused before either registry changes, so legacy and strict callers can
 * never resolve different provider identities after a partial bootstrap.
 */
export function registerProviderFacades(facades: ProviderFacades): void {
  if (facades.legacy.id !== facades.v2.id) {
    throw new TypeError("legacy and V2 provider facades must have the same id");
  }
  providers.set(facades.legacy.id, facades.legacy);
  providersV2.set(facades.v2.id, facades.v2);
}

/** Strict lookup used by the provider/model resolver and migrated call sites. */
export function getV2(id: ProviderId): ProviderV2 | undefined {
  return providersV2.get(id);
}

/** Every strict provider registered for new work. */
export function listV2(): ProviderV2[] {
  return [...providersV2.values()];
}

/**
 * Fan out even when one provider misbehaves. Callers may log the aggregate,
 * but no later provider is allowed to retain in-flight work.
 */
export function killAllRegisteredProviders(): void {
  const failures: unknown[] = [];
  // The map already deduplicates replacements by id. The Set additionally
  // protects shutdown if two ids ever intentionally expose one shared facade.
  for (const provider of new Set(providersV2.values())) {
    try {
      provider.killAll();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "one or more providers failed to kill all work");
  }
}

/** Test-only process-global cleanup. */
export function resetProviderRegistryForTests(): void {
  providers.clear();
  providersV2.clear();
}
