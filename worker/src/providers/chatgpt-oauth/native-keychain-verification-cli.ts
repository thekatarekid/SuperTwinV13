import { pathToFileURL } from "node:url";

/**
 * The former source/tsx verifier could invoke credential-capable helper code.
 * P6-D is now exclusively a startup-only signed-app Rust ceremony.
 */
export async function runNativeKeychainVerificationCli(): Promise<number> {
  throw new Error("native Keychain verification requires the startup-only signed-app broker ceremony");
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runNativeKeychainVerificationCli().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "native Keychain verification failed"}\n`);
      process.exitCode = 2;
    },
  );
}
