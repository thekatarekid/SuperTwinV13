import { afterEach, describe, expect, it } from "vitest";

import workerConfig from "../worker/vitest.config.ts";

const savedOptIn = process.env.SUPERTWIN_RUN_LIVE_CLAUDE_TESTS;

afterEach(() => {
  if (savedOptIn === undefined) delete process.env.SUPERTWIN_RUN_LIVE_CLAUDE_TESTS;
  else process.env.SUPERTWIN_RUN_LIVE_CLAUDE_TESTS = savedOptIn;
});

function resolveConfig(mode) {
  return workerConfig({ command: "serve", mode, isSsrBuild: false, isPreview: false });
}

describe("billable Claude test boundary", () => {
  it("keeps normal tests offline even if the spend variable leaks into the environment", () => {
    process.env.SUPERTWIN_RUN_LIVE_CLAUDE_TESTS = "1";
    const config = resolveConfig("test");
    expect(config.test.exclude).toContain("src/providers/claude-local/adapter.integration.test.ts");
    expect(config.test.exclude).toContain("src/providers/claude-local/transport.integration.test.ts");
    expect(config.test.exclude).not.toContain("src/server/server.integration.test.ts");
    expect(config.test.env.SUPERTWIN_LIVE_CLAUDE_MODE).toBe("0");
  });

  it("a live-looking mode without explicit spend opt-in is still offline", () => {
    delete process.env.SUPERTWIN_RUN_LIVE_CLAUDE_TESTS;
    const config = resolveConfig("live-claude");
    expect(config.test.exclude).toContain("src/providers/claude-local/adapter.integration.test.ts");
    expect(config.test.env.SUPERTWIN_LIVE_CLAUDE_MODE).toBe("0");
  });

  it("opens the live suites only when both mode and spend opt-in agree", () => {
    process.env.SUPERTWIN_RUN_LIVE_CLAUDE_TESTS = "1";
    const config = resolveConfig("live-claude");
    expect(config.test.exclude).not.toContain("src/providers/claude-local/adapter.integration.test.ts");
    expect(config.test.exclude).not.toContain("src/providers/claude-local/transport.integration.test.ts");
    expect(config.test.env.SUPERTWIN_LIVE_CLAUDE_MODE).toBe("1");
  });
});
