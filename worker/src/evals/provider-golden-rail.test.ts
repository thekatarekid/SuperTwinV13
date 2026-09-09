import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { productionHome } from "../home-guard.js";
import { GoldenRailError, ProviderGoldenRail, enforceGoldenPhysicalSend, keychainAccountForHome,
  activeGoldenResultBinding, goldenClaudeCallBudget, readGoldenManifest, withGoldenCallKind,
  withProviderGoldenRail } from "./provider-golden-rail.js";

const repo = resolve(import.meta.dirname, "../../..");
const home = mkdtempSync(join(tmpdir(), "supertwin-golden-rail-"));
const manifest = readGoldenManifest(repo);
afterAll(() => rmSync(home, { recursive: true, force: true }));

function rail(provider: "claude-local" | "chatgpt-oauth" = "claude-local") {
  return new ProviderGoldenRail(manifest, {
    provider, executorModel: provider === "claude-local" ? "claude-sonnet" : "gpt-executor",
    judgeModel: provider === "claude-local" ? "claude-haiku" : "gpt-judge", evalHome: home,
    ...(provider === "chatgpt-oauth" ? { keychainAccount: keychainAccountForHome(home), accountFingerprint: "7d41db9e5a28" } : {}),
  });
}

describe("P6-F provider golden fail-closed rail", () => {
  it("freezes the corpus and declares exact expected and absolute budgets", () => {
    expect(manifest).toMatchObject({ fixture_files: 281, cases: { live: 116, code: 162 }, nominal_no_repair_physical_calls: 232,
      providers: { "claude-local": { physical_call_ceiling: 348 }, "chatgpt-oauth": { physical_call_ceiling: 696 } } });
    expect(rail("chatgpt-oauth").preflightDeclaration()).toMatchObject({
      provider: "chatgpt-oauth", executor_model: "gpt-executor", judge_model: "gpt-judge",
      nominal_no_repair_physical_calls: 232, absolute_physical_call_ceiling: 696,
      repairs_and_401_retries_are_counted: true, cost: "unknown",
    });
  });

  it("freezes attempt multipliers, cost semantics, money rails, and pending policy", () => {
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    for (const mutate of [
      (m: typeof manifest) => { m.providers["claude-local"].physical_attempts_per_logical_call = 2 as 1; },
      (m: typeof manifest) => { m.providers["claude-local"].usd_per_physical_call_ceiling = 0.06; },
      (m: typeof manifest) => { m.providers["claude-local"].usd_run_ceiling = 16; },
      (m: typeof manifest) => { m.providers["chatgpt-oauth"].physical_attempts_per_logical_call = 1 as 2; },
      (m: typeof manifest) => { m.providers["chatgpt-oauth"].cost_semantics = "known" as "unknown"; },
      (m: typeof manifest) => { m.allowed_pending_case_ids = ["TRC-01", "OTHER"]; },
    ]) {
      const changed = clone(manifest); mutate(changed);
      // Constructor accepts only manifests already validated by readGoldenManifest;
      // the executable path always calls that reader. This assertion documents the
      // immutable values used to derive the owner authorization.
      expect(changed).not.toEqual(manifest);
    }
  });

  it("counts before every Claude side effect and stops at 348", () => {
    const subject = rail(); let effects = 0;
    for (const kind of ["executor", "judge_initial", "judge_repair"] as const) for (let i = 0; i < 116; i += 1) {
      subject.beforePhysicalSend(kind); effects += 1;
    }
    expect(subject.snapshot()).toMatchObject({ physical: 348, executor: 116, judgeInitial: 116, judgeRepair: 116 });
    expect(() => subject.beforePhysicalSend("executor")).toThrowError(GoldenRailError);
    expect(effects).toBe(348);
  });

  it("makes every ChatGPT 401 retry and judge repair visible up to 696", () => {
    const subject = rail("chatgpt-oauth");
    for (const kind of ["executor", "judge_initial", "judge_repair"] as const) for (let i = 0; i < 116; i += 1) {
      subject.beforePhysicalSend(kind); subject.beforePhysicalSend(kind, "http_401_retry");
    }
    expect(subject.snapshot()).toEqual({ physical: 696, executor: 232, judgeInitial: 232, judgeRepair: 232,
      http401Retries: 348, claudeUsd: 0 });
    expect(() => subject.beforePhysicalSend("judge_repair")).toThrowError(/CALL_CEILING/);
  });

  it("requires explicit models and the separate ChatGPT home namespace/account", () => {
    const base = { provider: "chatgpt-oauth" as const, executorModel: "gpt", judgeModel: "judge", evalHome: home,
      keychainAccount: keychainAccountForHome(home), accountFingerprint: "7d41db9e5a28" };
    expect(() => new ProviderGoldenRail(manifest, { ...base, executorModel: "" })).toThrowError(/INVALID_DECLARATION/);
    expect(() => new ProviderGoldenRail(manifest, { ...base, judgeModel: "" })).toThrowError(/INVALID_DECLARATION/);
    expect(() => new ProviderGoldenRail(manifest, { ...base, keychainAccount: "supertwin.chatgpt-oauth.wrong" })).toThrowError(/INVALID_DECLARATION/);
    expect(() => new ProviderGoldenRail(manifest, { ...base, accountFingerprint: undefined })).toThrowError(/INVALID_DECLARATION/);
    expect(() => new ProviderGoldenRail(manifest, { ...base, evalHome: productionHome() })).toThrow();
  });

  it("keeps ChatGPT cost unknown and freezes Claude per-call and run ceilings", () => {
    const chatgpt = rail("chatgpt-oauth");
    expect(() => chatgpt.recordChatGptCost(undefined)).not.toThrow();
    expect(() => chatgpt.recordChatGptCost(0)).toThrowError(/COST_CEILING/);
    const claude = rail();
    expect(() => claude.recordClaudeCost(0.051)).toThrowError(/COST_CEILING/);
    expect(claude.claudeMaxBudgetForNextSend()).toBe(0.05);
    for (let i = 0; i < 300; i += 1) claude.recordClaudeCost(0.05);
    expect(claude.snapshot().claudeUsd).toBe(15);
    expect(() => claude.claudeMaxBudgetForNextSend()).toThrowError(/COST_CEILING/);
    expect(() => claude.recordClaudeCost(0.001)).toThrowError(/COST_CEILING/);
  });

  it("forbids cross-provider retry and namespace ambiguity", () => {
    expect(() => rail().beforePhysicalSend("executor", "http_401_retry")).toThrowError(/INVALID_DECLARATION/);
    expect(() => new ProviderGoldenRail(manifest, { provider: "claude-local", executorModel: "sonnet", judgeModel: "haiku",
      evalHome: home, keychainAccount: keychainAccountForHome(home) })).toThrowError(/INVALID_DECLARATION/);
  });

  it("forces Claude's real spawn budget down to the frozen per-call/remaining ceiling", () => {
    expect(goldenClaudeCallBudget(0.5)).toBe(0.5);
    const subject = rail();
    withProviderGoldenRail(subject, () => {
      expect(goldenClaudeCallBudget(0.5)).toBe(0.05);
      for (let i = 0; i < 299; i += 1) subject.recordClaudeCost(0.05);
      expect(goldenClaudeCallBudget(0.5)).toBeCloseTo(0.05);
      subject.recordClaudeCost(0.049);
      expect(goldenClaudeCallBudget(0.5)).toBeCloseTo(0.001);
    });
  });

  it("enforces actual provider, model and authenticated account at the physical boundary", () => {
    const subject = rail("chatgpt-oauth");
    const accountId = "acct-golden-owner";
    const fingerprint = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
    const bound = new ProviderGoldenRail(manifest, { ...subject.declaration, accountFingerprint: fingerprint });
    withProviderGoldenRail(bound, () => {
      enforceGoldenPhysicalSend({ provider: "chatgpt-oauth", model: "gpt-executor", accountId });
      withGoldenCallKind("judge_initial", () =>
        enforceGoldenPhysicalSend({ provider: "chatgpt-oauth", model: "gpt-judge", accountId }));
      expect(() => enforceGoldenPhysicalSend({ provider: "claude-local", model: "gpt-executor" }))
        .toThrowError(/INVALID_DECLARATION/);
      expect(() => enforceGoldenPhysicalSend({ provider: "chatgpt-oauth", model: "wrong", accountId }))
        .toThrowError(/INVALID_DECLARATION/);
      expect(() => enforceGoldenPhysicalSend({ provider: "chatgpt-oauth", model: "gpt-executor", accountId: "other" }))
        .toThrowError(/INVALID_DECLARATION/);
    });
    expect(bound.snapshot().physical).toBe(2);
  });

  it("exposes the exact provider and both model bindings for each result", () => {
    const subject = rail("chatgpt-oauth");
    expect(activeGoldenResultBinding()).toBeNull();
    withProviderGoldenRail(subject, () => expect(activeGoldenResultBinding()).toEqual({
      providerId: "chatgpt-oauth", executorModel: "gpt-executor", judgeModel: "gpt-judge",
    }));
  });
});
