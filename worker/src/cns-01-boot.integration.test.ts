// ===========================================================================
// CNS-01 — nothing before yes: the REAL-PROCESS half (V6 P1 S1.3, Build §4.1;
// GoldenEvals_V6_Phase1 §5.2).
//
//   Setup.    Fresh home, all adapters present, no consent rows.
//   Input.    60 seconds of uptime.
//   Expected. 0 events; no WhatsApp daemon; no screen sidecar.
//   Wrong.    `microtask-import` — the browser 90-day import fires at boot.
//
// This boots the actual worker entrypoint (src/index.ts through tsx) the way
// scripts/dev-worker.mjs would — plan §1.3 rules 1, 2, 3 and 6 honoured by
// construction:
//   * SUPERTWIN_HOME is a throwaway temp dir; SUPERTWIN_DB_PATH is unset;
//   * the port is an OS-assigned free port (never 8013);
//   * the worker is a CHILD of this test (no detach) and is reaped in
//     afterAll — SIGTERM, then SIGKILL after a grace — and the port is
//     confirmed closed before the file ends;
//   * ZERO model calls: asserted through the `runs` ledger staying empty.
//
// Uptime defaults to the fixture's 60 s; CNS01_UPTIME_MS shortens it for a
// quick local loop (the assertions are identical).
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const UPTIME_MS = Number(process.env.CNS01_UPTIME_MS ?? 60_000);
const READY_TIMEOUT_MS = 90_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(HERE, "..");
const REPO = resolve(WORKER_DIR, "..");
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const PRODUCTION_PORT = 8013;

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Direct children of `pid` as `pid command` lines (empty when none). */
function children(pid: number): string[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((child) => {
        let cmd = "?";
        try {
          cmd = execFileSync("ps", ["-o", "command=", "-p", child], { encoding: "utf8" }).trim();
        } catch {
          /* raced with exit */
        }
        return `${child} ${cmd}`;
      });
  } catch {
    return []; // pgrep exits 1 when there are no matches
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let scratch: string;
let port: number;
let child: ChildProcess;
let workerPid: number | null = null;
let stdout = "";
let stderr = "";
let exited: Promise<void>;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "supertwin-cns01-boot-"));
  port = await freePort();
  expect(port).not.toBe(PRODUCTION_PORT);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SUPERTWIN_DB_PATH;
  delete env.SUPERTWIN_LAUNCHED_BY;
  delete env.SUPERTWIN_ALLOW_PRODUCTION_HOME;
  delete env.SUPERTWIN_WORKER_NO_PARENT;
  env.SUPERTWIN_HOME = scratch;
  env.SUPERTWIN_WORKER_PORT = String(port);

  child = spawn(process.execPath, [TSX_CLI, "src/index.ts"], {
    cwd: WORKER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.stdout!.on("data", (c: Buffer) => {
    stdout += c.toString("utf8");
  });
  child.stderr!.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
    const m = /\[worker\] home .* pid (\d+) ppid/.exec(stderr);
    if (m && workerPid === null) workerPid = Number(m[1]);
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!stdout.includes(`WORKER_READY port=${port}`)) {
    if (child.exitCode !== null) throw new Error(`worker exited early (${child.exitCode}):\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`worker not ready in ${READY_TIMEOUT_MS} ms:\n${stderr}`);
    await sleep(200);
  }
}, READY_TIMEOUT_MS + 10_000);

afterAll(async () => {
  // Rule 3: reap what we spawned, confirm the port is closed, then say so.
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      if (workerPid && processAlive(workerPid)) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }, 15_000);
    await exited;
    clearTimeout(killer);
  }
  if (workerPid) {
    const deadline = Date.now() + 5_000;
    while (processAlive(workerPid) && Date.now() < deadline) await sleep(100);
  }
  let portClosed = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`);
  } catch {
    portClosed = true;
  }
  rmSync(scratch, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.error(`[cns-01] worker on port ${port} stopped; port closed=${portClosed}; scratch home removed`);
  expect(portClosed).toBe(true);
  if (workerPid) expect(processAlive(workerPid)).toBe(false);
}, 30_000);

describe("CNS-01 — nothing before yes (60 s real boot on a scratch home)", () => {
  it(
    `serves /api/health for ${UPTIME_MS} ms and starts no adapter, no daemon, no sidecar; writes 0 events; 0 model calls`,
    async () => {
      expect(workerPid).not.toBeNull();
      const wp = workerPid!;

      // The boot line says what the supervisor did on a fresh home.
      expect(stderr).toContain("[worker] sources: started []");
      expect(stderr).toContain("whatsapp:no-consent");
      expect(stderr).toContain("browser:no-consent");
      expect(stderr).toContain("screen:no-consent");

      const end = Date.now() + UPTIME_MS;
      let polls = 0;
      while (Date.now() < end) {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok?: boolean; whatsapp?: { state: string } };
        expect(body.ok).toBe(true);
        // The adapter exists (the pairing route needs it) but never got a daemon.
        expect(body.whatsapp?.state).toBe("starting");
        polls += 1;
        await sleep(Math.min(5_000, Math.max(0, end - Date.now())));
      }
      expect(polls).toBeGreaterThan(0);
      expect(child.exitCode).toBeNull();

      // No WhatsApp daemon, no screen sidecar, no `claude`: the worker process
      // has no children of its own beyond two known helpers — tsx keeps an
      // esbuild transpile service under the process it loads, and the
      // consolidation job's idle probe (consolidation/t3.ts) runs `pmset` /
      // `ioreg` for a few ms at its one-minute tick. Anything else fails.
      // `children()` returns "<pid> <command> <args>", so every boundary here
      // has to admit the SPACE after the pid as well as `^` and `/`. It did
      // not, which cost twice: a bare `pmset` at the tick failed the filter
      // (seen at the V6P1S6d gate: "75755 pmset -g batt"), and — the half that
      // matters — a bare `claude` child would have slipped past the assertion
      // that this boot spends nothing.
      const all = children(wp);
      expect(all.some((k) => /whatsapp-go|screenwatch|(^|[\s/])claude(\s|$)/.test(k)), all.join("\n")).toBe(false);
      const kids = all.filter((k) => !/(^|[\s/])(esbuild|pmset|ioreg)(\s|$)/.test(k));
      expect(kids, `worker ${wp} spawned children:\n${kids.join("\n")}`).toEqual([]);
      expect(stderr).not.toMatch(/\[whatsapp-go\]/);
      expect(stderr).not.toMatch(/\[screenwatch/);
      // Wrong: microtask-import — the browser watcher never polled.
      expect(stderr).not.toMatch(/\[browser\]/);

      const screen = (await (await fetch(`http://127.0.0.1:${port}/api/screen/status`)).json()) as Record<string, unknown>;
      expect(screen.running).toBe(false);
      expect(screen.state).toBe("not_started");
      expect(screen.consent).toBe(false);

      // 0 events, 0 archive rows, 0 consents — and 0 model calls (runs ledger).
      const db = new Database(join(scratch, "supertwinv13.db"), { readonly: true });
      try {
        const n = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        expect(n("events")).toBe(0);
        expect(n("archive")).toBe(0);
        expect(n("consents")).toBe(0);
        // (`sources` may hold the registered adapter's manifest row from
        // Ingestion.start() — registry, not capture. Streams are capture.)
        expect(n("streams")).toBe(0);
        expect(n("runs")).toBe(0);
      } finally {
        db.close();
      }
    },
    UPTIME_MS + 60_000,
  );
});
