import {
  LIVE_DISCOVERY_HTTP_LIMITS,
  ProbeHttpAccounting,
  type ProbeHttpCounts,
} from "./accounting.js";
import { CODEX_MODELS_URL, CODEX_USAGE_URL } from "./constants.js";
import { runDeviceCodeFlow, type DeviceFlowHooks } from "./device-flow.js";
import { parseProbeModelCatalogue, type ProbeModelCapabilities } from "./models.js";
import { parseProbeQuota, type ProbeQuotaWindow } from "./quota.js";
import { EphemeralProbeTokenSession, type SafeSessionEvidence } from "./refresh.js";
import { buildBackendHeaders } from "./requests.js";
import { hasBoundedRestrictionSignal } from "./restriction.js";
import {
  assertLiveDiscoveryProbeAccount,
  assertLiveDiscoveryProbePreflight,
} from "./safety.js";

const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface DiscoveryProbeHooks extends DeviceFlowHooks {
  onFinalized?(evidence: {
    httpActuals: ProbeHttpCounts;
    logout: SafeSessionEvidence;
    aborted: boolean;
  }): void;
}

export interface DiscoveryProbeEvidence {
  mode: "discovery";
  evidenceCompleteness: "partial-metadata-only";
  persistedCredentials: false;
  inferenceCalls: 0;
  accountFingerprint: string;
  models: {
    status: number;
    responseBytes: number;
    visible: Array<{ id: string; capabilities: ProbeModelCapabilities }>;
  };
  quota: {
    status: number;
    responseBytes: number;
    planType: string;
    primary: ProbeQuotaWindow;
    secondary?: ProbeQuotaWindow;
    healthy: boolean;
    restrictionSignal: boolean;
    creditsRemaining?: number;
  };
  httpActuals: ProbeHttpCounts;
  logout: SafeSessionEvidence;
  localListeningSocketsCreated: false;
}

function listeningSocketCount(): number {
  const processWithHandles = process as typeof process & { _getActiveHandles?: () => unknown[] };
  return (processWithHandles._getActiveHandles?.() ?? []).filter((handle) =>
    Boolean(handle && typeof handle === "object" &&
      (handle as { listening?: boolean }).listening === true),
  ).length;
}

async function boundedJson(response: Response): Promise<{ status: number; value: unknown; bytes: number }> {
  if (!response.body) throw new Error(`Discovery metadata response has no body (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Discovery metadata response exceeded its byte limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!response.ok) throw new Error(`Discovery metadata request failed (HTTP ${response.status})`);
  try {
    return { status: response.status, value: JSON.parse(text) as unknown, bytes };
  } catch {
    throw new Error(`Discovery metadata response returned invalid JSON (HTTP ${response.status})`);
  }
}

async function fetchMetadata(
  url: string,
  headers: Record<string, string>,
  hooks: DiscoveryProbeHooks,
): Promise<{ status: number; value: unknown; bytes: number }> {
  const signal = hooks.signal
    ? AbortSignal.any([AbortSignal.timeout(30_000), hooks.signal])
    : AbortSignal.timeout(30_000);
  const response = await hooks.fetch(url, {
    method: "GET",
    redirect: "error",
    headers: { ...headers, Accept: "application/json" },
    signal,
  });
  return boundedJson(response);
}

export async function runDiscoveryProbe(
  hooks: DiscoveryProbeHooks,
): Promise<DiscoveryProbeEvidence> {
  const env = hooks.env ?? process.env;
  assertLiveDiscoveryProbePreflight(env);
  const listeningSocketsBefore = listeningSocketCount();
  const accounting = new ProbeHttpAccounting(LIVE_DISCOVERY_HTTP_LIMITS);
  const probeAbort = new AbortController();
  const signals = [hooks.signal, probeAbort.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const probeHooks: DiscoveryProbeHooks = {
    ...hooks,
    fetch: accounting.wrap(hooks.fetch, AbortSignal.any(signals)),
    signal: AbortSignal.any(signals),
  };
  let session: EphemeralProbeTokenSession | undefined;
  try {
    const tokens = await runDeviceCodeFlow(probeHooks);
    session = new EphemeralProbeTokenSession(tokens);
    const account = assertLiveDiscoveryProbeAccount(tokens.accessToken, env);
    const headers = buildBackendHeaders(tokens.accessToken, account.accountId, env);
    const modelResponse = await fetchMetadata(CODEX_MODELS_URL, headers, probeHooks);
    if (hasBoundedRestrictionSignal(modelResponse.value, {
      ignoreContainerKeys: ["models", "data"],
      ignoreRootArray: true,
      ignoreTextKeys: ["display_name", "displayName", "name", "description"],
    })) {
      throw new Error("Phase 0b discovery stopped on a structural account or restriction signal");
    }
    const catalogue = parseProbeModelCatalogue(modelResponse.value);
    if (!catalogue.models.length) {
      throw new Error("Phase 0b discovery model catalogue contains no safe visible model IDs");
    }
    const quotaResponse = await fetchMetadata(CODEX_USAGE_URL, headers, probeHooks);
    const quota = parseProbeQuota(quotaResponse.value);
    if (!quota.healthy) throw new Error("Phase 0b discovery found a quota or account restriction");
    const actuals = accounting.snapshot();
    if (actuals.deviceCode !== 1 || actuals.devicePoll < 1 || actuals.token !== 1 ||
        actuals.models !== 1 || actuals.quota !== 1 || actuals.inference !== 0 ||
        actuals.other !== 0) {
      throw new Error("Phase 0b discovery HTTP accounting did not match its declared flow");
    }
    session.logout();
    const logout = session.evidence();
    if (listeningSocketCount() > listeningSocketsBefore) {
      throw new Error("Phase 0b discovery unexpectedly created a local listening socket");
    }
    return {
      mode: "discovery",
      evidenceCompleteness: "partial-metadata-only",
      persistedCredentials: false,
      inferenceCalls: 0,
      accountFingerprint: account.fingerprint,
      models: {
        status: modelResponse.status,
        responseBytes: modelResponse.bytes,
        visible: catalogue.models.map(({ id, capabilities }) => ({ id, capabilities })),
      },
      quota: {
        status: quotaResponse.status,
        responseBytes: quotaResponse.bytes,
        planType: quota.planType,
        primary: quota.primary,
        ...(quota.secondary ? { secondary: quota.secondary } : {}),
        healthy: quota.healthy,
        restrictionSignal: quota.restrictionSignal,
        ...(quota.creditsRemaining === undefined ? {} : { creditsRemaining: quota.creditsRemaining }),
      },
      httpActuals: actuals,
      logout,
      localListeningSocketsCreated: false,
    };
  } finally {
    probeAbort.abort(new Error("Phase 0b discovery probe finished"));
    session?.logout();
    hooks.onFinalized?.({
      httpActuals: accounting.snapshot(),
      logout: session?.evidence() ?? {
        authenticated: false,
        hasRefreshToken: false,
        previousRecoveryPairAvailable: false,
      },
      aborted: probeAbort.signal.aborted,
    });
  }
}
