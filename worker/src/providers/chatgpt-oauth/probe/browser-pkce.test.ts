import { describe, expect, it } from "vitest";

import { CODEX_OAUTH_CLIENT_ID } from "./constants.js";
import {
  BROWSER_AUTHORIZATION_PARAMETER_NAMES,
  BROWSER_OAUTH_AUTHORIZE_URL,
  BROWSER_OAUTH_ORIGINATOR,
  BROWSER_OAUTH_REDIRECT_URI,
  BROWSER_OAUTH_SCOPE,
  assertBrowserAuthorizationUrl,
  buildBrowserAuthorizationUrl,
  createBrowserAuthorizationAttempt,
  createBrowserPkceMaterial,
  pkceChallengeForVerifier,
} from "./browser-pkce.js";

function deterministicHooks() {
  let call = 0;
  return {
    randomBytes: (size: number) => new Uint8Array(size).fill(++call),
    now: () => 1_000,
  };
}

describe("browser Authorization Code + PKCE material", () => {
  it("uses independent 256-bit values and an exact S256 challenge", () => {
    const material = createBrowserPkceMaterial(deterministicHooks());
    expect(material.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(material.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(material.state).not.toBe(material.codeVerifier);
    expect(material.codeChallenge).toBe(
      pkceChallengeForVerifier(material.codeVerifier),
    );
    expect(material.codeChallenge).toHaveLength(43);
  });

  it("builds only the pinned authorization parameters and never sends the verifier", () => {
    const material = createBrowserPkceMaterial(deterministicHooks());
    const url = new URL(buildBrowserAuthorizationUrl(material));
    expect(`${url.origin}${url.pathname}`).toBe(BROWSER_OAUTH_AUTHORIZE_URL);
    expect([...url.searchParams.keys()]).toEqual([
      ...BROWSER_AUTHORIZATION_PARAMETER_NAMES,
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CODEX_OAUTH_CLIENT_ID,
      redirect_uri: BROWSER_OAUTH_REDIRECT_URI,
      response_type: "code",
      scope: BROWSER_OAUTH_SCOPE,
      state: material.state,
      code_challenge: material.codeChallenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: BROWSER_OAUTH_ORIGINATOR,
    });
    expect(url.search).not.toContain(material.codeVerifier);
    expect(url.searchParams.has("code_verifier")).toBe(false);
    expect(() => assertBrowserAuthorizationUrl(url.href)).not.toThrow();
    url.searchParams.set("extra", "value");
    expect(() => assertBrowserAuthorizationUrl(url.href)).toThrow(/allowlist/);
  });

  it("creates a separate public login id and a bounded expiry", () => {
    const attempt = createBrowserAuthorizationAttempt(deterministicHooks());
    expect(attempt.loginId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(attempt.loginId).not.toBe(attempt.material.state);
    expect(attempt.expiresAtMs).toBe(901_000);
  });

  it("rejects short or reused random material", () => {
    expect(() =>
      createBrowserPkceMaterial({ randomBytes: () => new Uint8Array(31) }),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      createBrowserPkceMaterial({
        randomBytes: (size) => new Uint8Array(size).fill(7),
      }),
    ).toThrow(/independently generated/);
  });
});
