import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
} from "./constants.js";
import { assertBrowserAuthorizationUrl } from "./browser-pkce.js";

export interface BrowserSmokeNetworkCounts {
  authorizeNavigation: number;
  tokenExchange: number;
  tokenRefresh: number;
  deviceCode: number;
  devicePoll: number;
  models: number;
  quota: number;
  inference: number;
  other: number;
  workerFetchTotal: number;
  controlledRemoteTotal: number;
}

type CountedEndpoint = Exclude<
  keyof BrowserSmokeNetworkCounts,
  "workerFetchTotal" | "controlledRemoteTotal"
>;

export const BROWSER_SMOKE_NETWORK_LIMITS: Readonly<
  Record<CountedEndpoint, number>
> = Object.freeze({
  authorizeNavigation: 1,
  tokenExchange: 1,
  tokenRefresh: 1,
  deviceCode: 0,
  devicePoll: 0,
  models: 0,
  quota: 0,
  inference: 0,
  other: 0,
});
export const BROWSER_SMOKE_WORKER_FETCH_LIMIT = 2;
export const BROWSER_SMOKE_CONTROLLED_REMOTE_LIMIT = 3;

export const ZERO_BROWSER_SMOKE_NETWORK_COUNTS: Readonly<BrowserSmokeNetworkCounts> =
  Object.freeze({
    authorizeNavigation: 0,
    tokenExchange: 0,
    tokenRefresh: 0,
    deviceCode: 0,
    devicePoll: 0,
    models: 0,
    quota: 0,
    inference: 0,
    other: 0,
    workerFetchTotal: 0,
    controlledRemoteTotal: 0,
  });

export function formatBrowserSmokeNetworkActuals(
  counts: BrowserSmokeNetworkCounts,
): string {
  return `PHASE_0B_BROWSER_AUTH_SMOKE_ACTUALS=${JSON.stringify(counts)}`;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function grantType(init?: RequestInit): string | undefined {
  const body = init?.body;
  const params = body instanceof URLSearchParams
    ? body
    : typeof body === "string"
      ? new URLSearchParams(body)
      : undefined;
  const values = params?.getAll("grant_type") ?? [];
  if (values.length === 1) return values[0];
  return undefined;
}

function endpointFor(input: string | URL | Request, init?: RequestInit): CountedEndpoint {
  const url = requestUrl(input);
  if (url === CODEX_OAUTH_TOKEN_URL && init?.method === "POST") {
    const grant = grantType(init);
    if (grant === "authorization_code") return "tokenExchange";
    if (grant === "refresh_token") return "tokenRefresh";
  }
  if (url === CODEX_DEVICE_CODE_URL) return "deviceCode";
  if (url === CODEX_DEVICE_TOKEN_URL) return "devicePoll";
  if (url === CODEX_MODELS_URL) return "models";
  if (url === CODEX_USAGE_URL) return "quota";
  if (url === CODEX_RESPONSES_URL) return "inference";
  return "other";
}

export class BrowserSmokeNetworkBudget {
  readonly #counts: BrowserSmokeNetworkCounts = {
    ...ZERO_BROWSER_SMOKE_NETWORK_COUNTS,
  };

  #admit(endpoint: CountedEndpoint): void {
    if (this.#counts[endpoint] >= BROWSER_SMOKE_NETWORK_LIMITS[endpoint]) {
      throw new Error(`REFUSED: browser-auth smoke network budget exhausted for ${endpoint}`);
    }
    const nextWorkerFetch = this.#counts.workerFetchTotal +
      (endpoint === "authorizeNavigation" ? 0 : 1);
    const nextControlledRemote = this.#counts.controlledRemoteTotal + 1;
    if (
      nextWorkerFetch > BROWSER_SMOKE_WORKER_FETCH_LIMIT ||
      nextControlledRemote > BROWSER_SMOKE_CONTROLLED_REMOTE_LIMIT
    ) {
      throw new Error("REFUSED: browser-auth smoke total network budget exhausted");
    }
    this.#counts[endpoint] += 1;
    this.#counts.workerFetchTotal = nextWorkerFetch;
    this.#counts.controlledRemoteTotal = nextControlledRemote;
  }

  recordAuthorizationNavigation(authUrl: string): void {
    assertBrowserAuthorizationUrl(authUrl);
    this.#admit("authorizeNavigation");
  }

  wrapFetch(fetchImpl: typeof fetch, abortSignal?: AbortSignal): typeof fetch {
    return async (input, init) => {
      const endpoint = endpointFor(input, init);
      this.#admit(endpoint);
      const signals = [init?.signal, abortSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined && signal !== null,
      );
      return fetchImpl(input, {
        ...init,
        redirect: "error",
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
    };
  }

  snapshot(): BrowserSmokeNetworkCounts {
    return { ...this.#counts };
  }
}
