/**
 * Compatibility tombstone for the removed helper-based source verifier.
 * Native P6-D verification is available only as a startup mode of the signed
 * Tauri app, before any WebView or worker is created.
 */
export class NativeKeychainVerificationError extends Error {
  constructor() {
    super("native Keychain verification requires the startup-only signed-app broker ceremony");
    this.name = "NativeKeychainVerificationError";
  }
}

export function runNativeKeychainVerification(): never {
  throw new NativeKeychainVerificationError();
}

export function assertNativeKeychainVerificationOptIn(): never {
  throw new NativeKeychainVerificationError();
}
