import { createHash } from "node:crypto";

import {
  BROWSER_OAUTH_AUTHORIZE_URL,
  BROWSER_AUTHORIZATION_PARAMETER_NAMES,
  BROWSER_OAUTH_CALLBACK_HOST,
  BROWSER_OAUTH_CALLBACK_PATH,
  BROWSER_OAUTH_CALLBACK_PORT,
  BROWSER_OAUTH_ORIGINATOR,
  BROWSER_OAUTH_REDIRECT_URI,
  BROWSER_OAUTH_SCOPE,
  MUESLI_BROWSER_AUTH_REFERENCE_COMMIT,
} from "./browser-pkce.js";
import { BROWSER_AUTH_SUCCESS_HTML } from "./browser-loopback.js";
import type { BrowserSmokeNetworkCounts } from "./browser-smoke-budget.js";

export interface BrowserSmokeEvidenceInput {
  accountFingerprint: string;
  pkceCorrelation: boolean;
  stateValidated: boolean;
  callbackAccepted: number;
  listenerCleanedUp: boolean;
  refreshRotatedBeforeUse: boolean;
  logoutCleared: boolean;
  counts: BrowserSmokeNetworkCounts;
}

export interface BrowserSmokeEvidence {
  mode: "browser-authorization-code-pkce-smoke";
  status: "passed";
  referenceCommit: string;
  oauth: {
    authorizeEndpoint: string;
    redirectUri: string;
    scope: string;
    originator: string;
    parameterNames: readonly string[];
    codeChallengeMethod: "S256";
    verifierCharacters: 43;
    challengeCharacters: 43;
    pkceCorrelation: true;
    stateValidated: true;
  };
  callback: {
    host: string;
    port: number;
    path: string;
    accepted: 1;
    listenerCleanedUp: true;
    successPageSha256: string;
  };
  accountFingerprint: string;
  refreshRotatedBeforeUse: true;
  logoutCleared: true;
  retryPolicy: "none";
  networkActuals: BrowserSmokeNetworkCounts;
  scratchHomeProof: "no-residual-artifacts";
}

function requirePassed(value: boolean, label: string): true {
  if (!value) throw new Error(`browser-auth smoke evidence failed: ${label}`);
  return true;
}

export function buildBrowserSmokeEvidence(
  input: BrowserSmokeEvidenceInput,
): BrowserSmokeEvidence {
  if (!/^[a-f0-9]{12}$/.test(input.accountFingerprint)) {
    throw new Error("browser-auth smoke evidence requires a redacted account fingerprint");
  }
  if (input.callbackAccepted !== 1) {
    throw new Error("browser-auth smoke evidence requires exactly one callback");
  }
  const expectedCounts: BrowserSmokeNetworkCounts = {
    authorizeNavigation: 1,
    tokenExchange: 1,
    tokenRefresh: 1,
    deviceCode: 0,
    devicePoll: 0,
    models: 0,
    quota: 0,
    inference: 0,
    other: 0,
    workerFetchTotal: 2,
    controlledRemoteTotal: 3,
  };
  for (const [name, expected] of Object.entries(expectedCounts)) {
    if (input.counts[name as keyof BrowserSmokeNetworkCounts] !== expected) {
      throw new Error(`browser-auth smoke evidence has invalid ${name} accounting`);
    }
  }
  return {
    mode: "browser-authorization-code-pkce-smoke",
    status: "passed",
    referenceCommit: MUESLI_BROWSER_AUTH_REFERENCE_COMMIT,
    oauth: {
      authorizeEndpoint: BROWSER_OAUTH_AUTHORIZE_URL,
      redirectUri: BROWSER_OAUTH_REDIRECT_URI,
      scope: BROWSER_OAUTH_SCOPE,
      originator: BROWSER_OAUTH_ORIGINATOR,
      parameterNames: [...BROWSER_AUTHORIZATION_PARAMETER_NAMES].sort(),
      codeChallengeMethod: "S256",
      verifierCharacters: 43,
      challengeCharacters: 43,
      pkceCorrelation: requirePassed(input.pkceCorrelation, "PKCE correlation"),
      stateValidated: requirePassed(input.stateValidated, "state validation"),
    },
    callback: {
      host: BROWSER_OAUTH_CALLBACK_HOST,
      port: BROWSER_OAUTH_CALLBACK_PORT,
      path: BROWSER_OAUTH_CALLBACK_PATH,
      accepted: 1,
      listenerCleanedUp: requirePassed(input.listenerCleanedUp, "listener cleanup"),
      successPageSha256: createHash("sha256")
        .update(BROWSER_AUTH_SUCCESS_HTML, "utf8")
        .digest("hex"),
    },
    accountFingerprint: input.accountFingerprint,
    refreshRotatedBeforeUse: requirePassed(
      input.refreshRotatedBeforeUse,
      "refresh rotation before use",
    ),
    logoutCleared: requirePassed(input.logoutCleared, "logout cleanup"),
    retryPolicy: "none",
    networkActuals: { ...input.counts },
    scratchHomeProof: "no-residual-artifacts",
  };
}

export function serializeBrowserSmokeEvidence(evidence: BrowserSmokeEvidence): string {
  return JSON.stringify(evidence, null, 2);
}
