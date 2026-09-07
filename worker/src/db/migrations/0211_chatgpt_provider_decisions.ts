// ===========================================================================
// 0211_chatgpt_provider_decisions — ChatGPT provider Phase 0a decision gate.
//
// Product-governance decisions belong in the existing decisions ledger. Stable
// ids plus INSERT OR IGNORE make the owner-approved Appendix A record durable
// on fresh and upgraded installs without overwriting a later local correction.
// ===========================================================================

export const HERMES_REFERENCE_COMMIT = "e9bccc90a5e314ddf6dd4bd3772d50cb40027275";

export interface ProviderDecisionSeed {
  id: string;
  targetId: string;
  decision: string;
  rationale: string;
  residualRisk: string;
  acceptingOwner: string;
  acceptedAt: string;
  referenceUrl?: string;
  referenceCommit?: string;
  details: Record<string, unknown>;
}

export const CHATGPT_PROVIDER_DECISION_RECORDS: readonly ProviderDecisionSeed[] = [
  {
    id: "dec_provider_chatgpt_client_identity_v1",
    targetId: "chatgpt-oauth:client_identity",
    decision:
      "Follow the Hermes ChatGPT OAuth pattern: reuse the Codex OAuth public-client identity and private Codex backend contract while identifying SuperTwin honestly with its own user agent and originator header.",
    rationale:
      "The owner selected a pinned, working open-source precedent while requiring SuperTwin's product identity to remain explicit on the wire.",
    residualRisk:
      "The reused client ID and private endpoints can change or be rejected without notice; OpenAI may rate-limit, revoke tokens, suspend accounts, or treat the traffic as outside the intended Codex-client scope.",
    acceptingOwner: "Aditya Katare",
    acceptedAt: "2026-09-07",
    referenceUrl: "https://github.com/NousResearch/hermes-agent",
    referenceCommit: HERMES_REFERENCE_COMMIT,
    details: {
      oauth: {
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        issuer: "https://auth.openai.com",
        deviceVerificationUrl: "https://auth.openai.com/codex/device",
        deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
        devicePollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
        tokenUrl: "https://auth.openai.com/oauth/token",
        redirectUri: "https://auth.openai.com/deviceauth/callback",
        requestedScope: null,
        loopbackListener: false,
        deviceRequestContentType: "application/json",
        devicePollContentType: "application/json",
        tokenExchangeContentType: "application/x-www-form-urlencoded",
      },
      inference: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
        modelsUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
        refreshHeaders: {
          "User-Agent": "SuperTwinV13/<app-version>",
          Accept: "application/json",
        },
        backendHeaders: {
          "User-Agent": "SuperTwinV13/<app-version>",
          originator: "supertwinv13",
          "ChatGPT-Account-ID": "<jwt-account-id>",
        },
        accountIdClaim: {
          container: "https://api.openai.com/auth",
          field: "chatgpt_account_id",
        },
        requestIdentifiers: {
          headers: ["session_id", "x-client-request-id"],
          bounded: true,
          identityImpersonation: false,
        },
      },
      authMechanics: {
        flow: "device_code",
        exchangeServerReturnedAuthorizationCode: true,
        exchangeServerReturnedVerifier: true,
        refreshSkewSeconds: 120,
        persistRotatedPairBeforeUse: true,
        retainPreviousPairForRecovery: true,
        refreshAttemptsAfter401: 1,
        retryOriginalRequestAfterRefresh: 1,
        processRefreshLock: true,
        credentialStore: "home-namespaced macOS Keychain",
        importExternalCredentialStores: false,
      },
      rollout: {
        featureFlag: "ai.chatgpt.enabled",
        defaultEnabled: false,
        accountCollateral: "Every signed-in user's ChatGPT account",
      },
    },
  },
  {
    id: "dec_provider_chatgpt_terms_risk_v1",
    targetId: "chatgpt-oauth:terms_risk",
    decision:
      "Follow Hermes's direct ChatGPT OAuth/private Codex backend integration posture and explicitly accept the documented terms, account, and protocol risk; this is risk acceptance, not OpenAI authorization.",
    rationale:
      "The owner specifically chose the Hermes implementation precedent for SuperTwin's subscription-backed provider, with rollout constrained and observable.",
    residualRisk:
      "Owner acceptance cannot waive OpenAI's terms or bind OpenAI; enforcement, throttling, CAPTCHA, token revocation, subscription disruption, or account suspension remain possible and must not be circumvented.",
    acceptingOwner: "Aditya Katare",
    acceptedAt: "2026-09-07",
    referenceUrl: "https://github.com/NousResearch/hermes-agent",
    referenceCommit: HERMES_REFERENCE_COMMIT,
    details: {
      source: "https://openai.com/policies/terms-of-use/",
      finding:
        "No public authorization was found for this non-Codex private-backend workload; current consumer terms prohibit automatic/programmatic output extraction and circumvention of restrictions.",
      acceptedPosture: {
        directPrivateBackend: true,
        continuousBackgroundProcessing: true,
        concurrencyAtLeastEight: true,
        shippedMaximumConcurrency: 16,
        riskAcceptanceIsAuthorization: false,
      },
      stopOnSignals: [
        "rate_limit",
        "account_flag",
        "captcha",
        "token_revocation",
        "subscription_warning",
        "backend_restriction",
      ],
      circumventRestrictions: false,
    },
  },
  {
    id: "dec_provider_chatgpt_consumer_data_consent_v1",
    targetId: "chatgpt-oauth:consumer_data_consent",
    decision:
      "SuperTwin will send selected WhatsApp messages, browser text, screen captures, and derived context to OpenAI using your personal ChatGPT/Codex subscription. This is consumer-service traffic, not API business data. OpenAI may retain or use content according to your account’s data controls. SuperTwin cannot guarantee no training, Temporary Chat treatment, or deletion. Confirm you have permission to share this data. You can sign out and stop future sends at any time.",
    rationale:
      "The consent names the data categories, destination, consumer-service posture, permission duty, and stop control before authentication.",
    residualRisk:
      "Account controls may change, and senders or people represented in captured content may not have authorized onward disclosure; consent must remain explicit and revocable.",
    acceptingOwner: "Aditya Katare",
    acceptedAt: "2026-09-07",
    details: {
      treatment: "OpenAI consumer-service traffic controlled by the selected account settings",
      apiBusinessDataTreatment: false,
      guarantees: {
        noTraining: false,
        temporaryChatEquivalent: false,
        deletion: false,
        storeFalseControlsRetention: false,
      },
      differsFromClaude:
        "Content goes to OpenAI under the selected OpenAI account/workspace controls instead of to Anthropic through Claude CLI account controls.",
      consentRequiredBeforeAuthentication: true,
      consentRevocableByLogout: true,
    },
  },
] as const;

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const CHATGPT_PROVIDER_DECISIONS = CHATGPT_PROVIDER_DECISION_RECORDS.map((record) => {
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
  return `INSERT OR IGNORE INTO decisions
    (id, run_id, pass, target_kind, target_id, action, old_json, new_json, reason, confidence)
   VALUES
    (${sqlText(record.id)}, NULL, 'user', 'provider_rollout', ${sqlText(record.targetId)},
     'accept', NULL, ${sqlText(payload)}, ${sqlText(record.rationale)}, 1);`;
}).join("\n");
