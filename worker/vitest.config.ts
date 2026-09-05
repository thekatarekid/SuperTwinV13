import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // Opens the consent gate for the legacy suites (see src/test-setup.ts);
    // the CNS suites re-enforce it themselves.
    setupFiles: ["src/test-setup.ts"],
    // The media suites spawn real node processes as stub ffmpeg/whisper binaries.
    // Vitest's 5s default is comfortable on an idle machine and not on a loaded
    // one, so the whole suite went red intermittently while the code was fine —
    // which is worse than slow, because a flaky suite hides real regressions.
    testTimeout: 30_000,
  },
});
