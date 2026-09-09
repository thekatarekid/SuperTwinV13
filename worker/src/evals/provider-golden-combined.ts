import { createHash } from "node:crypto";

import type { ChatGptTokenPair } from "../providers/chatgpt-oauth/keychain.js";
import { CHATGPT_OAUTH_CLIENT_ID, CHATGPT_OAUTH_SCOPE } from "../providers/chatgpt-oauth/auth.js";
import type { GoldenCounters } from "./provider-golden-rail.js";

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_FINGERPRINT = /^[a-f0-9]{12}$/;
const SAFE_DIGEST = /^[a-f0-9]{64}$/;

export interface SignedGoldenConfig {
  readonly appVersion: string;
  readonly executorModel: string;
  readonly judgeModel: string;
  readonly expectedAccountFingerprint: string;
  readonly evalHomeIdentity: Readonly<{ dev: number; ino: number; mode: "0700" }>;
  readonly fixtureSha256: string;
  readonly baselineSha256: string;
  readonly gateSourceSha256: string;
  readonly codeIdentitySha256: string;
  readonly bundleSha256: string;
}

export interface SignedGoldenCredentialScope {
  /** Rust creates the exact label/item and returns only SHA-256(ref), never ref. */
  create(pair: ChatGptTokenPair, signal: AbortSignal): Promise<string>;
  binding(signal: AbortSignal): Promise<string>;
  /** Exact Rust-owned item only; the worker cannot supply a namespace/ref. */
  load(signal: AbortSignal): Promise<ChatGptTokenPair>;
  /** Exact Rust-owned delete followed by an absence proof. */
  clearAndProveAbsent(signal: AbortSignal): Promise<boolean>;
}

export interface SignedGoldenDependencies {
  approve(declaration: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
  /** Automatic PKCE. Calls persist only after identity validation succeeds. */
  oauthLogin(persist: (pair: ChatGptTokenPair, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<SignedGoldenOAuthActuals>;
  credential: SignedGoldenCredentialScope;
  execute(input: Readonly<{
    executorModel: string;
    judgeModel: string;
    accountFingerprint: string;
    brokerBinding: string;
    credential: ChatGptTokenPair;
    signal: AbortSignal;
  }>): Promise<{ code: number; counters: GoldenCounters }>;
  assertHomeIdentity(): void;
  assertSourceIdentity(): void;
}

export interface SignedGoldenResult {
  readonly code: number;
  readonly counters: GoldenCounters;
  readonly cleanupProven: true;
  readonly runAuthorizationId: string;
  readonly oauthActuals: SignedGoldenOAuthActuals;
}

export interface SignedGoldenOAuthActuals {
  readonly navigation: 1;
  readonly callback: 1;
  readonly token: 1;
  readonly retries: 0;
}

function exactOAuthActuals(value: SignedGoldenOAuthActuals): boolean {
  return value.navigation === 1 && value.callback === 1 && value.token === 1 && value.retries === 0 &&
    Object.keys(value).length === 4;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function authorization(declaration: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...declaration,
    authorization_id: createHash("sha256").update(canonical(declaration)).digest("hex") });
}

function accountFingerprint(accountId: string | undefined): string {
  return createHash("sha256").update(accountId ?? "").digest("hex").slice(0, 12);
}

function validateConfig(config: SignedGoldenConfig): void {
  if (!SAFE_MODEL.test(config.executorModel) || !SAFE_MODEL.test(config.judgeModel) ||
      !SAFE_FINGERPRINT.test(config.expectedAccountFingerprint) ||
      !SAFE_DIGEST.test(config.fixtureSha256) || !SAFE_DIGEST.test(config.baselineSha256) || !SAFE_DIGEST.test(config.gateSourceSha256) || !SAFE_DIGEST.test(config.codeIdentitySha256) ||
      !SAFE_DIGEST.test(config.bundleSha256) || !Number.isSafeInteger(config.evalHomeIdentity.dev) ||
      !Number.isSafeInteger(config.evalHomeIdentity.ino) || config.evalHomeIdentity.mode !== "0700" ||
      !/^\d+\.\d+\.\d+$/.test(config.appVersion)) {
    throw new Error("signed ChatGPT golden configuration is invalid");
  }
}

/**
 * One signed-app/broker-lifetime P6-F ceremony. No token, account id, or raw
 * persistent reference enters either declaration or the returned evidence.
 * The Rust broker owns the crash receipt and exact Keychain cleanup.
 */
export async function runCombinedSignedChatGptGolden(
  config: SignedGoldenConfig,
  dependencies: SignedGoldenDependencies,
  signal: AbortSignal,
): Promise<SignedGoldenResult> {
  validateConfig(config);
  if (signal.aborted) throw new Error("signed ChatGPT golden ceremony cancelled");
  dependencies.assertHomeIdentity();
  dependencies.assertSourceIdentity();
  const loginDeclaration = authorization({
    mode: "P6-F signed-app ChatGPT OAuth",
    app_version: config.appVersion,
    expected_account_fingerprint: config.expectedAccountFingerprint,
    eval_home_identity: config.evalHomeIdentity,
    bundle_sha256: config.bundleSha256,
    endpoints: {
      authorize: { method: "GET", url: "https://auth.openai.com/oauth/authorize", calls: 1 },
      callback: { method: "GET", url: "http://localhost:1455/auth/callback", calls: 1 },
      token: { method: "POST", url: "https://auth.openai.com/oauth/token", calls: 1 },
    },
    oauth_contract: { client_id: CHATGPT_OAUTH_CLIENT_ID, scope: CHATGPT_OAUTH_SCOPE,
      redirect_uri: "http://localhost:1455/auth/callback", response_type: "code", code_challenge_method: "S256",
      originator: "supertwinv13", id_token_add_organizations: "true", codex_cli_simplified_flow: "true",
      token_content_type: "application/x-www-form-urlencoded", token_accept: "application/json", redirect: "error" },
    models: 0, quota: 0, refresh: 0, inference: 0, retries: 0,
  });
  await dependencies.approve(loginDeclaration, signal);
  dependencies.assertHomeIdentity(); dependencies.assertSourceIdentity();

  let created = false;
  let cleanupProven = false;
  let validatedAccountId: string | undefined;
  try {
    const oauthActuals = await dependencies.oauthLogin(async (pair, persistSignal) => {
      if (!pair.accountId || accountFingerprint(pair.accountId) !== config.expectedAccountFingerprint) {
        throw new Error("signed ChatGPT golden selected the wrong account");
      }
      dependencies.assertHomeIdentity(); dependencies.assertSourceIdentity();
      const binding = await dependencies.credential.create(pair, persistSignal);
      if (!SAFE_DIGEST.test(binding)) throw new Error("signed ChatGPT golden credential binding is invalid");
      validatedAccountId = pair.accountId;
      created = true;
    }, signal);
    if (!exactOAuthActuals(oauthActuals)) throw new Error("signed ChatGPT golden OAuth actuals are invalid");
    if (!created || !validatedAccountId) throw new Error("signed ChatGPT golden OAuth did not persist credentials");
    const credential = await dependencies.credential.load(signal);
    if (credential.accountId !== validatedAccountId ||
        accountFingerprint(credential.accountId) !== config.expectedAccountFingerprint) {
      throw new Error("signed ChatGPT golden credential ownership is invalid");
    }
    // Rust retains the raw persistent reference. The declaration binds only a
    // non-secret digest supplied by the exact active broker scope.
    const binding = await dependencies.credential.binding(signal);
    if (!SAFE_DIGEST.test(binding)) throw new Error("signed ChatGPT golden credential binding is invalid");
    dependencies.assertHomeIdentity(); dependencies.assertSourceIdentity();
    const runDeclaration = authorization({
      mode: "P6-F provider golden",
      app_version: config.appVersion,
      provider: "chatgpt-oauth",
      executor_model: config.executorModel,
      judge_model: config.judgeModel,
      expected_account_fingerprint: config.expectedAccountFingerprint,
      fixture_sha256: config.fixtureSha256,
      baseline_sha256: config.baselineSha256,
      gate_source_sha256: config.gateSourceSha256,
      code_identity_sha256: config.codeIdentitySha256,
      bundle_sha256: config.bundleSha256,
      broker_binding_sha256: binding,
      absolute_physical_call_ceiling: 696,
      cases: { live: 116, code: 162 },
      nominal_no_repair_physical_calls: 232,
      repairs_and_401_retries_are_counted: true,
      inference_endpoint: { method: "POST", url: "https://chatgpt.com/backend-api/codex/responses" },
      metadata_endpoint_call_ceilings: {
        models: { method: "GET", url: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0", calls: 1 },
        quota: { method: "GET", url: "https://chatgpt.com/backend-api/wham/usage", calls: 697 },
        refresh: { method: "POST", url: "https://auth.openai.com/oauth/token", calls: 1394 },
      },
      compatibility_canary: "suppressed_zero_calls",
      oauth_actuals: oauthActuals,
      cost: "unknown",
    });
    await dependencies.approve(runDeclaration, signal);
    dependencies.assertHomeIdentity(); dependencies.assertSourceIdentity();
    const result = await dependencies.execute({ executorModel: config.executorModel,
      judgeModel: config.judgeModel, accountFingerprint: config.expectedAccountFingerprint,
      brokerBinding: binding, credential, signal });
    return { ...result, cleanupProven: true, runAuthorizationId: String(runDeclaration.authorization_id), oauthActuals };
  } finally {
    if (created) cleanupProven = await dependencies.credential.clearAndProveAbsent(new AbortController().signal);
    if (created && !cleanupProven) throw new Error("signed ChatGPT golden credential cleanup is unproven");
  }
}
