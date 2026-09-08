import { describe, expect, it, vi } from "vitest";

import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_MODELS_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_URL,
  CODEX_USAGE_URL,
} from "./constants.js";
import { createBrowserPkceMaterial, buildBrowserAuthorizationUrl } from "./browser-pkce.js";
import { BrowserSmokeNetworkBudget } from "./browser-smoke-budget.js";

function authorizationUrl(): string {
  const values = [1, 2];
  return buildBrowserAuthorizationUrl(
    createBrowserPkceMaterial({
      randomBytes: (size) => new Uint8Array(size).fill(values.shift() ?? 3),
    }),
  );
}

describe("zero-inference browser smoke network budget", () => {
  it("allows one navigation, one exchange and one refresh with no retries", async () => {
    const delegate = vi.fn<typeof fetch>(async () => new Response("{}"));
    const budget = new BrowserSmokeNetworkBudget();
    const fetch = budget.wrapFetch(delegate);
    budget.recordAuthorizationNavigation(authorizationUrl());
    await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });
    await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token" }),
    });

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(delegate.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(budget.snapshot()).toEqual({
      authorizeNavigation: 1,
      tokenExchange: 1,
      tokenRefresh: 1,
      deviceCode: 0,
      devicePoll: 0,
      models: 0,
      quota: 0,
      inference: 0,
      other: 0,
      workerFetchTotal: 2,
      controlledRemoteTotal: 3,
    });
    expect(() => budget.recordAuthorizationNavigation(authorizationUrl())).toThrow(
      /authorizeNavigation/,
    );
    await expect(
      fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token" }),
      }),
    ).rejects.toThrow(/tokenRefresh/);
    expect(delegate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["deviceCode", CODEX_DEVICE_CODE_URL, { method: "POST" }],
    ["devicePoll", CODEX_DEVICE_TOKEN_URL, { method: "POST" }],
    ["models", CODEX_MODELS_URL, undefined],
    ["quota", CODEX_USAGE_URL, undefined],
    ["inference", CODEX_RESPONSES_URL, { method: "POST" }],
    ["other", "https://example.invalid/other", undefined],
    [
      "other",
      CODEX_OAUTH_TOKEN_URL,
      { method: "POST", body: new URLSearchParams({ grant_type: "password" }) },
    ],
    [
      "other",
      CODEX_OAUTH_TOKEN_URL,
      {
        method: "POST",
        body: "grant_type=authorization_code&grant_type=refresh_token",
      },
    ],
  ] as const)("hard-refuses %s before the fetch delegate", async (_name, url, init) => {
    const delegate = vi.fn<typeof fetch>();
    const budget = new BrowserSmokeNetworkBudget();
    await expect(budget.wrapFetch(delegate)(url, init)).rejects.toThrow(/REFUSED/);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("refuses any browser navigation except the pinned authorize endpoint", () => {
    const budget = new BrowserSmokeNetworkBudget();
    expect(() => budget.recordAuthorizationNavigation("https://example.invalid/oauth"))
      .toThrow(/endpoint was not pinned/);
    const withExtra = new URL(authorizationUrl());
    withExtra.searchParams.set("extra", "value");
    expect(() => budget.recordAuthorizationNavigation(withExtra.href))
      .toThrow(/allowlist changed/);
    expect(budget.snapshot().controlledRemoteTotal).toBe(0);
  });
});
