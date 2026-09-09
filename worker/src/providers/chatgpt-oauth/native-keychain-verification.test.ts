import { expect, it } from "vitest";

import { runNativeKeychainVerificationCli } from "./native-keychain-verification-cli.js";
import { assertNativeKeychainVerificationOptIn, runNativeKeychainVerification } from "./native-keychain-verification.js";

it("hard-refuses every obsolete helper-based source verification entry", async () => {
  expect(() => assertNativeKeychainVerificationOptIn()).toThrow(/startup-only signed-app broker/);
  expect(() => runNativeKeychainVerification()).toThrow(/startup-only signed-app broker/);
  await expect(runNativeKeychainVerificationCli()).rejects.toThrow(/startup-only signed-app broker/);
});
