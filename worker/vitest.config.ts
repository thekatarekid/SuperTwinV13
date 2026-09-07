import { configDefaults, defineConfig } from "vitest/config";

/**
 * These are the only suites allowed to reach the real Claude CLI. Keep the
 * list explicit: an `*.integration.test.ts` glob would also hide offline
 * integration coverage from the normal gate.
 */
const LIVE_CLAUDE_FILES = [
  "src/providers/claude-local/adapter.integration.test.ts",
  "src/providers/claude-local/transport.integration.test.ts",
];

export default defineConfig(({ mode }) => {
  // Two keys are required. The env flag alone can never turn `npm test` live;
  // the dedicated npm command also supplies this otherwise-unused mode.
  const liveClaude =
    mode === "live-claude" && process.env.SUPERTWIN_RUN_LIVE_CLAUDE_TESTS === "1";

  return {
    test: {
      environment: "node",
      include: ["src/**/*.{test,spec}.ts"],
      exclude: liveClaude
        ? configDefaults.exclude
        : [...configDefaults.exclude, ...LIVE_CLAUDE_FILES],
      // Do not exclude server.integration.test.ts wholesale: its V2 surface
      // route suite is offline and must remain in the ordinary regression gate.
      // The env value is derived from BOTH opt-ins above; the mixed server file
      // reads it to gate only its real-CLI describe block.
      env: { SUPERTWIN_LIVE_CLAUDE_MODE: liveClaude ? "1" : "0" },
      // Opens the consent gate for the legacy suites (see src/test-setup.ts);
      // the CNS suites re-enforce it themselves.
      setupFiles: ["src/test-setup.ts"],
      // The media suites spawn real node processes as stub ffmpeg/whisper binaries.
      // Vitest's 5s default is comfortable on an idle machine and not on a loaded
      // one, so the whole suite went red intermittently while the code was fine —
      // which is worse than slow, because a flaky suite hides real regressions.
      testTimeout: 30_000,
    },
  };
});
