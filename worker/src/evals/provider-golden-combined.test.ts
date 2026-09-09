import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ChatGptTokenPair } from "../providers/chatgpt-oauth/keychain.js";
import { runCombinedSignedChatGptGolden, type SignedGoldenDependencies } from "./provider-golden-combined.js";

const accountId = "account-golden";
const fingerprint = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
const config = { appVersion: "13.12.2", executorModel: "gpt-5.6-sol", judgeModel: "gpt-5.6-sol",
  expectedAccountFingerprint: fingerprint, evalHomeIdentity: { dev: 1, ino: 2, mode: "0700" as const },
  fixtureSha256: "a".repeat(64), baselineSha256: "d".repeat(64), gateSourceSha256: "e".repeat(64), codeIdentitySha256: "b".repeat(64), bundleSha256: "c".repeat(64) };
const pair: ChatGptTokenPair = { accessToken: "secret-access", refreshToken: "secret-refresh",
  expiresAtMs: 9_000_000, accountId };

function fixture(overrides: Partial<SignedGoldenDependencies> = {}) {
  const declarations: Array<Record<string, unknown>> = [];
  let durable: ChatGptTokenPair | undefined;
  let creates = 0;
  const dependencies: SignedGoldenDependencies = {
    approve: vi.fn(async (value) => { declarations.push(value as Record<string, unknown>); }),
    oauthLogin: vi.fn(async (persist, signal) => { await persist(pair, signal);
      return { navigation: 1, callback: 1, token: 1, retries: 0 } as const; }),
    credential: {
      create: vi.fn(async (value) => { durable = value; creates += 1; return "d".repeat(64); }),
      binding: vi.fn(async () => "d".repeat(64)),
      load: vi.fn(async () => { if (!durable) throw new Error("missing"); return durable; }),
      clearAndProveAbsent: vi.fn(async () => { durable = undefined; return true; }),
    },
    execute: vi.fn(async () => ({ code: 0, counters: { physical: 2, executor: 1, judgeInitial: 1,
      judgeRepair: 0, http401Retries: 0, claudeUsd: 0, models: 1, quota: 2, refresh: 0 } })),
    assertHomeIdentity: vi.fn(), assertSourceIdentity: vi.fn(), ...overrides,
  };
  return { dependencies, declarations, state: () => ({ durable, creates }) };
}

describe("combined signed-app ChatGPT golden ceremony", () => {
  it("requires two exact native approvals, validates identity before create, and always cleans", async () => {
    const f = fixture();
    const result = await runCombinedSignedChatGptGolden(config, f.dependencies, new AbortController().signal);
    expect(result).toMatchObject({ code: 0, cleanupProven: true });
    expect(f.declarations).toHaveLength(2);
    expect(f.declarations[0]).toMatchObject({ mode: "P6-F signed-app ChatGPT OAuth", models: 0,
      quota: 0, refresh: 0, inference: 0, retries: 0 });
    expect(f.declarations[1]).toMatchObject({ mode: "P6-F provider golden", provider: "chatgpt-oauth",
      absolute_physical_call_ceiling: 696, cost: "unknown", broker_binding_sha256: "d".repeat(64),
      oauth_actuals: { navigation: 1, callback: 1, token: 1, retries: 0 } });
    expect(result.runAuthorizationId).toBe(f.declarations[1]!.authorization_id);
    for (const declaration of f.declarations) {
      expect(declaration.authorization_id).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(declaration)).not.toMatch(/secret-access|secret-refresh|account-golden/);
    }
    expect(f.state()).toEqual({ durable: undefined, creates: 1 });
    expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  });

  it("performs zero OAuth, credential, or inference work before the first owner gate", async () => {
    const f = fixture({ approve: vi.fn(async () => { throw new Error("owner declined"); }) });
    await expect(runCombinedSignedChatGptGolden(config, f.dependencies, new AbortController().signal))
      .rejects.toThrow("owner declined");
    expect(f.dependencies.oauthLogin).not.toHaveBeenCalled();
    expect(f.state().creates).toBe(0);
    expect(f.dependencies.execute).not.toHaveBeenCalled();
  });

  it("rejects the wrong OAuth account before durable create", async () => {
    const f = fixture({ oauthLogin: async (persist, signal) => { await persist({ ...pair, accountId: "wrong" }, signal);
      return { navigation: 1, callback: 1, token: 1, retries: 0 }; } });
    await expect(runCombinedSignedChatGptGolden(config, f.dependencies, new AbortController().signal))
      .rejects.toThrow("wrong account");
    expect(f.state().creates).toBe(0);
    expect(f.dependencies.execute).not.toHaveBeenCalled();
  });

  it("rejects non-exact OAuth actuals before the inference approval", async () => {
    const f = fixture({ oauthLogin: async (persist, signal) => { await persist(pair, signal);
      return { navigation: 1, callback: 1, token: 1, retries: 1 } as never; } });
    await expect(runCombinedSignedChatGptGolden(config, f.dependencies, new AbortController().signal))
      .rejects.toThrow(/OAuth actuals/);
    expect(f.declarations).toHaveLength(1);
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.state().durable).toBeUndefined();
  });

  it.each(["second approval", "execution", "cancellation"])("proves absence after %s failure", async (stage) => {
    const f = fixture();
    if (stage === "second approval") {
      let calls = 0; f.dependencies.approve = async () => { if (++calls === 2) throw new Error("declined"); };
    } else if (stage === "execution") f.dependencies.execute = async () => { throw new Error("failed"); };
    const controller = new AbortController();
    if (stage === "cancellation") f.dependencies.execute = async () => { controller.abort(); throw new Error("cancelled"); };
    await expect(runCombinedSignedChatGptGolden(config, f.dependencies, controller.signal)).rejects.toThrow();
    expect(f.state().durable).toBeUndefined();
    expect(f.dependencies.credential.clearAndProveAbsent).toHaveBeenCalledTimes(1);
  });

  it("makes failed cleanup the terminal hard error", async () => {
    const f = fixture();
    f.dependencies.credential.clearAndProveAbsent = vi.fn(async () => false);
    await expect(runCombinedSignedChatGptGolden(config, f.dependencies, new AbortController().signal))
      .rejects.toThrow("cleanup is unproven");
  });
});
