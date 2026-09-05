#!/usr/bin/env node
// ===========================================================================
// dev-worker.mjs — `npm run worker`, made structurally safe (V6 P1 S0.2, T0-5).
//
// Before this script `npm run worker` was `tsx worker/src/index.ts`: the real
// home (~/SuperTwinV13), the real port (8013), the real pipeline, real money,
// and nothing to stop it. That is how a hand-started worker ran for nine hours.
//
// DEV (default):
//   * SUPERTWIN_HOME  = a fresh scratch dir under os.tmpdir()   (never your data)
//   * SUPERTWIN_WORKER_PORT = 8113 (env override honoured; 8013 is refused)
//   * a PID file under os.tmpdir() refuses a second dev worker
//   * a 30-minute self-kill (SUPERTWIN_DEV_WORKER_TTL_MS overrides — tests)
//   * the scratch home is deleted on exit (SUPERTWIN_DEV_WORKER_KEEP_HOME=1 keeps it)
//
// LIVE (`--live`, `npm run worker:live`):
//   * plain pass-through: the real home, port 8013, no TTL. The worker's own
//     home guard (worker/src/home-guard.ts) still refuses to boot unless the
//     app launched it (SUPERTWIN_LAUNCHED_BY=app) or you set
//     SUPERTWIN_ALLOW_PRODUCTION_HOME=1. This is what src-tauri runs in dev.
//
// Either way the worker is a CHILD of this process with inherited stdio — never
// detached — and every exit path (TTL, signal, child exit) reaps it.
//
// Usage:  node scripts/dev-worker.mjs [--live]
// ===========================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, "..");

export const PRODUCTION_PORT = 8013;
export const DEV_PORT = 8113;
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const PID_FILE = join(tmpdir(), "supertwinv13-dev-worker.pid");
const KILL_GRACE_MS = 5_000;

/** kill -0. EPERM means "exists, not ours" — still alive. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * Decide what this run looks like. Pure: takes argv + env, returns the plan
 * (or throws with a one-line reason). The scratch home is minted by the
 * caller so the plan stays inspectable without touching the filesystem.
 */
export function planRun(argv, env) {
  const live = argv.includes("--live");
  if (live) {
    const port = Number(env.SUPERTWIN_WORKER_PORT ?? PRODUCTION_PORT);
    return { mode: "live", port, ttlMs: null, home: env.SUPERTWIN_HOME ?? null };
  }
  const port = Number(env.SUPERTWIN_WORKER_PORT ?? DEV_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`SUPERTWIN_WORKER_PORT=${env.SUPERTWIN_WORKER_PORT} is not a port`);
  }
  if (port === PRODUCTION_PORT) {
    throw new Error(
      `refusing to run the DEV worker on port ${PRODUCTION_PORT} — that is the app's port. ` +
        `Unset SUPERTWIN_WORKER_PORT (default ${DEV_PORT}) or use \`npm run worker:live\`.`,
    );
  }
  const ttlRaw = env.SUPERTWIN_DEV_WORKER_TTL_MS;
  const ttlMs = ttlRaw !== undefined && ttlRaw !== "" ? Number(ttlRaw) : DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`SUPERTWIN_DEV_WORKER_TTL_MS=${ttlRaw} is not a positive duration`);
  }
  return { mode: "dev", port, ttlMs, home: null };
}

/**
 * Claim the dev PID file. Returns true when claimed; false when another live
 * dev worker owns it. A file naming a dead pid is stale and is taken over.
 */
export function claimPidFile(pidFile, selfPid, alive = processAlive) {
  if (existsSync(pidFile)) {
    let owner = NaN;
    try {
      owner = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      /* unreadable: stale */
    }
    if (Number.isInteger(owner) && owner !== selfPid && alive(owner)) return false;
  }
  writeFileSync(pidFile, `${selfPid}\n`, "utf8");
  return true;
}

export function releasePidFile(pidFile, selfPid) {
  try {
    if (!existsSync(pidFile)) return;
    if (Number(readFileSync(pidFile, "utf8").trim()) === selfPid) rmSync(pidFile, { force: true });
  } catch {
    /* best-effort */
  }
}

/** The worker entry: `worker/src/index.ts` via the repo tsx, or a test stub. */
export function resolveEntry(env) {
  if (env.SUPERTWIN_DEV_WORKER_ENTRY) {
    return { cmd: process.execPath, args: [env.SUPERTWIN_DEV_WORKER_ENTRY] };
  }
  const tsx = join(REPO, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) throw new Error(`tsx not found at ${tsx} — run npm install`);
  return { cmd: tsx, args: [join(REPO, "worker", "src", "index.ts")] };
}

function log(line) {
  process.stderr.write(`[dev-worker] ${line}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let plan;
  try {
    plan = planRun(argv, env);
  } catch (err) {
    log(err.message);
    return 2;
  }

  const childEnv = { ...env, SUPERTWIN_WORKER_PORT: String(plan.port) };
  let scratchHome = null;
  const keepHome = env.SUPERTWIN_DEV_WORKER_KEEP_HOME === "1";

  if (plan.mode === "dev") {
    if (!claimPidFile(PID_FILE, process.pid)) {
      log(`another dev worker is already running (pid file ${PID_FILE}) — refusing a second boot`);
      return 3;
    }
    scratchHome = mkdtempSync(join(tmpdir(), "supertwinv13-dev-home-"));
    childEnv.SUPERTWIN_HOME = scratchHome;
    // A scratch home is never the production DB; make sure no inherited
    // override drags the child back to the real one.
    delete childEnv.SUPERTWIN_DB_PATH;
    delete childEnv.SUPERTWIN_LAUNCHED_BY;
    delete childEnv.SUPERTWIN_ALLOW_PRODUCTION_HOME;
    log(`DEV — home ${scratchHome}, port ${plan.port}, self-kill in ${Math.round(plan.ttlMs / 60000)} min`);
  } else {
    log(`LIVE — real home, port ${plan.port}, no TTL (the worker's home guard still applies)`);
  }

  let entry;
  try {
    entry = resolveEntry(env);
  } catch (err) {
    log(err.message);
    releasePidFile(PID_FILE, process.pid);
    if (scratchHome && !keepHome) rmSync(scratchHome, { recursive: true, force: true });
    return 2;
  }

  const child = spawn(entry.cmd, entry.args, { cwd: REPO, env: childEnv, stdio: "inherit" });

  let killTimer = null;
  const terminate = (why) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    log(`${why} — stopping the worker`);
    try {
      child.kill("SIGTERM");
    } catch {
      /* gone */
    }
    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }
  };

  const ttlTimer = plan.ttlMs ? setTimeout(() => terminate(`TTL of ${Math.round(plan.ttlMs / 60000)} min reached`), plan.ttlMs) : null;
  const onSignal = (sig) => terminate(`${sig} received`);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, onSignal);

  const code = await new Promise((done) => {
    child.on("exit", (c, s) => done(c ?? (s ? 1 : 0)));
    child.on("error", (err) => {
      log(`could not start the worker: ${err.message}`);
      done(1);
    });
  });

  if (ttlTimer) clearTimeout(ttlTimer);
  if (killTimer) clearTimeout(killTimer);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(sig, onSignal);

  if (plan.mode === "dev") {
    releasePidFile(PID_FILE, process.pid);
    if (scratchHome) {
      if (keepHome) log(`kept scratch home ${scratchHome}`);
      else rmSync(scratchHome, { recursive: true, force: true });
    }
  }
  log(`worker exited (${code})`);
  return code;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    log(`fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
