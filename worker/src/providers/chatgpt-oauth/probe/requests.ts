import {
  CODEX_BACKEND_BASE_URL,
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
  superTwinUserAgent,
} from "./constants.js";
import { redactProbeValue } from "./redact.js";

export interface ProbeHttpRequest {
  name: string;
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

export function buildBackendHeaders(
  accessToken: string,
  accountId: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-ID": accountId,
    "User-Agent": superTwinUserAgent(env),
    originator: "supertwinv13",
  };
}

export function buildDryRunRequests(
  env: NodeJS.ProcessEnv = process.env,
): ProbeHttpRequest[] {
  const identityHeaders = { "User-Agent": superTwinUserAgent(env) };
  const backend = buildBackendHeaders("probe-access-token", "probe-account-id", env);
  return [
    {
      name: "device-code",
      method: "POST",
      url: CODEX_DEVICE_CODE_URL,
      headers: { ...identityHeaders, "Content-Type": "application/json" },
      body: { client_id: CODEX_OAUTH_CLIENT_ID },
    },
    {
      name: "device-poll",
      method: "POST",
      url: CODEX_DEVICE_TOKEN_URL,
      headers: { ...identityHeaders, "Content-Type": "application/json" },
      body: { device_auth_id: "probe-device-id", user_code: "ABCD-EFGH" },
    },
    {
      name: "token-exchange",
      method: "POST",
      url: CODEX_OAUTH_TOKEN_URL,
      headers: {
        ...identityHeaders,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: {
        grant_type: "authorization_code",
        code: "probe-authorization-code",
        redirect_uri: CODEX_DEVICE_REDIRECT_URI,
        client_id: CODEX_OAUTH_CLIENT_ID,
        code_verifier: "probe-code-verifier",
      },
    },
    {
      name: "refresh",
      method: "POST",
      url: CODEX_OAUTH_TOKEN_URL,
      headers: {
        ...identityHeaders,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: {
        grant_type: "refresh_token",
        refresh_token: "probe-refresh-token",
        client_id: CODEX_OAUTH_CLIENT_ID,
      },
    },
    {
      name: "models",
      method: "GET",
      url: CODEX_MODELS_URL,
      headers: { ...backend, Accept: "application/json" },
    },
    {
      name: "quota",
      method: "GET",
      url: CODEX_USAGE_URL,
      headers: { ...backend, Accept: "application/json" },
    },
    {
      name: "blank-context-canary",
      method: "POST",
      url: CODEX_RESPONSES_URL,
      headers: {
        ...backend,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        session_id: "probe-stateless-session",
        "x-client-request-id": "probe-canary-request",
      },
      body: {
        model: "<discovered-model>",
        instructions: "",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with OK." }],
          },
        ],
        store: false,
        stream: true,
      },
    },
  ];
}

export function dryRunSnapshot(env: NodeJS.ProcessEnv = process.env): unknown {
  return {
    mode: "dry-run",
    backend: CODEX_BACKEND_BASE_URL,
    networkCalls: 0,
    requests: redactProbeValue(buildDryRunRequests(env)),
  };
}
