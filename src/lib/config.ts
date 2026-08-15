// Central config for the UI. The worker base URL is a single overridable
// constant so the whole app points at one place (Phase 0 §8).
//
// Override order (first defined wins):
//   1. Vite env  VITE_WORKER_BASE_URL  (build/dev time)
//   2. window.__SUPERTWIN_WORKER_BASE_URL__ (runtime injection / tests)
//   3. the localhost default the worker binds to (§7: port 8011)

const DEFAULT_WORKER_BASE_URL = "http://localhost:8011";

function readEnvBaseUrl(): string | undefined {
  // import.meta.env is present under Vite/vitest; guard for other runtimes.
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    const v = env?.VITE_WORKER_BASE_URL;
    return v && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function readRuntimeBaseUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const v = (window as unknown as { __SUPERTWIN_WORKER_BASE_URL__?: string })
    .__SUPERTWIN_WORKER_BASE_URL__;
  return v && v.length > 0 ? v : undefined;
}

/** Base URL of the local worker, without a trailing slash. */
export const WORKER_BASE_URL: string = (
  readRuntimeBaseUrl() ??
  readEnvBaseUrl() ??
  DEFAULT_WORKER_BASE_URL
).replace(/\/+$/, "");

/** Build a full worker URL from a leading-slash path, e.g. "/api/health". */
export function workerUrl(path: string): string {
  return `${WORKER_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
