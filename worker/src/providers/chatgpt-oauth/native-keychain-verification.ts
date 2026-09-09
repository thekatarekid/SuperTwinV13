import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  CHATGPT_KEYCHAIN_SERVICE,
  ChatGptKeychainStore,
  chatGptKeychainAccount,
  type ChatGptTokenPair,
  type KeychainCommand,
} from "./keychain.js";

export const NATIVE_KEYCHAIN_VERIFY_ENV = "SUPERTWIN_RUN_NATIVE_KEYCHAIN_TESTS";
export const NATIVE_KEYCHAIN_CONFIRMATION = "ACL CONFIRMED FOR DUMMY ITEM";
export const NATIVE_ADHOC_RESIGN_FLAG = "--allow-temp-adhoc-resign";

const APP_COPY_NAME = "SuperTwinV13.app";
const MAX_NATIVE_OUTPUT_BYTES = 128 * 1024;
const NATIVE_TIMEOUT_MS = 30_000;

export class NativeKeychainVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeKeychainVerificationError";
  }
}

export interface NativeKeychainAclSnapshot {
  found: true;
  allowAllApplications: false;
  trustedApplicationCount: number;
  authorizationCount: number;
  fingerprint: string;
}

export interface NativeKeychainAclPrompt {
  service: typeof CHATGPT_KEYCHAIN_SERVICE;
  account: string;
  requiredConfirmation: typeof NATIVE_KEYCHAIN_CONFIRMATION;
  acl: NativeKeychainAclSnapshot;
}

export interface NativeKeychainVerificationEvidence {
  status: "passed";
  networkCalls: 0;
  browserCalls: 0;
  oauthCalls: 0;
  metadataCalls: 0;
  inferenceCalls: 0;
  scratchHome: "fresh-canonical-temp-0700-disposed";
  sourceAppUntouched: true;
  appCopy: "verified-resigned-verified-disposed";
  keychain: {
    service: typeof CHATGPT_KEYCHAIN_SERVICE;
    account: string;
    productionAccountUntouched: true;
    dummySecretTransport: "stdin";
    allowAllAclFlag: false;
    aclConfirmed: true;
    aclUnchangedAfterResign: true;
    credentialUnchangedAfterResign: true;
    removedAndAbsent: true;
  };
}

export interface NativeKeychainVerificationDependencies {
  keychainCommand?: KeychainCommand;
  codesign?: (args: readonly string[], signal?: AbortSignal) => Promise<void>;
  signatureFingerprint?: (appPath: string, signal?: AbortSignal) => Promise<string>;
  copyApp?: (source: string, destination: string, signal?: AbortSignal) => Promise<void>;
  inspectAcl?: (
    service: string,
    account: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  confirmAcl: (prompt: NativeKeychainAclPrompt) => Promise<boolean>;
  random?: (bytes: number) => Buffer;
  temporaryRoot?: string;
  installSignalHandlers?: (onSignal: () => void) => () => void;
}

interface ScratchIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface NativeCommandResult {
  stdout: string;
  stderr: string;
}

function refuse(message: string): never {
  throw new NativeKeychainVerificationError(message);
}

function isChild(root: string, candidate: string): boolean {
  const tail = relative(root, candidate);
  return tail.length > 0 && !tail.startsWith("..") && !isAbsolute(tail);
}

function freshScratch(rootOverride?: string): ScratchIdentity {
  let created: string | undefined;
  try {
    const lexicalRoot = resolve(rootOverride ?? tmpdir());
    const canonicalRoot = realpathSync(lexicalRoot);
    created = mkdtempSync(join(canonicalRoot, "supertwin-keychain-native-"));
    chmodSync(created, 0o700);
    const canonical = realpathSync(created);
    const stat = lstatSync(canonical);
    const uid = process.getuid?.();
    if (!isChild(canonicalRoot, canonical) || stat.isSymbolicLink() || !stat.isDirectory() ||
        (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o700) {
      refuse("native verification scratch directory is unsafe");
    }
    return { path: canonical, dev: Number(stat.dev), ino: Number(stat.ino) };
  } catch (error) {
    if (created !== undefined) {
      try {
        const stat = lstatSync(created);
        if (!stat.isSymbolicLink() && stat.isDirectory()) rmSync(created, { recursive: true, force: false });
      } catch {
        // The fixed error below intentionally withholds the scratch path.
      }
    }
    if (error instanceof NativeKeychainVerificationError) throw error;
    return refuse("native verification could not create a safe scratch directory");
  }
}

function assertScratchIdentity(identity: ScratchIdentity): void {
  const stat = lstatSync(identity.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || Number(stat.dev) !== identity.dev ||
      Number(stat.ino) !== identity.ino || (stat.mode & 0o777) !== 0o700) {
    refuse("native verification scratch identity changed");
  }
}

function assertSourceApp(path: string): string {
  if (!isAbsolute(path) || basename(path).endsWith(".app") === false) {
    refuse("native verification requires an absolute .app path");
  }
  const lexical = resolve(path);
  if (lexical === "/" || lexical === resolve(homedir()) || lexical.startsWith("/Applications/")) {
    refuse("native verification source app target is forbidden");
  }
  try {
    const stat = lstatSync(lexical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      refuse("native verification source app is unsafe");
    }
    return realpathSync(lexical);
  } catch (error) {
    if (error instanceof NativeKeychainVerificationError) throw error;
    return refuse("native verification source app is unavailable or unsafe");
  }
}

async function nativeCommand(
  executable: string,
  args: readonly string[],
  secretStdin?: string,
  signal?: AbortSignal,
): Promise<NativeCommandResult> {
  signal?.throwIfAborted();
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectCommand(error);
      else resolveCommand({ stdout, stderr });
    };
    const stop = (message: string): void => {
      child.kill("SIGKILL");
      finish(new NativeKeychainVerificationError(message));
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_NATIVE_OUTPUT_BYTES) {
        stop("native verification command output exceeded its limit");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    const onAbort = (): void => stop("native verification interrupted");
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", () => finish(new NativeKeychainVerificationError("native verification command failed")));
    child.once("close", (code) => finish(code === 0
      ? undefined
      : new NativeKeychainVerificationError("native verification command failed")));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => stop("native verification command timed out"), NATIVE_TIMEOUT_MS);
    timer.unref();
    child.stdin.end(secretStdin);
  });
}

function normalizeAclSnapshot(value: unknown): NativeKeychainAclSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return refuse("native verification ACL helper returned invalid evidence");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "allowAllApplications", "authorizationCount", "fingerprint", "found", "trustedApplicationCount",
  ])) return refuse("native verification ACL helper returned invalid evidence");
  if (row.found !== true || row.allowAllApplications !== false ||
      !Number.isSafeInteger(row.trustedApplicationCount) || Number(row.trustedApplicationCount) < 0 ||
      !Number.isSafeInteger(row.authorizationCount) || Number(row.authorizationCount) < 1 ||
      typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)) {
    return refuse("native verification ACL is missing or allows all applications");
  }
  return Object.freeze({
    found: true,
    allowAllApplications: false,
    trustedApplicationCount: Number(row.trustedApplicationCount),
    authorizationCount: Number(row.authorizationCount),
    fingerprint: row.fingerprint,
  });
}

function parseAclSnapshot(text: string): NativeKeychainAclSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse("native verification ACL helper returned invalid evidence");
  }
  return normalizeAclSnapshot(value);
}

function assertAclEqual(before: NativeKeychainAclSnapshot, after: NativeKeychainAclSnapshot): void {
  if (before.fingerprint !== after.fingerprint ||
      before.trustedApplicationCount !== after.trustedApplicationCount ||
      before.authorizationCount !== after.authorizationCount || after.allowAllApplications) {
    refuse("native verification Keychain ACL changed or broadened after re-signing");
  }
}

function samePair(left: ChatGptTokenPair | undefined, right: ChatGptTokenPair): boolean {
  return left?.accessToken === right.accessToken && left.refreshToken === right.refreshToken &&
    left.expiresAtMs === right.expiresAtMs && left.accountId === right.accountId;
}

function defaultSignalHandlers(onSignal: () => void): () => void {
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

/** Owner-attended, zero-network release gate. */
export async function runNativeKeychainVerification(
  sourceAppPath: string,
  dependencies: NativeKeychainVerificationDependencies,
): Promise<NativeKeychainVerificationEvidence> {
  const sourceApp = assertSourceApp(sourceAppPath);
  const scratch = freshScratch(dependencies.temporaryRoot);
  const appCopy = join(scratch.path, APP_COPY_NAME);
  const protectedAccounts = new Set([
    chatGptKeychainAccount(resolve(homedir(), "SuperTwinV13")),
    chatGptKeychainAccount(),
  ]);
  const observations: Array<{ executable: string; args: readonly string[]; hasStdin: boolean }> = [];
  const baseKeychainCommand = dependencies.keychainCommand ?? nativeCommand;
  const observedCommand: KeychainCommand = async (executable, args, secretStdin, signal) => {
    // The production store updates an existing credential. This disposable verifier must
    // instead be create-once so a preflight race can never overwrite another item.
    const forwardedArgs = args[0] === "add-generic-password"
      ? args.filter((arg) => arg !== "-U")
      : [...args];
    observations.push({ executable, args: forwardedArgs, hasStdin: secretStdin !== undefined });
    return baseKeychainCommand(executable, forwardedArgs, secretStdin, signal);
  };
  const codesign = dependencies.codesign ?? (async (args, signal) => {
    await nativeCommand("/usr/bin/codesign", args, undefined, signal);
  });
  const signatureFingerprint = dependencies.signatureFingerprint ?? (async (appPath, signal) => {
    const result = await nativeCommand("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], undefined, signal);
    const match = `${result.stdout}\n${result.stderr}`.match(/^CDHash=([a-f0-9]+)$/mi);
    if (!match) refuse("native verification could not fingerprint the source signature");
    return match[1]!.toLowerCase();
  });
  const copyApp = dependencies.copyApp ?? (async (source, destination, signal) => {
    await nativeCommand("/usr/bin/ditto", ["--noqtn", source, destination], undefined, signal);
  });
  let aclHelperReady = false;
  const inspectAcl = dependencies.inspectAcl ?? (async (service, account, signal) => {
    const source = resolve(import.meta.dirname, "../../../../scripts/native-keychain-acl.m");
    const helper = join(scratch.path, "native-keychain-acl");
    if (!aclHelperReady) {
      await nativeCommand("/usr/bin/xcrun", [
        "clang", "-fobjc-arc", "-framework", "Foundation", "-framework", "Security",
        source, "-o", helper,
      ], undefined, signal);
      aclHelperReady = true;
    }
    const result = await nativeCommand(
      helper,
      ["--service", service, "--account", account],
      undefined,
      signal,
    );
    return parseAclSnapshot(result.stdout);
  });
  const store = new ChatGptKeychainStore({ command: observedCommand, resolveHome: () => scratch.path });
  const random = dependencies.random ?? randomBytes;
  const dummy: ChatGptTokenPair = {
    accessToken: `dummy-access-${random(32).toString("base64url")}`,
    refreshToken: `dummy-refresh-${random(32).toString("base64url")}`,
    expiresAtMs: Date.now() + 60 * 60_000,
    accountId: `dummy-account-${random(16).toString("hex")}`,
  };
  const abort = new AbortController();
  const uninstallSignals = (dependencies.installSignalHandlers ?? defaultSignalHandlers)(() => abort.abort());
  let mayHaveCreatedItem = false;
  let itemRemoved = false;
  let failure: NativeKeychainVerificationError | undefined;
  let evidence: NativeKeychainVerificationEvidence | undefined;
  try {
    if (protectedAccounts.has(store.account)) refuse("native verification refused the production Keychain account");
    if (await store.load() !== undefined) refuse("native verification dummy Keychain account is not empty");
    const sourceSignatureBefore = await signatureFingerprint(sourceApp, abort.signal);
    mayHaveCreatedItem = true;
    await store.save(dummy, abort.signal);
    if (!samePair(await store.load(), dummy)) refuse("native verification could not reload the dummy item");
    const add = observations.find((entry) => entry.args[0] === "add-generic-password");
    const exactAdd = [
      "add-generic-password", "-s", CHATGPT_KEYCHAIN_SERVICE, "-a", store.account, "-w",
    ];
    if (!add || add.executable !== "/usr/bin/security" ||
        JSON.stringify(add.args) !== JSON.stringify(exactAdd) || !add.hasStdin || add.args.includes("-A")) {
      refuse("native verification Keychain write contract changed");
    }
    const aclBefore = normalizeAclSnapshot(
      await inspectAcl(CHATGPT_KEYCHAIN_SERVICE, store.account, abort.signal),
    );
    if (aclBefore.allowAllApplications) refuse("native verification Keychain ACL allows all applications");
    if (!await dependencies.confirmAcl({
      service: CHATGPT_KEYCHAIN_SERVICE,
      account: store.account,
      requiredConfirmation: NATIVE_KEYCHAIN_CONFIRMATION,
      acl: aclBefore,
    })) refuse("native verification ACL confirmation was refused");
    abort.signal.throwIfAborted();

    await codesign(["--verify", "--deep", "--strict", sourceApp], abort.signal);
    await copyApp(sourceApp, appCopy, abort.signal);
    assertScratchIdentity(scratch);
    const copied = realpathSync(appCopy);
    const copiedStat = lstatSync(copied);
    if (!isChild(scratch.path, copied) || copiedStat.isSymbolicLink() || !copiedStat.isDirectory()) {
      refuse("native verification app copy is unsafe");
    }
    await codesign(["--verify", "--deep", "--strict", copied], abort.signal);
    await codesign(["--force", "--deep", "--sign", "-", "--timestamp=none", copied], abort.signal);
    await codesign(["--verify", "--deep", "--strict", copied], abort.signal);
    if (!samePair(await store.load(), dummy)) refuse("native verification dummy item changed after re-signing");
    const aclAfter = normalizeAclSnapshot(
      await inspectAcl(CHATGPT_KEYCHAIN_SERVICE, store.account, abort.signal),
    );
    assertAclEqual(aclBefore, aclAfter);
    const sourceSignatureAfter = await signatureFingerprint(sourceApp, abort.signal);
    if (sourceSignatureAfter !== sourceSignatureBefore) refuse("native verification source app changed");
    await codesign(["--verify", "--deep", "--strict", sourceApp], abort.signal);

    evidence = {
      status: "passed",
      networkCalls: 0,
      browserCalls: 0,
      oauthCalls: 0,
      metadataCalls: 0,
      inferenceCalls: 0,
      scratchHome: "fresh-canonical-temp-0700-disposed",
      sourceAppUntouched: true,
      appCopy: "verified-resigned-verified-disposed",
      keychain: {
        service: CHATGPT_KEYCHAIN_SERVICE,
        account: store.account,
        productionAccountUntouched: true,
        dummySecretTransport: "stdin",
        allowAllAclFlag: false,
        aclConfirmed: true,
        aclUnchangedAfterResign: true,
        credentialUnchangedAfterResign: true,
        removedAndAbsent: true,
      },
    };
  } catch (error) {
    failure = error instanceof NativeKeychainVerificationError
      ? error
      : new NativeKeychainVerificationError("native Keychain verification failed; dummy cleanup was attempted");
  } finally {
    uninstallSignals();
    if (mayHaveCreatedItem) {
      try {
        const current = await store.load();
        if (current === undefined) {
          itemRemoved = true;
        } else if (samePair(current, dummy)) {
          await store.clear();
          itemRemoved = await store.load() === undefined;
        } else {
          // A racing process owns the exact account now. Never delete an item we did not create.
          itemRemoved = false;
        }
      } catch {
        itemRemoved = false;
      }
    } else itemRemoved = true;
    try {
      assertScratchIdentity(scratch);
      rmSync(scratch.path, { recursive: true, force: false });
    } catch {
      failure ??= new NativeKeychainVerificationError("native verification scratch cleanup failed");
    }
    if (!itemRemoved) {
      failure = new NativeKeychainVerificationError(
        `native verification cleanup failed for ${CHATGPT_KEYCHAIN_SERVICE}/${store.account}`,
      );
    }
  }
  if (failure || !evidence) throw failure ?? new NativeKeychainVerificationError("native verification failed");
  return evidence;
}

export interface NativeKeychainPreflightOptions {
  platform?: NodeJS.Platform;
  interactive?: boolean;
}

export function assertNativeKeychainVerificationOptIn(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: NativeKeychainPreflightOptions = {},
): string {
  if (args.length !== 4 || args[0] !== "--native-keychain-verification" ||
      args[1] !== "--app" || args[3] !== NATIVE_ADHOC_RESIGN_FLAG) {
    refuse(`native Keychain verification requires --native-keychain-verification --app <absolute.app> ${NATIVE_ADHOC_RESIGN_FLAG}`);
  }
  if (env[NATIVE_KEYCHAIN_VERIFY_ENV] !== "1") {
    refuse(`native Keychain verification requires ${NATIVE_KEYCHAIN_VERIFY_ENV}=1`);
  }
  if ((options.platform ?? process.platform) !== "darwin") refuse("native Keychain verification requires macOS");
  if (!(options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY))) {
    refuse("native Keychain verification requires an interactive owner terminal");
  }
  return assertSourceApp(args[2]!);
}
