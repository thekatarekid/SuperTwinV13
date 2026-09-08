import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
} from "./constants.js";

export interface ProbeHttpCounts {
  deviceCode: number;
  devicePoll: number;
  token: number;
  models: number;
  quota: number;
  inference: number;
  other: number;
  total: number;
}

export type ProbeHttpEndpoint = Exclude<keyof ProbeHttpCounts, "total">;
export type ProbeHttpLimits = Record<ProbeHttpEndpoint, number>;

export const LIVE_AUTH_HTTP_LIMITS: ProbeHttpLimits = {
  deviceCode: 1,
  devicePoll: 300,
  token: 1,
  models: 0,
  quota: 0,
  inference: 0,
  other: 0,
};

export const LIVE_DISCOVERY_HTTP_LIMITS: ProbeHttpLimits = {
  deviceCode: 1,
  devicePoll: 300,
  token: 1,
  models: 1,
  quota: 1,
  inference: 0,
  other: 0,
};

export const LIVE_CONTRACT_HTTP_LIMITS: ProbeHttpLimits = {
  deviceCode: 1,
  devicePoll: 300,
  token: 2,
  models: 1,
  quota: 2,
  inference: 55,
  other: 0,
};

export const LIVE_CONTRACT_HTTP_REQUEST_BUDGET = Object.values(
  LIVE_CONTRACT_HTTP_LIMITS,
).reduce((sum, count) => sum + count, 0);

export const LIVE_DISCOVERY_HTTP_REQUEST_BUDGET = Object.values(
  LIVE_DISCOVERY_HTTP_LIMITS,
).reduce((sum, count) => sum + count, 0);

export class ProbeHttpAccounting {
  readonly #counts: ProbeHttpCounts = {
    deviceCode: 0,
    devicePoll: 0,
    token: 0,
    models: 0,
    quota: 0,
    inference: 0,
    other: 0,
    total: 0,
  };

  constructor(private readonly limits: ProbeHttpLimits) {}

  record(input: string | URL | Request): void {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = url === CODEX_DEVICE_CODE_URL ? "deviceCode"
      : url === CODEX_DEVICE_TOKEN_URL ? "devicePoll"
        : url === CODEX_OAUTH_TOKEN_URL ? "token"
          : url === CODEX_MODELS_URL ? "models"
            : url === CODEX_USAGE_URL ? "quota"
              : url === CODEX_RESPONSES_URL ? "inference"
                : "other";
    if (this.#counts[key] >= this.limits[key]) {
      throw new Error(`REFUSED: Phase 0b HTTP budget exhausted for ${key}`);
    }
    this.#counts[key] += 1;
    this.#counts.total += 1;
  }

  snapshot(): ProbeHttpCounts {
    return { ...this.#counts };
  }

  wrap(fetchImpl: typeof fetch, abortSignal?: AbortSignal): typeof fetch {
    return async (input, init) => {
      this.record(input);
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
}

export function formatHttpAccounting(counts: ProbeHttpCounts): string {
  return `PHASE_0B_HTTP_ACTUALS=${JSON.stringify(counts)}`;
}
