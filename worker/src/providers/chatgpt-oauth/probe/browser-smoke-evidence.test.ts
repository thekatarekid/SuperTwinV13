import { describe, expect, it } from "vitest";

import {
  buildBrowserSmokeEvidence,
  serializeBrowserSmokeEvidence,
} from "./browser-smoke-evidence.js";
import type { BrowserSmokeNetworkCounts } from "./browser-smoke-budget.js";

const COUNTS: BrowserSmokeNetworkCounts = {
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

describe("allowlisted browser-auth smoke evidence", () => {
  it("contains exact safe proof fields and no OAuth secrets", () => {
    const serialized = serializeBrowserSmokeEvidence(
      buildBrowserSmokeEvidence({
        accountFingerprint: "7d41db9e5a28",
        pkceCorrelation: true,
        stateValidated: true,
        callbackAccepted: 1,
        listenerCleanedUp: true,
        refreshRotatedBeforeUse: true,
        logoutCleared: true,
        counts: COUNTS,
      }),
    );
    expect(serialized).toContain('"inference": 0');
    expect(serialized).toContain('"other": 0');
    expect(serialized).toContain('"retryPolicy": "none"');
    for (const secret of [
      "raw-access-token",
      "raw-refresh-token",
      "raw-authorization-code",
      "raw-state",
      "raw-verifier",
      "?code=",
      "?state=",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("refuses evidence unless every hard bound and proof passed", () => {
    const base = {
      accountFingerprint: "7d41db9e5a28",
      pkceCorrelation: true,
      stateValidated: true,
      callbackAccepted: 1,
      listenerCleanedUp: true,
      refreshRotatedBeforeUse: true,
      logoutCleared: true,
      counts: COUNTS,
    };
    expect(() => buildBrowserSmokeEvidence({ ...base, pkceCorrelation: false }))
      .toThrow(/PKCE correlation/);
    expect(() =>
      buildBrowserSmokeEvidence({
        ...base,
        counts: { ...COUNTS, models: 1 },
      }),
    ).toThrow(/models accounting/);
    expect(() => buildBrowserSmokeEvidence({ ...base, callbackAccepted: 0 }))
      .toThrow(/exactly one callback/);
    expect(() =>
      buildBrowserSmokeEvidence({ ...base, accountFingerprint: "account-id" }),
    ).toThrow(/redacted account fingerprint/);
  });
});
