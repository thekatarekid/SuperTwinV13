import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { homeRoot } from "../../home.js";
import type { ProviderAuthState, ProviderErrorCode } from "../types.js";

const KEYCHAIN_SERVICE = "SuperTwinV13 ChatGPT OAuth";
const ACCOUNT_PREFIX = "supertwin.chatgpt-oauth.";
const REFRESH_SKEW_MS = 120_000;
const MAX_KEYCHAIN_VALUE_BYTES = 128 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_ACCOUNT_ID_BYTES = 4 * 1024;
const MAX_REFRESH_RESPONSE_BYTES = 128 * 1024;
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

const accountOperationTails = new Map<string, Promise<void>>();
const accountRefreshes = new Map<string, Promise<ChatGptTokenPair>>();
const accountEpochs = new Map<string, number>();
const accountSessions = new Map<string, Set<ChatGptTokenSession>>();

function accountEpoch(account: string): number {
  return accountEpochs.get(account) ?? 0;
}

async function withAccountLock<T>(account: string, operation: () => Promise<T>): Promise<T> {
  const prior = accountOperationTails.get(account) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolveLock) => { release = resolveLock; });
  accountOperationTails.set(account, mine);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (accountOperationTails.get(account) === mine) accountOperationTails.delete(account);
  }
}

export type ChatGptCredentialErrorCode = Extract<
  ProviderErrorCode,
  "AUTH_REQUIRED" | "AUTH_EXPIRED" | "RATE_LIMITED" | "TRANSPORT_ERROR"
>;

/** Fixed messages only: command output and OAuth material never cross this boundary. */
export class ChatGptCredentialError extends Error {
  constructor(readonly code: ChatGptCredentialErrorCode, message: string) {
    super(message);
    this.name = "ChatGptCredentialError";
  }
}

export interface ChatGptTokenPair {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  accountId?: string;
}

interface StoredCredentialEnvelope {
  version: 1;
  current: ChatGptTokenPair;
  previous?: ChatGptTokenPair;
}

export interface KeychainCommandResult {
  stdout: string;
  stderr: string;
}

export type KeychainCommand = (
  executable: string,
  args: readonly string[],
  secretStdin?: string,
  signal?: AbortSignal,
) => Promise<KeychainCommandResult>;

export interface ChatGptKeychainOptions {
  command?: KeychainCommand;
  resolveHome?: () => string;
}

interface CommandFailure extends Error {
  code?: string | number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || byteLength(value) > maxBytes) return undefined;
  return value;
}

function normalizePair(value: unknown): ChatGptTokenPair | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some((key) => !["accessToken", "refreshToken", "expiresAtMs", "accountId"].includes(key))) {
    return undefined;
  }
  const accessToken = boundedString(row.accessToken, MAX_TOKEN_BYTES);
  const refreshToken = boundedString(row.refreshToken, MAX_TOKEN_BYTES);
  const accountId = boundedString(row.accountId, MAX_ACCOUNT_ID_BYTES);
  const expiresAtMs = row.expiresAtMs;
  if (!accessToken) return undefined;
  if (expiresAtMs !== undefined &&
      (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0)) {
    return undefined;
  }
  if (row.refreshToken !== undefined && !refreshToken) return undefined;
  if (row.accountId !== undefined && !accountId) return undefined;
  return { accessToken, refreshToken, expiresAtMs, accountId };
}

function normalizeDurablePair(value: unknown): ChatGptTokenPair | undefined {
  const pair = normalizePair(value);
  return pair?.refreshToken !== undefined && pair.expiresAtMs !== undefined && pair.accountId !== undefined
    ? pair
    : undefined;
}

function clonePair(pair: ChatGptTokenPair): ChatGptTokenPair {
  return { ...pair };
}

function encodeEnvelope(envelope: StoredCredentialEnvelope): string {
  const current = normalizeDurablePair(envelope.current);
  const previous = envelope.previous === undefined ? undefined : normalizeDurablePair(envelope.previous);
  if (!current || (envelope.previous !== undefined && !previous)) {
    throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT credential data is invalid; sign in again");
  }
  const encoded = JSON.stringify({ version: 1, current, ...(previous ? { previous } : {}) });
  if (byteLength(encoded) > MAX_KEYCHAIN_VALUE_BYTES) {
    throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT credential data is invalid; sign in again");
  }
  return encoded;
}

function decodeEnvelope(encoded: string): StoredCredentialEnvelope {
  if (byteLength(encoded) > MAX_KEYCHAIN_VALUE_BYTES) {
    throw new ChatGptCredentialError("AUTH_EXPIRED", "Stored ChatGPT credentials are invalid; sign in again");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new ChatGptCredentialError("AUTH_EXPIRED", "Stored ChatGPT credentials are invalid; sign in again");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatGptCredentialError("AUTH_EXPIRED", "Stored ChatGPT credentials are invalid; sign in again");
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || Object.keys(row).some((key) => !["version", "current", "previous"].includes(key))) {
    throw new ChatGptCredentialError("AUTH_EXPIRED", "Stored ChatGPT credentials are invalid; sign in again");
  }
  const current = normalizeDurablePair(row.current);
  const previous = row.previous === undefined ? undefined : normalizeDurablePair(row.previous);
  if (!current || (row.previous !== undefined && !previous)) {
    throw new ChatGptCredentialError("AUTH_EXPIRED", "Stored ChatGPT credentials are invalid; sign in again");
  }
  return { version: 1, current, ...(previous ? { previous } : {}) };
}

function envelopesEqual(
  left: StoredCredentialEnvelope | undefined,
  right: StoredCredentialEnvelope | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return encodeEnvelope(left) === encodeEnvelope(right);
}

async function defaultCommand(
  executable: string,
  args: readonly string[],
  secretStdin?: string,
  signal?: AbortSignal,
): Promise<KeychainCommandResult> {
  if (signal?.aborted) {
    throw new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled");
  }
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let forcedError: Error | undefined;
    const stop = (error: Error): void => {
      if (settled) return;
      forcedError ??= error;
      child.kill("SIGKILL");
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_KEYCHAIN_VALUE_BYTES) {
        stop(new Error("Keychain command output exceeded its limit"));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    // SIGKILL can close the pipe before the bounded secret finishes writing;
    // process completion, not this pipe event, settles the operation.
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectCommand(forcedError ?? error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (forcedError) rejectCommand(forcedError);
      else if (code === 0) resolveCommand({ stdout, stderr });
      else rejectCommand(Object.assign(new Error("Keychain command failed"), { code }));
    });
    const onAbort = (): void => stop(new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(new Error("Keychain command timed out")), 10_000);
    timer.unref();
    child.stdin.end(secretStdin);
  });
}

function isMissingItem(error: unknown): boolean {
  const failure = error as CommandFailure;
  return failure?.code === 44;
}

export function chatGptKeychainAccount(canonicalHome = homeRoot()): string {
  if (typeof canonicalHome !== "string" || canonicalHome.length === 0 || byteLength(canonicalHome) > 16 * 1024) {
    throw new ChatGptCredentialError("TRANSPORT_ERROR", "SuperTwin home is unavailable");
  }
  const fingerprint = createHash("sha256").update(resolve(canonicalHome), "utf8").digest("hex").slice(0, 16);
  return `${ACCOUNT_PREFIX}${fingerprint}`;
}

/**
 * macOS generic-password storage accessed through `security` with argv only.
 * No shell is involved. We intentionally do not pass `-A`: the login Keychain
 * retains its normal user-authorized ACL instead of granting every process
 * access. Because `security` mediates access, a Tauri re-sign does not rewrite
 * or broaden the item's ACL; the user's login-Keychain policy still applies.
 */
export class ChatGptKeychainStore {
  readonly account: string;
  readonly #command: KeychainCommand;

  constructor(options: ChatGptKeychainOptions = {}) {
    this.#command = options.command ?? defaultCommand;
    this.account = chatGptKeychainAccount((options.resolveHome ?? homeRoot)());
  }

  async loadEnvelope(): Promise<StoredCredentialEnvelope | undefined> {
    try {
      const result = await this.#command("/usr/bin/security", [
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w",
      ]);
      return decodeEnvelope(result.stdout.trimEnd());
    } catch (error) {
      if (isMissingItem(error)) return undefined;
      if (error instanceof ChatGptCredentialError) throw error;
      throw new ChatGptCredentialError("TRANSPORT_ERROR", "Unable to read ChatGPT credentials from Keychain");
    }
  }

  async load(): Promise<ChatGptTokenPair | undefined> {
    const envelope = await this.loadEnvelope();
    return envelope ? clonePair(envelope.current) : undefined;
  }

  async save(pair: ChatGptTokenPair, signal?: AbortSignal): Promise<void> {
    await this.#write({ version: 1, current: clonePair(pair) }, signal);
  }

  /** Persist current+previous as one value before exposing the rotated pair. */
  async saveRotation(next: ChatGptTokenPair, previous: ChatGptTokenPair, signal?: AbortSignal): Promise<void> {
    await this.#write({ version: 1, current: clonePair(next), previous: clonePair(previous) }, signal);
  }

  /**
   * Resolve an abort/error at the Keychain commit boundary from durable state.
   * Callers hold the process-wide account lock. If the desired envelope won,
   * success is returned; otherwise the exact prior envelope is restored.
   */
  async commit(
    current: ChatGptTokenPair,
    previous?: ChatGptTokenPair,
    signal?: AbortSignal,
  ): Promise<void> {
    const desired: StoredCredentialEnvelope = {
      version: 1,
      current: clonePair(current),
      ...(previous ? { previous: clonePair(previous) } : {}),
    };
    // Validate before reading or invoking the command.
    encodeEnvelope(desired);
    const prior = await this.loadEnvelope();
    try {
      await this.#write(desired, signal);
      return;
    } catch (writeError) {
      let durable: StoredCredentialEnvelope | undefined;
      try {
        durable = await this.loadEnvelope();
      } catch {
        throw new ChatGptCredentialError(
          "AUTH_EXPIRED",
          "ChatGPT credential commit could not be reconciled; sign in again",
        );
      }
      if (envelopesEqual(durable, desired)) return;
      if (!envelopesEqual(durable, prior)) {
        try {
          if (prior) await this.#write(prior);
          else await this.clear();
        } catch {
          throw new ChatGptCredentialError(
            "AUTH_EXPIRED",
            "ChatGPT credential commit could not be reconciled; sign in again",
          );
        }
      }
      throw writeError;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.#command("/usr/bin/security", [
        "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", this.account,
      ]);
    } catch (error) {
      if (isMissingItem(error)) return;
      throw new ChatGptCredentialError("TRANSPORT_ERROR", "Unable to clear ChatGPT credentials from Keychain");
    }
  }

  async #write(envelope: StoredCredentialEnvelope, signal?: AbortSignal): Promise<void> {
    const encoded = encodeEnvelope(envelope);
    try {
      await this.#command("/usr/bin/security", [
        "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w",
      ], encoded, signal);
    } catch (error) {
      if (error instanceof ChatGptCredentialError) throw error;
      throw new ChatGptCredentialError("TRANSPORT_ERROR", "Unable to persist ChatGPT credentials in Keychain");
    }
  }
}

export type ChatGptTokenRefresher = (
  refreshToken: string,
  signal?: AbortSignal,
) => Promise<ChatGptTokenPair>;

export interface ChatGptOAuthRefreshOptions {
  fetch: typeof fetch;
  now?: () => number;
  userAgent: string;
  signal?: AbortSignal;
}

async function boundedRefreshJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) {
    throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh returned an invalid response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REFRESH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh response exceeded its limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ChatGptCredentialError) throw error;
    throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh returned an invalid response");
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh returned an invalid response");
  }
}

/** Production refresh transport with an injected fetch seam and fixed endpoint. */
export function createChatGptOAuthRefresher(options: ChatGptOAuthRefreshOptions): ChatGptTokenRefresher {
  const now = options.now ?? Date.now;
  if (!options.userAgent || byteLength(options.userAgent) > 512) {
    throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh configuration is invalid");
  }
  return async (refreshToken, callSignal) => {
    if (!boundedString(refreshToken, MAX_TOKEN_BYTES)) {
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT sign-in expired; sign in again");
    }
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(15_000);
      response = await options.fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          timeout,
          ...(options.signal ? [options.signal] : []),
          ...(callSignal ? [callSignal] : []),
        ]),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": options.userAgent,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
    } catch {
      throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh transport failed");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT refresh was rejected; sign in again");
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new ChatGptCredentialError("RATE_LIMITED", "ChatGPT refresh was rate-limited");
    }
    const payload = await boundedRefreshJson(response);
    if (payload.error === "invalid_grant") {
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT refresh was rejected; sign in again");
    }
    if (!response.ok) {
      throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh failed");
    }
    const accessToken = boundedString(payload.access_token, MAX_TOKEN_BYTES);
    const nextRefreshToken = boundedString(payload.refresh_token, MAX_TOKEN_BYTES);
    const expiresIn = payload.expires_in;
    if (!accessToken || (payload.refresh_token !== undefined && !nextRefreshToken) ||
        (expiresIn !== undefined &&
          (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > 31_536_000))) {
      throw new ChatGptCredentialError("TRANSPORT_ERROR", "ChatGPT refresh returned an invalid response");
    }
    return {
      accessToken,
      refreshToken: nextRefreshToken,
      expiresAtMs: expiresIn === undefined ? undefined : now() + expiresIn * 1_000,
    };
  };
}

export interface ChatGptTokenSessionOptions {
  now?: () => number;
}

export class ChatGptTokenSession {
  #current?: ChatGptTokenPair;
  #previous?: ChatGptTokenPair;
  #terminalExpired = false;
  #epoch: number;
  readonly #now: () => number;

  private constructor(
    readonly store: ChatGptKeychainStore,
    readonly refreshToken: ChatGptTokenRefresher,
    options: ChatGptTokenSessionOptions,
  ) {
    this.#now = options.now ?? Date.now;
    this.#epoch = accountEpoch(store.account);
  }

  static async open(
    store: ChatGptKeychainStore,
    refreshToken: ChatGptTokenRefresher,
    options: ChatGptTokenSessionOptions = {},
  ): Promise<ChatGptTokenSession> {
    const session = new ChatGptTokenSession(store, refreshToken, options);
    const envelope = await withAccountLock(store.account, () => store.loadEnvelope());
    session.#epoch = accountEpoch(store.account);
    session.#current = envelope?.current;
    session.#previous = envelope?.previous;
    const sessions = accountSessions.get(store.account) ?? new Set<ChatGptTokenSession>();
    sessions.add(session);
    accountSessions.set(store.account, sessions);
    return session;
  }

  authState(): ProviderAuthState {
    if (this.#epoch !== accountEpoch(this.store.account)) return { status: "signed_out", error: null };
    if (!this.#current) return { status: "signed_out", error: null };
    if (this.#terminalExpired) return { status: "expired", error: "ChatGPT sign-in expired" };
    if (this.#current.expiresAtMs !== undefined && this.#current.expiresAtMs <= this.#now() && !this.#current.refreshToken) {
      return { status: "expired", error: "ChatGPT sign-in expired" };
    }
    return { status: "ready", error: null };
  }

  current(): ChatGptTokenPair {
    if (this.#epoch !== accountEpoch(this.store.account)) {
      this.#current = undefined;
      this.#previous = undefined;
      throw new ChatGptCredentialError("AUTH_REQUIRED", "ChatGPT sign-in required");
    }
    if (!this.#current) {
      throw new ChatGptCredentialError("AUTH_REQUIRED", "ChatGPT sign-in required");
    }
    if (this.#terminalExpired) {
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT sign-in expired; sign in again");
    }
    return clonePair(this.#current);
  }

  previousRecoveryPair(): ChatGptTokenPair | undefined {
    return this.#previous ? clonePair(this.#previous) : undefined;
  }

  async install(pair: ChatGptTokenPair, signal?: AbortSignal): Promise<void> {
    const normalized = normalizeDurablePair(pair);
    if (!normalized) throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT credential data is invalid; sign in again");
    await withAccountLock(this.store.account, async () => {
      if (signal?.aborted) throw new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled");
      await this.store.commit(normalized, undefined, signal);
      for (const session of accountSessions.get(this.store.account) ?? []) {
        session.#current = undefined;
        session.#previous = undefined;
        session.#terminalExpired = false;
      }
      const epoch = accountEpoch(this.store.account) + 1;
      accountEpochs.set(this.store.account, epoch);
      this.#epoch = epoch;
      this.#current = normalized;
    });
  }

  shouldRefresh(): boolean {
    const pair = this.#current;
    return pair?.expiresAtMs !== undefined && pair.expiresAtMs - this.#now() <= REFRESH_SKEW_MS;
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled");
    this.current();
    if (this.shouldRefresh()) return (await this.refresh(signal)).accessToken;
    return this.current().accessToken;
  }

  refresh(signal?: AbortSignal): Promise<ChatGptTokenPair> {
    if (signal?.aborted) return Promise.reject(
      new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled"),
    );
    this.current();
    const account = this.store.account;
    const shared = accountRefreshes.get(account);
    if (shared) {
      return shared.then((next) => {
        this.#previous = this.#current;
        this.#current = clonePair(next);
        return clonePair(next);
      }).catch((error: unknown) => {
        if (error instanceof ChatGptCredentialError && error.code === "AUTH_EXPIRED") {
          this.#terminalExpired = true;
        }
        throw error;
      });
    }
    const pending = withAccountLock(account, () => this.#performRefresh(signal));
    accountRefreshes.set(account, pending);
    void pending.finally(() => {
      if (accountRefreshes.get(account) === pending) accountRefreshes.delete(account);
    }).catch(() => undefined);
    return pending.then(clonePair);
  }

  async #performRefresh(signal?: AbortSignal): Promise<ChatGptTokenPair> {
    // Reload under the account-wide lock. Another manager instance may have
    // completed a rotation since this instance opened.
    const envelope = await this.store.loadEnvelope();
    if (!envelope) throw new ChatGptCredentialError("AUTH_REQUIRED", "ChatGPT sign-in required");
    const previous = clonePair(envelope.current);
    this.#current = previous;
    this.#previous = envelope.previous;
    if (!previous.refreshToken) {
      this.#terminalExpired = true;
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT sign-in expired; sign in again");
    }
    const refreshToken = previous.refreshToken;
    let next: ChatGptTokenPair;
    try {
      next = await new Promise<ChatGptTokenPair>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled"));
          return;
        }
        const aborted = () => reject(
          new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled"),
        );
        signal?.addEventListener("abort", aborted, { once: true });
        this.refreshToken(refreshToken, signal).then(resolve, reject).finally(() => {
          signal?.removeEventListener("abort", aborted);
        });
      });
    } catch (error) {
      if (error instanceof ChatGptCredentialError) {
        if (error.code === "AUTH_EXPIRED") this.#terminalExpired = true;
        throw error;
      }
      this.#terminalExpired = true;
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT refresh failed; sign in again");
    }
    const normalized = normalizeDurablePair({
      ...next,
      refreshToken: next.refreshToken ?? previous.refreshToken,
      accountId: next.accountId ?? previous.accountId,
    });
    if (!normalized) {
      this.#terminalExpired = true;
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT refresh failed; sign in again");
    }
    try {
      if (signal?.aborted) throw new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled");
      await this.store.commit(normalized, previous, signal);
    } catch {
      // The server may already have invalidated the old refresh token. Never
      // expose the unpersisted access token or pretend that retry is safe.
      this.#terminalExpired = true;
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT credential rotation could not be secured; sign in again");
    }
    this.#previous = previous;
    this.#current = normalized;
    return clonePair(normalized);
  }

  async retryOnceAfter401<T extends { status: number }>(
    send: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const first = await send(await this.accessToken());
    if (first.status !== 401) return first;
    const refreshed = await this.refresh();
    return send(refreshed.accessToken);
  }

  async logout(): Promise<void> {
    await withAccountLock(this.store.account, async () => {
      await this.store.clear();
      for (const session of accountSessions.get(this.store.account) ?? []) {
        session.#current = undefined;
        session.#previous = undefined;
        session.#terminalExpired = false;
      }
      const epoch = accountEpoch(this.store.account) + 1;
      accountEpochs.set(this.store.account, epoch);
      this.#epoch = epoch;
    });
  }

  /** Release this process-local view without deleting the durable Keychain item. */
  close(): void {
    this.#current = undefined;
    this.#previous = undefined;
    this.#terminalExpired = false;
    const sessions = accountSessions.get(this.store.account);
    sessions?.delete(this);
    if (sessions?.size === 0) accountSessions.delete(this.store.account);
  }
}

export const CHATGPT_REFRESH_SKEW_MS = REFRESH_SKEW_MS;
