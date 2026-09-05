// ===========================================================================
// scripts/dev-worker.mjs (S0.2, T0-5): `npm run worker` writes to a temp home
// on port 8113 and exits on its TTL; a second dev worker is refused; the
// production port is refused in dev mode. The "worker" here is a stub entry
// (SUPERTWIN_DEV_WORKER_ENTRY) that records its environment and idles — the
// real entrypoint is never booted, no port is opened, no model is called.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEV_PORT,
  DEFAULT_TTL_MS,
  PID_FILE,
  PRODUCTION_PORT,
  claimPidFile,
  planRun,
} from "./dev-worker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "dev-worker.mjs");

function baseEnv() {
  const env = { ...process.env };
  delete env.SUPERTWIN_HOME;
  delete env.SUPERTWIN_DB_PATH;
  delete env.SUPERTWIN_WORKER_PORT;
  delete env.SUPERTWIN_DEV_WORKER_TTL_MS;
  delete env.SUPERTWIN_DEV_WORKER_KEEP_HOME;
  return env;
}

describe("planRun", () => {
  it("dev: scratch home, port 8113, 30-minute TTL", () => {
    expect(planRun([], {})).toEqual({ mode: "dev", port: DEV_PORT, ttlMs: DEFAULT_TTL_MS, home: null });
    expect(DEV_PORT).toBe(8113);
    expect(DEFAULT_TTL_MS).toBe(30 * 60 * 1000);
  });
  it("dev refuses the production port", () => {
    expect(() => planRun([], { SUPERTWIN_WORKER_PORT: String(PRODUCTION_PORT) })).toThrow(/8013/);
  });
  it("dev honours a port override and a TTL override", () => {
    expect(planRun([], { SUPERTWIN_WORKER_PORT: "8200", SUPERTWIN_DEV_WORKER_TTL_MS: "5000" })).toMatchObject({ port: 8200, ttlMs: 5000 });
    expect(() => planRun([], { SUPERTWIN_DEV_WORKER_TTL_MS: "-1" })).toThrow(/TTL/);
  });
  it("live: pass-through, real port, no TTL", () => {
    expect(planRun(["--live"], {})).toEqual({ mode: "live", port: PRODUCTION_PORT, ttlMs: null, home: null });
  });
});

describe("claimPidFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-worker-pid-"));
  const file = join(dir, "x.pid");
  it("claims a fresh or stale file, refuses a live owner", () => {
    expect(claimPidFile(file, 10, () => false)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe("10");
    expect(claimPidFile(file, 11, (p) => p === 10)).toBe(false);
    expect(readFileSync(file, "utf8").trim()).toBe("10");
    expect(claimPidFile(file, 12, () => false)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe("12");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("npm run worker (the script end to end, with a stub worker)", () => {
  it("writes to a temp home on 8113 and exits on its TTL; the pid file and scratch home are gone after", () => {
    const stage = mkdtempSync(join(tmpdir(), "dev-worker-e2e-"));
    const probe = join(stage, "probe.json");
    const stub = join(stage, "stub.mjs");
    writeFileSync(
      stub,
      [
        'import { writeFileSync, existsSync } from "node:fs";',
        "writeFileSync(process.env.ST_PROBE, JSON.stringify({",
        "  home: process.env.SUPERTWIN_HOME, port: process.env.SUPERTWIN_WORKER_PORT,",
        "  homeExists: existsSync(process.env.SUPERTWIN_HOME), ppid: process.ppid,",
        "  launchedBy: process.env.SUPERTWIN_LAUNCHED_BY ?? null, dbPath: process.env.SUPERTWIN_DB_PATH ?? null }));",
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    // The pid file is machine-global; a stale one from an earlier run is taken over.
    if (existsSync(PID_FILE)) {
      const owner = Number(readFileSync(PID_FILE, "utf8").trim());
      let alive = false;
      try {
        process.kill(owner, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`a dev worker (pid ${owner}) is really running — refusing to test over it`);
    }
    const env = {
      ...baseEnv(),
      SUPERTWIN_DEV_WORKER_ENTRY: stub,
      SUPERTWIN_DEV_WORKER_TTL_MS: "800",
      SUPERTWIN_LAUNCHED_BY: "app", // must NOT reach the dev child
      SUPERTWIN_DB_PATH: "/should/be/dropped.db",
      ST_PROBE: probe,
    };
    const started = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8", timeout: 20_000 });
    const elapsed = Date.now() - started;
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/DEV — home .*supertwinv13-dev-home-.*, port 8113/);
    expect(r.stderr).toMatch(/TTL of 0 min reached — stopping the worker/);
    expect(elapsed).toBeGreaterThanOrEqual(700);
    const p = JSON.parse(readFileSync(probe, "utf8"));
    expect(p.port).toBe("8113");
    expect(p.home.startsWith(join(tmpdir(), "supertwinv13-dev-home-"))).toBe(true);
    expect(p.homeExists).toBe(true);
    expect(p.launchedBy).toBeNull();
    expect(p.dbPath).toBeNull();
    // Cleaned up: the scratch home and the pid file are gone.
    expect(existsSync(p.home)).toBe(false);
    expect(existsSync(PID_FILE)).toBe(false);
    rmSync(stage, { recursive: true, force: true });
  });

  it("refuses a second dev worker while one holds the pid file", () => {
    const owner = process.pid; // this vitest process is alive
    writeFileSync(PID_FILE, `${owner}\n`);
    try {
      const r = spawnSync(process.execPath, [SCRIPT], {
        env: { ...baseEnv(), SUPERTWIN_DEV_WORKER_ENTRY: "/nonexistent.mjs" },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/refusing a second boot/);
      expect(readFileSync(PID_FILE, "utf8").trim()).toBe(String(owner));
    } finally {
      rmSync(PID_FILE, { force: true });
    }
  });

  it("refuses to run the dev worker on 8013", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...baseEnv(), SUPERTWIN_WORKER_PORT: "8013", SUPERTWIN_DEV_WORKER_ENTRY: "/nonexistent.mjs" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing to run the DEV worker on port 8013/);
  });
});
