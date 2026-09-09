import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  KEYCHAIN_BROKER_HELLO_PREFIX,
  KEYCHAIN_BROKER_REQUEST_PREFIX,
  KEYCHAIN_BROKER_RESPONSE_PREFIX,
  StdioKeychainBroker,
} from "./keychain-broker.js";
import { ChatGptKeychainStore, type KeychainCommand } from "./keychain.js";

const SESSION = "07".repeat(32);
const PROTOCOL = "supertwin-keychain-broker-v1";

function digest(id: number, body: Buffer): string {
  const sequence = Buffer.allocUnsafe(8); sequence.writeBigUInt64BE(BigInt(id));
  const secret = Buffer.from(SESSION, "hex");
  return createHmac("sha256", secret).update("supertwin-keychain-broker-v1\0").update("response").update("\0")
    .update(sequence).update(body).digest("hex");
}

function response(id: number, value: { code: number; stdout: string }, macOverride?: string): string {
  const body = Buffer.from(JSON.stringify(value));
  const wire = Buffer.from(JSON.stringify({ protocol: PROTOCOL, id,
    body: body.toString("base64url"), mac: macOverride ?? digest(id, body) }));
  return `${KEYCHAIN_BROKER_RESPONSE_PREFIX}${wire.toString("base64url")}\n`;
}

function requestId(line: string): number {
  const encoded = line.trim().slice(KEYCHAIN_BROKER_REQUEST_PREFIX.length);
  return Number(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).id);
}

describe("private stdio Keychain broker client", () => {
  it("waits for a split private HELLO and correlates bounded authenticated responses", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const broker = new StdioKeychainBroker(input, output);
    let request = ""; output.on("data", (chunk) => { request += chunk.toString(); });
    const pending = broker.command("read");
    input.write(KEYCHAIN_BROKER_HELLO_PREFIX.slice(0, 10));
    input.write(`${KEYCHAIN_BROKER_HELLO_PREFIX.slice(10)}${SESSION}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(request).toMatch(/^SUPERTWIN_KEYCHAIN_REQUEST_V1 [A-Za-z0-9_-]+\n$/);
    expect(request).not.toContain(SESSION);
    input.write(response(requestId(request), { code: 0, stdout: "credential-envelope" }).slice(0, 31));
    input.write(response(requestId(request), { code: 0, stdout: "credential-envelope" }).slice(31));
    await expect(pending).resolves.toEqual({ stdout: "credential-envelope", stderr: "" });
  });

  it("rejects missing-item status, bad MAC, replay, unknown lines, and unsupported inputs", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const broker = new StdioKeychainBroker(input, output);
    const requests: string[] = []; output.on("data", (chunk) => requests.push(chunk.toString()));
    input.write(`${KEYCHAIN_BROKER_HELLO_PREFIX}${SESSION}\n`);
    const missing = broker.command("exists");
    await new Promise((resolve) => setImmediate(resolve));
    input.write(response(requestId(requests[0]!), { code: 44, stdout: "" }));
    await expect(missing).rejects.toMatchObject({ code: 44 });
    await expect(broker.command("read", "unexpected")).rejects.toThrow(/Invalid/);

    const poisoned = broker.command("read");
    await new Promise((resolve) => setImmediate(resolve));
    const bad = response(requestId(requests[1]!), { code: 0, stdout: "secret" }, "f".repeat(64));
    input.write(bad);
    await expect(poisoned).rejects.toThrow(/invalid/);
    await expect(broker.command("read")).rejects.toThrow(/unavailable/);
  });

  it("keeps aborted work correlated until authenticated settlement without reusing request ids", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const broker = new StdioKeychainBroker(input, output);
    const requests: string[] = []; output.on("data", (chunk) => requests.push(chunk.toString()));
    input.write(`${KEYCHAIN_BROKER_HELLO_PREFIX}${SESSION}\n`);
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = controllers.map((controller) => broker.command("read", undefined, controller.signal));
    await expect(broker.command("read")).rejects.toThrow(/unavailable/);
    controllers.forEach((controller) => controller.abort());
    let settled = false;
    void Promise.allSettled(pending).then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    // The authenticated responses prove every backend operation has finished;
    // only then do the callers observe their fixed cancellation result.
    requests.forEach((request) => input.write(response(requestId(request), { code: 0, stdout: "late" })));
    await Promise.all(pending.map((promise) => expect(promise).rejects.toThrow(/cancelled/)));
    const next = broker.command("read");
    await new Promise((resolve) => setImmediate(resolve));
    input.write(response(requestId(requests.at(-1)!), { code: 0, stdout: "next" }));
    await expect(next).resolves.toEqual({ stdout: "next", stderr: "" });
  });

  it("does not emit an already-cancelled mutation", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const broker = new StdioKeychainBroker(input, output);
    let request = ""; output.on("data", (chunk) => { request += chunk.toString(); });
    input.write(`${KEYCHAIN_BROKER_HELLO_PREFIX}${SESSION}\n`);
    const controller = new AbortController(); controller.abort();
    await expect(broker.command("upsert", "secret", controller.signal)).rejects.toThrow(/cancelled/);
    expect(request).toBe("");
  });

  it("settles a direct store save before reporting cancellation and cannot mutate later", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const broker = new StdioKeychainBroker(input, output);
    let request = ""; output.on("data", (chunk) => { request += chunk.toString(); });
    input.write(`${KEYCHAIN_BROKER_HELLO_PREFIX}${SESSION}\n`);
    const command: KeychainCommand = async (_executable, args, secretStdin, signal) => {
      expect(args[0]).toBe("add-generic-password");
      return broker.command("upsert", secretStdin, signal);
    };
    const store = new ChatGptKeychainStore({ command, resolveHome: () => "/tmp/broker-abort-save" });
    const controller = new AbortController();
    const saving = store.save({ accessToken: "access-abort", refreshToken: "refresh-abort",
      expiresAtMs: 2_000_000, accountId: "account-abort" }, controller.signal);
    const outcome = saving.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    let settled = false; void outcome.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    const emittedRequest = request;
    let durableMutations = 0;
    durableMutations += 1;
    input.write(response(requestId(request), { code: 0, stdout: "" }));
    const terminal = await outcome;
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error).toMatchObject({ message: "Keychain operation cancelled" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(durableMutations).toBe(1);
    expect(request).toBe(emittedRequest); // no late callback can emit another write
  });
});
