import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { dryRunSnapshot } from "./requests.js";
import { redactedJson } from "./redact.js";
import { accountFingerprint, accountIdFromAccessToken } from "./account.js";
import { runDeviceCodeFlow, type DeviceCode } from "./device-flow.js";
import {
  formatHttpAccounting,
  LIVE_AUTH_HTTP_LIMITS,
  ProbeHttpAccounting,
  type ProbeHttpCounts,
} from "./accounting.js";
import { runContractProbeScaffold } from "./contract-runner.js";
import { runDiscoveryProbe } from "./discovery-runner.js";
import { runCanaryProbe } from "./canary-runner.js";
import { EphemeralProbeTokenSession } from "./refresh.js";
import { enforceScratchHomeInvariant } from "./scratch.js";
import {
  assertLiveBrowserAuthSmokePreflight,
  assertLiveContractProbePreflight,
  assertLiveCanaryProbePreflight,
  assertLiveDiscoveryProbePreflight,
  assertLiveProbeOptIn,
  formatBrowserAuthSmokeDeclaration,
  formatLiveDeclaration,
} from "./safety.js";
import { prepareLiveInferenceAuthorization } from "./live-authorization.js";
import {
  appendInferenceAuthorizationPlanSuccessorFromEnvironment,
  initializeInferenceAuthorizationFromEnvironment,
} from "./authorization-ledger-init.js";
import { requestedProbeModelId } from "./models.js";
import {
  runBrowserAuthSmoke,
  type BrowserAuthSmokeHooks,
} from "./browser-auth-smoke.js";
import {
  formatBrowserSmokeNetworkActuals,
  ZERO_BROWSER_SMOKE_NETWORK_COUNTS,
  type BrowserSmokeNetworkCounts,
} from "./browser-smoke-budget.js";
import {
  createBrowserSmokeRuntimeHooks,
  type BrowserSmokeRuntimeOptions,
} from "./browser-smoke-runtime.js";

export interface ProbeCliDependencies {
  runAuthFlow?: typeof runDeviceCodeFlow;
  runCanaryProbe?: typeof runCanaryProbe;
  runContractProbe?: typeof runContractProbeScaffold;
  runDiscoveryProbe?: typeof runDiscoveryProbe;
  initializeAuthorizationLedger?: typeof initializeInferenceAuthorizationFromEnvironment;
  appendAuthorizationPlanSuccessor?: typeof appendInferenceAuthorizationPlanSuccessorFromEnvironment;
  createBrowserSmokeHooks?: (
    options: BrowserSmokeRuntimeOptions,
  ) => Promise<BrowserAuthSmokeHooks>;
  runBrowserAuthSmoke?: typeof runBrowserAuthSmoke;
}

const ZERO_HTTP_COUNTS: Readonly<ProbeHttpCounts> = Object.freeze({
  deviceCode: 0,
  devicePoll: 0,
  token: 0,
  models: 0,
  quota: 0,
  inference: 0,
  other: 0,
  total: 0,
});

export async function runProbeCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ProbeCliDependencies = {},
): Promise<number> {
  env = { ...env };
  const liveAuth = args.includes("--live-auth");
  const liveContract = args.includes("--live-contract");
  const liveDiscover = args.includes("--live-discover");
  const liveCanary = args.includes("--live-canary");
  const liveBrowserAuthSmoke = args.includes("--live-browser-auth-smoke");
  const appendAuthorizationPlanSuccessor = args.includes("--append-authorization-plan-successor");
  const initializeAuthorizationLedger = args.includes("--initialize-authorization-ledger");
  if (appendAuthorizationPlanSuccessor) {
    if (args.length !== 1 || args[0] !== "--append-authorization-plan-successor") {
      throw new Error("REFUSED: --append-authorization-plan-successor must be the only CLI argument");
    }
    const evidence = await (
      dependencies.appendAuthorizationPlanSuccessor ??
      appendInferenceAuthorizationPlanSuccessorFromEnvironment
    )(env);
    process.stdout.write(`${redactedJson(evidence)}\n`);
    return 0;
  }
  if (initializeAuthorizationLedger) {
    if (args.length !== 1 || args[0] !== "--initialize-authorization-ledger") {
      throw new Error("REFUSED: --initialize-authorization-ledger must be the only CLI argument");
    }
    const evidence = await (
      dependencies.initializeAuthorizationLedger ?? initializeInferenceAuthorizationFromEnvironment
    )(env);
    process.stdout.write(`${redactedJson(evidence)}\n`);
    return 0;
  }
  const emitAuthorizationPlan = args.includes("--emit-authorization-plan");
  if (emitAuthorizationPlan && (
    args.length !== 3 || new Set(args).size !== 3 ||
    !liveAuth || !liveDiscover || liveCanary || liveContract
  )) {
    throw new Error(
      "REFUSED: --emit-authorization-plan requires exactly the live discovery mode",
    );
  }
  if (liveBrowserAuthSmoke) {
    // The bounded declaration is always emitted before opt-in checks, crypto,
    // listener creation, browser navigation, or fetch.
    process.stderr.write(`${formatBrowserAuthSmokeDeclaration()}\n`);
    if (args.length !== 1 || args[0] !== "--live-browser-auth-smoke") {
      throw new Error(
        "REFUSED: --live-browser-auth-smoke must be the only CLI argument",
      );
    }
    return runLiveBrowserAuthSmokeProbe(env, dependencies);
  }
  if (!liveAuth && !liveContract && !liveDiscover && !liveCanary) {
    process.stdout.write(`${redactedJson(dryRunSnapshot(env))}\n`);
    return 0;
  }

  // This declaration must precede the opt-in checks and every possible network operation.
  process.stderr.write(`${formatLiveDeclaration(
    liveContract ? "contract" : liveCanary ? "canary" : liveDiscover ? "discover" : "auth",
  )}\n`);
  if ([liveContract, liveDiscover, liveCanary].filter(Boolean).length > 1) {
    throw new Error("REFUSED: --live-contract, --live-canary, and --live-discover are mutually exclusive");
  }
  if (liveContract && !liveAuth) {
    throw new Error("REFUSED: --live-contract additionally requires --live-auth");
  }
  if (liveContract) return runLiveContractProbe(env, dependencies);
  if (liveCanary && !liveAuth) {
    throw new Error("REFUSED: --live-canary additionally requires --live-auth");
  }
  if (liveCanary) return runLiveCanaryProbe(env, dependencies);
  if (liveDiscover && !liveAuth) {
    throw new Error("REFUSED: --live-discover additionally requires --live-auth");
  }
  if (liveDiscover) {
    if (emitAuthorizationPlan) requestedProbeModelId(env);
    return runLiveDiscoveryProbe(env, dependencies, emitAuthorizationPlan);
  }
  const accounting = new ProbeHttpAccounting(LIVE_AUTH_HTTP_LIMITS);
  const abortController = new AbortController();
  let session: EphemeralProbeTokenSession | undefined;
  let accountingPrinted = false;
  const printAccounting = (): void => {
    if (accountingPrinted) return;
    accountingPrinted = true;
    process.stderr.write(`${formatHttpAccounting(accounting.snapshot())}\n`);
  };
  const onSigint = (): void => {
    abortController.abort(new Error("Phase 0b probe cancelled by SIGINT"));
    printAccounting();
  };
  process.once("SIGINT", onSigint);
  const hooks = {
    fetch: accounting.wrap(fetch, abortController.signal),
    sleep: (milliseconds: number, signal?: AbortSignal) => sleep(milliseconds, undefined, { signal }),
    now: Date.now,
    env,
    signal: abortController.signal,
    onUserCode: ({ userCode, verificationUrl }: DeviceCode) => {
      process.stderr.write(`Open ${verificationUrl} and enter code ${userCode}. Waiting up to 15 minutes.\n`);
    },
  };
  try {
    const evidence = await enforceScratchHomeInvariant(env, async () => {
      assertLiveProbeOptIn(env);
      try {
        const tokens = await (dependencies.runAuthFlow ?? runDeviceCodeFlow)(hooks);
        session = new EphemeralProbeTokenSession(tokens);
        const fingerprint = accountFingerprint(accountIdFromAccessToken(tokens.accessToken));
        return {
          status: "authenticated-ephemeral",
          scratchHomeProof: "no-residual-artifacts",
          account_fingerprint: fingerprint,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
        };
      } finally {
        abortController.abort(new Error("Phase 0b auth-only probe finished"));
        session?.logout();
      }
    });
    process.stdout.write(
      `${redactedJson(evidence)}\n`,
    );
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    printAccounting();
  }
}

async function runLiveBrowserAuthSmokeProbe(
  env: NodeJS.ProcessEnv,
  dependencies: ProbeCliDependencies,
): Promise<number> {
  const abortController = new AbortController();
  let networkActuals: BrowserSmokeNetworkCounts = {
    ...ZERO_BROWSER_SMOKE_NETWORK_COUNTS,
  };
  const onSigint = (): void => {
    abortController.abort(new Error("Phase 0b browser-auth smoke cancelled by SIGINT"));
  };
  process.once("SIGINT", onSigint);
  try {
    // This preflight must finish before constructing the real runtime hooks.
    assertLiveBrowserAuthSmokePreflight(env);
    const onNetworkActuals = (counts: BrowserSmokeNetworkCounts): void => {
      networkActuals = { ...counts };
    };
    const createHooks =
      dependencies.createBrowserSmokeHooks ?? createBrowserSmokeRuntimeHooks;
    const createdHooks = await createHooks({
      env,
      signal: abortController.signal,
      onNetworkActuals,
    });
    const evidence = await (
      dependencies.runBrowserAuthSmoke ?? runBrowserAuthSmoke
    )({
      ...createdHooks,
      env: { ...env },
      signal: abortController.signal,
      onNetworkActuals,
    });
    process.stdout.write(`${redactedJson(evidence)}\n`);
    return 0;
  } finally {
    abortController.abort(new Error("Phase 0b browser-auth smoke finished"));
    process.off("SIGINT", onSigint);
    process.stderr.write(`${formatBrowserSmokeNetworkActuals(networkActuals)}\n`);
  }
}

async function runLiveCanaryProbe(
  env: NodeJS.ProcessEnv,
  dependencies: ProbeCliDependencies,
): Promise<number> {
  const abortController = new AbortController();
  let httpActuals: ProbeHttpCounts = { ...ZERO_HTTP_COUNTS };
  const onSigint = (): void => {
    abortController.abort(new Error("Phase 0b canary-only probe cancelled by SIGINT"));
  };
  process.once("SIGINT", onSigint);
  try {
    const runner = dependencies.runCanaryProbe ?? runCanaryProbe;
    const execute = () => runner({
      fetch,
      sleep: (milliseconds: number, signal?: AbortSignal) => sleep(milliseconds, undefined, { signal }),
      now: Date.now,
      env,
      signal: abortController.signal,
      onUserCode: ({ userCode, verificationUrl }: DeviceCode) => {
        process.stderr.write(`Open ${verificationUrl} and enter code ${userCode}. Waiting up to 15 minutes.\n`);
      },
      onFinalized: (finalized) => {
        httpActuals = finalized.httpActuals;
      },
    });
    const evidence = dependencies.runCanaryProbe
      ? await enforceScratchHomeInvariant(env, async () => {
        assertLiveCanaryProbePreflight(env);
        await prepareLiveInferenceAuthorization("canary", env);
        return execute();
      })
      : await execute();
    process.stdout.write(`${redactedJson(evidence)}\n`);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    process.stderr.write(`${formatHttpAccounting(httpActuals)}\n`);
  }
}

async function runLiveDiscoveryProbe(
  env: NodeJS.ProcessEnv,
  dependencies: ProbeCliDependencies,
  emitAuthorizationPlan: boolean,
): Promise<number> {
  const abortController = new AbortController();
  let httpActuals: ProbeHttpCounts = { ...ZERO_HTTP_COUNTS };
  const onSigint = (): void => {
    abortController.abort(new Error("Phase 0b discovery probe cancelled by SIGINT"));
  };
  process.once("SIGINT", onSigint);
  try {
    const runner = dependencies.runDiscoveryProbe ?? runDiscoveryProbe;
    const execute = () => runner({
      fetch,
      sleep: (milliseconds: number, signal?: AbortSignal) => sleep(milliseconds, undefined, { signal }),
      now: Date.now,
      env,
      ...(emitAuthorizationPlan ? { emitAuthorizationPlan: true as const } : {}),
      signal: abortController.signal,
      onUserCode: ({ userCode, verificationUrl }: DeviceCode) => {
        process.stderr.write(`Open ${verificationUrl} and enter code ${userCode}. Waiting up to 15 minutes.\n`);
      },
      onFinalized: (finalized) => {
        httpActuals = finalized.httpActuals;
      },
    });
    const evidence = dependencies.runDiscoveryProbe
      ? await enforceScratchHomeInvariant(env, async () => {
        assertLiveDiscoveryProbePreflight(env);
        return execute();
      })
      : await execute();
    process.stdout.write(`${redactedJson(evidence)}\n`);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    process.stderr.write(`${formatHttpAccounting(httpActuals)}\n`);
  }
}

async function runLiveContractProbe(
  env: NodeJS.ProcessEnv,
  dependencies: ProbeCliDependencies,
): Promise<number> {
  // Validate every pre-OAuth gate again inside the runner; neither layer may be bypassed.
  const abortController = new AbortController();
  let httpActuals: ProbeHttpCounts = { ...ZERO_HTTP_COUNTS };
  const onSigint = (): void => {
    abortController.abort(new Error("Phase 0b contract probe cancelled by SIGINT"));
  };
  process.once("SIGINT", onSigint);
  try {
    const runner = dependencies.runContractProbe ?? runContractProbeScaffold;
    const execute = () => runner({
      fetch,
      sleep: (milliseconds: number, signal?: AbortSignal) => sleep(milliseconds, undefined, { signal }),
      now: Date.now,
      env,
      signal: abortController.signal,
      onUserCode: ({ userCode, verificationUrl }: DeviceCode) => {
        process.stderr.write(`Open ${verificationUrl} and enter code ${userCode}. Waiting up to 15 minutes.\n`);
      },
      onFinalized: (finalized) => {
        httpActuals = finalized.httpActuals;
      },
    });
    const evidence = dependencies.runContractProbe
      ? await enforceScratchHomeInvariant(env, async () => {
        assertLiveContractProbePreflight(env);
        await prepareLiveInferenceAuthorization("contract", env);
        return execute();
      })
      : await execute();
    process.stdout.write(`${redactedJson(evidence)}\n`);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    process.stderr.write(`${formatHttpAccounting(httpActuals)}\n`);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runProbeCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
