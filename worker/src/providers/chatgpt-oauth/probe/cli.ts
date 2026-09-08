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
import {
  assertLiveContractProbePreflight,
  assertLiveProbeOptIn,
  formatLiveDeclaration,
} from "./safety.js";

export interface ProbeCliDependencies {
  runContractProbe?: typeof runContractProbeScaffold;
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
  const liveAuth = args.includes("--live-auth");
  const liveContract = args.includes("--live-contract");
  if (!liveAuth && !liveContract) {
    process.stdout.write(`${redactedJson(dryRunSnapshot(env))}\n`);
    return 0;
  }

  // This declaration must precede the opt-in checks and every possible network operation.
  process.stderr.write(`${formatLiveDeclaration(liveContract ? "contract" : "auth")}\n`);
  if (liveContract && !liveAuth) {
    throw new Error("REFUSED: --live-contract additionally requires --live-auth");
  }
  if (liveContract) return runLiveContractProbe(env, dependencies);
  assertLiveProbeOptIn(env);

  const accounting = new ProbeHttpAccounting(LIVE_AUTH_HTTP_LIMITS);
  const abortController = new AbortController();
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
    const tokens = await runDeviceCodeFlow(hooks);
    const fingerprint = accountFingerprint(accountIdFromAccessToken(tokens.accessToken));
    process.stdout.write(
      `${redactedJson({
        status: "authenticated-ephemeral",
        account_fingerprint: fingerprint,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      })}\n`,
    );
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    printAccounting();
  }
}

async function runLiveContractProbe(
  env: NodeJS.ProcessEnv,
  dependencies: ProbeCliDependencies,
): Promise<number> {
  // Validate every pre-OAuth gate again inside the runner; neither layer may be bypassed.
  assertLiveContractProbePreflight(env);
  const abortController = new AbortController();
  let httpActuals: ProbeHttpCounts = { ...ZERO_HTTP_COUNTS };
  const onSigint = (): void => {
    abortController.abort(new Error("Phase 0b contract probe cancelled by SIGINT"));
  };
  process.once("SIGINT", onSigint);
  try {
    const evidence = await (dependencies.runContractProbe ?? runContractProbeScaffold)({
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
