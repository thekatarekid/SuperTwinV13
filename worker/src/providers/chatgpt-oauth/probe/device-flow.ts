import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  MAX_DEVICE_POLL_SECONDS,
  MIN_DEVICE_POLL_INTERVAL_SECONDS,
  superTwinUserAgent,
} from "./constants.js";

export interface DeviceCode {
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
  verificationUrl: string;
}

export interface EphemeralOAuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface DeviceFlowHooks {
  fetch: typeof fetch;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  onUserCode(code: DeviceCode): void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface DeviceAuthorization {
  authorization_code?: unknown;
  code_verifier?: unknown;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`OAuth response missing ${name}`);
  return value;
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`);
  }
}

function requestSignal(hooks: DeviceFlowHooks): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return hooks.signal ? AbortSignal.any([timeout, hooks.signal]) : timeout;
}

function assertNotAborted(hooks: DeviceFlowHooks): void {
  if (hooks.signal?.aborted) throw hooks.signal.reason ?? new Error("OAuth probe aborted");
}

export async function requestDeviceCode(hooks: DeviceFlowHooks): Promise<DeviceCode> {
  assertNotAborted(hooks);
  const response = await hooks.fetch(CODEX_DEVICE_CODE_URL, {
    method: "POST",
    signal: requestSignal(hooks),
    headers: {
      "Content-Type": "application/json",
      "User-Agent": superTwinUserAgent(hooks.env),
    },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
  });
  if (response.status === 429) {
    throw new Error("OpenAI rate-limited the device code request (HTTP 429); stop and retry later");
  }
  if (response.status !== 200) throw new Error(`Device code request failed (HTTP ${response.status})`);
  const payload = await responseJson(response, "Device code request");
  const deviceCode = {
    userCode: requiredString(payload.user_code, "user_code"),
    deviceAuthId: requiredString(payload.device_auth_id, "device_auth_id"),
    intervalSeconds: Math.max(MIN_DEVICE_POLL_INTERVAL_SECONDS, Number(payload.interval) || 5),
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
  };
  hooks.onUserCode(deviceCode);
  return deviceCode;
}

export async function pollDeviceAuthorization(
  device: DeviceCode,
  hooks: DeviceFlowHooks,
): Promise<DeviceAuthorization> {
  const startedAt = hooks.now();
  while (hooks.now() - startedAt < MAX_DEVICE_POLL_SECONDS * 1_000) {
    assertNotAborted(hooks);
    await hooks.sleep(device.intervalSeconds * 1_000, hooks.signal);
    const response = await hooks.fetch(CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      signal: requestSignal(hooks),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": superTwinUserAgent(hooks.env),
      },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
    });
    if (response.status === 403 || response.status === 404) continue;
    if (response.status !== 200) throw new Error(`Device authorization poll failed (HTTP ${response.status})`);
    return responseJson(response, "Device authorization poll");
  }
  throw new Error("Device authorization timed out after 15 minutes");
}

export async function exchangeAuthorizationCode(
  authorization: DeviceAuthorization,
  hooks: DeviceFlowHooks,
): Promise<EphemeralOAuthTokens> {
  assertNotAborted(hooks);
  const code = requiredString(authorization.authorization_code, "authorization_code");
  const verifier = requiredString(authorization.code_verifier, "code_verifier");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  });
  const response = await hooks.fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    signal: requestSignal(hooks),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": superTwinUserAgent(hooks.env),
    },
    body,
  });
  if (response.status === 429) throw new Error("OpenAI rate-limited token exchange; stop and retry later");
  if (response.status !== 200) throw new Error(`Token exchange failed (HTTP ${response.status})`);
  const payload = await responseJson(response, "Token exchange");
  return {
    accessToken: requiredString(payload.access_token, "access_token"),
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
  };
}

export async function runDeviceCodeFlow(hooks: DeviceFlowHooks): Promise<EphemeralOAuthTokens> {
  const device = await requestDeviceCode(hooks);
  const authorization = await pollDeviceAuthorization(device, hooks);
  return exchangeAuthorizationCode(authorization, hooks);
}
