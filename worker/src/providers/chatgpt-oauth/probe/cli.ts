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
} from "./accounting.js";
import { assertLiveProbeOptIn, formatLiveDeclaration } from "./safety.js";

export async function runProbeCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
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
  if (liveContract) {
    throw new Error(
      "REFUSED: live contract execution is not enabled until the dedicated-account, refresh, logout, quota-health, capability, cache, cancellation, and hard-stop gates pass",
    );
  }
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
