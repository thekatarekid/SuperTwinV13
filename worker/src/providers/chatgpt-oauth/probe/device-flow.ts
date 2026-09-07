import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  MAX_DEVICE_CODE_REQUESTS,
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
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  onUserCode(code: DeviceCode): void;
  env?: NodeJS.ProcessEnv;
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

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export async function requestDeviceCode(hooks: DeviceFlowHooks): Promise<DeviceCode> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_DEVICE_CODE_REQUESTS; attempt += 1) {
    const response = await hooks.fetch(CODEX_DEVICE_CODE_URL, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": superTwinUserAgent(hooks.env),
      },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    });
    lastStatus = response.status;
    if (response.status !== 429) {
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
    if (attempt < MAX_DEVICE_CODE_REQUESTS) {
      const delay = Math.max(1, Math.min(retryAfterSeconds(response) ?? 2 ** attempt, 60));
      await hooks.sleep(delay * 1_000);
    }
  }
  throw new Error(`OpenAI rate-limited the device code request (HTTP ${lastStatus}); stop and retry later`);
}

export async function pollDeviceAuthorization(
  device: DeviceCode,
  hooks: DeviceFlowHooks,
): Promise<DeviceAuthorization> {
  const startedAt = hooks.now();
  while (hooks.now() - startedAt < MAX_DEVICE_POLL_SECONDS * 1_000) {
    await hooks.sleep(device.intervalSeconds * 1_000);
    const response = await hooks.fetch(CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
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
    signal: AbortSignal.timeout(15_000),
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
