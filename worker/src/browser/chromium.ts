// ===========================================================================
// Bundled Chromium — build P3.4, spec §12.1. Launch the staged
// Chrome-for-Testing build headed-but-hidden (never `--headless`, the #1 bot
// signal), with the persistent dedicated profile, driven over the CDP pipe.
//
// Resolution mirrors media/tools.ts: env pin → packaged resources one level up
// from the worker bundle → dev tree under <repo>/src-tauri/resources. There is
// deliberately NO PATH fallback and no use of the user's own Chrome — the
// agent browser is its own binary with its own profile. A machine without the
// staged build resolves to null and every caller reports "browser unavailable"
// instead of spawning into ENOENT; unit tests never need the binary at all
// (the CDP layer takes an injectable transport).
// ===========================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RawCdpTransport } from "./cdp.js";

/** Where the persistent logged-in profile lives (spec §12.2 — ONE profile). */
export function browserProfileDir(): string {
  return (
    process.env.SUPERTWIN_BROWSER_PROFILE ??
    join(homedir(), "SuperTwinV13", "browser-profile")
  );
}

// The executable inside the staged chrome-mac-arm64 tree, as Chrome for
// Testing unpacks it. scripts/stage-media-tools.mjs stages the tree verbatim.
const CFT_EXECUTABLE = join(
  "chrome-mac-arm64",
  "Google Chrome for Testing.app",
  "Contents",
  "MacOS",
  "Google Chrome for Testing",
);

function moduleBaseDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    const cjsDir = (globalThis as { __dirname?: string }).__dirname;
    if (typeof cjsDir === "string") return cjsDir;
    return process.cwd();
  }
}

/**
 * The staged Chromium executable, or null when absent (dev/test without a
 * staged build — gracefully absent by design).
 */
export function chromiumPath(): string | null {
  const pinned = process.env.SUPERTWIN_CHROMIUM_PATH;
  if (pinned && pinned.trim().length > 0) {
    return existsSync(pinned) ? pinned : null;
  }
  const candidates = [
    // Packaged: Contents/Resources/worker/worker.cjs → ../chromium/…
    resolve(join(moduleBaseDir(), "..", "chromium", CFT_EXECUTABLE)),
    // Dev: run from the repo root.
    resolve(join(process.cwd(), "src-tauri", "resources", "chromium", CFT_EXECUTABLE)),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface LaunchedChromium {
  child: ChildProcess;
  transport: RawCdpTransport;
  /** Where the profile actually is, for status surfaces. */
  profileDir: string;
}

/**
 * CDP pipe framing: NUL-separated JSON messages on fds 3 (write) / 4 (read).
 */
class PipeTransport implements RawCdpTransport {
  private buffer = "";
  private messageHandler: ((m: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(private readonly child: ChildProcess) {
    const readable = child.stdio[4] as NodeJS.ReadableStream | null;
    readable?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\0")) >= 0) {
        const frame = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (frame.length > 0) this.messageHandler?.(frame);
      }
    });
    child.on("exit", () => this.closeHandler?.());
  }

  send(message: string): void {
    const writable = this.child.stdio[3] as NodeJS.WritableStream | null;
    writable?.write(`${message}\0`);
  }

  onMessage(handler: (m: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}

/**
 * Launch the staged Chromium. Throws with a stated reason when the binary is
 * absent — callers surface that, they do not fall back to anything.
 */
export function launchChromium(): LaunchedChromium {
  const bin = chromiumPath();
  if (!bin) {
    throw new Error(
      "SuperTwin Browser unavailable: no staged Chromium. Run " +
        "`node scripts/stage-media-tools.mjs` or set SUPERTWIN_CHROMIUM_PATH.",
    );
  }
  const profileDir = browserProfileDir();
  mkdirSync(profileDir, { recursive: true });

  const child = spawn(
    bin,
    [
      // CDP over the stdio pipe — no debugging TCP port open on the machine.
      "--remote-debugging-pipe",
      `--user-data-dir=${profileDir}`,
      // Headed-but-hidden: a real windowed browser parked far off-screen. The
      // app shell parents/presents the window for user browsing (spec §12.2);
      // never --headless.
      "--window-position=-45000,-45000",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--hide-crash-restore-bubble",
    ],
    {
      // fds: stdin, stdout, stderr, CDP-in (3), CDP-out (4).
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    },
  );

  return { child, transport: new PipeTransport(child), profileDir };
}
