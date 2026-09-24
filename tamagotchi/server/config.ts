import { geminiProvider } from "./providers/gemini.ts";
import { mfluxInstalled, mfluxProvider } from "./providers/mflux.ts";
import { mockProvider } from "./providers/mock.ts";
import { pollinationsProvider } from "./providers/pollinations.ts";
import type { ImageProvider } from "./providers/types.ts";

/**
 * Picks the image provider from the environment:
 *   IMAGE_PROVIDER=local|pollinations|gemini|mock forces one;
 *   otherwise: local MFLUX if it's installed (free), then the first configured
 *   key (Pollinations, then Gemini); with nothing set up, offline demo mode.
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env, hasMflux = () => mfluxInstalled(env.MFLUX_BIN?.trim() || undefined, env.PATH)): ImageProvider {
  const forced = env.IMAGE_PROVIDER?.trim().toLowerCase();
  const pollKey = env.POLLINATIONS_API_KEY?.trim();
  const gemKey = env.GEMINI_API_KEY?.trim();

  if (forced === "mock") return mockProvider();
  if (forced === "local" || (!forced && hasMflux())) {
    return mfluxProvider({
      bin: env.MFLUX_BIN?.trim() || undefined,
      model: env.MFLUX_MODEL?.trim() || undefined,
      quantize: intFromEnv(env.MFLUX_QUANTIZE, 8),
      steps: intFromEnv(env.MFLUX_STEPS, 4),
      lowRam: env.MFLUX_LOW_RAM === "1",
    });
  }
  if (forced === "pollinations" || (!forced && pollKey)) {
    if (!pollKey) throw new Error("IMAGE_PROVIDER=pollinations but POLLINATIONS_API_KEY is empty");
    return pollinationsProvider(pollKey, env.POLLINATIONS_MODEL?.trim() || undefined);
  }
  if (forced === "gemini" || (!forced && gemKey)) {
    if (!gemKey) throw new Error("IMAGE_PROVIDER=gemini but GEMINI_API_KEY is empty");
    return geminiProvider(gemKey, env.GEMINI_MODEL?.trim() || undefined);
  }
  if (forced) throw new Error(`Unknown IMAGE_PROVIDER "${forced}" (use local, pollinations, gemini or mock)`);
  return mockProvider();
}

export function intFromEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
