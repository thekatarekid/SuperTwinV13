import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { BrowserOAuthManagerDependencies } from "../providers/chatgpt-oauth/auth.js";
import { GOLDEN_CHATGPT_LOGIN_ENV, GoldenChatGptCleanupError, createGoldenCredentialTarget, goldenChatGptLoginFailureMessage,
  runGoldenChatGptLogin } from "./provider-golden-chatgpt-login.js";
import { keychainAccountForHome } from "./provider-golden-rail.js";

const homes: string[] = [];
const expectedFingerprint = createHash("sha256").update("account-safe").digest("hex").slice(0, 12);
const ownership = "1".repeat(32);
const cleanIdentity = () => ({ commit: "a".repeat(40), tree: "b".repeat(40), status: "" });
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function home(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "supertwin-golden-login-")));
  homes.push(value); return value;
}

function target(evalHome: string) {
  const install = vi.fn(async () => undefined);
  const logout = vi.fn(async () => undefined);
  const close = vi.fn();
  return { account: keychainAccountForHome(evalHome), initiallyEmpty: true,
    session: { install, logout, close, current: () => ({ accessToken: "secret", refreshToken: "secret-refresh",
      expiresAtMs: Date.now() + 60_000, accountId: "account-safe" }) }, install, logout, close };
}

function successfulManager(onWait?: () => void, accountId = "account-safe") {
  return (options: BrowserOAuthManagerDependencies) => ({
    async start() {
      const signal = new AbortController().signal;
      await options.openBrowser("https://auth.openai.com/oauth/authorize?safe=1", signal);
      const listener = await options.createCallbackListener!({ host: "127.0.0.1", port: 1455,
        expectedState: "state", signal });
      await listener.callback;
      await options.fetch!("https://auth.openai.com/oauth/token", { method: "POST" });
      await options.credentialStore.save({ accessToken: "secret", refreshToken: "secret-refresh",
        expiresAtMs: Date.now() + 60_000, accountId }, signal);
      return { loginId: "login", authUrl: "https://auth.openai.com/oauth/authorize", expiresAt: Date.now() + 1_000 };
    },
    async wait() { onWait?.(); },
    async shutdown() { /* listener lifecycle is owned by BrowserOAuthManager in production */ },
  });
}

function callbackListener() {
  return { callback: Promise.resolve({ code: "never-output", response: { finish: vi.fn() } }), close: vi.fn(async () => undefined) };
}

async function declaration(evalHome: string): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  await runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership], {},
  { output: (line) => lines.push(line), repositoryIdentity: cleanIdentity });
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

it("prints the frozen zero-extra-call declaration before requiring both opt-ins", async () => {
  const evalHome = home();
  const createCredentialTarget = vi.fn();
  const lines: string[] = [];
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", "a".repeat(64)], {}, { output: (line) => lines.push(line), createCredentialTarget,
      repositoryIdentity: cleanIdentity }))
    .rejects.toThrow(/opt-in/);
  expect(createCredentialTarget).not.toHaveBeenCalled();
  expect(JSON.parse(lines[0]!)).toMatchObject({ endpoint_budget: { browser_navigation: { calls: 1 },
    localhost_callback: { calls: 1 }, authorization_code_exchange: { calls: 1 }, models: 0, quota: 0,
    refresh: 0, inference: 0, retries: 0 } });
});

it("installs exactly once, emits only redacted binding/counts, and leaves home empty", async () => {
  const evalHome = home();
  const preflight = await declaration(evalHome);
  const credential = target(evalHome);
  const lines: string[] = [];
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
      platform: "darwin", interactive: true, output: (line) => lines.push(line),
      createCredentialTarget: async () => credential, createManager: successfulManager(),
      openBrowser: vi.fn(async () => undefined), fetch: vi.fn(async () => new Response("{}")) as never,
      createCallbackListener: async () => callbackListener(),
      repositoryIdentity: cleanIdentity,
    })).resolves.toBe(0);
  expect(credential.install).toHaveBeenCalledOnce();
  expect(credential.logout).not.toHaveBeenCalled();
  expect(credential.close).toHaveBeenCalledOnce();
  const success = JSON.parse(lines[1]!);
  expect(success).toMatchObject({ status: "signed_in", account_fingerprint:
    createHash("sha256").update("account-safe").digest("hex").slice(0, 12),
  actuals: { browserNavigation: 1, callback: 1, authorizationCodeExchange: 1 },
  retained_for_provider_golden: true });
  expect(lines.join("\n")).not.toMatch(/secret|account-safe|never-output/);
});

it("refuses extra token traffic and clears a possibly installed credential", async () => {
  const evalHome = home();
  const preflight = await declaration(evalHome);
  const credential = target(evalHome);
  const createManager = (options: BrowserOAuthManagerDependencies) => ({
    async start() {
      await options.fetch!("https://auth.openai.com/oauth/token", { method: "POST" });
      await options.fetch!("https://auth.openai.com/oauth/token", { method: "POST" });
      return { loginId: "login", authUrl: "https://auth.openai.com", expiresAt: 1 };
    }, async wait() {}, async shutdown() {},
  });
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
      platform: "darwin", interactive: true, output: () => undefined, createCredentialTarget: async () => credential,
      createManager, fetch: vi.fn(async () => new Response("{}")) as never,
      repositoryIdentity: cleanIdentity,
    })).rejects.toThrow(/budget/);
  expect(credential.logout).toHaveBeenCalledOnce();
});

it("rechecks the frozen home after callback and clears credentials on drift", async () => {
  const evalHome = home();
  const preflight = await declaration(evalHome);
  const credential = target(evalHome);
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
      platform: "darwin", interactive: true, output: () => undefined, createCredentialTarget: async () => credential,
      createManager: successfulManager(() => writeFileSync(join(evalHome, "drift"), "x")),
      openBrowser: async () => undefined, fetch: vi.fn(async () => new Response("{}")) as never,
      createCallbackListener: async () => callbackListener(),
      repositoryIdentity: cleanIdentity,
    })).rejects.toThrow(/INVALID_DECLARATION/);
  expect(credential.logout).toHaveBeenCalledOnce();
});

it("surfaces an unproven cleanup after a post-persist failure and never calls it safe", async () => {
  const evalHome = home(); const preflight = await declaration(evalHome); const credential = target(evalHome);
  credential.logout.mockRejectedValueOnce(new Error("secret delete detail"));
  let caught: unknown;
  try {
    await runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
      "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
      "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
        platform: "darwin", interactive: true, output: () => undefined, createCredentialTarget: async () => credential,
        createManager: successfulManager(() => writeFileSync(join(evalHome, "post-persist-drift"), "x")),
        openBrowser: async () => undefined, fetch: vi.fn(async () => new Response("{}")) as never,
        createCallbackListener: async () => callbackListener(), repositoryIdentity: cleanIdentity,
      });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GoldenChatGptCleanupError);
  expect(goldenChatGptLoginFailureMessage(caught)).toBe(
    `golden ChatGPT login cleanup failed; remove exact ownership ${ownership}\n`);
  expect(goldenChatGptLoginFailureMessage(caught)).not.toContain("failed safely");
  expect(credential.install).toHaveBeenCalledOnce();
  expect(credential.logout).toHaveBeenCalledOnce();
});

it("retains a cleanup candidate when create-once throws after a possible durable commit", async () => {
  const evalHome = home(); const preflight = await declaration(evalHome);
  const pair = { accessToken: "secret", refreshToken: "refresh", expiresAtMs: Date.now() + 60_000,
    accountId: "account-safe" };
  const clearOwned = vi.fn(async () => false);
  const credential = await createGoldenCredentialTarget("/unused", expectedFingerprint, ownership, {
    account: keychainAccountForHome(evalHome), isEmpty: async () => true,
    createOwned: async () => { throw new Error("ambiguous command close"); }, clearOwned,
  } as never);
  await expect(credential.session.install(pair)).rejects.toThrow(/ambiguous/);
  await expect(credential.session.logout()).rejects.toThrow(/cleanup failed/);
  expect(clearOwned).toHaveBeenCalledWith(ownership, pair);
  clearOwned.mockClear();
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
      platform: "darwin", interactive: true, output: () => undefined, createCredentialTarget: async () => credential,
      createManager: successfulManager(), openBrowser: async () => undefined,
      fetch: vi.fn(async () => new Response("{}")) as never, createCallbackListener: async () => callbackListener(),
      repositoryIdentity: cleanIdentity,
    })).rejects.toBeInstanceOf(GoldenChatGptCleanupError);
  expect(clearOwned).toHaveBeenCalledOnce();
});

it("refuses a nonempty Keychain namespace before browser/network and closes its session", async () => {
  const evalHome = home();
  const preflight = await declaration(evalHome);
  const credential = { ...target(evalHome), initiallyEmpty: false };
  const createManager = vi.fn();
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
      platform: "darwin", interactive: true, output: () => undefined,
      createCredentialTarget: async () => credential, createManager,
      repositoryIdentity: cleanIdentity,
    })).rejects.toThrow(/credential target/);
  expect(createManager).not.toHaveBeenCalled();
  expect(credential.close).toHaveBeenCalledOnce();
  expect(credential.logout).not.toHaveBeenCalled();
});

it("rejects a changed source identity at the credential commit boundary", async () => {
  const evalHome = home();
  const preflight = await declaration(evalHome);
  const credential = target(evalHome);
  let reads = 0;
  const drifting = () => (++reads < 2 ? cleanIdentity() : { commit: "c".repeat(40), tree: "d".repeat(40), status: "" });
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
      platform: "darwin", interactive: true, output: () => undefined, createCredentialTarget: async () => credential,
      createManager: successfulManager(), openBrowser: async () => undefined,
      fetch: vi.fn(async () => new Response("{}")) as never, createCallbackListener: async () => callbackListener(),
      repositoryIdentity: drifting,
    })).rejects.toThrow(/source identity changed/);
  expect(credential.install).not.toHaveBeenCalled();
});

it("rejects the wrong account before any credential install", async () => {
  const evalHome = home(); const preflight = await declaration(evalHome); const credential = target(evalHome);
  await expect(runGoldenChatGptLogin(["--golden-chatgpt-login", "--eval-home", evalHome,
    "--account-fingerprint", expectedFingerprint, "--keychain-ownership", ownership, "--execute", "yes",
    "--authorization-id", String(preflight.authorization_id)], { [GOLDEN_CHATGPT_LOGIN_ENV]: "1" }, {
      platform: "darwin", interactive: true, output: () => undefined, createCredentialTarget: async () => credential,
      createManager: successfulManager(undefined, "wrong-account"), openBrowser: async () => undefined,
      fetch: vi.fn(async () => new Response("{}")) as never, createCallbackListener: async () => callbackListener(),
      repositoryIdentity: cleanIdentity,
    })).rejects.toThrow(/wrong account/);
  expect(credential.install).not.toHaveBeenCalled();
});

it("contains no DB/runtime/catalogue/device/API-key/fallback transport", () => {
  const source = readFileSync(join(import.meta.dirname, "provider-golden-chatgpt-login.ts"), "utf8");
  expect(source).not.toMatch(/runMigrations|initializeProductionChatGptRuntime|discoverChatGpt|pollChatGptQuota/);
  expect(source).not.toMatch(/device.?code|api.?key|fallback/i);
  expect(source.match(/CHATGPT_OAUTH_TOKEN_URL/g)?.length).toBeGreaterThan(1);
});
