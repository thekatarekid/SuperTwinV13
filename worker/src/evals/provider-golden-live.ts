#!/usr/bin/env node
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "../db/index.js";
import { closeDb } from "../db/connection.js";
import { PROVIDER_SETTING_KEYS, setActiveProvider, setProviderModelSelection } from "../db/settings.js";
import { bootstrapBuiltInProviders } from "../providers/bootstrap.js";
import { main as evalMain } from "./cli.js";
import { parseGoldenPreflight } from "./provider-golden-cli.js";
import { ProviderGoldenRail, readGoldenManifest, resolveGoldenRepositoryIdentity, withProviderGoldenRail,
  type GoldenRepositoryIdentityReader } from "./provider-golden-rail.js";

export const GOLDEN_LIVE_OPT_IN = "SUPERTWIN_RUN_PROVIDER_GOLDEN";

interface GoldenLiveDependencies {
  runEval: typeof evalMain;
  output(line: string): void;
  repositoryIdentity?: GoldenRepositoryIdentityReader;
}

const DEFAULT_DEPENDENCIES: GoldenLiveDependencies = {
  runEval: evalMain,
  output: (line) => process.stdout.write(line),
};

function assertFreshSafeHome(path: string): string {
  const requested = resolve(path);
  if (lstatSync(requested).isSymbolicLink()) {
    throw new Error("provider golden eval home must be a fresh empty 0700 directory");
  }
  const home = realpathSync(requested);
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || readdirSync(home).length !== 0) {
    throw new Error("provider golden eval home must be a fresh empty 0700 directory");
  }
  return home;
}

export async function executeProviderGolden(
  argv: readonly string[], env = process.env, dependencies: GoldenLiveDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const executeAt = argv.indexOf("--execute");
  const authorizationAt = argv.indexOf("--authorization-id");
  const control = new Set<number>();
  if (executeAt >= 0) { control.add(executeAt); control.add(executeAt + 1); }
  if (authorizationAt >= 0) { control.add(authorizationAt); control.add(authorizationAt + 1); }
  const declarationArgs = argv.filter((_value, index) => !control.has(index));
  const declaration = parseGoldenPreflight(declarationArgs);
  if (declaration.provider === "chatgpt-oauth") {
    throw new Error("ChatGPT golden requires the combined signed-app broker flow");
  }
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const manifest = readGoldenManifest(repoRoot);
  const rail = new ProviderGoldenRail(manifest, declaration);
  const repositoryIdentity = resolveGoldenRepositoryIdentity(repoRoot, dependencies.repositoryIdentity);
  const preflight = rail.preflightDeclaration(repositoryIdentity);
  dependencies.output(`${JSON.stringify(preflight, null, 2)}\n`);
  if (executeAt === -1) return 0;
  if (argv[executeAt + 1] !== "yes" || env[GOLDEN_LIVE_OPT_IN] !== "1" ||
      authorizationAt === -1 || argv[authorizationAt + 1] !== preflight.authorization_id) {
    throw new Error("provider golden execution lacks exact owner authorization");
  }
  if (env.EVAL_FIXTURES !== undefined) throw new Error("provider golden refuses EVAL_FIXTURES overrides");
  const home = assertFreshSafeHome(declaration.evalHome);
  const priorHome = process.env.SUPERTWIN_HOME;
  const priorDb = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_HOME = home;
  process.env.SUPERTWIN_DB_PATH = resolve(home, "supertwinv13.db");
  try {
    return await withProviderGoldenRail(rail, async () => {
      try {
        const executionIdentity = resolveGoldenRepositoryIdentity(repoRoot, dependencies.repositoryIdentity);
        if (JSON.stringify(executionIdentity) !== JSON.stringify(repositoryIdentity)) {
          throw new Error("provider golden repository identity changed after authorization");
        }
        // Keep this last: a repository-status subprocess is an attacker-controlled
        // scheduling window. Rebind the home immediately before the first write.
        rail.assertEvalHomeUnchanged();
        runMigrations();
        bootstrapBuiltInProviders();
        setActiveProvider(declaration.provider);
        for (const key of PROVIDER_SETTING_KEYS) setProviderModelSelection(declaration.provider, key,
          key === "classify" ? declaration.judgeModel : declaration.executorModel);
        return await dependencies.runEval(["--dir", resolve(repoRoot, manifest.fixture_root), "--judge", "haiku",
          "--strict", "--allow-pending", manifest.allowed_pending_case_ids.join(","),
          "--compare-baseline", "--ast-parity"]);
      } finally {
        dependencies.output(`${JSON.stringify({ provider_golden_actuals: rail.snapshot() })}\n`);
      }
    });
  } finally {
    closeDb();
    if (priorHome === undefined) delete process.env.SUPERTWIN_HOME; else process.env.SUPERTWIN_HOME = priorHome;
    if (priorDb === undefined) delete process.env.SUPERTWIN_DB_PATH; else process.env.SUPERTWIN_DB_PATH = priorDb;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  executeProviderGolden(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`provider golden refused: ${(error as Error).message}\n`); process.exitCode = 2;
  });
}
