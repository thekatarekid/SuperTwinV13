import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  BrowserOAuthManager,
  CHATGPT_OAUTH_AUTHORIZE_URL,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_TOKEN_URL,
  createBrowserOAuthTokenSession,
  createNodeBrowserOAuthCallbackListener,
  type BrowserOAuthManagerDependencies,
} from "../providers/chatgpt-oauth/auth.js";
import { ChatGptKeychainStore, ChatGptTokenSession } from "../providers/chatgpt-oauth/keychain.js";
import { assertGoldenEvalHomeIdentity, bindGoldenEvalHome, keychainAccountForHome,
  resolveGoldenRepositoryIdentity, type GoldenRepositoryIdentityReader } from "./provider-golden-rail.js";

export const GOLDEN_CHATGPT_LOGIN_ENV = "SUPERTWIN_RUN_GOLDEN_CHATGPT_LOGIN";

export class GoldenChatGptCleanupError extends Error {
  constructor(readonly ownership: string) {
    super(`golden ChatGPT login credential cleanup unproven; remediation ownership ${ownership}`);
    this.name = "GoldenChatGptCleanupError";
  }
}

export function goldenChatGptLoginFailureMessage(error: unknown): string {
  return error instanceof GoldenChatGptCleanupError
    ? `golden ChatGPT login cleanup failed; remove exact ownership ${error.ownership}\n`
    : "golden ChatGPT login failed safely\n";
}

interface CredentialTarget {
  account: string;
  initiallyEmpty: boolean;
  session: Pick<ChatGptTokenSession, "install" | "current" | "logout" | "close">;
}

export interface GoldenChatGptLoginDependencies {
  platform?: NodeJS.Platform;
  interactive?: boolean;
  output(line: string): void;
  createCredentialTarget?(home: string, expectedFingerprint: string, ownership: string): Promise<CredentialTarget>;
  createManager?(dependencies: BrowserOAuthManagerDependencies): Pick<BrowserOAuthManager, "start" | "wait" | "shutdown">;
  openBrowser?(url: string, signal: AbortSignal): Promise<void>;
  fetch?: typeof fetch;
  createCallbackListener?: BrowserOAuthManagerDependencies["createCallbackListener"];
  installSignalHandlers?(handler: () => void): () => void;
  repositoryIdentity?: GoldenRepositoryIdentityReader;
}

const DEFAULT_OUTPUT = (line: string): void => { process.stdout.write(line); };

async function openSystemBrowser(url: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], { shell: false, stdio: "ignore", signal });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("browser opener failed")));
  });
}

function defaultSignals(handler: () => void): () => void {
  process.on("SIGINT", handler); process.on("SIGTERM", handler);
  return () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); };
}

type GoldenCredentialStore = Pick<ChatGptKeychainStore, "account" | "isEmpty" | "createOwned" | "clearOwned">;

export async function createGoldenCredentialTarget(home: string, expectedFingerprint: string, ownership: string,
  injectedStore?: GoldenCredentialStore): Promise<CredentialTarget> {
  const store = injectedStore ?? new ChatGptKeychainStore({ resolveHome: () => home });
  let installed: ReturnType<ChatGptTokenSession["current"]> | undefined;
  return { account: store.account, initiallyEmpty: await store.isEmpty(), session: {
    async install(pair) {
      const fingerprint = createHash("sha256").update(pair.accountId ?? "").digest("hex").slice(0, 12);
      if (fingerprint !== expectedFingerprint) throw new Error("golden ChatGPT login selected the wrong account");
      installed = pair;
      const created = await store.createOwned(pair, ownership);
      if (!created) {
        installed = undefined;
        throw new Error("golden ChatGPT login credential target is occupied");
      }
    },
    current() { if (!installed) throw new Error("golden ChatGPT login did not install credentials"); return installed; },
    async logout() { if (installed && !await store.clearOwned(ownership, installed)) throw new Error("owned credential cleanup failed"); },
    close() { installed = undefined; },
  } as CredentialTarget["session"] };
}

function parseArgs(args: readonly string[]): { home: string; expectedFingerprint: string; ownership: string; execute: boolean; authorizationId?: string } {
  if (args.length !== 7 && args.length !== 11) throw new Error("golden ChatGPT login arguments are invalid");
  if (args[0] !== "--golden-chatgpt-login" || args[1] !== "--eval-home" || !args[2] ||
      args[3] !== "--account-fingerprint" || !/^[a-f0-9]{12}$/.test(args[4] ?? "") ||
      args[5] !== "--keychain-ownership" || !/^[a-f0-9]{32}$/.test(args[6] ?? "")) {
    throw new Error("golden ChatGPT login arguments are invalid");
  }
  if (args.length === 11 && (args[7] !== "--execute" || args[8] !== "yes" ||
      args[9] !== "--authorization-id" || !/^[a-f0-9]{64}$/.test(args[10] ?? ""))) {
    throw new Error("golden ChatGPT login arguments are invalid");
  }
  return { home: args[2], expectedFingerprint: args[4]!, ownership: args[6]!, execute: args.length === 11,
    ...(args[10] ? { authorizationId: args[10] } : {}) };
}

export async function runGoldenChatGptLogin(
  args: readonly string[], env: NodeJS.ProcessEnv = process.env,
  dependencies: GoldenChatGptLoginDependencies = { output: DEFAULT_OUTPUT },
): Promise<number> {
  const parsed = parseArgs(args);
  const identity = bindGoldenEvalHome(parsed.home);
  const keychainAccount = keychainAccountForHome(identity.path);
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const repositoryIdentity = resolveGoldenRepositoryIdentity(repoRoot, dependencies.repositoryIdentity);
  const declaration = {
    mode: "P6-F ChatGPT credential bootstrap",
    keychain_account: keychainAccount,
    keychain_ownership: parsed.ownership,
    expected_account_fingerprint: parsed.expectedFingerprint,
    repository_identity: repositoryIdentity,
    ceremony: { app_version: "13.12.2", client_id: CHATGPT_OAUTH_CLIENT_ID, originator: "supertwinv13",
      authorize_url: CHATGPT_OAUTH_AUTHORIZE_URL, token_url: CHATGPT_OAUTH_TOKEN_URL,
      redirect_uri: CHATGPT_OAUTH_REDIRECT_URI, pkce: "S256", listener: "127.0.0.1:1455/auth/callback" },
    eval_home_identity: { dev: identity.dev, ino: identity.ino, mode: "0700", empty: true },
    endpoint_budget: {
      browser_navigation: { method: "GET", url: "https://auth.openai.com/oauth/authorize", calls: 1 },
      localhost_callback: { method: "GET", url: "http://localhost:1455/auth/callback", calls: 1 },
      authorization_code_exchange: { method: "POST", url: CHATGPT_OAUTH_TOKEN_URL, calls: 1 },
      models: 0, quota: 0, refresh: 0, inference: 0, retries: 0,
    },
  };
  const authorizationId = createHash("sha256").update(JSON.stringify(declaration)).digest("hex");
  dependencies.output(`${JSON.stringify({ ...declaration, authorization_id: authorizationId })}\n`);
  if (!parsed.execute) return 0;
  if (parsed.authorizationId !== authorizationId || env[GOLDEN_CHATGPT_LOGIN_ENV] !== "1" ||
      (dependencies.platform ?? process.platform) !== "darwin" ||
      !(dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY))) {
    throw new Error("golden ChatGPT login lacks exact owner opt-in");
  }
  assertGoldenEvalHomeIdentity(identity);
  const target = await (dependencies.createCredentialTarget ?? createGoldenCredentialTarget)(identity.path,
    parsed.expectedFingerprint, parsed.ownership);
  if (target.account !== keychainAccount || !target.initiallyEmpty) {
    target.session.close();
    throw new Error("golden ChatGPT login credential target is unavailable");
  }
  const counts = { browserNavigation: 0, callback: 0, authorizationCodeExchange: 0 };
  const openBrowser = dependencies.openBrowser ?? openSystemBrowser;
  const fetchImpl = dependencies.fetch ?? fetch;
  const listenerFactory = dependencies.createCallbackListener ?? createNodeBrowserOAuthCallbackListener;
  const managerDependencies: BrowserOAuthManagerDependencies = {
    browserOwner: "manager",
    credentialStore: {
      async save(pair, signal) {
        const fingerprint = createHash("sha256").update(pair.accountId ?? "").digest("hex").slice(0, 12);
        if (fingerprint !== parsed.expectedFingerprint) throw new Error("golden ChatGPT login selected the wrong account");
        if (JSON.stringify(resolveGoldenRepositoryIdentity(repoRoot, dependencies.repositoryIdentity)) !== JSON.stringify(repositoryIdentity)) {
          throw new Error("golden ChatGPT login source identity changed");
        }
        assertGoldenEvalHomeIdentity(identity);
        await target.session.install(pair, signal);
      },
    },
    tokenSession: createBrowserOAuthTokenSession(),
    openBrowser: async (url, signal) => {
      if (++counts.browserNavigation !== 1) throw new Error("golden ChatGPT login browser budget exceeded");
      await openBrowser(url, signal);
    },
    fetch: (async (input, init) => {
      if (String(input) !== CHATGPT_OAUTH_TOKEN_URL || init?.method !== "POST" ||
          ++counts.authorizationCodeExchange !== 1) throw new Error("golden ChatGPT login network budget exceeded");
      return fetchImpl(input, init);
    }) as typeof fetch,
    createCallbackListener: async (options) => {
      const listener = await listenerFactory(options);
      return { close: () => listener.close(), callback: listener.callback.then((callback) => {
        if (++counts.callback !== 1) throw new Error("golden ChatGPT login callback budget exceeded");
        return callback;
      }) };
    },
  };
  const manager = (dependencies.createManager ?? ((options) => new BrowserOAuthManager(options)))(managerDependencies);
  let signalled = false;
  let completed = false;
  const uninstall = (dependencies.installSignalHandlers ?? defaultSignals)(() => {
    signalled = true; void manager.shutdown();
  });
  try {
    const started = await manager.start();
    await manager.wait(started.loginId);
    if (JSON.stringify(resolveGoldenRepositoryIdentity(repoRoot, dependencies.repositoryIdentity)) !== JSON.stringify(repositoryIdentity)) {
      throw new Error("golden ChatGPT login source identity changed");
    }
    if (signalled || counts.browserNavigation !== 1 || counts.callback !== 1 || counts.authorizationCodeExchange !== 1) {
      throw new Error("golden ChatGPT login did not complete its exact ceremony");
    }
    assertGoldenEvalHomeIdentity(identity);
    const current = target.session.current();
    if (!current.accountId || Buffer.byteLength(current.accountId, "utf8") > 4_096) {
      throw new Error("golden ChatGPT login account binding failed");
    }
    const accountFingerprint = createHash("sha256").update(current.accountId).digest("hex").slice(0, 12);
    if (accountFingerprint !== parsed.expectedFingerprint) throw new Error("golden ChatGPT login selected the wrong account");
    dependencies.output(`${JSON.stringify({ status: "signed_in", account_fingerprint: accountFingerprint,
      keychain_account: keychainAccount, eval_home_identity: declaration.eval_home_identity,
      actuals: counts, retained_for_provider_golden: true })}\n`);
    completed = true;
    return 0;
  } catch (error) {
    if (!completed) {
      try { await target.session.logout(); }
      catch { throw new GoldenChatGptCleanupError(parsed.ownership); }
    }
    throw error;
  } finally {
    uninstall();
    await manager.shutdown().catch(() => undefined);
    target.session.close();
  }
}
