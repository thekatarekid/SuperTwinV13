#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderId } from "../providers/types.js";
import { ProviderGoldenRail, readGoldenManifest, resolveGoldenRepositoryIdentity, type GoldenDeclaration,
  type GoldenRepositoryIdentityReader } from "./provider-golden-rail.js";

function value(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

export function parseGoldenPreflight(argv: readonly string[]): GoldenDeclaration {
  const known = new Set(["--provider", "--executor-model", "--judge-model", "--eval-home"]);
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    if (!known.has(flag) || seen.has(flag) || argv[i + 1] === undefined) throw new Error("invalid provider golden preflight arguments");
    seen.add(flag);
  }
  const provider = value(argv, "--provider") as ProviderId | undefined;
  const executorModel = value(argv, "--executor-model");
  const judgeModel = value(argv, "--judge-model");
  const evalHome = value(argv, "--eval-home");
  if (!provider || !executorModel || !judgeModel || !evalHome) throw new Error("provider, executor model, judge model and eval home are required");
  if (provider === "chatgpt-oauth") throw new Error("ChatGPT golden requires the combined signed-app broker flow");
  return { provider, executorModel, judgeModel, evalHome };
}

export function goldenPreflight(argv: readonly string[], repoRoot = resolve(import.meta.dirname, "../../.."),
  repositoryIdentity?: GoldenRepositoryIdentityReader): string {
  const rail = new ProviderGoldenRail(readGoldenManifest(repoRoot), parseGoldenPreflight(argv));
  return JSON.stringify(rail.preflightDeclaration(resolveGoldenRepositoryIdentity(repoRoot, repositoryIdentity)), null, 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${goldenPreflight(process.argv.slice(2))}\n`); }
  catch (error) {
    process.stderr.write(`provider golden preflight refused: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
