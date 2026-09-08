// ===========================================================================
// 0213_chatgpt_browser_pkce_decision — append-only Phase 0a amendment.
//
// The original Hermes/device-probe decision remains immutable historical
// evidence. This fourth row records the shipped browser Authorization Code +
// PKCE ceremony without rewriting or deleting any earlier governance record.
// ===========================================================================

import type { ProviderDecisionSeed } from "./0211_chatgpt_provider_decisions.js";

export const MUESLI_REFERENCE_COMMIT =
  "31fb39b40ce7224d48aefeb1d6807ea39b5a9052";

export const CHATGPT_BROWSER_PKCE_DECISION_RECORD: ProviderDecisionSeed = {
  id: "dec_provider_chatgpt_product_login_browser_pkce_v1",
  targetId: "chatgpt-oauth:product_login_ceremony",
  decision:
    "Ship browser Authorization Code OAuth with PKCE S256 and an automatic IPv4-loopback callback as the only ChatGPT product login ceremony; users never copy or enter an authorization code.",
  rationale:
    "The owner selected the Muesli-referenced grant-access ceremony while retaining SuperTwin's stronger Keychain isolation, refresh locking, model discovery, request validation, and direct HTTP transport.",
  residualRisk:
    "The reused public OAuth client may reject the redirect or third-party originator, local security software may block the callback, or port 1455 may be occupied; these failures are typed and never trigger a device-code, API-key, Claude, or Codex CLI fallback.",
  acceptingOwner: "Aditya Katare",
  acceptedAt: "2026-09-08",
  referenceUrl:
    "https://github.com/Muesli-HQ/muesli/blob/31fb39b40ce7224d48aefeb1d6807ea39b5a9052/native/MuesliNative/Sources/MuesliNativeApp/ChatGPTAuthManager.swift",
  referenceCommit: MUESLI_REFERENCE_COMMIT,
  details: {
    providerId: "chatgpt-oauth",
    shippedFlow: "authorization_code_pkce_s256_loopback",
    endpoints: {
      authorize: "https://auth.openai.com/oauth/authorize",
      token: "https://auth.openai.com/oauth/token",
      redirectUri: "http://localhost:1455/auth/callback",
    },
    authorizationParameters: {
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirectUri: "http://localhost:1455/auth/callback",
      responseType: "code",
      scope: "openid profile email offline_access",
      codeChallengeMethod: "S256",
      idTokenAddOrganizations: "true",
      codexCliSimplifiedFlow: "true",
      originator: "supertwinv13",
      independentHighEntropyState: true,
      independentHighEntropyVerifier: true,
    },
    exchangeParameters: {
      grantType: "authorization_code",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      returnedAuthorizationCodeRequired: true,
      exactRedirectUri: true,
      codeVerifierRequired: true,
    },
    refreshParameters: {
      grantType: "refresh_token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      currentRefreshTokenRequired: true,
      followsOriginalRotationProtocol: true,
    },
    userExperience: {
      action: "Sign in with ChatGPT",
      browserAccountAndWorkspaceSelection: true,
      automaticCallbackCompletion: true,
      successHeading: "Signed in to SuperTwin",
      authorizationCodeEntryUi: false,
    },
    callbackSecurity: {
      bindHost: "127.0.0.1",
      port: 1455,
      method: "GET",
      path: "/auth/callback",
      timingSafeStateValidation: true,
      singleUse: true,
      boundedParsing: true,
      rejectsMalformedOversizedDuplicateAndOauthErrorRequests: true,
      timeoutCancellationWindowCloseAndShutdownCleanup: true,
      reflectsCallbackValues: false,
      logsCodesTokensVerifierStateOrCallbackUrls: false,
    },
    preservedStrongerDesign: {
      homeNamespacedKeychain: true,
      singleFlightRefreshAndSafeRotation: true,
      dynamicAccountVisibleModels: true,
      strictRequestAllowlist: true,
      providerSpecificParallelHttp: true,
    },
    fallbacksAllowed: {
      deviceCodeInProduction: false,
      apiKey: false,
      codexCli: false,
      automaticClaudeFallback: false,
    },
    claudeLocalRemainsSeparateProvider: true,
    historicalDeviceCodeDisposition: {
      retainedOnlyUnder: "worker/src/providers/chatgpt-oauth/probe/",
      productImportOrRoute: false,
      automaticFallback: false,
    },
    transportEvidence: {
      cumulativeInferenceAttemptsConsumed: 3,
      cumulativeInferenceAttemptsAuthorized: 55,
      ceremonyChangeAddsInferenceAuthorization: false,
    },
  },
};

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const record = CHATGPT_BROWSER_PKCE_DECISION_RECORD;
const payload = JSON.stringify({
  status: "accepted",
  decision: record.decision,
  rationale: record.rationale,
  residualRisk: record.residualRisk,
  acceptingOwner: record.acceptingOwner,
  acceptedAt: record.acceptedAt,
  referenceUrl: record.referenceUrl ?? null,
  referenceCommit: record.referenceCommit ?? null,
  details: record.details,
});

export const CHATGPT_BROWSER_PKCE_DECISION = `INSERT OR IGNORE INTO decisions
  (id, run_id, pass, target_kind, target_id, action, old_json, new_json, reason, confidence)
 VALUES
  (${sqlText(record.id)}, NULL, 'user', 'provider_rollout', ${sqlText(record.targetId)},
   'accept', NULL, ${sqlText(payload)}, ${sqlText(record.rationale)}, 1);`;
