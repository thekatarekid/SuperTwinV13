// ===========================================================================
// ScreenAdapter (build P2.1, spec §4.2.2 / §4.3) — supervises the screenwatch
// Swift sidecar exactly the way WhatsAppAdapter supervises whatsapp-go:
//
//   - resolves the binary (env → bundled bin/ → dev sources/ path),
//   - line-buffered NDJSON parse of stdout, JSON-per-line commands on stdin,
//   - restart-on-crash with capped exponential backoff,
//   - graceful shutdown (`shutdown` cmd, then SIGTERM backstop).
//
// Snapshots become `screen.snapshot` events via the sink (P0.4 single-writer).
// Privacy is enforced IN the sidecar (spec §4.3) — but this adapter re-checks
// the two hard rules (password-manager bundles, private windows) before
// anything reaches the sink, belt-and-suspenders, and the tests assert the
// gate HARD: blocked content never lands even if a frame claims otherwise.
//
// The spawn function is dependency-injected (SpawnFn) so tests drive the real
// framing code with a scripted fake child.
// ===========================================================================

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChildLike, SpawnFn } from "../whatsapp/adapter.js";
import { toScreenEnvelope } from "./envelope.js";
import {
  isSnapshotFrame,
  type ScreenDropFrame,
  type ScreenState,
  type SnapshotFrame,
} from "./frames.js";
import { ScreenEventlogSink, type ScreenEventSink } from "./sink.js";

export type { ChildLike, SpawnFn } from "../whatsapp/adapter.js";

const SHUTDOWN_GRACE_MS = 3_000;

// ---- Node-side privacy re-check (spec §4.3, belt-and-suspenders) ----------
// Mirrors sources/screenwatch/Sources/ScreenwatchCore/Privacy.swift. The
// sidecar is the enforcement point; this second gate exists so a buggy or
// stale sidecar still cannot land blocked content in the event log.

export const PASSWORD_MANAGER_BUNDLE_PREFIXES: readonly string[] = [
  "com.1password.",
  "com.agilebits.onepassword",
  "com.bitwarden.",
  "com.lastpass.",
  "com.dashlane.",
  "com.apple.keychainaccess",
  "com.apple.passwords",
  "org.keepassxc.",
  "com.mseven.msecure",
  "in.sinew.enpass",
  "com.nordpass.",
  "com.roboform.",
  "com.keepersecurity.",
  "com.protonmail.pass",
];

const PRIVATE_MODE_BROWSER_BUNDLES = new Set([
  "com.apple.safari",
  "com.apple.safaritechnologypreview",
  "com.google.chrome",
  "com.google.chrome.canary",
  "com.google.chrome.beta",
  "company.thebrowser.browser",
  "company.thebrowser.dia",
]);

const PRIVATE_TITLE_MARKERS = ["private browsing", "(incognito)", "incognito)", "(private)"];

/** Why the ADAPTER would refuse a snapshot the sidecar let through. */
export function nodePrivacyVeto(frame: SnapshotFrame): string | null {
  const bundle = frame.bundle_id.toLowerCase();
  if (PASSWORD_MANAGER_BUNDLE_PREFIXES.some((p) => bundle.startsWith(p))) {
    return "password_manager";
  }
  if (PRIVATE_MODE_BROWSER_BUNDLES.has(bundle)) {
    const title = frame.window_title.toLowerCase();
    if (PRIVATE_TITLE_MARKERS.some((m) => title.includes(m))) {
      return "private_window";
    }
  }
  return null;
}

// ---- Binary resolution -----------------------------------------------------

export function resolveScreenwatchBin(explicit?: string): {
  bin: string;
  found: boolean;
} {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const env = process.env.SUPERTWIN_SCREENWATCH_BIN;
  if (env) candidates.push(env);

  const here = moduleDir();
  candidates.push(join(here, "bin", "screenwatch"));
  candidates.push(join(here, "..", "..", "..", "bin", "screenwatch"));

  const repoRoot = join(here, "..", "..", "..", "..");
  candidates.push(join(repoRoot, "sources", "screenwatch", "screenwatch"));

  for (const c of candidates) {
    if (c && existsSync(c)) return { bin: c, found: true };
  }
  return {
    bin: join(repoRoot, "sources", "screenwatch", "screenwatch"),
    found: false,
  };
}

function moduleDir(): string {
  try {
    return dirname(new URL(import.meta.url).pathname);
  } catch {
    return process.cwd();
  }
}

// ---- Adapter ---------------------------------------------------------------

export interface ScreenAdapterStatus {
  state: ScreenState;
  paused: boolean;
  pausedApps: string[];
  /** Accessibility permission granted (false while `need_permission`). */
  permission: boolean;
  /** Content-free drop counters by reason, for the Library privacy view. */
  drops: Record<string, number>;
  snapshots: number;
  lastError?: { code: string; message: string };
}

export interface ScreenAdapterOptions {
  spawn?: SpawnFn;
  binPath?: string;
  sink?: ScreenEventSink;
  mock?: boolean;
  fixturePath?: string;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  autoRestart?: boolean;
  log?: (line: string) => void;
}

export class ScreenAdapter {
  readonly sourceId = "screen";

  private readonly spawnFn: SpawnFn;
  private readonly binPath?: string;
  private readonly sink: ScreenEventSink;
  private readonly mock: boolean;
  private readonly fixturePath?: string;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly autoRestart: boolean;
  private readonly log: (line: string) => void;

  private child: ChildLike | null = null;
  private stdoutBuf = "";
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private ready = false;
  private pendingCommands: string[] = [];

  private state: ScreenState = "starting";
  private paused = false;
  private readonly pausedApps = new Set<string>();
  private permission = true;
  private readonly dropCounts = new Map<string, number>();
  private snapshotCount = 0;
  private lastError?: { code: string; message: string };

  private readonly snapshotCbs: Array<(f: SnapshotFrame) => void> = [];
  private readonly statusCbs: Array<(s: ScreenAdapterStatus) => void> = [];

  constructor(opts: ScreenAdapterOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.binPath = opts.binPath;
    this.sink = opts.sink ?? new ScreenEventlogSink(opts.log ?? (() => {}));
    this.mock = opts.mock ?? process.env.SUPERTWIN_SCREENWATCH_MOCK === "1";
    this.fixturePath = opts.fixturePath;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 15_000;
    this.autoRestart = opts.autoRestart ?? true;
    this.log = opts.log ?? (() => {});
  }

  onSnapshot(cb: (f: SnapshotFrame) => void): void {
    this.snapshotCbs.push(cb);
  }

  onStatus(cb: (s: ScreenAdapterStatus) => void): void {
    this.statusCbs.push(cb);
  }

  getStatus(): ScreenAdapterStatus {
    return {
      state: this.state,
      paused: this.paused,
      pausedApps: [...this.pausedApps].sort(),
      permission: this.permission,
      drops: Object.fromEntries(this.dropCounts),
      snapshots: this.snapshotCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  // ---- Lifecycle ----------------------------------------------------------

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.spawnSidecar();
  }

  /** Kill-switch (spec §4.3): pause/resume all capture. */
  async pause(paused: boolean): Promise<void> {
    this.paused = paused;
    this.send({ cmd: paused ? "pause" : "resume" });
    this.setState(paused ? "paused" : "capturing");
  }

  /** Per-app capture pause (spec §4.3, Library privacy controls). */
  async pauseApp(bundleId: string, paused: boolean): Promise<void> {
    const id = bundleId.toLowerCase();
    if (paused) this.pausedApps.add(id);
    else this.pausedApps.delete(id);
    this.send({ cmd: paused ? "pause_app" : "resume_app", bundle_id: bundleId });
    this.emitStatus();
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.send({ cmd: "shutdown" });
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (this.killTimer) {
          clearTimeout(this.killTimer);
          this.killTimer = null;
        }
        resolve();
      };
      child.once("exit", done);
      this.killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done();
      }, SHUTDOWN_GRACE_MS);
      this.killTimer.unref?.();
    });
    this.child = null;
  }

  // ---- Spawn + supervise --------------------------------------------------

  private spawnSidecar(): void {
    const { bin, found } = resolveScreenwatchBin(this.binPath);
    const args: string[] = [];
    if (this.mock) {
      args.push("--mock");
      if (this.fixturePath) args.push("--fixture", this.fixturePath);
    }

    this.ready = false;
    this.stdoutBuf = "";

    let child: ChildLike;
    try {
      child = this.spawnFn(bin, args, { env: { ...process.env } });
    } catch (err) {
      this.lastError = {
        code: "SPAWN_FAILED",
        message: `failed to spawn screenwatch (${bin}): ${(err as Error).message}`,
      };
      this.setState("error");
      if (found) this.scheduleRestart();
      return;
    }

    this.child = child;
    this.setState("starting");

    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.onStdout(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const line = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim();
      if (line) this.log(`[screenwatch] ${line}`);
    });
    child.on("error", (err: Error) => {
      this.lastError = { code: "CHILD_ERROR", message: err.message };
      this.setState("error");
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.child = null;
      this.ready = false;
      this.log(`[screenwatch] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (this.shuttingDown) return;
      this.setState("reconnecting");
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.autoRestart || this.shuttingDown) return;
    if (this.restartTimer) return;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.restartCount);
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      this.spawnSidecar();
    }, delay);
    this.restartTimer.unref?.();
  }

  // ---- NDJSON framing ------------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
    if (this.stdoutBuf.length > 4_000_000) this.stdoutBuf = "";
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.log(`[screenwatch:stdout] ${line}`);
      return;
    }
    switch (msg["t"]) {
      case "ready":
        this.ready = true;
        this.restartCount = 0;
        this.flushPending();
        // A fresh sidecar has no pause state: re-install ours.
        if (this.paused) this.send({ cmd: "pause" });
        for (const app of this.pausedApps) this.send({ cmd: "pause_app", bundle_id: app });
        break;
      case "status":
        this.handleStatus(String(msg["state"] ?? ""));
        break;
      case "snapshot":
        this.handleSnapshot(msg);
        break;
      case "drop": {
        const d = msg as unknown as ScreenDropFrame;
        this.bumpDrop(String(d.reason ?? "unknown"));
        break;
      }
      case "error":
        this.lastError = {
          code: String(msg["code"] ?? "ERROR"),
          message: String(msg["message"] ?? ""),
        };
        this.setState("error");
        break;
      default:
        // Unknown `t` — ignore for forward-compat.
        break;
    }
  }

  private handleStatus(state: string): void {
    switch (state) {
      case "need_permission":
        this.permission = false;
        this.setState("need_permission");
        break;
      case "capturing":
      case "fixture_done":
        this.permission = true;
        if (!this.paused) this.setState("capturing");
        break;
      case "paused":
        this.setState("paused");
        break;
      default:
        // app_paused / app_resumed / shutting_down — reflected elsewhere.
        this.emitStatus();
        break;
    }
  }

  private handleSnapshot(msg: Record<string, unknown>): void {
    if (!isSnapshotFrame(msg)) {
      this.log("[screen] malformed snapshot frame dropped");
      return;
    }
    const frame = msg;
    // Kill-switch belt+suspenders: while paused nothing is ingested even if
    // the sidecar keeps emitting.
    if (this.paused) {
      this.bumpDrop("paused");
      return;
    }
    if (this.pausedApps.has(frame.bundle_id.toLowerCase())) {
      this.bumpDrop("app_paused");
      return;
    }
    // HARD privacy re-check (spec §4.3): the sidecar should never emit these;
    // if one arrives anyway it dies here, before the sink.
    const veto = nodePrivacyVeto(frame);
    if (veto) {
      this.bumpDrop(veto);
      this.log(`[screen] privacy veto (${veto}) for ${frame.bundle_id} — frame dropped`);
      return;
    }
    this.snapshotCount += 1;
    this.sink.append([toScreenEnvelope(frame)]);
    for (const cb of this.snapshotCbs) cb(frame);
  }

  private bumpDrop(reason: string): void {
    this.dropCounts.set(reason, (this.dropCounts.get(reason) ?? 0) + 1);
  }

  // ---- Commands (stdin) ----------------------------------------------------

  private send(cmd: Record<string, unknown>): void {
    const line = JSON.stringify(cmd) + "\n";
    if (!this.ready || !this.child?.stdin) {
      this.pendingCommands.push(line);
      return;
    }
    try {
      this.child.stdin.write(line);
    } catch {
      this.pendingCommands.push(line);
    }
  }

  private flushPending(): void {
    if (!this.child?.stdin) return;
    const queued = this.pendingCommands;
    this.pendingCommands = [];
    for (const line of queued) {
      try {
        this.child.stdin.write(line);
      } catch {
        this.pendingCommands.push(line);
      }
    }
  }

  // ---- Status --------------------------------------------------------------

  private setState(state: ScreenState): void {
    this.state = state;
    this.emitStatus();
  }

  private emitStatus(): void {
    const s = this.getStatus();
    for (const cb of this.statusCbs) cb(s);
  }
}

const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const child = nodeSpawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env,
  });
  return child as unknown as ChildLike;
};
