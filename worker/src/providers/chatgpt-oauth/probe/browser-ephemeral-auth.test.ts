import { describe, expect, it, vi } from "vitest";

import { runBrowserEphemeralAuth } from "./browser-ephemeral-auth.js";
import {
  BROWSER_OAUTH_CALLBACK_HOST,
  BROWSER_OAUTH_CALLBACK_PATH,
  BROWSER_OAUTH_CALLBACK_PORT,
} from "./browser-pkce.js";

describe("ephemeral browser PKCE probe authentication", () => {
  it("opens the browser and consumes the automatic callback without a user code", async () => {
    let randomCall = 0;
    const opened: string[] = [];
    const closed = vi.fn(async () => undefined);
    const tokens = await runBrowserEphemeralAuth({
      env: { SUPERTWIN_APP_VERSION: "13.12.2" },
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, ++randomCall),
      openAuthorizationUrl: async (url) => { opened.push(url); },
      listenerFactory: async () => ({
        addressEvidence: {
          host: BROWSER_OAUTH_CALLBACK_HOST,
          port: BROWSER_OAUTH_CALLBACK_PORT,
          path: BROWSER_OAUTH_CALLBACK_PATH,
        },
        wait: async () => ({ code: "automatic-callback-code", stateValidated: true }),
        cancel: () => undefined,
        close: closed,
      }),
      fetch: vi.fn<typeof fetch>(async (_input, init) => {
        expect(String(init?.body)).toContain("code=automatic-callback-code");
        return new Response(JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        }), { status: 200 });
      }),
    });

    expect(tokens).toEqual({ accessToken: "access", refreshToken: "refresh", expiresAtMs: 3_601_000 });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("code_challenge=");
    expect(opened[0]).not.toContain("code_verifier");
    expect(closed).toHaveBeenCalledOnce();
  });
});
