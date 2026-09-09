import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHATGPT_KEYCHAIN_SERVICE } from "./keychain.js";
import {
  NATIVE_ADHOC_RESIGN_FLAG,
  NATIVE_KEYCHAIN_CONFIRMATION,
  NATIVE_KEYCHAIN_VERIFY_ENV,
  NativeKeychainVerificationError,
  assertNativeKeychainVerificationOptIn,
  runNativeKeychainVerification,
  type NativeKeychainAclSnapshot,
  type NativeKeychainVerificationDependencies,
} from "./native-keychain-verification.js";
import { runNativeKeychainVerificationCli } from "./native-keychain-verification-cli.js";
import type { KeychainCommand } from "./keychain.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "st-native-keychain-test-"));
  roots.push(root);
  const app = join(root, "Signed Source.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents", "marker"), "source-unchanged");
  return { root, app };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function keychain(initial?: string) {
  let value = initial;
  const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
  const command: KeychainCommand = async (executable, args, stdin) => {
    calls.push({ executable, args: [...args], ...(stdin === undefined ? {} : { stdin }) });
    if (args[0] === "find-generic-password") {
      if (value === undefined) throw Object.assign(new Error("missing"), { code: 44 });
      return { stdout: `${value}\n`, stderr: "" };
    }
    if (args[0] === "add-generic-password") {
      value = stdin;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      value = undefined;
      return { stdout: "", stderr: "" };
    }
    throw new Error("unexpected command");
  };
  return { command, calls, value: () => value };
}

const ACL: NativeKeychainAclSnapshot = {
  found: true,
  allowAllApplications: false,
  trustedApplicationCount: 1,
  authorizationCount: 2,
  fingerprint: "a".repeat(64),
};

function deps(root: string, command: KeychainCommand, overrides: Partial<NativeKeychainVerificationDependencies> = {}) {
  let signalHandler: (() => void) | undefined;
  const codesign = vi.fn<(
    args: readonly string[],
    signal?: AbortSignal,
  ) => Promise<void>>(async () => undefined);
  const inspectAcl = vi.fn(async () => ACL);
  const copyApp = vi.fn(async (source: string, destination: string) => {
    cpSync(source, destination, { recursive: true });
  });
  const dependencies: NativeKeychainVerificationDependencies = {
    temporaryRoot: root,
    keychainCommand: command,
    codesign,
    signatureFingerprint: vi.fn(async () => "source-signature"),
    copyApp,
    inspectAcl,
    confirmAcl: vi.fn(async ({ service, account, requiredConfirmation, acl }) => {
      expect(service).toBe(CHATGPT_KEYCHAIN_SERVICE);
      expect(account).toMatch(/^supertwin\.chatgpt-oauth\.[a-f0-9]{16}$/);
      expect(requiredConfirmation).toBe(NATIVE_KEYCHAIN_CONFIRMATION);
      expect(acl).toEqual(ACL);
      return true;
    }),
    random: (bytes) => Buffer.alloc(bytes, 7),
    installSignalHandlers: (handler) => {
      signalHandler = handler;
      return () => { signalHandler = undefined; };
    },
    ...overrides,
  };
  return { dependencies, codesign, inspectAcl, copyApp, signal: () => signalHandler?.() };
}

describe("native Keychain release verification rail", () => {
  it("refuses before side effects unless macOS, interactive, and both explicit opt-ins match", () => {
    const { app } = fixture();
    const good = ["--native-keychain-verification", "--app", app, NATIVE_ADHOC_RESIGN_FLAG];
    expect(() => assertNativeKeychainVerificationOptIn([], {}, { platform: "darwin", interactive: true }))
      .toThrow(/sole dedicated flag|requires --native/);
    expect(() => assertNativeKeychainVerificationOptIn(good, {}, { platform: "darwin", interactive: true }))
      .toThrow(NATIVE_KEYCHAIN_VERIFY_ENV);
    expect(() => assertNativeKeychainVerificationOptIn(good, { [NATIVE_KEYCHAIN_VERIFY_ENV]: "1" }, {
      platform: "linux", interactive: true,
    })).toThrow(/macOS/);
    expect(() => assertNativeKeychainVerificationOptIn(good, { [NATIVE_KEYCHAIN_VERIFY_ENV]: "1" }, {
      platform: "darwin", interactive: false,
    })).toThrow(/interactive owner/);
    expect(assertNativeKeychainVerificationOptIn(good, { [NATIVE_KEYCHAIN_VERIFY_ENV]: "1" }, {
      platform: "darwin", interactive: true,
    })).toBe(realpathSync(app));
  });

  it("rejects relative, non-app, symlinked, and Applications source targets", () => {
    const { root, app } = fixture();
    const env = { [NATIVE_KEYCHAIN_VERIFY_ENV]: "1" };
    const args = (path: string) => ["--native-keychain-verification", "--app", path, NATIVE_ADHOC_RESIGN_FLAG];
    expect(() => assertNativeKeychainVerificationOptIn(args("relative.app"), env, {
      platform: "darwin", interactive: true,
    })).toThrow(/absolute/);
    expect(() => assertNativeKeychainVerificationOptIn(args(root), env, {
      platform: "darwin", interactive: true,
    })).toThrow(/\.app/);
    const link = join(root, "Linked.app");
    symlinkSync(app, link);
    expect(() => assertNativeKeychainVerificationOptIn(args(link), env, {
      platform: "darwin", interactive: true,
    })).toThrow(/unsafe/);
    expect(() => assertNativeKeychainVerificationOptIn(args("/Applications/SuperTwinV13.app"), env, {
      platform: "darwin", interactive: true,
    })).toThrow(/forbidden/);
    expect(() => assertNativeKeychainVerificationOptIn(args(join(root, "secret-name.app")), env, {
      platform: "darwin", interactive: true,
    })).toThrow(/^native verification source app is unavailable or unsafe$/);
  });

  it("uses one dummy stdin-only item, compares ACL across only the re-signed copy, and cleans everything", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    const h = deps(root, fake.command);
    const before = readFileSync(join(app, "Contents", "marker"), "utf8");
    const evidence = await runNativeKeychainVerification(app, h.dependencies);

    expect(evidence).toMatchObject({
      status: "passed", networkCalls: 0, browserCalls: 0, oauthCalls: 0,
      metadataCalls: 0, inferenceCalls: 0, sourceAppUntouched: true,
      keychain: { dummySecretTransport: "stdin", allowAllAclFlag: false, removedAndAbsent: true },
    });
    expect(evidence.keychain.account).not.toBe("supertwin.chatgpt-oauth.production");
    expect(fake.value()).toBeUndefined();
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
    expect(readFileSync(join(app, "Contents", "marker"), "utf8")).toBe(before);
    expect(h.inspectAcl).toHaveBeenCalledTimes(2);
    expect(h.inspectAcl.mock.calls[0]!.slice(0, 2)).toEqual(h.inspectAcl.mock.calls[1]!.slice(0, 2));

    const resign = h.codesign.mock.calls.find(([argv]) => argv[0] === "--force")![0];
    expect(resign.at(-1)).toMatch(/supertwin-keychain-native-.*\/SuperTwinV13\.app$/);
    expect(resign).not.toContain(app);
    const add = fake.calls.find((call) => call.args[0] === "add-generic-password")!;
    expect(add.executable).toBe("/usr/bin/security");
    expect(add.args).not.toContain("-U");
    expect(add.args).not.toContain("-A");
    expect(add.stdin).toContain("dummy-access-");
    expect(add.args.join(" ")).not.toContain("dummy-access-");
    const publicJson = JSON.stringify(evidence);
    expect(publicJson).not.toContain("dummy-access-");
    expect(publicJson).not.toContain("dummy-refresh-");
  });

  it("refuses a pre-existing exact item without updating or deleting it", async () => {
    const { root, app } = fixture();
    const original = JSON.stringify({ version: 1, current: {
      accessToken: "existing", refreshToken: "existing-refresh", expiresAtMs: Date.now() + 1_000,
      accountId: "existing-account",
    } });
    const fake = keychain(original);
    const h = deps(root, fake.command);
    await expect(runNativeKeychainVerification(app, h.dependencies)).rejects.toThrow(/not empty/);
    expect(fake.value()).toBe(original);
    expect(fake.calls.some((call) => call.args[0] === "add-generic-password")).toBe(false);
    expect(fake.calls.some((call) => call.args[0] === "delete-generic-password")).toBe(false);
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it("does not overwrite or delete an item created during the create-once race", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    const raced = JSON.stringify({ version: 1, current: {
      accessToken: "raced", refreshToken: "raced-refresh", expiresAtMs: Date.now() + 1_000,
      accountId: "raced-account",
    } });
    const command: KeychainCommand = async (executable, args, stdin, signal) => {
      if (args[0] === "add-generic-password") {
        await fake.command(executable, args, raced, signal);
        throw new Error("duplicate item");
      }
      return fake.command(executable, args, stdin, signal);
    };
    const h = deps(root, command);
    const error = await runNativeKeychainVerification(app, h.dependencies).catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeKeychainVerificationError);
    expect(fake.value()).toBe(raced);
    expect(fake.calls.some((call) => call.args[0] === "delete-generic-password")).toBe(false);
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it.each([
    ["ACL inspection", { inspectAcl: vi.fn(async () => { throw new Error("secret native output"); }) }],
    ["ACL refusal", { confirmAcl: vi.fn(async () => false) }],
    ["copy", { copyApp: vi.fn(async () => { throw new Error("secret path"); }) }],
    ["sign", { codesign: vi.fn(async (args: readonly string[]) => {
      if (args[0] === "--force") throw new Error("codesign secret output");
    }) }],
  ] as const)("cleans the dummy item and app copy after %s failure without leaking detail", async (_label, override) => {
    const { root, app } = fixture();
    const fake = keychain();
    const h = deps(root, fake.command, override);
    const error = await runNativeKeychainVerification(app, h.dependencies).catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeKeychainVerificationError);
    expect(error.message).not.toMatch(/secret|codesign|path/);
    expect(fake.value()).toBeUndefined();
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it("rejects an ACL broaden/change after resign and still proves cleanup", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    const changed = { ...ACL, fingerprint: "b".repeat(64) };
    const inspectAcl = vi.fn()
      .mockResolvedValueOnce(ACL)
      .mockResolvedValueOnce(changed);
    const h = deps(root, fake.command, { inspectAcl });
    await expect(runNativeKeychainVerification(app, h.dependencies)).rejects.toThrow(/changed or broadened/);
    expect(fake.value()).toBeUndefined();
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it("rejects an explicitly broadened ACL candidate and still proves cleanup", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    const h = deps(root, fake.command, {
      inspectAcl: vi.fn(async () => ({ ...ACL, allowAllApplications: true })),
    });
    await expect(runNativeKeychainVerification(app, h.dependencies)).rejects.toThrow(/allows all/);
    expect(fake.value()).toBeUndefined();
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it("rejects a changed source signature and cleans the disposable item and app", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    const signatureFingerprint = vi.fn()
      .mockResolvedValueOnce("source-signature-before")
      .mockResolvedValueOnce("source-signature-after");
    const h = deps(root, fake.command, { signatureFingerprint });
    await expect(runNativeKeychainVerification(app, h.dependencies)).rejects.toThrow(/source app changed/);
    expect(signatureFingerprint).toHaveBeenCalledTimes(2);
    expect(fake.value()).toBeUndefined();
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it("makes exact-item cleanup failure a redacted hard failure", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    const command: KeychainCommand = async (executable, args, stdin, signal) => {
      if (args[0] === "delete-generic-password") throw new Error("secret delete output");
      return fake.command(executable, args, stdin, signal);
    };
    const h = deps(root, command);
    const error = await runNativeKeychainVerification(app, h.dependencies).catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeKeychainVerificationError);
    expect(error.message).toContain(CHATGPT_KEYCHAIN_SERVICE);
    expect(error.message).toMatch(/supertwin\.chatgpt-oauth\.[a-f0-9]{16}/);
    expect(error.message).not.toMatch(/secret|dummy-access|dummy-refresh|Signed Source/);
    expect(fake.value()).toBeDefined();
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it("aborts an in-flight owner confirmation and cleans on SIGINT/SIGTERM hook", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    let release!: () => void;
    const confirmation = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const h = deps(root, fake.command, { confirmAcl: vi.fn(async () => confirmation) });
    const running = runNativeKeychainVerification(app, h.dependencies);
    await vi.waitFor(() => expect(fake.value()).toBeDefined());
    h.signal();
    release();
    await expect(running).rejects.toThrow(/interrupted|failed/);
    expect(fake.value()).toBeUndefined();
    expect(readdirSync(root)).toEqual(["Signed Source.app"]);
  });

  it("CLI prints only bounded redacted evidence and the source has no network/runtime imports", async () => {
    const { root, app } = fixture();
    const fake = keychain();
    const h = deps(root, fake.command);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runNativeKeychainVerificationCli(
      ["--native-keychain-verification", "--app", app, NATIVE_ADHOC_RESIGN_FLAG],
      { [NATIVE_KEYCHAIN_VERIFY_ENV]: "1" },
      { ...h.dependencies, platform: "darwin", interactive: true },
    )).resolves.toBe(0);
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(JSON.parse(output)).toMatchObject({ status: "passed", networkCalls: 0, inferenceCalls: 0 });
    expect(output).not.toMatch(/dummy-access|dummy-refresh|Signed Source|st-native-keychain-test/);

    const source = readFileSync(join(import.meta.dirname, "native-keychain-verification.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|https?:\/\/|bootstrapBuiltInProviders|startServer|openExternal|BrowserOAuth/);
    expect(source).not.toContain("device-flow");
  });

  it("uses an item-targeted ACL helper that cannot read or dump Keychain secrets", () => {
    const source = readFileSync(join(import.meta.dirname, "../../../../scripts/native-keychain-acl.m"), "utf8");
    expect(source).toContain("SecKeychainFindGenericPassword");
    expect(source).toMatch(/NULL, NULL,\s*&item/);
    expect(source).toContain("SecKeychainItemCopyAccess");
    expect(source).toContain("SecTrustedApplicationCopyData");
    expect(source).not.toMatch(/SecKeychainItemCopyContent|dump-keychain|find-generic-password.*-w/);
  });
});
