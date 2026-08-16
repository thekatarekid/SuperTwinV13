// The `*.integration.test.ts` suites drive the REAL `claude` CLI. They are the
// only tests that prove the bare-call contract against the actual binary, so
// they must keep running wherever the binary exists — a developer machine, or
// this project's own Claude Code container.
//
// A CI runner has no `claude` on PATH, and until CI actually ran (it was
// disabled by a duplicate YAML key) nobody noticed those suites abort in
// `beforeAll` with ENOENT and fail the build.
//
// The distinction this module draws is the important part: ONLY "the binary is
// not installed" is a reason to skip. If `claude` is present but exits non-zero,
// or is not executable, that is a real failure and stays red — otherwise a
// broken CLI would quietly look like an absent one and these suites would
// evaporate exactly when they matter.

import { execFileSync } from "node:child_process";

export type CliProbe =
  | { available: true; version: string }
  | { available: false; reason: string };

/** Probe for a runnable `claude` binary. Never throws. */
export function probeRealCli(exec: typeof execFileSync = execFileSync): CliProbe {
  try {
    const version = exec("claude", ["--version"], { encoding: "utf8" }) as unknown as string;
    return { available: true, version: String(version).trim() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT: nothing named `claude` on PATH. EACCES: present but not runnable
    // by this user — also an environment gap rather than a product defect.
    if (code === "ENOENT" || code === "EACCES") {
      return { available: false, reason: `claude CLI not available on PATH (${code})` };
    }
    // Anything else means the binary ran and misbehaved. Surface it.
    throw err;
  }
}

export const realCli = probeRealCli();

/**
 * `describe.skipIf(skipWithoutRealCli)` — skips a suite only when the binary is
 * genuinely absent, and says so once so a green run is never mistaken for a run
 * that actually exercised the CLI.
 */
export const skipWithoutRealCli = !realCli.available;

if (!realCli.available) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] skipping real-CLI suites: ${realCli.reason}`);
}
