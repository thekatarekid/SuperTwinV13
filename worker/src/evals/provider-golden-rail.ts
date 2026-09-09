import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { productionHome } from "../home-guard.js";
import type { ProviderId } from "../providers/types.js";

export type GoldenCallKind = "executor" | "judge_initial" | "judge_repair";
export type GoldenAttemptReason = "initial" | "http_401_retry";

export interface GoldenManifest {
  schema: 1;
  fixture_root: string;
  fixture_files: number;
  fixture_sha256: string;
  cases: { live: number; code: number };
  logical_calls: Record<GoldenCallKind, number>;
  nominal_no_repair_physical_calls: number;
  allowed_pending_case_ids: readonly string[];
  providers: {
    "claude-local": {
      physical_call_ceiling: number;
      physical_attempts_per_logical_call: 1;
      usd_per_physical_call_ceiling: number;
      usd_run_ceiling: number;
    };
    "chatgpt-oauth": {
      physical_call_ceiling: number;
      physical_attempts_per_logical_call: 2;
      cost_semantics: "unknown";
    };
  };
}

export interface GoldenDeclaration {
  provider: ProviderId;
  executorModel: string;
  judgeModel: string;
  evalHome: string;
  keychainAccount?: string;
  accountFingerprint?: string;
}

export interface GoldenCounters {
  physical: number;
  executor: number;
  judgeInitial: number;
  judgeRepair: number;
  http401Retries: number;
  claudeUsd: number;
}

interface GoldenScope { rail: ProviderGoldenRail; kind: GoldenCallKind }
const goldenScope = new AsyncLocalStorage<GoldenScope>();

export class GoldenRailError extends Error {
  constructor(readonly code: "INVALID_MANIFEST" | "INVALID_DECLARATION" | "CALL_CEILING" | "COST_CEILING") {
    super(`provider golden rail stopped (${code})`);
    this.name = "GoldenRailError";
  }
}

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_ACCOUNT = /^[a-f0-9]{12}$/;

function fail(code: GoldenRailError["code"]): never { throw new GoldenRailError(code); }

export function keychainAccountForHome(home: string): string {
  const canonical = realpathSync(resolve(home));
  const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
  return `supertwin.chatgpt-oauth.${fingerprint}`;
}

export function fixtureDigest(root: string): { files: number; sha256: string } {
  const canonical = realpathSync(root);
  const files: string[] = [];
  const pending = [canonical];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail("INVALID_MANIFEST");
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile() && basename(path).endsWith(".json")) files.push(path);
    }
  }
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(canonical, file).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return { files: files.length, sha256: hash.digest("hex") };
}

export function readGoldenManifest(repoRoot: string): GoldenManifest {
  let manifest: GoldenManifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, "evals/provider-golden-v1.json"), "utf8")) as GoldenManifest;
  } catch { return fail("INVALID_MANIFEST"); }
  if (manifest.fixture_root !== "evals/v13") fail("INVALID_MANIFEST");
  const digest = fixtureDigest(join(repoRoot, manifest.fixture_root));
  if (manifest.schema !== 1 || digest.files !== manifest.fixture_files || digest.sha256 !== manifest.fixture_sha256 ||
      manifest.cases.live !== 116 || manifest.cases.code !== 162 ||
      manifest.logical_calls.executor !== 116 || manifest.logical_calls.judge_initial !== 116 ||
      manifest.logical_calls.judge_repair !== 116 || manifest.nominal_no_repair_physical_calls !== 232 ||
      JSON.stringify(manifest.allowed_pending_case_ids) !== JSON.stringify(["TRC-01", "TRC-03"]) ||
      manifest.providers["claude-local"].physical_call_ceiling !== 348 ||
      manifest.providers["claude-local"].physical_attempts_per_logical_call !== 1 ||
      manifest.providers["claude-local"].usd_per_physical_call_ceiling !== 0.05 ||
      manifest.providers["claude-local"].usd_run_ceiling !== 15 ||
      manifest.providers["chatgpt-oauth"].physical_call_ceiling !== 696 ||
      manifest.providers["chatgpt-oauth"].physical_attempts_per_logical_call !== 2 ||
      manifest.providers["chatgpt-oauth"].cost_semantics !== "unknown") fail("INVALID_MANIFEST");
  return manifest;
}

export function validateGoldenDeclaration(declaration: GoldenDeclaration): GoldenDeclaration {
  if (!SAFE_MODEL.test(declaration.executorModel) || !SAFE_MODEL.test(declaration.judgeModel)) {
    fail("INVALID_DECLARATION");
  }
  const evalHome = realpathSync(resolve(declaration.evalHome));
  if (evalHome === realpathSync(productionHome())) fail("INVALID_DECLARATION");
  if (declaration.provider === "chatgpt-oauth") {
    if (!declaration.accountFingerprint || !SAFE_ACCOUNT.test(declaration.accountFingerprint) ||
        declaration.keychainAccount !== keychainAccountForHome(evalHome)) fail("INVALID_DECLARATION");
  } else if (declaration.provider === "claude-local") {
    if (declaration.accountFingerprint !== undefined || declaration.keychainAccount !== undefined) {
      fail("INVALID_DECLARATION");
    }
  } else fail("INVALID_DECLARATION");
  return { ...declaration, evalHome };
}

export class ProviderGoldenRail {
  readonly declaration: GoldenDeclaration;
  readonly manifest: GoldenManifest;
  #counts: GoldenCounters = { physical: 0, executor: 0, judgeInitial: 0, judgeRepair: 0, http401Retries: 0, claudeUsd: 0 };

  constructor(manifest: GoldenManifest, declaration: GoldenDeclaration) {
    this.manifest = manifest;
    this.declaration = validateGoldenDeclaration(declaration);
  }

  beforePhysicalSend(kind: GoldenCallKind, reason: GoldenAttemptReason = "initial", actual?: {
    provider: ProviderId; model: string; accountId?: string; maxBudgetUsd?: number;
  }): GoldenCounters {
    if (actual) {
      const expectedModel = kind === "executor" ? this.declaration.executorModel : this.declaration.judgeModel;
      if (actual.provider !== this.declaration.provider || actual.model !== expectedModel) fail("INVALID_DECLARATION");
      if (actual.provider === "chatgpt-oauth") {
        if (!actual.accountId || createHash("sha256").update(actual.accountId).digest("hex").slice(0, 12) !==
            this.declaration.accountFingerprint) fail("INVALID_DECLARATION");
      } else if (actual.maxBudgetUsd === undefined || actual.maxBudgetUsd > this.claudeMaxBudgetForNextSend()) {
        fail("COST_CEILING");
      }
    }
    const provider = this.manifest.providers[this.declaration.provider];
    const logicalKey = kind === "judge_initial" ? "judgeInitial" : kind === "judge_repair" ? "judgeRepair" : "executor";
    if (reason === "http_401_retry" && this.declaration.provider !== "chatgpt-oauth") fail("INVALID_DECLARATION");
    if (this.#counts[logicalKey] >= this.manifest.logical_calls[kind] * provider.physical_attempts_per_logical_call ||
        this.#counts.physical >= provider.physical_call_ceiling) fail("CALL_CEILING");
    this.#counts.physical += 1;
    this.#counts[logicalKey] += 1;
    if (reason === "http_401_retry") this.#counts.http401Retries += 1;
    return this.snapshot();
  }

  recordClaudeCost(usd: number): GoldenCounters {
    if (this.declaration.provider !== "claude-local" || !Number.isFinite(usd) || usd < 0) fail("COST_CEILING");
    const limits = this.manifest.providers["claude-local"];
    const nextMicros = Math.round(usd * 1_000_000);
    const usedMicros = Math.round(this.#counts.claudeUsd * 1_000_000);
    if (nextMicros > Math.round(limits.usd_per_physical_call_ceiling * 1_000_000) ||
        usedMicros + nextMicros > Math.round(limits.usd_run_ceiling * 1_000_000)) {
      fail("COST_CEILING");
    }
    this.#counts.claudeUsd = (usedMicros + nextMicros) / 1_000_000;
    return this.snapshot();
  }

  claudeMaxBudgetForNextSend(): number {
    if (this.declaration.provider !== "claude-local") fail("COST_CEILING");
    const limits = this.manifest.providers["claude-local"];
    const remaining = limits.usd_run_ceiling - this.#counts.claudeUsd;
    if (remaining <= 0) fail("COST_CEILING");
    return Math.min(limits.usd_per_physical_call_ceiling, remaining);
  }

  recordChatGptCost(value: unknown): void {
    if (this.declaration.provider !== "chatgpt-oauth" || value !== undefined) fail("COST_CEILING");
  }

  snapshot(): GoldenCounters { return { ...this.#counts }; }

  preflightDeclaration(): Record<string, unknown> {
    const provider = this.manifest.providers[this.declaration.provider];
    const claudeCost = this.manifest.providers["claude-local"];
    const declaration = {
      mode: "P6-F provider golden",
      provider: this.declaration.provider,
      executor_model: this.declaration.executorModel,
      judge_model: this.declaration.judgeModel,
      fixture_sha256: this.manifest.fixture_sha256,
      cases: this.manifest.cases,
      nominal_no_repair_physical_calls: this.manifest.nominal_no_repair_physical_calls,
      absolute_physical_call_ceiling: provider.physical_call_ceiling,
      repairs_and_401_retries_are_counted: true,
      cost: this.declaration.provider === "chatgpt-oauth" ? "unknown" : {
        per_call_usd_ceiling: claudeCost.usd_per_physical_call_ceiling,
        run_usd_ceiling: claudeCost.usd_run_ceiling,
      },
      eval_home: this.declaration.evalHome,
      ...(this.declaration.accountFingerprint ? { account_fingerprint: this.declaration.accountFingerprint } : {}),
    };
    return { ...declaration, authorization_id: createHash("sha256").update(JSON.stringify(declaration)).digest("hex") };
  }
}

export function withProviderGoldenRail<T>(rail: ProviderGoldenRail, operation: () => T): T {
  return goldenScope.run({ rail, kind: "executor" }, operation);
}

export function withGoldenCallKind<T>(kind: GoldenCallKind, operation: () => T): T {
  const active = goldenScope.getStore();
  return active ? goldenScope.run({ rail: active.rail, kind }, operation) : operation();
}

export function activeGoldenResultBinding(): { providerId: ProviderId; executorModel: string; judgeModel: string } | null {
  const active = goldenScope.getStore();
  return active ? {
    providerId: active.rail.declaration.provider,
    executorModel: active.rail.declaration.executorModel,
    judgeModel: active.rail.declaration.judgeModel,
  } : null;
}

export function enforceGoldenPhysicalSend(actual: {
  provider: ProviderId; model: string; reason?: GoldenAttemptReason; accountId?: string; maxBudgetUsd?: number;
}): void {
  const active = goldenScope.getStore();
  if (!active) return;
  active.rail.beforePhysicalSend(active.kind, actual.reason ?? "initial", actual);
}

export function recordGoldenProviderCost(provider: ProviderId, costUsd: number | undefined): void {
  const active = goldenScope.getStore();
  if (!active) return;
  if (provider === "chatgpt-oauth") active.rail.recordChatGptCost(costUsd);
  else active.rail.recordClaudeCost(costUsd ?? Number.NaN);
}

export function goldenClaudeCallBudget(ordinary: number): number {
  const active = goldenScope.getStore();
  return active?.rail.declaration.provider === "claude-local"
    ? Math.min(ordinary, active.rail.claudeMaxBudgetForNextSend())
    : ordinary;
}
