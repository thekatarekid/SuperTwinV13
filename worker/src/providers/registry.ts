// Provider registry (Cabinet-style). Minimal by design — register concrete
// providers at worker startup, then resolve by id. The Claude adapter agent
// registers "claude-local" and it is the default.

import type { Provider } from "./types.js";

/** Default provider id used when a caller does not specify one. */
export const DEFAULT_PROVIDER_ID = "claude-local";

const providers = new Map<string, Provider>();

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
