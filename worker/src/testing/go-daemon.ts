// Two suites drive the REAL Go daemon and so must compile it first:
// adapters/whatsapp/mock-e2e and server/executor-demo.integration. That
// compile is the single most expensive thing in `npm test` — about 60 CPU-
// seconds of Go against a cold build cache — and HOW it is run decides whether
// CI passes.
//
// It used to run through spawnSync, which parks the vitest worker's event loop
// for the entire compile. Vitest's worker<->main RPC (birpc) gives an in-flight
// call 60s to come back, so on a 2-core CI runner — where 60 CPU-seconds of
// compile cannot finish inside 60 wall-seconds while sibling workers hold the
// cores — the blocked worker could not process the reply to its own pending
// `onTaskUpdate`, and the run died with
//
//     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
//
// AFTER every last test had already passed. Three consecutive runs on main died
// that way at 60.8s and 61.9s of file time; a fourth went green only because the
// compile happened to land at 38.6s. The suite was never the problem.
//
// Building through the ASYNC child_process API is the fix. The compile takes
// exactly as long, but the event loop stays free to answer RPC while the Go
// toolchain works, so the run stops being a race against the heartbeat. Keep it
// async: a spawnSync here brings the failure straight back.

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// worker/src/testing -> worker/src -> worker -> repo root (same shape in dist/).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const GO_DIR = join(REPO, "sources", "whatsapp-go");

/**
 * Synchronous on purpose: `go version` is milliseconds, and this is read at
 * module scope to gate `describe.skipIf` before collection. Absent toolchain is
 * a clean skip — the same posture testing/real-cli.ts takes for the CLI.
 */
export const goAvailable =
  spawnSync("go", ["version"], { encoding: "utf8" }).status === 0 &&
  existsSync(join(GO_DIR, "go.mod"));

let building: Promise<string> | null = null;

/**
 * Build the daemon once per worker into a temp path, without blocking the
 * event loop. Memoised on the promise, so two tests in one file share a single
 * compile instead of racing two.
 */
export function buildDaemon(): Promise<string> {
  building ??= (async () => {
    const out = join(mkdtempSync(join(tmpdir(), "wa-go-bin-")), "whatsapp-go");
    try {
      await execFileAsync("go", ["build", "-o", out, "."], { cwd: GO_DIR });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr;
      throw new Error(`go build failed: ${stderr ?? String(err)}`);
    }
    return out;
  })();
  return building;
}
