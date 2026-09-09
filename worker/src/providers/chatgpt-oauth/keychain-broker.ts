import { createHmac, timingSafeEqual } from "node:crypto";
import type { Readable, Writable } from "node:stream";

export const KEYCHAIN_BROKER_HELLO_PREFIX = "SUPERTWIN_KEYCHAIN_HELLO_V1 ";
export const KEYCHAIN_BROKER_REQUEST_PREFIX = "SUPERTWIN_KEYCHAIN_REQUEST_V1 ";
export const KEYCHAIN_BROKER_RESPONSE_PREFIX = "SUPERTWIN_KEYCHAIN_RESPONSE_V1 ";
export const SIGNED_GOLDEN_DECLARATION_PREFIX = "SUPERTWIN_SIGNED_GOLDEN_DECLARATION_V1 ";
export const SIGNED_GOLDEN_APPROVAL_PREFIX = "SUPERTWIN_SIGNED_GOLDEN_APPROVAL_V1 ";
const PROTOCOL = "supertwin-keychain-broker-v1";
const MAX_FRAME_BYTES = 768 * 1024;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_PENDING = 8;
const TIMEOUT_MS = 10_000;
const SAFE_SESSION = /^[a-f0-9]{64}$/;
const SAFE_AUTHORIZATION = /^[a-f0-9]{64}$/;

export type KeychainBrokerOperation = "exists" | "read" | "upsert" | "delete" | "binding";

export interface KeychainBrokerResult { stdout: string; stderr: string }

export class KeychainBrokerOperationError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "KeychainBrokerOperationError";
    if (code !== undefined) this.code = code;
  }
}

interface Pending {
  resolve(value: KeychainBrokerResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
  abortRequested: boolean;
  timeoutRequested: boolean;
}

function failure(message: string, code?: number): Error & { code?: number } {
  return new KeychainBrokerOperationError(message, code);
}

function mac(secret: Buffer, direction: "request" | "response", id: number, body: Buffer): string {
  const sequence = Buffer.allocUnsafe(8);
  sequence.writeBigUInt64BE(BigInt(id));
  return createHmac("sha256", secret).update("supertwin-keychain-broker-v1\0").update(direction).update("\0")
    .update(sequence).update(body).digest("hex");
}

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("non-canonical base64url");
  return decoded;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) === JSON.stringify([...keys].sort());
}

export class StdioKeychainBroker {
  readonly #disconnect = new AbortController();
  readonly #input: Readable;
  readonly #output: Pick<Writable, "write">;
  readonly #pending = new Map<number, Pending>();
  readonly #retired = new Set<number>();
  #session?: string;
  #secret?: Buffer;
  #buffer = "";
  #nextId = 1;
  #started = false;
  #failed = false;
  #helloWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  #goldenApproval?: { expected: string; resolve(): void; reject(error: Error): void;
    timer: NodeJS.Timeout; signal?: AbortSignal; abort?: () => void };

  constructor(input: Readable, output: Pick<Writable, "write">) {
    this.#input = input;
    this.#output = output;
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#input.setEncoding("utf8");
    this.#input.on("data", (chunk: string) => this.#onData(chunk));
    this.#input.once("end", () => this.#poison("credential broker closed"));
    this.#input.once("error", () => this.#poison("credential broker failed"));
    this.#input.resume();
  }

  #poison(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#disconnect.abort();
    this.#secret?.fill(0);
    this.#secret = undefined;
    this.#session = undefined;
    const error = failure(message);
    for (const waiter of this.#helloWaiters.splice(0)) waiter.reject(error);
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    if (this.#goldenApproval) {
      const approval = this.#goldenApproval; this.#goldenApproval = undefined;
      clearTimeout(approval.timer);
      if (approval.abort && approval.signal) approval.signal.removeEventListener("abort", approval.abort);
      approval.reject(error);
    }
    this.#retired.clear();
  }

  disconnectSignal(): AbortSignal { this.#start(); return this.#disconnect.signal; }

  #onData(chunk: string): void {
    if (this.#failed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_FRAME_BYTES * 2) {
      this.#poison("credential broker frame exceeded its limit"); return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.startsWith(KEYCHAIN_BROKER_HELLO_PREFIX)) this.#onHello(line);
      else if (line.startsWith(KEYCHAIN_BROKER_RESPONSE_PREFIX)) this.#onResponse(line);
      else if (line.startsWith(SIGNED_GOLDEN_APPROVAL_PREFIX)) this.#onGoldenApproval(line);
      else if (line.length > 0) { this.#poison("credential broker sent an invalid frame"); return; }
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onGoldenApproval(line: string): void {
    const approval = this.#goldenApproval;
    const value = line.slice(SIGNED_GOLDEN_APPROVAL_PREFIX.length);
    if (!approval || value !== approval.expected || !SAFE_AUTHORIZATION.test(value)) {
      this.#poison("signed golden owner approval was invalid"); return;
    }
    this.#goldenApproval = undefined;
    clearTimeout(approval.timer);
    if (approval.abort && approval.signal) approval.signal.removeEventListener("abort", approval.abort);
    approval.resolve();
  }

  #onHello(line: string): void {
    if (this.#session !== undefined) { this.#poison("credential broker repeated its handshake"); return; }
    const session = line.slice(KEYCHAIN_BROKER_HELLO_PREFIX.length);
    if (!SAFE_SESSION.test(session)) { this.#poison("credential broker handshake is invalid"); return; }
    this.#session = session;
    this.#secret = Buffer.from(session, "hex");
    for (const waiter of this.#helloWaiters.splice(0)) waiter.resolve();
  }

  #onResponse(line: string): void {
    try {
      if (!this.#session || !this.#secret) throw new Error("handshake missing");
      const encoded = line.slice(KEYCHAIN_BROKER_RESPONSE_PREFIX.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > MAX_FRAME_BYTES) throw new Error("invalid encoding");
      const parsed = JSON.parse(decodeBase64Url(encoded).toString("utf8")) as unknown;
      if (!exactObject(parsed, ["protocol", "id", "body", "mac"]) ||
          parsed.protocol !== PROTOCOL || !Number.isSafeInteger(parsed.id) ||
          typeof parsed.body !== "string" || !/^[A-Za-z0-9_-]+$/.test(parsed.body) ||
          typeof parsed.mac !== "string" || !/^[a-f0-9]{64}$/.test(parsed.mac)) throw new Error("bad envelope");
      const id = Number(parsed.id);
      const body = decodeBase64Url(parsed.body);
      const actualMac = Buffer.from(parsed.mac, "hex");
      const expectedMac = Buffer.from(mac(this.#secret, "response", id, body), "hex");
      if (actualMac.length !== expectedMac.length ||
          !timingSafeEqual(actualMac, expectedMac)) throw new Error("bad mac");
      const result = JSON.parse(body.toString("utf8")) as unknown;
      if (!exactObject(result, ["code", "stdout"]) || !Number.isInteger(result.code) ||
          ![0, 1, 44, 45, 64, 65, 66].includes(Number(result.code)) ||
          typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 256 * 1024 ||
          (result.code !== 0 && result.stdout !== "")) throw new Error("bad body");
      const pending = this.#pending.get(id);
      if (!pending) {
        if (this.#retired.delete(id)) return;
        throw new Error("unknown response");
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
      // Once a frame has crossed the private pipe, cancellation cannot undo a
      // Security.framework mutation. Keep the correlation live until the
      // authenticated response proves that the broker operation has settled;
      // only then report the caller's cancellation/timeout intent.
      if (pending.abortRequested) pending.reject(failure("Keychain operation cancelled"));
      else if (pending.timeoutRequested) pending.reject(failure("Keychain broker operation timed out"));
      else if (result.code === 0) pending.resolve({ stdout: result.stdout, stderr: "" });
      else pending.reject(failure("Keychain broker operation failed", Number(result.code)));
    } catch { this.#poison("credential broker response is invalid"); }
  }

  async #ready(signal?: AbortSignal): Promise<void> {
    this.#start();
    if (this.#failed) throw failure("credential broker is unavailable");
    if (this.#session) return;
    await new Promise<void>((resolve, reject) => {
      let waiter: { resolve(): void; reject(error: Error): void };
      const remove = (): void => {
        const index = this.#helloWaiters.indexOf(waiter);
        if (index >= 0) this.#helloWaiters.splice(index, 1);
      };
      const timer = setTimeout(() => { remove(); reject(failure("credential broker handshake timed out")); }, TIMEOUT_MS);
      timer.unref();
      const finish = (action: () => void): void => { remove(); clearTimeout(timer); signal?.removeEventListener("abort", abort); action(); };
      const abort = (): void => finish(() => reject(failure("Keychain operation cancelled")));
      waiter = { resolve: () => finish(resolve), reject: (error) => finish(() => reject(error)) };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.#helloWaiters.push(waiter);
    });
  }

  async command(operation: KeychainBrokerOperation, input?: string,
    signal?: AbortSignal): Promise<KeychainBrokerResult> {
    await this.#ready(signal);
    // Abort before allocating an id or emitting a possibly mutating frame. An
    // already-aborted signal does not dispatch a newly-added listener.
    if (signal?.aborted) throw failure("Keychain operation cancelled");
    if (!this.#session || !this.#secret || this.#pending.size >= MAX_PENDING || this.#retired.size >= 64) {
      throw failure("credential broker is unavailable");
    }
    if ((operation === "upsert") !== (input !== undefined) ||
        (input !== undefined && (input.length === 0 || Buffer.byteLength(input) > MAX_INPUT_BYTES))) {
      throw failure("Invalid Keychain broker request");
    }
    const id = this.#nextId++;
    const body = Buffer.from(JSON.stringify({ operation, ...(input === undefined ? {} : { input }) }), "utf8");
    const wire = Buffer.from(JSON.stringify({ protocol: PROTOCOL, id,
      body: body.toString("base64url"), mac: mac(this.#secret, "request", id, body) }), "utf8");
    const frame = `${KEYCHAIN_BROKER_REQUEST_PREFIX}${wire.toString("base64url")}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw failure("Invalid Keychain broker request");
    return new Promise<KeychainBrokerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        pending.timeoutRequested = true;
      }, TIMEOUT_MS);
      timer.unref();
      const abort = signal ? () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        pending.abortRequested = true;
      } : undefined;
      this.#pending.set(id, { resolve, reject, timer, abortRequested: false, timeoutRequested: false,
        ...(signal ? { signal } : {}), ...(abort ? { abort } : {}) });
      signal?.addEventListener("abort", abort!, { once: true });
      try {
        this.#output.write(frame, "utf8");
      } catch {
        this.#pending.delete(id); this.#retired.add(id); clearTimeout(timer);
        signal?.removeEventListener("abort", abort!);
        reject(failure("credential broker is unavailable"));
      }
    });
  }

  async requestGoldenOwnerApproval(declaration: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    await this.#ready(signal);
    if (signal?.aborted) throw failure("Signed golden owner approval cancelled");
    if (this.#goldenApproval || this.#pending.size > 0) throw failure("signed golden owner approval is unavailable");
    const authorizationId = declaration.authorization_id;
    if (typeof authorizationId !== "string" || !SAFE_AUTHORIZATION.test(authorizationId)) {
      throw failure("signed golden declaration is invalid");
    }
    const encoded = Buffer.from(JSON.stringify(declaration), "utf8").toString("base64url");
    const frame = `${SIGNED_GOLDEN_DECLARATION_PREFIX}${encoded}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw failure("signed golden declaration is invalid");
    return new Promise<void>((resolve, reject) => {
      const finish = (action: () => void): void => {
        const approval = this.#goldenApproval;
        if (!approval) return;
        this.#goldenApproval = undefined; clearTimeout(approval.timer);
        if (approval.abort && approval.signal) approval.signal.removeEventListener("abort", approval.abort);
        action();
      };
      const timer = setTimeout(() => finish(() => reject(failure("Signed golden owner approval timed out"))), 300_000);
      timer.unref();
      const abort = signal ? () => finish(() => reject(failure("Signed golden owner approval cancelled"))) : undefined;
      this.#goldenApproval = { expected: authorizationId, resolve, reject, timer,
        ...(signal ? { signal } : {}), ...(abort ? { abort } : {}) };
      signal?.addEventListener("abort", abort!, { once: true });
      try { this.#output.write(frame, "utf8"); }
      catch { finish(() => reject(failure("signed golden owner approval is unavailable"))); }
    });
  }
}

let productionBroker: StdioKeychainBroker | undefined;

export function runStdioKeychainBrokerCommand(
  operation: KeychainBrokerOperation,
  input?: string,
  signal?: AbortSignal,
): Promise<KeychainBrokerResult> {
  productionBroker ??= new StdioKeychainBroker(process.stdin, process.stdout);
  return productionBroker.command(operation, input, signal);
}

/** Parent-pipe lifetime capability. Golden execution must terminate on abort. */
export function stdioKeychainBrokerDisconnectSignal(): AbortSignal {
  productionBroker ??= new StdioKeychainBroker(process.stdin, process.stdout);
  return productionBroker.disconnectSignal();
}

export function requestSignedGoldenOwnerApproval(
  declaration: Readonly<Record<string, unknown>>, signal?: AbortSignal,
): Promise<void> {
  productionBroker ??= new StdioKeychainBroker(process.stdin, process.stdout);
  return productionBroker.requestGoldenOwnerApproval(declaration, signal);
}
