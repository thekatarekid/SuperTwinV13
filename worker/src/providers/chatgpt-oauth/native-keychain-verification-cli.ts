import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import {
  NATIVE_KEYCHAIN_CONFIRMATION,
  NativeKeychainVerificationError,
  assertNativeKeychainVerificationOptIn,
  runNativeKeychainVerification,
  type NativeKeychainVerificationDependencies,
  type NativeKeychainPreflightOptions,
} from "./native-keychain-verification.js";

export async function runNativeKeychainVerificationCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: Partial<NativeKeychainVerificationDependencies> & NativeKeychainPreflightOptions = {},
): Promise<number> {
  const sourceApp = assertNativeKeychainVerificationOptIn(args, env, {
    platform: dependencies.platform,
    interactive: dependencies.interactive,
  });
  const confirmAcl = dependencies.confirmAcl ?? (async ({ service, account }) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stderr.write(
        `Open Keychain Access and inspect only service "${service}", account "${account}". ` +
        `Confirm Access Control does not allow all applications. Type ${NATIVE_KEYCHAIN_CONFIRMATION}: `,
      );
      return (await terminal.question("")).trim() === NATIVE_KEYCHAIN_CONFIRMATION;
    } finally {
      terminal.close();
    }
  });
  const evidence = await runNativeKeychainVerification(sourceApp, {
    ...dependencies,
    confirmAcl,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runNativeKeychainVerificationCli().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      const message = error instanceof NativeKeychainVerificationError
        ? error.message
        : "native Keychain verification failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
