// Phase 0b probe constants. Pinned to hermes-agent commit
// e9bccc90a5e314ddf6dd4bd3772d50cb40027275. This module is diagnostic-only;
// application traffic must not import it.

export const HERMES_REFERENCE_COMMIT = "e9bccc90a5e314ddf6dd4bd3772d50cb40027275";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_DEVICE_CODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;

export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_RESPONSES_URL = `${CODEX_BACKEND_BASE_URL}/responses`;
export const CODEX_MODELS_URL = `${CODEX_BACKEND_BASE_URL}/models?client_version=1.0.0`;
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export const LIVE_PROBE_ENV = "SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE";
export const FULL_PROBE_CASE_BREAKDOWN = {
  allowlistAcceptedAndRejected: 30,
  focusedBehavior: 9,
  concurrencyLadder: 1 + 4 + 8 + 16,
  canary: 1,
  cancellation: 1,
} as const;
export const FULL_PROBE_CASE_BUDGET = Object.values(
  FULL_PROBE_CASE_BREAKDOWN,
).reduce(
  (sum, calls) => sum + calls,
  0,
);
/** 15 negative contract cases are rejected locally and never reach the backend. */
export const FULL_PROBE_PREFLIGHT_REJECTION_COUNT = 15;
export const FULL_PROBE_INFERENCE_POST_BUDGET =
  FULL_PROBE_CASE_BUDGET - FULL_PROBE_PREFLIGHT_REJECTION_COUNT;
/** The currently implemented --live-auth command performs OAuth only. */
export const LIVE_AUTH_INFERENCE_CALL_BUDGET = 0;
/** Phase 0b stops on the first 429; it does not exercise Hermes's production retry loop. */
export const MAX_DEVICE_CODE_REQUESTS = 1;
export const MIN_DEVICE_POLL_INTERVAL_SECONDS = 3;
export const MAX_DEVICE_POLL_SECONDS = 15 * 60;
export const MAX_DEVICE_POLL_REQUESTS =
  MAX_DEVICE_POLL_SECONDS / MIN_DEVICE_POLL_INTERVAL_SECONDS;
export const LIVE_AUTH_HTTP_REQUEST_BUDGET =
  MAX_DEVICE_CODE_REQUESTS + MAX_DEVICE_POLL_REQUESTS + 1;

export function superTwinUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const version = env.SUPERTWIN_APP_VERSION?.trim() || env.npm_package_version?.trim();
  return `SuperTwinV13/${version || "<app-version>"}`;
}
