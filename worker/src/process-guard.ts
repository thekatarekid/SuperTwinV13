// ===========================================================================
// [CODE] Process guard — the worker does not outlive its reason to exist
// (build V6 P1 S0.2, backlog T0-7 and T0-15).
//
// The 13.4.x incident in one line: `worker.log` recorded 7 spawns against 2
// terminations. Workers orphaned by a dead parent kept dispatching for nine
// hours. Three small mechanisms close that:
//
//   startParentWatch()   — if the parent goes away (we are re-parented to
//                          launchd/init, or the recorded ppid stops answering
//                          kill -0), exit 10 minutes later unless
//                          SUPERTWIN_WORKER_NO_PARENT=1 says this is a
//                          deliberate headless run. The grace is generous so a
//                          Tauri restart can re-attach; it is not infinite.
//   sweepStaleWorkers()  — at boot, read `<home>/worker.pid`; a live process
//                          that is not us and was started on this home is a
//                          pre-existing worker: SIGTERM it (SIGKILL after a
//                          grace), then write our own pid.
//   installCrashKill()   — `unhandledRejection` kills every in-flight `claude`
//                          child before the process dies, so a crash cannot
//                          leave children billing.
//
// Everything that touches the OS goes through injectable deps so the rules
// are unit-tested without spawning anything.
// ===========================================================================

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NO_PARENT_ENV = "SUPERTWIN_WORKER_NO_PARENT";
/** Exit this long after the parent is first seen missing. */
export const PARENT_LOSS_GRACE_MS = 10 * 60 * 1000;
/** How often the parent is probed. */
export const PARENT_POLL_MS = 15 * 1000;
export const PID_FILENAME = "worker.pid";
const SWEEP_KILL_GRACE_MS = 2_000;

/** kill -0: true when `pid` exists and we may signal it. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but not ours — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---- parent watch ------------------------------------------------------------

export interface ParentWatchDeps {
  /** Current ppid (defaults to process.ppid, re-read each poll). */
  ppid: () => number;
  alive: (pid: number) => boolean;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (t: NodeJS.Timeout) => void;
  log: (line: string) => void;
}

export interface ParentWatchOptions {
  /** Called once, when the grace expires. Should shut down and exit. */
  onParentLost: (detail: string) => void;
  graceMs?: number;
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<ParentWatchDeps>;
}

export interface ParentWatch {
  /** Non-null once the parent has been seen missing; the deadline (epoch ms). */
  readonly deadline: () => number | null;
  /** True when SUPERTWIN_WORKER_NO_PARENT=1 disabled the watch. */
  readonly disabled: boolean;
  /** Run one probe now (tests). */
  poll(): void;
  stop(): void;
}

/**
 * Parent-loss detection. The parent is "lost" when the ppid we booted under
 * changes (macOS/Linux re-parent orphans to 1 / launchd) or stops answering
 * kill -0. Re-appearance before the deadline cancels the countdown — a probe
 * glitch must not kill a healthy worker.
 */
export function startParentWatch(opts: ParentWatchOptions): ParentWatch {
  const env = opts.env ?? process.env;
  const d: ParentWatchDeps = {
    ppid: () => process.ppid,
    alive: processAlive,
    now: Date.now,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
    log: (line) => console.error(line),
    ...opts.deps,
  };
  const graceMs = opts.graceMs ?? PARENT_LOSS_GRACE_MS;
  const pollMs = opts.pollMs ?? PARENT_POLL_MS;

  if (env[NO_PARENT_ENV] === "1") {
    d.log(`[worker] ${NO_PARENT_ENV}=1 — parent watch disabled (headless run)`);
    return { deadline: () => null, disabled: true, poll: () => {}, stop: () => {} };
  }

  const bootPpid = d.ppid();
  let deadline: number | null = null;
  let fired = false;
  let timer: NodeJS.Timeout | null = null;

  const poll = (): void => {
    if (fired) return;
    const now = d.now();
    const current = d.ppid();
    const lost = current !== bootPpid || !d.alive(current);
    if (!lost) {
      if (deadline !== null) d.log("[worker] parent is back — cancelling self-shutdown");
      deadline = null;
      return;
    }
    if (deadline === null) {
      deadline = now + graceMs;
      d.log(
        `[worker] parent process ${bootPpid} is gone (ppid now ${current}) — ` +
          `self-shutdown in ${Math.round(graceMs / 60000)} min unless it returns ` +
          `(set ${NO_PARENT_ENV}=1 for a deliberate headless run)`,
      );
      return;
    }
    if (now >= deadline) {
      fired = true;
      if (timer) d.clearInterval(timer);
      opts.onParentLost(`parent ${bootPpid} lost for ${Math.round(graceMs / 60000)} min`);
    }
  };

  timer = d.setInterval(poll, pollMs);
  timer.unref?.();
  return {
    deadline: () => deadline,
    disabled: false,
    poll,
    stop: () => {
      if (timer) d.clearInterval(timer);
      timer = null;
    },
  };
}

// ---- startup sweep + pid file --------------------------------------------------

export interface SweepDeps {
  alive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Schedule the SIGKILL follow-up. Defaults to setTimeout (unref'd). */
  later: (fn: () => void, ms: number) => void;
  selfPid: number;
  log: (line: string) => void;
}

export interface SweepResult {
  pidFile: string;
  /** The stale pid that was signalled, if any. */
  killed: number | null;
  /** A pid file existed but named a dead process. */
  stale: boolean;
}

export function pidFilePath(home: string): string {
  return join(home, PID_FILENAME);
}

/**
 * Kill any pre-existing worker on this home, then claim the pid file. The
 * pid file names the worker that owns the home; a live one that is not us is
 * exactly the orphan T0-15 describes.
 */
export function sweepStaleWorkers(home: string, deps: Partial<SweepDeps> = {}): SweepResult {
  const d: SweepDeps = {
    alive: processAlive,
    kill: (pid, sig) => process.kill(pid, sig),
    later: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
    },
    selfPid: process.pid,
    log: (line) => console.error(line),
    ...deps,
  };
  const pidFile = pidFilePath(home);
  let killed: number | null = null;
  let stale = false;

  if (existsSync(pidFile)) {
    let previous = NaN;
    try {
      previous = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      /* unreadable: treat as stale */
    }
    if (Number.isInteger(previous) && previous !== d.selfPid && d.alive(previous)) {
      d.log(`[worker] pre-existing worker pid ${previous} owns ${home} — terminating it`);
      try {
        d.kill(previous, "SIGTERM");
        killed = previous;
        d.later(() => {
          if (d.alive(previous)) {
            try {
              d.kill(previous, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        }, SWEEP_KILL_GRACE_MS);
      } catch (err) {
        d.log(`[worker] could not signal pid ${previous}: ${(err as Error).message}`);
      }
    } else if (previous !== d.selfPid) {
      stale = true;
    }
  }

  writeFileSync(pidFile, `${d.selfPid}\n`, "utf8");
  return { pidFile, killed, stale };
}

/** Remove the pid file if it still names us. Best-effort. */
export function releasePidFile(home: string, selfPid: number = process.pid): void {
  const pidFile = pidFilePath(home);
  try {
    if (!existsSync(pidFile)) return;
    const owner = Number(readFileSync(pidFile, "utf8").trim());
    if (owner === selfPid) rmSync(pidFile, { force: true });
  } catch {
    /* best-effort */
  }
}

// ---- crash hygiene ---------------------------------------------------------------

/**
 * On an unhandled rejection: kill every in-flight child FIRST, then let the
 * process die the way Node would have (exit 1). Node's default for an
 * unhandled rejection is already a crash; without this hook the crash orphaned
 * the children.
 */
export function installCrashKill(killAll: () => void, exit: (code: number) => void = (c) => process.exit(c)): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandled rejection — killing children and exiting:", reason);
    try {
      killAll();
    } finally {
      exit(1);
    }
  });
}
