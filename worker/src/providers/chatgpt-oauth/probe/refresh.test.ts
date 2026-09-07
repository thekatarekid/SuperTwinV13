import { describe, expect, it, vi } from "vitest";

import { CODEX_OAUTH_TOKEN_URL } from "./constants.js";
import { EphemeralProbeTokenSession, ProbeAuthError } from "./refresh.js";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Phase 0b ephemeral refresh proof", () => {
  it("refreshes once for concurrent waiters, adopts rotation before exposure, and retains one recovery pair", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response(200, {
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3_600,
    }));
    const session = new EphemeralProbeTokenSession({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAtMs: 121_000,
    });
    const hooks = { fetch: fetchMock, now: () => 10_000, env: { SUPERTWIN_APP_VERSION: "13.12.2" } };

    expect(session.shouldRefresh(1_000)).toBe(true);
    const [first, second] = await Promise.all([session.refresh(hooks), session.refresh(hooks)]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(session.current()).toEqual({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAtMs: 3_610_000,
    });
    expect(session.evidence()).toEqual({
      authenticated: true,
      expiresAtMs: 3_610_000,
      hasRefreshToken: true,
      previousRecoveryPairAvailable: true,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CODEX_OAUTH_TOKEN_URL);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(String(init?.body)).toContain("refresh_token=refresh-old");
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "SuperTwinV13/13.12.2",
    });
  });

  it("retains the current refresh token when rotation omits a replacement", async () => {
    const session = new EphemeralProbeTokenSession({ accessToken: "a1", refreshToken: "r1" });
    await session.refresh({
      fetch: vi.fn<typeof fetch>(async () => response(200, { access_token: "a2" })),
      now: () => 0,
    });
    expect(session.current().refreshToken).toBe("r1");
  });

  it("refreshes and retries an original 401 exactly once", async () => {
    const session = new EphemeralProbeTokenSession({ accessToken: "a1", refreshToken: "r1" });
    const send = vi.fn(async (token: string) => ({ status: token === "a1" ? 401 : 200 }));
    const fetchMock = vi.fn<typeof fetch>(async () => response(200, {
      access_token: "a2",
      refresh_token: "r2",
    }));
    await expect(session.retryOnceAfter401(send, { fetch: fetchMock, now: () => 0 })).resolves.toEqual({ status: 200 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [429, {}, "RATE_LIMITED"],
    [401, {}, "AUTH_EXPIRED"],
    [400, { error: "invalid_grant" }, "AUTH_EXPIRED"],
  ] as const)("stops safely on HTTP %s", async (status, body, code) => {
    const session = new EphemeralProbeTokenSession({ accessToken: "a1", refreshToken: "r1" });
    const error = await session.refresh({
      fetch: vi.fn<typeof fetch>(async () => response(status, body)),
      now: () => 0,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ProbeAuthError);
    expect((error as ProbeAuthError).code).toBe(code);
  });

  it("logout clears both pairs and subsequent access is AUTH_REQUIRED without fetch", async () => {
    const session = new EphemeralProbeTokenSession({ accessToken: "a1", refreshToken: "r1" });
    session.logout();
    expect(session.evidence()).toEqual({
      authenticated: false,
      expiresAtMs: undefined,
      hasRefreshToken: false,
      previousRecoveryPairAvailable: false,
    });
    expect(() => session.current()).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });
});
