import { createServer } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_OAUTH_CALLBACK_HOST,
  BROWSER_OAUTH_CALLBACK_PORT,
} from "./browser-pkce.js";
import {
  BROWSER_AUTH_FAILURE_HTML,
  BROWSER_AUTH_SUCCESS_HTML,
  BrowserLoopbackError,
  startBrowserLoopback,
  type BrowserLoopbackListener,
} from "./browser-loopback.js";

let active: BrowserLoopbackListener | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
});

function callbackRequest(
  path: string,
  options: { method?: string; host?: string; oversizedHeader?: boolean } = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: BROWSER_OAUTH_CALLBACK_HOST,
        port: BROWSER_OAUTH_CALLBACK_PORT,
        path,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? "localhost:1455",
          Connection: "close",
          ...(options.oversizedHeader ? { "X-Oversized": "x".repeat(9_000) } : {}),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function listener(state = "expected-state", timeoutMs = 2_000) {
  active = await startBrowserLoopback({ expectedState: state, timeoutMs });
  return active;
}

describe("single-use IPv4 loopback callback", () => {
  it("accepts one exact callback and serves only the fixed success page", async () => {
    const handle = await listener();
    expect(handle.addressEvidence).toEqual({
      host: "127.0.0.1",
      port: 1455,
      path: "/auth/callback",
    });
    const waiting = handle.wait();
    const response = await callbackRequest(
      "/auth/callback?code=secret-code&state=expected-state",
    );
    await expect(waiting).resolves.toEqual({
      code: "secret-code",
      stateValidated: true,
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe(BROWSER_AUTH_SUCCESS_HTML);
    expect(response.body).not.toContain("secret-code");
    expect(response.body).not.toContain("expected-state");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    await handle.close();
  });

  it("allows bounded stray paths without consuming the callback", async () => {
    const handle = await listener();
    const waiting = handle.wait();
    const stray = await callbackRequest("/favicon.ico");
    expect(stray.status).toBe(404);
    expect(stray.body).toBe(BROWSER_AUTH_FAILURE_HTML);
    await callbackRequest("/auth/callback?code=ok&state=expected-state");
    await expect(waiting).resolves.toMatchObject({ code: "ok" });
  });

  it.each([
    ["wrong state", "/auth/callback?code=code-secret&state=wrong", {}],
    ["duplicate state", "/auth/callback?code=x&state=a&state=b", {}],
    ["duplicate code", "/auth/callback?code=x&code=y&state=expected-state", {}],
    ["empty code", "/auth/callback?code=&state=expected-state", {}],
    ["malformed encoding", "/auth/callback?code=%ZZ&state=expected-state", {}],
    ["OAuth error", "/auth/callback?error=access_denied&state=expected-state", {}],
    ["wrong method", "/auth/callback?code=x&state=expected-state", { method: "POST" }],
    ["wrong host", "/auth/callback?code=x&state=expected-state", { host: "evil.test" }],
    ["oversized target", `/auth/callback?code=${"x".repeat(4_100)}&state=expected-state`, {}],
  ] as const)("rejects %s without reflecting callback values", async (_label, path, options) => {
    const handle = await listener();
    const waiting = handle.wait();
    const response = await callbackRequest(path, options);
    await expect(waiting).rejects.toMatchObject({ code: "CALLBACK_REJECTED" });
    expect(response.status).toBe(400);
    expect(response.body).toBe(BROWSER_AUTH_FAILURE_HTML);
    expect(response.body).not.toContain("code-secret");
    expect(response.body).not.toContain("access_denied");
  });

  it("rejects oversized headers and closes the listener", async () => {
    const handle = await listener();
    const waiting = handle.wait();
    await expect(callbackRequest("/auth/callback", { oversizedHeader: true }))
      .rejects.toBeDefined();
    await expect(waiting).rejects.toMatchObject({ code: "CALLBACK_REJECTED" });
  });

  it("cancels and times out without leaving the port open", async () => {
    const cancelled = await listener();
    const cancelledWait = cancelled.wait();
    cancelled.cancel();
    await expect(cancelledWait).rejects.toMatchObject({ code: "CANCELLED" });
    await cancelled.close();
    active = undefined;

    const expired = await listener("expected-state", 10);
    await expect(expired.wait()).rejects.toMatchObject({ code: "EXPIRED" });
    await expired.close();
  });

  it("refuses invalid state, timeout, and pre-aborted input before binding", async () => {
    await expect(
      startBrowserLoopback({ expectedState: "", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "CALLBACK_REJECTED" });
    await expect(
      startBrowserLoopback({ expectedState: "state", timeoutMs: 15 * 60_000 + 1 }),
    ).rejects.toMatchObject({ code: "CALLBACK_REJECTED" });
    const abortController = new AbortController();
    abortController.abort();
    await expect(
      startBrowserLoopback({
        expectedState: "state",
        timeoutMs: 1_000,
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("treats a port conflict as typed failure without choosing another port", async () => {
    const holder = createServer();
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(
        { host: BROWSER_OAUTH_CALLBACK_HOST, port: BROWSER_OAUTH_CALLBACK_PORT },
        resolve,
      );
    });
    expect((holder.address() as AddressInfo).port).toBe(1455);
    try {
      const error = await startBrowserLoopback({
        expectedState: "state",
        timeoutMs: 1_000,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BrowserLoopbackError);
      expect(error).toMatchObject({ code: "PORT_IN_USE" });
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
