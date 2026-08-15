import { defineConfig } from "vitest/config";

// The root config only looks at src/ and runs in jsdom. Build scripts are plain
// Node ESM, so they get their own project rather than a widened root include.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
  },
});
