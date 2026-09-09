#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { PROVIDER_SETTING_KEYS, setActiveProvider, setProviderModelSelection } from "../db/settings.js";
import { bootstrapBuiltInProviders } from "../providers/bootstrap.js";
import { BrowserOAuthManager, createBrowserOAuthTokenSession } from "../providers/chatgpt-oauth/auth.js";
import { ChatGptKeychainStore, createChatGptOAuthRefresher, ChatGptTokenSession } from "../providers/chatgpt-oauth/keychain.js";
import { requestSignedGoldenOwnerApproval, runStdioKeychainBrokerCommand,
  stdioKeychainBrokerDisconnectSignal } from "../providers/chatgpt-oauth/keychain-broker.js";
import { initializeProductionChatGptRuntime } from "../providers/chatgpt-oauth/runtime.js";
import { main as evalMain } from "./cli.js";
import { runCombinedSignedChatGptGolden, type SignedGoldenConfig } from "./provider-golden-combined.js";
import { ProviderGoldenRail, fixtureDigest, keychainAccountForHome, withProviderGoldenRail,
  type GoldenManifest } from "./provider-golden-rail.js";

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_FP = /^[a-f0-9]{12}$/;
const SAFE_HASH = /^[a-f0-9]{64}$/;
const RESULT_PREFIX = "SUPERTWIN_SIGNED_GOLDEN_RESULT_V1 ";

function parse(argv: readonly string[]): SignedGoldenConfig & { evalHome: string; fixtureRoot: string } {
  const names = ["--signed-chatgpt-golden", "--eval-home", "--account-fingerprint", "--executor-model",
    "--judge-model", "--bundle-sha256", "--eval-home-dev", "--eval-home-ino"];
  if (argv.length !== 15 || argv[0] !== names[0]) throw new Error("signed ChatGPT golden arguments are invalid");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    if (!names.includes(argv[index]!) || values.has(argv[index]!)) throw new Error("signed ChatGPT golden arguments are invalid");
    values.set(argv[index]!, argv[index + 1]!);
  }
  const evalHome = resolve(values.get("--eval-home") ?? "");
  const expectedAccountFingerprint = values.get("--account-fingerprint") ?? "";
  const executorModel = values.get("--executor-model") ?? "";
  const judgeModel = values.get("--judge-model") ?? "";
  const bundleSha256 = values.get("--bundle-sha256") ?? "";
  const dev = Number(values.get("--eval-home-dev")); const ino = Number(values.get("--eval-home-ino"));
  if (!evalHome.startsWith("/") || !SAFE_FP.test(expectedAccountFingerprint) || !SAFE_MODEL.test(executorModel) ||
      !SAFE_MODEL.test(judgeModel) || !SAFE_HASH.test(bundleSha256) || !Number.isSafeInteger(dev) ||
      !Number.isSafeInteger(ino)) throw new Error("signed ChatGPT golden arguments are invalid");
  const bundleRoot = resolve(process.cwd());
  const manifest = JSON.parse(readFileSync(join(bundleRoot, "evals/provider-golden-v1.json"), "utf8")) as GoldenManifest;
  const fixtureRoot = join(bundleRoot, "evals/v13");
  const baseline = fixtureDigest(join(bundleRoot, "evals/baseline"));
  const gateSourceSha256 = createHash("sha256").update(readFileSync(join(bundleRoot, "source/scheduler/v6/gate.ts"))).digest("hex");
  const actualFixture = fixtureDigest(fixtureRoot);
  if (manifest.schema !== 1 || manifest.fixture_files !== actualFixture.files ||
      manifest.fixture_sha256 !== actualFixture.sha256 || !SAFE_HASH.test(manifest.code_identity.sha256) ||
      manifest.baseline_files !== baseline.files || manifest.baseline_sha256 !== baseline.sha256 ||
      manifest.gate_source_sha256 !== gateSourceSha256 ||
      manifest.providers["chatgpt-oauth"].physical_call_ceiling !== 696) {
    throw new Error("signed ChatGPT golden bundle manifest is invalid");
  }
  return { appVersion: "13.12.2", executorModel, judgeModel, expectedAccountFingerprint,
    evalHomeIdentity: { dev, ino, mode: "0700" }, fixtureSha256: manifest.fixture_sha256,
    baselineSha256: baseline.sha256,
    gateSourceSha256,
    codeIdentitySha256: manifest.code_identity.sha256, bundleSha256, evalHome, fixtureRoot };
}

function assertHome(config: ReturnType<typeof parse>): void {
  const stat = lstatSync(config.evalHome);
  if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.dev) !== config.evalHomeIdentity.dev ||
      Number(stat.ino) !== config.evalHomeIdentity.ino || (stat.mode & 0o777) !== 0o700) {
    throw new Error("signed ChatGPT golden eval home identity changed");
  }
}

function assertBundle(config: ReturnType<typeof parse>): void {
  const entry = resolve(process.argv[1] ?? "");
  const digest = createHash("sha256").update(readFileSync(entry)).digest("hex");
  const fixture = fixtureDigest(config.fixtureRoot);
  const baseline = fixtureDigest(join(process.cwd(), "evals/baseline"));
  const gateSourceSha256 = createHash("sha256").update(readFileSync(join(process.cwd(), "source/scheduler/v6/gate.ts"))).digest("hex");
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "evals/provider-golden-v1.json"), "utf8")) as GoldenManifest;
  if (digest !== config.bundleSha256 || fixture.sha256 !== config.fixtureSha256 ||
      fixture.files !== manifest.fixture_files || manifest.fixture_sha256 !== config.fixtureSha256 ||
      baseline.files !== manifest.baseline_files || baseline.sha256 !== config.baselineSha256 ||
      manifest.baseline_sha256 !== config.baselineSha256 ||
      gateSourceSha256 !== config.gateSourceSha256 || manifest.gate_source_sha256 !== config.gateSourceSha256 ||
      manifest.code_identity.sha256 !== config.codeIdentitySha256) {
    throw new Error("signed ChatGPT golden bundle identity changed");
  }
}

async function openBrowser(url: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn("/usr/bin/open", [url], { shell: false, stdio: "ignore" });
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => { signal.removeEventListener("abort", abort); rejectOpen(new Error("browser open failed")); });
    child.once("close", (code) => { signal.removeEventListener("abort", abort);
      code === 0 ? resolveOpen() : rejectOpen(new Error("browser open failed")); });
  });
}

export async function runSignedGoldenCli(argv = process.argv.slice(2), env = process.env): Promise<number> {
  if (env.SUPERTWIN_SIGNED_GOLDEN_BROKER !== "1") throw new Error("signed ChatGPT golden requires the app broker");
  const config = parse(argv);
  const store = new ChatGptKeychainStore({ resolveHome: () => config.evalHome });
  const controller = new AbortController();
  const parentPipe = stdioKeychainBrokerDisconnectSignal();
  const parentGone = () => { controller.abort(); process.exit(2); };
  parentPipe.addEventListener("abort", parentGone, { once: true });
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const priorHome = process.env.SUPERTWIN_HOME; const priorDb = process.env.SUPERTWIN_DB_PATH;
  try {
    const result = await runCombinedSignedChatGptGolden(config, {
      approve: requestSignedGoldenOwnerApproval,
      oauthLogin: async (persist, signal) => {
        let navigation = 0; let token = 0;
        const manager = new BrowserOAuthManager({ browserOwner: "manager", tokenSession: createBrowserOAuthTokenSession(),
          credentialStore: { save: persist }, openBrowser: async (url, inner) => {
            if (++navigation !== 1) throw new Error("OAuth browser budget exceeded");
            await openBrowser(url, inner);
          }, fetch: (async (input, init) => {
            if (String(input) !== "https://auth.openai.com/oauth/token" || init?.method !== "POST" || ++token !== 1) {
              throw new Error("OAuth token budget exceeded");
            }
            return fetch(input, init);
          }) as typeof fetch });
        const onAbort = () => { void manager.shutdown(); };
        signal.addEventListener("abort", onAbort, { once: true });
        try { const started = await manager.start(); await manager.wait(started.loginId);
          return { navigation: 1, callback: 1, token: 1, retries: 0 } as const; }
        finally { signal.removeEventListener("abort", onAbort); await manager.shutdown(); }
      },
      credential: {
        async create(pair, signal) { await store.save(pair, signal); return (await runStdioKeychainBrokerCommand("binding", undefined, signal)).stdout; },
        async binding(signal) { return (await runStdioKeychainBrokerCommand("binding", undefined, signal)).stdout; },
        async load() { const value = await store.load(); if (!value) throw new Error("signed golden credential missing"); return value; },
        async clearAndProveAbsent() { try { await store.clear(); } catch { return false; } return store.isEmpty(); },
      },
      assertHomeIdentity: () => assertHome(config), assertSourceIdentity: () => assertBundle(config),
      execute: async ({ executorModel, judgeModel, accountFingerprint, brokerBinding, credential }) => {
        const manifest = JSON.parse(readFileSync(join(process.cwd(), "evals/provider-golden-v1.json"), "utf8")) as GoldenManifest;
        const rail = new ProviderGoldenRail(manifest, { provider: "chatgpt-oauth", executorModel, judgeModel,
          evalHome: config.evalHome, keychainAccount: keychainAccountForHome(config.evalHome), accountFingerprint,
          keychainBrokerBinding: brokerBinding });
        process.env.SUPERTWIN_HOME = config.evalHome; process.env.SUPERTWIN_DB_PATH = resolve(config.evalHome, "supertwinv13.db");
        return withProviderGoldenRail(rail, async () => {
          let runtime: Awaited<ReturnType<typeof initializeProductionChatGptRuntime>> | undefined;
          try {
            runMigrations(); bootstrapBuiltInProviders(); setActiveProvider("chatgpt-oauth");
            for (const key of PROVIDER_SETTING_KEYS) setProviderModelSelection("chatgpt-oauth", key,
              key === "classify" ? judgeModel : executorModel);
            const session = await ChatGptTokenSession.open(store, createChatGptOAuthRefresher({ fetch,
              userAgent: `SuperTwinV13/${config.appVersion}` }));
            if (session.current().accountId !== credential.accountId) throw new Error("signed golden session changed");
            runtime = await initializeProductionChatGptRuntime({ appVersion: config.appVersion, enabled: () => true,
              activeProvider: () => "claude-local", suppressCompatibilityCanary: true, store, session });
            const code = await evalMain(["--dir", config.fixtureRoot, "--judge", "haiku", "--strict", "--allow-pending",
              "TRC-01,TRC-03", "--compare-baseline", "--ast-parity"]);
            return { code, counters: rail.snapshot() };
          } finally { await runtime?.shutdown(); closeDb(); }
        });
      },
    }, controller.signal);
    const evidence = { code: result.code, provider: "chatgpt-oauth", executor_model: config.executorModel,
      judge_model: config.judgeModel, run_authorization_id: result.runAuthorizationId,
      bundle_sha256: config.bundleSha256, fixture_sha256: config.fixtureSha256,
      baseline_sha256: config.baselineSha256, code_identity_sha256: config.codeIdentitySha256,
      oauth_actuals: result.oauthActuals, counters: result.counters, cleanup_proven: result.cleanupProven };
    process.stdout.write(`${RESULT_PREFIX}${Buffer.from(JSON.stringify(evidence), "utf8").toString("base64url")}\n`);
    return result.code;
  } finally {
    parentPipe.removeEventListener("abort", parentGone);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    if (priorHome === undefined) delete process.env.SUPERTWIN_HOME; else process.env.SUPERTWIN_HOME = priorHome;
    if (priorDb === undefined) delete process.env.SUPERTWIN_DB_PATH; else process.env.SUPERTWIN_DB_PATH = priorDb;
  }
}

runSignedGoldenCli().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`signed ChatGPT golden refused: ${(error as Error).message}\n`); process.exitCode = 2;
});
