import type { ChildProcess } from "node:child_process";

import {
  type BrowserAuthSmokeHooks,
} from "./browser-auth-smoke.js";
import { startBrowserLoopback } from "./browser-loopback.js";
import type { BrowserSmokeNetworkCounts } from "./browser-smoke-budget.js";

export interface BrowserSmokeRuntimeOptions {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onNetworkActuals(counts: BrowserSmokeNetworkCounts): void;
}

function waitForBrowserOpener(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`system browser opener failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

/**
 * Construct the real macOS hooks only after the CLI has passed every preflight
 * gate and printed its bounded-network declaration.
 */
export async function createBrowserSmokeRuntimeHooks(
  options: BrowserSmokeRuntimeOptions,
): Promise<BrowserAuthSmokeHooks> {
  if (process.platform !== "darwin") {
    throw new Error("REFUSED: browser-auth smoke requires the macOS system browser opener");
  }
  const [{ randomBytes }, { spawn }] = await Promise.all([
    import("node:crypto"),
    import("node:child_process"),
  ]);
  return {
    fetch: globalThis.fetch,
    randomBytes,
    now: Date.now,
    env: { ...options.env },
    signal: options.signal,
    listenerFactory: startBrowserLoopback,
    onNetworkActuals: options.onNetworkActuals,
    async openAuthorizationUrl(url, signal): Promise<void> {
      const child = spawn("/usr/bin/open", [url], {
        shell: false,
        stdio: "ignore",
        signal,
      });
      await waitForBrowserOpener(child);
    },
  };
}
