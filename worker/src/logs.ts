// ===========================================================================
// Logs util (see docs/PHASE34_CONTRACT.md §9). Tiny, no framework.
//
// Layout under the SuperTwinV11 home:
//   ~/SuperTwinV11/logs/
//     worker.log        # Rust writes this one level up (~/SuperTwinV11/worker.log)
//     worker-node.log   # the node worker tees its own console here (best-effort)
//     runs/<taskId>-<ts>.log   # per-execution transcript
//
// logsDir() mirrors brainRoot()'s HOME resolution (SUPERTWIN_HOME else
// ~/SuperTwinV11) but has no brain-style override — logs always live under
// <home>/logs so the "reveal logs" button opens one stable directory.
// ===========================================================================

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve <home>/logs: SUPERTWIN_HOME/logs, else ~/SuperTwinV11/logs. */
export function logsDir(): string {
  const home =
    process.env.SUPERTWIN_HOME && process.env.SUPERTWIN_HOME.trim().length
      ? process.env.SUPERTWIN_HOME
      : join(homedir(), "SuperTwinV11");
  return resolve(join(home, "logs"));
}

/** mkdir -p logsDir() and logsDir()/runs. Returns logsDir(). Idempotent. */
export function ensureLogsDir(): string {
  const dir = logsDir();
  mkdirSync(join(dir, "runs"), { recursive: true });
  return dir;
}

/** Absolute path for a task-run transcript: logsDir()/runs/<taskId>-<epochms>.log. */
export function runTranscriptPath(taskId: string): string {
  return join(logsDir(), "runs", `${taskId}-${Date.now()}.log`);
}

/** Durable node-side console log path (next to the run transcripts). */
export function workerNodeLogPath(): string {
  return join(logsDir(), "worker-node.log");
}

/**
 * Append one line (a trailing newline is added). Best-effort: any failure
 * (missing dir, permissions, EPIPE) is swallowed — logging never breaks a run.
 */
export function appendLine(absPath: string, text: string): void {
  try {
    appendFileSync(absPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  } catch {
    // best-effort — never throw from a logging call
  }
}

let teed = false;

/**
 * Tee console.log/info/warn/error to logs/worker-node.log (best-effort). Idempotent
 * — safe to call once on boot. The original console methods still fire, so stdout
 * is unchanged; a durable copy just also lands on disk next to run transcripts.
 */
export function teeConsole(): void {
  if (teed) return;
  teed = true;
  const path = workerNodeLogPath();
  const methods = ["log", "info", "warn", "error"] as const;
  for (const m of methods) {
    const original = console[m].bind(console);
    console[m] = (...args: unknown[]): void => {
      original(...args);
      try {
        const line = args
          .map((a) => (typeof a === "string" ? a : safeInspect(a)))
          .join(" ");
        appendLine(path, `${new Date().toISOString()} [${m}] ${line}`);
      } catch {
        // best-effort
      }
    };
  }
}

function safeInspect(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
