// Built-in provider bootstrap. This is the only production seam that knows
// concrete Claude module paths; worker/index.ts and all other consumers depend
// only on the provider module.

import { claudeLocalProvider } from "./claude-local/index.js";
import { claudeLocalProviderV2 } from "./claude-local/neutral.js";
import {
  registerProviderFacades,
  type ProviderFacades,
} from "./registry.js";

/**
 * Register the one-release legacy facade and strict V2 facade together. The
 * V2 singleton is constructed over `claudeLocalProvider`, so cancellation and
 * killAll reach the exact same underlying in-flight child map.
 */
export function bootstrapBuiltInProviders(
  facades: ProviderFacades = {
    legacy: claudeLocalProvider,
    v2: claudeLocalProviderV2,
  },
): Readonly<ProviderFacades> {
  registerProviderFacades(facades);
  return Object.freeze({ ...facades });
}
