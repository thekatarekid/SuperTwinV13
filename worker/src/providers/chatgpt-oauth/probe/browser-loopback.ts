import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  BROWSER_OAUTH_CALLBACK_HOST,
  BROWSER_OAUTH_CALLBACK_PATH,
  BROWSER_OAUTH_CALLBACK_PORT,
  BROWSER_AUTH_ATTEMPT_TTL_MS,
} from "./browser-pkce.js";

export const BROWSER_CALLBACK_MAX_TARGET_BYTES = 4 * 1024;
export const BROWSER_CALLBACK_MAX_HEADER_BYTES = 8 * 1024;
export const BROWSER_CALLBACK_MAX_STRAY_REQUESTS = 4;

export const BROWSER_AUTH_SUCCESS_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Signed in to SuperTwin</title></head>" +
  "<body><h1>Signed in to SuperTwin</h1><p>You can close this window.</p></body></html>";
export const BROWSER_AUTH_FAILURE_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>SuperTwin sign-in failed</title></head>" +
  "<body><h1>SuperTwin sign-in failed</h1><p>Return to SuperTwin and try again.</p></body></html>";

export type BrowserLoopbackErrorCode =
  | "PORT_IN_USE"
  | "CALLBACK_REJECTED"
  | "CANCELLED"
  | "EXPIRED";

export class BrowserLoopbackError extends Error {
  constructor(readonly code: BrowserLoopbackErrorCode, message: string) {
    super(message);
    this.name = "BrowserLoopbackError";
  }
}

export interface BrowserCallbackResult {
  code: string;
  stateValidated: true;
}

export interface BrowserLoopbackOptions {
  expectedState: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BrowserLoopbackListener {
  readonly addressEvidence: {
    host: typeof BROWSER_OAUTH_CALLBACK_HOST;
    port: typeof BROWSER_OAUTH_CALLBACK_PORT;
    path: typeof BROWSER_OAUTH_CALLBACK_PATH;
  };
  wait(): Promise<BrowserCallbackResult>;
  cancel(): void;
  close(): Promise<void>;
}

function fixedPageHeaders(length: number): Record<string, string | number> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": length,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  };
}

function sendFixedPage(
  response: ServerResponse,
  status: number,
  body: string,
  finished?: () => void,
): void {
  response.writeHead(status, fixedPageHeaders(Buffer.byteLength(body)));
  response.end(body, finished);
}

function validPercentEncoding(value: string): boolean {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 1)) {
    if (!/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) return false;
  }
  return true;
}

function timingSafeStateMatch(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function singleNonempty(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0]?.trim()) return undefined;
  return values[0];
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startBrowserLoopback(
  options: BrowserLoopbackOptions,
): Promise<BrowserLoopbackListener> {
  if (!options.expectedState || Buffer.byteLength(options.expectedState) > 128) {
    throw new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback state was invalid");
  }
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > BROWSER_AUTH_ATTEMPT_TTL_MS
  ) {
    throw new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback timeout was invalid");
  }
  if (options.signal?.aborted) {
    throw new BrowserLoopbackError("CANCELLED", "Browser sign-in was cancelled");
  }
  let expectedState = options.expectedState;
  let settled = false;
  let strayRequests = 0;
  let resolveResult!: (result: BrowserCallbackResult) => void;
  let rejectResult!: (error: BrowserLoopbackError) => void;
  const result = new Promise<BrowserCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);

  const server = createServer(
    { maxHeaderSize: BROWSER_CALLBACK_MAX_HEADER_BYTES, requestTimeout: 5_000 },
    (request, response) => {
      void handleRequest(request, response);
    },
  );
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 1;
  server.headersTimeout = 5_000;
  server.timeout = 5_000;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(5_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });

  const cleanup = (): void => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    expectedState = "";
    void closeServer(server, sockets);
  };
  const reject = (error: BrowserLoopbackError, response?: ServerResponse): void => {
    if (settled) {
      if (response) sendFixedPage(response, 409, BROWSER_AUTH_FAILURE_HTML);
      return;
    }
    settled = true;
    if (response) {
      sendFixedPage(response, 400, BROWSER_AUTH_FAILURE_HTML, () => {
        rejectResult(error);
        cleanup();
      });
    } else {
      rejectResult(error);
      cleanup();
    }
  };
  server.on("clientError", (_error, socket) => {
    socket.destroy();
    reject(
      new BrowserLoopbackError(
        "CALLBACK_REJECTED",
        "OAuth callback request exceeded parser bounds",
      ),
    );
  });
  const resolve = (callback: BrowserCallbackResult, response: ServerResponse): void => {
    if (settled) {
      sendFixedPage(response, 409, BROWSER_AUTH_FAILURE_HTML);
      return;
    }
    settled = true;
    sendFixedPage(response, 200, BROWSER_AUTH_SUCCESS_HTML, () => {
      resolveResult(callback);
      cleanup();
    });
  };
  const onAbort = (): void => {
    reject(new BrowserLoopbackError("CANCELLED", "Browser sign-in was cancelled"));
  };
  const timeout = setTimeout(() => {
    reject(new BrowserLoopbackError("EXPIRED", "Browser sign-in timed out"));
  }, options.timeoutMs);
  timeout.unref();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rawTarget = request.url ?? "";
    if (Buffer.byteLength(rawTarget) > BROWSER_CALLBACK_MAX_TARGET_BYTES) {
      reject(new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback target was oversized"), response);
      return;
    }
    if (request.method !== "GET" || request.headers.host !== "localhost:1455") {
      reject(new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback method or host was invalid"), response);
      return;
    }
    if (!validPercentEncoding(rawTarget)) {
      reject(new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback encoding was invalid"), response);
      return;
    }
    let url: URL;
    try {
      url = new URL(rawTarget, "http://localhost:1455");
    } catch {
      reject(new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback target was invalid"), response);
      return;
    }
    if (url.pathname !== BROWSER_OAUTH_CALLBACK_PATH) {
      strayRequests += 1;
      if (strayRequests > BROWSER_CALLBACK_MAX_STRAY_REQUESTS) {
        reject(new BrowserLoopbackError("CALLBACK_REJECTED", "Too many non-callback requests"), response);
      } else {
        sendFixedPage(response, 404, BROWSER_AUTH_FAILURE_HTML);
      }
      return;
    }
    if (url.searchParams.has("error")) {
      reject(new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth provider rejected sign-in"), response);
      return;
    }
    const code = singleNonempty(url.searchParams, "code");
    const state = singleNonempty(url.searchParams, "state");
    if (!code || !state || !timingSafeStateMatch(state, expectedState)) {
      reject(new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback validation failed"), response);
      return;
    }
    resolve({ code, stateValidated: true }, response);
  }

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        rejectListening(
          error.code === "EADDRINUSE"
            ? new BrowserLoopbackError("PORT_IN_USE", "OAuth callback port 1455 is already in use")
            : new BrowserLoopbackError("CALLBACK_REJECTED", "OAuth callback listener failed"),
        );
      };
      server.once("error", onError);
      server.listen(
        { host: BROWSER_OAUTH_CALLBACK_HOST, port: BROWSER_OAUTH_CALLBACK_PORT, exclusive: true },
        () => {
          server.off("error", onError);
          resolveListening();
        },
      );
    });
  } catch (error) {
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    expectedState = "";
    rejectResult(error as BrowserLoopbackError);
    throw error;
  }

  if (options.signal?.aborted) onAbort();
  return {
    addressEvidence: {
      host: BROWSER_OAUTH_CALLBACK_HOST,
      port: BROWSER_OAUTH_CALLBACK_PORT,
      path: BROWSER_OAUTH_CALLBACK_PATH,
    },
    wait: () => result,
    cancel: onAbort,
    close: async () => {
      if (!settled) onAbort();
      await closeServer(server, sockets);
    },
  };
}
