import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { dryRunSnapshot } from "./requests.js";
import { redactedJson } from "./redact.js";
import { runDeviceCodeFlow } from "./device-flow.js";
import { assertLiveProbeOptIn, formatLiveDeclaration } from "./safety.js";

export async function runProbeCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const live = args.includes("--live-auth");
  if (!live) {
    process.stdout.write(`${redactedJson(dryRunSnapshot(env))}\n`);
    return 0;
  }

  // This declaration must precede the opt-in checks and every possible network operation.
  process.stderr.write(`${formatLiveDeclaration()}\n`);
  assertLiveProbeOptIn(env);

  const tokens = await runDeviceCodeFlow({
    fetch,
    sleep,
    now: Date.now,
    env,
    onUserCode: ({ userCode, verificationUrl }) => {
      process.stderr.write(`Open ${verificationUrl} and enter code ${userCode}. Waiting up to 15 minutes.\n`);
    },
  });
  process.stdout.write(
    `${redactedJson({ status: "authenticated-ephemeral", access_token: tokens.accessToken, refresh_token: tokens.refreshToken })}\n`,
  );
  return 0;
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
