import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_ACCOUNT_QUOTA_URL,
  CHATGPT_QUOTA_MAX_RESPONSE_BYTES,
  pollChatGptQuota,
} from "./quota.js";

const session = {
  authorization: vi.fn(async () => ({ accessToken: "secret-token", accountId: "account-a" })),
};

describe("production ChatGPT quota polling", () => {
  it("performs exactly one bounded authenticated metadata GET and returns only a fingerprint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      plan_type: "plus", rate_limit: {
        primary_window: { used_percent: 60, reset_at: "2026-09-10T00:00:00.000Z" },
        secondary_window: null,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await pollChatGptQuota({ session, fetch: fetch as unknown as typeof globalThis.fetch, userAgent: "SuperTwinV13/13.12.2" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(CHATGPT_ACCOUNT_QUOTA_URL);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(result.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("account-a");
    expect(result.snapshot.primary.usedPercent).toBe(60);
  });

  it("rejects oversized or malformed responses without retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ x: "x".repeat(CHATGPT_QUOTA_MAX_RESPONSE_BYTES) }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(pollChatGptQuota({ session, fetch: fetch as unknown as typeof globalThis.fetch, userAgent: "SuperTwinV13/13.12.2" })).rejects.toThrow("quota polling failed");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
