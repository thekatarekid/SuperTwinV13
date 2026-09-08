import { createHash } from "node:crypto";

import { CODEX_ISSUER, CODEX_OAUTH_CLIENT_ID } from "./constants.js";

export const MUESLI_BROWSER_AUTH_REFERENCE_COMMIT =
  "31fb39b40ce7224d48aefeb1d6807ea39b5a9052";
export const BROWSER_OAUTH_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const BROWSER_OAUTH_REDIRECT_URI =
  "http://localhost:1455/auth/callback";
export const BROWSER_OAUTH_SCOPE = "openid profile email offline_access";
export const BROWSER_OAUTH_ORIGINATOR = "supertwinv13";
export const BROWSER_OAUTH_CALLBACK_PORT = 1455;
export const BROWSER_OAUTH_CALLBACK_HOST = "127.0.0.1";
export const BROWSER_OAUTH_CALLBACK_PATH = "/auth/callback";
export const BROWSER_AUTH_ATTEMPT_TTL_MS = 15 * 60_000;

export const BROWSER_AUTHORIZATION_PARAMETER_NAMES = Object.freeze([
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "id_token_add_organizations",
  "codex_cli_simplified_flow",
  "originator",
] as const);

export interface BrowserPkceHooks {
  randomBytes(size: number): Uint8Array;
  now(): number;
}

export interface BrowserPkceMaterial {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export interface BrowserAuthorizationAttempt {
  loginId: string;
  authUrl: string;
  expiresAtMs: number;
  material: BrowserPkceMaterial;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function exactRandomBytes(
  hooks: Pick<BrowserPkceHooks, "randomBytes">,
  size: number,
): Uint8Array {
  const bytes = hooks.randomBytes(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    throw new Error(`PKCE random source must return exactly ${size} bytes`);
  }
  return bytes;
}

export function pkceChallengeForVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createBrowserPkceMaterial(
  hooks: Pick<BrowserPkceHooks, "randomBytes">,
): BrowserPkceMaterial {
  const codeVerifier = base64Url(exactRandomBytes(hooks, 32));
  const state = base64Url(exactRandomBytes(hooks, 32));
  if (codeVerifier === state) {
    throw new Error("PKCE verifier and OAuth state must be independently generated");
  }
  return {
    codeVerifier,
    codeChallenge: pkceChallengeForVerifier(codeVerifier),
    state,
  };
}

export function buildBrowserAuthorizationUrl(material: BrowserPkceMaterial): string {
  const url = new URL(BROWSER_OAUTH_AUTHORIZE_URL);
  const values: Record<(typeof BROWSER_AUTHORIZATION_PARAMETER_NAMES)[number], string> = {
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
  };
  for (const name of BROWSER_AUTHORIZATION_PARAMETER_NAMES) {
    url.searchParams.set(name, values[name]);
  }
  return url.href;
}

export function assertBrowserAuthorizationUrl(authUrl: string): void {
  const url = new URL(authUrl);
  if (
    `${url.origin}${url.pathname}` !== BROWSER_OAUTH_AUTHORIZE_URL ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("REFUSED: browser authorization URL endpoint was not pinned");
  }
  const names = [...url.searchParams.keys()];
  if (
    names.length !== BROWSER_AUTHORIZATION_PARAMETER_NAMES.length ||
    names.some((name, index) => name !== BROWSER_AUTHORIZATION_PARAMETER_NAMES[index]) ||
    BROWSER_AUTHORIZATION_PARAMETER_NAMES.some(
      (name) => url.searchParams.getAll(name).length !== 1,
    )
  ) {
    throw new Error("REFUSED: browser authorization URL parameter allowlist changed");
  }
  const exactValues = {
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: BROWSER_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: BROWSER_OAUTH_SCOPE,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: BROWSER_OAUTH_ORIGINATOR,
  } as const;
  if (
    Object.entries(exactValues).some(
      ([name, value]) => url.searchParams.get(name) !== value,
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "")
  ) {
    throw new Error("REFUSED: browser authorization URL value contract changed");
  }
}

export function createBrowserAuthorizationAttempt(
  hooks: BrowserPkceHooks,
): BrowserAuthorizationAttempt {
  const material = createBrowserPkceMaterial(hooks);
  const loginId = base64Url(exactRandomBytes(hooks, 16));
  const authUrl = buildBrowserAuthorizationUrl(material);
  assertBrowserAuthorizationUrl(authUrl);
  return {
    loginId,
    authUrl,
    expiresAtMs: hooks.now() + BROWSER_AUTH_ATTEMPT_TTL_MS,
    material,
  };
}
