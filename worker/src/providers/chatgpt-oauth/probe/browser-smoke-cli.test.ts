import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV } from "./account.js";
import {
  LIVE_BROWSER_AUTH_SMOKE_ENV,
  type BrowserAuthSmokeHooks,
} from "./browser-auth-smoke.js";
import { runProbeCli } from "./cli.js";
import { LIVE_PROBE_ENV } from "./constants.js";
import {
  buildBrowserSmokeEvidence,
  type BrowserSmokeEvidence,
} from "./browser-smoke-evidence.js";
import {
  formatBrowserAuthSmokeDeclaration,
} from "./safety.js";

const ACCOUNT_FINGERPRINT = "7d41db9e5a28";
const EXACT_ACTUALS = {
  authorizeNavigation: 1,
  tokenExchange: 1,
  tokenRefresh: 1,
  deviceCode: 0,
  devicePoll: 0,
  models: 0,
  quota: 0,
  inference: 0,
  other: 0,
  workerFetchTotal: 2,
  controlledRemoteTotal: 3,
} as const;

const scratchHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of scratchHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function scratchHome(): string {
  const path = mkdtempSync(join(tmpdir(), "supertwin-browser-cli-"));
  chmodSync(path, 0o700);
  scratchHomes.push(path);
  return path;
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    [LIVE_PROBE_ENV]: "1",
    [LIVE_BROWSER_AUTH_SMOKE_ENV]: "1",
    [EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV]: ACCOUNT_FINGERPRINT,
    SUPERTWIN_APP_VERSION: "13.12.2",
    SUPERTWIN_HOME: scratchHome(),
  };
}

function passedEvidence(): BrowserSmokeEvidence {
  return buildBrowserSmokeEvidence({
    accountFingerprint: ACCOUNT_FINGERPRINT,
    pkceCorrelation: true,
    stateValidated: true,
    callbackAccepted: 1,
    listenerCleanedUp: true,
    refreshRotatedBeforeUse: true,
    logoutCleared: true,
    counts: { ...EXACT_ACTUALS },
  });
}

function unusedHooks(env: NodeJS.ProcessEnv, signal: AbortSignal): BrowserAuthSmokeHooks {
  return {
    fetch: vi.fn<typeof fetch>(async () => {
      throw new Error("unexpected fetch");
    }),
    openAuthorizationUrl: vi.fn(async () => {
      throw new Error("unexpected browser open");
    }),
    listenerFactory: vi.fn(async () => {
      throw new Error("unexpected listener");
    }),
    randomBytes: (size) => new Uint8Array(size),
    now: () => 0,
    env,
    signal,
  };
}

describe("browser-auth smoke CLI isolation", () => {
  it("declares exact zero-inference ceilings before runtime construction and emits safe actuals", async () => {
    const env = validEnv();
    const events: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      events.push(String(value));
      return true;
    });
    const createBrowserSmokeHooks = vi.fn(async (options) => {
      events.push("runtime-hooks-created");
      return unusedHooks(options.env, options.signal);
    });
    const runBrowserAuthSmoke = vi.fn(async (hooks: BrowserAuthSmokeHooks) => {
      hooks.onNetworkActuals?.({ ...EXACT_ACTUALS });
      return passedEvidence();
    });

    await expect(runProbeCli(
      ["--live-browser-auth-smoke"],
      env,
      { createBrowserSmokeHooks, runBrowserAuthSmoke },
    )).resolves.toBe(0);

    expect(events[0]).toContain("PHASE_0B_BROWSER_AUTH_SMOKE_DECLARATION");
    expect(events.indexOf("runtime-hooks-created")).toBeGreaterThan(0);
    const declaration = String(stderrSpy.mock.calls[0]?.[0]);
    expect(declaration).toContain("MAX_AUTHORIZATION_NAVIGATIONS=1");
    expect(declaration).toContain("MAX_TOKEN_EXCHANGE_POSTS=1");
    expect(declaration).toContain("MAX_TOKEN_REFRESH_POSTS=1");
    for (const zeroCeiling of [
      "MAX_DEVICE_CODE_REQUESTS=0",
      "MAX_DEVICE_POLL_REQUESTS=0",
      "MAX_MODEL_REQUESTS=0",
      "MAX_QUOTA_REQUESTS=0",
      "MAX_INFERENCE_POSTS=0",
      "MAX_OTHER_REQUESTS=0",
    ]) {
      expect(declaration).toContain(zeroCeiling);
    }
    expect(declaration).toContain("OAUTH_RETRIES=0");
    expect(declaration).toContain("INFERENCE_RETRIES=0");
    expect(stderrSpy.mock.calls.map(([value]) => String(value)).join(""))
      .toContain(`PHASE_0B_BROWSER_AUTH_SMOKE_ACTUALS=${JSON.stringify(EXACT_ACTUALS)}`);
    expect(createBrowserSmokeHooks).toHaveBeenCalledOnce();
    expect(runBrowserAuthSmoke).toHaveBeenCalledOnce();
    const output = stdoutSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('"mode": "browser-authorization-code-pkce-smoke"');
    expect(output).toContain('"inference": 0');
    expect(output).not.toMatch(/access[_-]?token|refresh[_-]?token|authorization-code-secret/i);
  });

  it.each([
    ["--live-browser-auth-smoke", "--live-auth"],
    ["--live-browser-auth-smoke", "--live-discover"],
    ["--live-browser-auth-smoke", "--live-canary"],
    ["--live-browser-auth-smoke", "--live-contract"],
    ["--live-browser-auth-smoke", "--emit-authorization-plan"],
    ["--live-browser-auth-smoke", "--initialize-authorization-ledger"],
    ["--live-browser-auth-smoke", "--live-browser-auth-smoke"],
    ["--live-browser-auth-smoke", "--unknown"],
  ])("refuses coexisting mode or modifier %s %s before runtime", async (...args) => {
    const createBrowserSmokeHooks = vi.fn();
    const runBrowserAuthSmoke = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runProbeCli(args, validEnv(), {
      createBrowserSmokeHooks,
      runBrowserAuthSmoke,
    })).rejects.toThrow(/REFUSED/);

    expect(createBrowserSmokeHooks).not.toHaveBeenCalled();
    expect(runBrowserAuthSmoke).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["global opt-in", (env: NodeJS.ProcessEnv) => delete env[LIVE_PROBE_ENV]],
    ["dedicated opt-in", (env: NodeJS.ProcessEnv) => delete env[LIVE_BROWSER_AUTH_SMOKE_ENV]],
    ["exact dedicated opt-in", (env: NodeJS.ProcessEnv) => {
      env[LIVE_BROWSER_AUTH_SMOKE_ENV] = "true";
    }],
    ["semver", (env: NodeJS.ProcessEnv) => delete env.SUPERTWIN_APP_VERSION],
    ["fingerprint", (env: NodeJS.ProcessEnv) => {
      delete env[EXPECTED_PROBE_ACCOUNT_FINGERPRINT_ENV];
    }],
  ])("refuses missing %s before runtime, browser, or fetch", async (_label, mutate) => {
    const env = validEnv();
    mutate(env);
    const createBrowserSmokeHooks = vi.fn();
    const runBrowserAuthSmoke = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runProbeCli(["--live-browser-auth-smoke"], env, {
      createBrowserSmokeHooks,
      runBrowserAuthSmoke,
    })).rejects.toThrow(/REFUSED/);

    expect(String(stderrSpy.mock.calls[0]?.[0]))
      .toContain("PHASE_0B_BROWSER_AUTH_SMOKE_DECLARATION");
    expect(createBrowserSmokeHooks).not.toHaveBeenCalled();
    expect(runBrowserAuthSmoke).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps browser modules device-flow-free and creates the real opener only behind the runtime factory", () => {
    const sourceNames = [
      "browser-pkce.ts",
      "browser-loopback.ts",
      "browser-smoke-budget.ts",
      "browser-smoke-evidence.ts",
      "browser-auth-smoke.ts",
      "browser-smoke-runtime.ts",
    ];
    const sources = sourceNames.map((name) =>
      readFileSync(new URL(name, import.meta.url), "utf8")
    );
    for (const source of sources) {
      expect(source).not.toMatch(/from\s+["'][^"']*device-flow/);
    }
    const runtime = sources.at(-1)!;
    expect(runtime).toContain('import("node:crypto")');
    expect(runtime).toContain('import("node:child_process")');
    expect(runtime).toContain('spawn("/usr/bin/open", [url]');
    expect(runtime).toContain("shell: false");
    expect(formatBrowserAuthSmokeDeclaration()).toContain("MAX_CONTROLLED_REMOTE_OPERATIONS=3");

    const packageJson = readFileSync(
      new URL("../../../../package.json", import.meta.url),
      "utf8",
    );
    expect(packageJson).toContain('"probe:chatgpt-oauth:browser-auth-smoke"');
    expect(packageJson).toContain("--live-browser-auth-smoke");
  });
});
