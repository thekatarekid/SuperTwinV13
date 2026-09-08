import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_REFRESH_SKEW_MS,
  ChatGptCredentialError,
  ChatGptKeychainStore,
  ChatGptTokenSession,
  chatGptKeychainAccount,
  createChatGptOAuthRefresher,
  type ChatGptTokenPair,
  type KeychainCommand,
} from "./keychain.js";

interface FakeKeychain {
  command: KeychainCommand;
  calls: Array<{ executable: string; args: readonly string[]; secretStdin?: string }>;
  value?: string;
  failWrite?: boolean;
}

function missing(): Error & { code: number } {
  return Object.assign(new Error("fixture-only missing item"), { code: 44 });
}

function fakeKeychain(initial?: string): FakeKeychain {
  const fake: FakeKeychain = {
    calls: [],
    value: initial,
    command: async (executable, args, secretStdin) => {
      fake.calls.push({ executable, args: [...args], secretStdin });
      if (args[0] === "find-generic-password") {
        if (fake.value === undefined) throw missing();
        return { stdout: `${fake.value}\n`, stderr: "" };
      }
      if (args[0] === "add-generic-password") {
        if (fake.failWrite) throw new Error("fixture-only write failure");
        fake.value = secretStdin;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        if (fake.value === undefined) throw missing();
        fake.value = undefined;
        return { stdout: "", stderr: "" };
      }
      throw new Error("unexpected fixture command");
    },
  };
  return fake;
}

function pair(suffix: string, expiresAtMs = 2_000_000): ChatGptTokenPair {
  return {
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    expiresAtMs,
    accountId: `account-${suffix}`,
  };
}

function store(fake: FakeKeychain, home: string): ChatGptKeychainStore {
  return new ChatGptKeychainStore({ command: fake.command, resolveHome: () => home });
}

describe("ChatGPT home-isolated Keychain", () => {
  it("derives the documented generic-password account from the resolved home", () => {
    const home = resolve("fixture", "..", "production-home");
    const digest = createHash("sha256").update(home).digest("hex").slice(0, 16);
    expect(chatGptKeychainAccount("fixture/../production-home")).toBe(
      `supertwin.chatgpt-oauth.${digest}`,
    );
  });

  it("keeps production and scratch homes in distinct Keychain accounts", () => {
    expect(store(fakeKeychain(), "/Users/person/SuperTwinV13").account).not.toBe(
      store(fakeKeychain(), "/tmp/supertwin-eval-home").account,
    );
  });

  it("uses absolute security argv without a shell or broad -A ACL", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/a home;$(touch nope)");
    await subject.save(pair("one"));
    const call = fake.calls[0]!;
    expect(call.executable).toBe("/usr/bin/security");
    expect(call.args.slice(0, 2)).toEqual(["add-generic-password", "-U"]);
    expect(call.args).not.toContain("-A");
    expect(call.args).toContain(subject.account);
    expect(call.args.join(" ")).not.toContain("access-one");
    expect(call.args.join(" ")).not.toContain("refresh-one");
    expect(call.secretStdin).toContain("access-one");
  });

  it("loads, bounds, and clears the home-specific item", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/home-a");
    await subject.save(pair("one"));
    expect(await subject.load()).toEqual(pair("one"));
    await subject.clear();
    await expect(subject.load()).resolves.toBeUndefined();
    await expect(subject.clear()).resolves.toBeUndefined();
  });

  it("refuses to persist an incomplete credential pair", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/home-a");
    await expect(subject.save({ accessToken: "access-only" })).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      message: "ChatGPT credential data is invalid; sign in again",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("aborts an in-progress save and cannot perform a late write", async () => {
    let persisted: string | undefined;
    const command: KeychainCommand = async (_executable, args, secretStdin, signal) => {
      if (args[0] !== "add-generic-password") throw missing();
      return new Promise((resolveCommand, rejectCommand) => {
        const timer = setTimeout(() => {
          persisted = secretStdin;
          resolveCommand({ stdout: "", stderr: "" });
        }, 30);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          rejectCommand(new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled"));
        }, { once: true });
      });
    };
    const subject = new ChatGptKeychainStore({ command, resolveHome: () => "/tmp/abort-save" });
    const controller = new AbortController();
    const saving = subject.save(pair("cancelled"), controller.signal);
    controller.abort();
    await expect(saving).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      message: "Keychain operation cancelled",
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(persisted).toBeUndefined();
  });

  it("rejects malformed, unknown-field, oversized, and unsafe numeric values with fixed errors", async () => {
    const values = [
      "not-json",
      JSON.stringify({ version: 1, current: { accessToken: "x", surprise: true } }),
      JSON.stringify({ version: 1, current: { accessToken: "x", expiresAtMs: -1 } }),
      "x".repeat(128 * 1024 + 1),
    ];
    for (const value of values) {
      const subject = store(fakeKeychain(value), "/tmp/home-a");
      await expect(subject.load()).rejects.toMatchObject({
        code: "AUTH_EXPIRED",
        message: "Stored ChatGPT credentials are invalid; sign in again",
      });
    }
  });

  it("maps command failures to fixed errors without including command output", async () => {
    const command: KeychainCommand = async () => {
      throw Object.assign(new Error("access-secret refresh-secret"), {
        code: 1,
        stderr: "access-secret refresh-secret",
      });
    };
    await expect(new ChatGptKeychainStore({ command, resolveHome: () => "/tmp/x" }).load())
      .rejects.toEqual(expect.objectContaining({
        code: "TRANSPORT_ERROR",
        message: "Unable to read ChatGPT credentials from Keychain",
      }));
  });
});

describe("ChatGPT rotating token session", () => {
  it("reports signed-out and fixed AUTH_REQUIRED without touching refresh", async () => {
    const refresh = vi.fn();
    const session = await ChatGptTokenSession.open(store(fakeKeychain(), "/tmp/signed-out"), refresh);
    expect(session.authState()).toEqual({ status: "signed_out", error: null });
    expect(() => session.current()).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes at the 120-second skew and persists before exposing the new token", async () => {
    const now = 1_000_000;
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/skew");
    await subject.save(pair("old", now + CHATGPT_REFRESH_SKEW_MS));
    const observations: string[] = [];
    const session = await ChatGptTokenSession.open(subject, async () => {
      observations.push("server-rotated");
      return pair("new", now + 600_000);
    }, { now: () => now });
    const originalCommand = fake.command;
    fake.command = originalCommand;
    expect(await session.accessToken()).toBe("access-new");
    expect(observations).toEqual(["server-rotated"]);
    const persisted = JSON.parse(fake.value!) as { current: ChatGptTokenPair; previous: ChatGptTokenPair };
    expect(persisted.current.accessToken).toBe("access-new");
    expect(persisted.previous.accessToken).toBe("access-old");
    expect(session.previousRecoveryPair()?.accessToken).toBe("access-old");
  });

  it("aborted authorization cannot persist a refresh result that resolves late", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/metadata-timeout");
    await subject.save(pair("old", 100));
    let resolveRefresh!: (value: ChatGptTokenPair) => void;
    const refresh = vi.fn(() => new Promise<ChatGptTokenPair>((resolve) => {
      resolveRefresh = resolve;
    }));
    const session = await ChatGptTokenSession.open(subject, refresh, { now: () => 1_000 });
    const controller = new AbortController();
    const pending = session.accessToken(controller.signal);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    resolveRefresh(pair("late", 9_000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const persisted = JSON.parse(fake.value!) as { current: ChatGptTokenPair };
    expect(persisted.current.accessToken).toBe("access-old");
    expect(() => session.current()).not.toThrow();
    expect(session.current().accessToken).toBe("access-old");
  });

  it("single-flights concurrent refresh and returns isolated copies", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/concurrent");
    await subject.save(pair("old", 100));
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const refresh = vi.fn(async () => {
      await gate;
      return pair("new", 9_000);
    });
    const session = await ChatGptTokenSession.open(subject, refresh, { now: () => 1_000 });
    const first = session.refresh();
    const second = session.refresh();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("single-flights refresh process-wide across managers for the same home", async () => {
    const fake = fakeKeychain();
    const firstStore = store(fake, "/tmp/shared-home");
    const secondStore = store(fake, "/tmp/shared-home");
    await firstStore.save(pair("old", 100));
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const refresh = vi.fn(async () => {
      await gate;
      return pair("shared-new", 9_000);
    });
    const [first, second] = await Promise.all([
      ChatGptTokenSession.open(firstStore, refresh, { now: () => 1_000 }),
      ChatGptTokenSession.open(secondStore, refresh, { now: () => 1_000 }),
    ]);
    const one = first.refresh();
    const two = second.refresh();
    release();
    await expect(Promise.all([one, two])).resolves.toEqual([
      pair("shared-new", 9_000),
      pair("shared-new", 9_000),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(first.current().accessToken).toBe("access-shared-new");
    expect(second.current().accessToken).toBe("access-shared-new");
  });

  it("does not expose an unpersisted rotated token", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/crash-window");
    await subject.save(pair("old", 100));
    const session = await ChatGptTokenSession.open(subject, async () => pair("never-exposed"), {
      now: () => 1_000,
    });
    fake.failWrite = true;
    await expect(session.refresh()).rejects.toEqual(expect.objectContaining({
      code: "AUTH_EXPIRED",
      message: "ChatGPT credential rotation could not be secured; sign in again",
    }));
    expect(session.authState()).toEqual({ status: "expired", error: "ChatGPT sign-in expired" });
    expect(() => session.current()).toThrowError(expect.objectContaining({ code: "AUTH_EXPIRED" }));
    expect(fake.value).not.toContain("never-exposed");
  });

  it("retries an original 401 exactly once after one refresh", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/retry");
    await subject.save(pair("old", 9_000_000));
    const refresh = vi.fn(async () => pair("new", 10_000_000));
    const session = await ChatGptTokenSession.open(subject, refresh, { now: () => 1_000 });
    const send = vi.fn(async (token: string) => ({ status: token === "access-old" ? 401 : 200 }));
    await expect(session.retryOnceAfter401(send)).resolves.toEqual({ status: 200 });
    expect(send.mock.calls).toEqual([["access-old"], ["access-new"]]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces rotation-shaped failures as AUTH_EXPIRED without retry", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/rejected");
    await subject.save(pair("old", 100));
    const refresh = vi.fn(async () => {
      throw new ChatGptCredentialError("AUTH_EXPIRED", "ChatGPT refresh rejected; sign in again");
    });
    const session = await ChatGptTokenSession.open(subject, refresh, { now: () => 1_000 });
    await expect(session.accessToken()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("logout clears current and recovery pairs before returning", async () => {
    const fake = fakeKeychain();
    const subject = store(fake, "/tmp/logout");
    await subject.save(pair("old", 100));
    const session = await ChatGptTokenSession.open(subject, async () => pair("new"), { now: () => 1_000 });
    await session.refresh();
    expect(session.previousRecoveryPair()).toBeDefined();
    await session.logout();
    expect(session.authState()).toEqual({ status: "signed_out", error: null });
    expect(session.previousRecoveryPair()).toBeUndefined();
    expect(fake.value).toBeUndefined();
  });

  it("logout invalidates other in-process managers for the same home", async () => {
    const fake = fakeKeychain();
    const firstStore = store(fake, "/tmp/shared-logout");
    const secondStore = store(fake, "/tmp/shared-logout");
    await firstStore.save(pair("old"));
    const [first, second] = await Promise.all([
      ChatGptTokenSession.open(firstStore, vi.fn()),
      ChatGptTokenSession.open(secondStore, vi.fn()),
    ]);
    await second.logout();
    expect(first.authState()).toEqual({ status: "signed_out", error: null });
    expect(first.previousRecoveryPair()).toBeUndefined();
    expect(() => first.current()).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });

  it("account-locked browser relogin invalidates older managers", async () => {
    const fake = fakeKeychain();
    const firstStore = store(fake, "/tmp/shared-relogin");
    const secondStore = store(fake, "/tmp/shared-relogin");
    await firstStore.save(pair("old"));
    const [first, second] = await Promise.all([
      ChatGptTokenSession.open(firstStore, vi.fn()),
      ChatGptTokenSession.open(secondStore, vi.fn()),
    ]);
    await second.install(pair("replacement"));
    expect(second.current()).toEqual(pair("replacement"));
    expect(first.authState()).toEqual({ status: "signed_out", error: null });
    expect(() => first.current()).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });

  it("adopts an exact durable relogin that wins at the cancellation boundary", async () => {
    let value: string | undefined;
    let boundaryMode = false;
    let committedResolve!: () => void;
    const committed = new Promise<void>((resolveCommit) => { committedResolve = resolveCommit; });
    const command: KeychainCommand = async (_executable, args, secretStdin, signal) => {
      if (args[0] === "find-generic-password") {
        if (value === undefined) throw missing();
        return { stdout: `${value}\n`, stderr: "" };
      }
      if (args[0] === "add-generic-password") {
        value = secretStdin;
        if (!boundaryMode) return { stdout: "", stderr: "" };
        committedResolve();
        return new Promise((_resolveCommand, rejectCommand) => {
          signal?.addEventListener("abort", () => {
            rejectCommand(new ChatGptCredentialError("TRANSPORT_ERROR", "Keychain operation cancelled"));
          }, { once: true });
        });
      }
      if (args[0] === "delete-generic-password") {
        value = undefined;
        return { stdout: "", stderr: "" };
      }
      throw new Error("unexpected fixture command");
    };
    const firstStore = new ChatGptKeychainStore({ command, resolveHome: () => "/tmp/boundary-relogin" });
    const secondStore = new ChatGptKeychainStore({ command, resolveHome: () => "/tmp/boundary-relogin" });
    await firstStore.save(pair("old"));
    const [first, second] = await Promise.all([
      ChatGptTokenSession.open(firstStore, vi.fn()),
      ChatGptTokenSession.open(secondStore, vi.fn()),
    ]);
    boundaryMode = true;
    const controller = new AbortController();
    const installing = second.install(pair("committed"), controller.signal);
    await committed;
    controller.abort();

    // Durable state is the linearization winner even though process
    // cancellation raced the `security` command's close notification.
    await expect(installing).resolves.toBeUndefined();
    expect(second.current()).toEqual(pair("committed"));
    expect(first.authState()).toEqual({ status: "signed_out", error: null });
    expect(await secondStore.load()).toEqual(pair("committed"));
  });
});

describe("ChatGPT refresh transport", () => {
  it("uses only the fixed token endpoint and bounded form contract", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    }), { status: 200 }));
    const refresh = createChatGptOAuthRefresher({
      fetch: fetchMock,
      now: () => 5_000,
      userAgent: "SuperTwinV13/13.12.2",
    });
    await expect(refresh("refresh-old")).resolves.toEqual({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAtMs: 3_605_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect((init?.body as URLSearchParams).toString()).toBe(
      "grant_type=refresh_token&refresh_token=refresh-old&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
    );
  });

  it.each([
    [401, {}, "AUTH_EXPIRED"],
    [403, {}, "AUTH_EXPIRED"],
    [400, { error: "invalid_grant" }, "AUTH_EXPIRED"],
    [429, {}, "RATE_LIMITED"],
  ] as const)("maps HTTP %s without exposing response data", async (status, body, code) => {
    const refresh = createChatGptOAuthRefresher({
      fetch: async () => new Response(JSON.stringify(body), { status }),
      userAgent: "SuperTwinV13/test",
    });
    await expect(refresh("refresh-secret")).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("cancels and rejects an oversized response with a fixed error", async () => {
    const refresh = createChatGptOAuthRefresher({
      fetch: async () => new Response(JSON.stringify({ access_token: "x".repeat(128 * 1024) })),
      userAgent: "SuperTwinV13/test",
    });
    await expect(refresh("refresh-secret")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      message: "ChatGPT refresh response exceeded its limit",
    });
  });
});
